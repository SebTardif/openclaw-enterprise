//! Synthetic contract peers only; no protected OCE provider or UDS authority.
//! These cases are source-authored and require separately authorized execution.
use super::*;
use bytes::Bytes;
use hyper::body::{Body, Frame};
use rcgen::{
    date_time_ymd, BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer,
    KeyPair, KeyUsagePurpose, SanType,
};
use std::{
    collections::VecDeque,
    future::poll_fn,
    pin::Pin,
    sync::{atomic::AtomicUsize, Condvar},
    task::{Context, Poll},
};
use tokio::sync::Notify;

const DRIVER: &str = "spiffe://example.test/publication-driver";
const BROKER: &str = "spiffe://example.test/publication-broker";
fn sample(seconds: u64) -> MaterialTime {
    let monotonic = tokio::time::Instant::now();
    MaterialTime {
        wall: Duration::from_secs(seconds),
        monotonic,
    }
}
fn now() -> MaterialTime {
    sample(date_time_ymd(2026, 6, 1).unix_timestamp() as u64)
}
fn selectors() -> DriverProfileSelectors {
    DriverProfileSelectors {
        profile_ref: "test:synthetic-profile".into(),
        source_revision: 1,
        workload_api_socket: "/synthetic/workload.sock".into(),
        workload_api_peer_uid: 123,
        trusted_ancestor_uids: vec![0, 123],
        driver_spiffe_id: DRIVER.into(),
        broker_spiffe_id: BROKER.into(),
        trust_domain: "example.test".into(),
    }
}
fn peer() -> (watch::Sender<bool>, Arc<IdentityStartup>) {
    let (tx, invalidated) = watch::channel(false);
    let profile = CapturedDriverProfile {
        selectors: selectors(),
        invalidated,
    };
    (tx, IdentityStartup::new(profile).unwrap())
}
fn vi(mut n: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while n >= 128 {
        out.push(n as u8 | 128);
        n >>= 7;
    }
    out.push(n as u8);
    out
}
fn fld(n: u64, bytes: &[u8]) -> Vec<u8> {
    let mut out = vi(n << 3 | 2);
    out.extend(vi(bytes.len() as u64));
    out.extend(bytes);
    out
}
fn fields(id: &[u8]) -> Vec<Vec<u8>> {
    vec![id.to_vec(), vec![1], vec![2], vec![3], Vec::new()]
}
fn entry(parts: &[Vec<u8>]) -> Vec<u8> {
    parts
        .iter()
        .enumerate()
        .flat_map(|(i, v)| fld(i as u64 + 1, v))
        .collect()
}
fn response(parts: &[Vec<u8>]) -> Vec<u8> {
    fld(1, &entry(parts))
}
fn reject<T>(result: Result<T, Refusal>, expected: Refusal) {
    assert!(
        matches!(result, Err(e) if e == expected),
        "expected {expected:?}"
    );
}
fn scan_ok(raw: &[u8]) -> usize {
    scan(raw, &AtomicBool::new(false)).unwrap().len()
}
fn scan_bad(raw: &[u8], why: Refusal) {
    reject(scan(raw, &AtomicBool::new(false)), why);
}

struct Frames {
    frames: VecDeque<Frame<Bytes>>,
    polls: Arc<AtomicUsize>,
}
impl Body for Frames {
    type Data = Bytes;
    type Error = std::io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        self.polls.fetch_add(1, Ordering::SeqCst);
        Poll::Ready(self.frames.pop_front().map(Ok))
    }
}
fn stream(
    chunks: Vec<Vec<u8>>,
    trailers: bool,
    limit: usize,
) -> (tonic::Streaming<Zeroizing<Vec<u8>>>, Arc<AtomicUsize>) {
    let polls = Arc::new(AtomicUsize::new(0));
    let mut frames: VecDeque<_> = chunks
        .into_iter()
        .map(|v| Frame::data(Bytes::from(v)))
        .collect();
    if trailers {
        let mut headers = http::HeaderMap::new();
        headers.insert("grpc-status", "0".parse().unwrap());
        frames.push_back(Frame::trailers(headers));
    }
    (
        tonic::Streaming::new_response(
            RawDecoder,
            Frames {
                frames,
                polls: polls.clone(),
            },
            http::StatusCode::OK,
            None,
            Some(limit),
        ),
        polls,
    )
}
fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = vec![0];
    out.extend((payload.len() as u32).to_be_bytes());
    out.extend(payload);
    out
}
#[tokio::test]
async fn tonic_response_limit_precedes_payload_and_decoder_has_own_limit() {
    let payload = vec![42; RESPONSE_BYTES];
    let (mut s, _) = stream(vec![frame(&payload)], true, RESPONSE_BYTES);
    assert_eq!(&**s.message().await.unwrap().unwrap(), &payload);
    assert!(s.message().await.unwrap().is_none());
    let mut header = vec![0];
    header.extend(((RESPONSE_BYTES + 1) as u32).to_be_bytes());
    let (mut s, polls) = stream(vec![header, vec![99]], false, RESPONSE_BYTES);
    assert_eq!(
        s.message().await.unwrap_err().code(),
        tonic::Code::OutOfRange
    );
    assert_eq!(
        polls.load(Ordering::SeqCst),
        1,
        "oversize header must precede next body read"
    );
    let (mut s, _) = stream(
        vec![frame(&vec![0; RESPONSE_BYTES + 1])],
        true,
        RESPONSE_BYTES + 1,
    );
    assert_eq!(
        s.message().await.unwrap_err().code(),
        tonic::Code::ResourceExhausted
    );
}
#[tokio::test]
async fn tonic_preserves_fragmented_and_coalesced_messages() {
    let a = response(&fields(DRIVER.as_bytes()));
    let b = response(&fields(BROKER.as_bytes()));
    let joined = [frame(&a), frame(&b)].concat();
    for chunks in [
        vec![joined.clone()],
        joined.chunks(1).map(<[u8]>::to_vec).collect(),
        joined.chunks(7).map(<[u8]>::to_vec).collect(),
    ] {
        let (mut s, _) = stream(chunks, true, RESPONSE_BYTES);
        for expected in [&a, &b] {
            let actual = s.message().await.unwrap().unwrap();
            assert_eq!(&*actual, expected);
            assert_eq!(scan_ok(&actual), 1);
        }
        assert!(s.message().await.unwrap().is_none());
    }
}
#[tokio::test]
async fn tonic_refuses_compression_bad_flags_and_truncated_frames() {
    for flag in [1, 2, 255] {
        let mut raw = frame(&[0x1f, 0x8b, 8, 0]);
        raw[0] = flag;
        let (mut s, _) = stream(vec![raw], false, RESPONSE_BYTES);
        assert_eq!(s.message().await.unwrap_err().code(), tonic::Code::Internal);
    }
    for raw in [vec![0, 0, 0], vec![0, 0, 0, 0, 5, 1]] {
        let (mut s, _) = stream(vec![raw], false, RESPONSE_BYTES);
        assert_eq!(s.message().await.unwrap_err().code(), tonic::Code::Internal);
    }
}
#[test]
fn scan_refuses_every_crl_and_federation_occurrence() {
    let good = response(&fields(DRIVER.as_bytes()));
    for n in [2, 3] {
        for forbidden in [
            fld(n, &[]),
            fld(n, &[1]),
            [fld(n, &[]), fld(n, &[])].concat(),
            vi(n << 3),
            vi(n << 3 | 2),
        ] {
            for raw in [forbidden.clone(), [good.clone(), forbidden].concat()] {
                scan_bad(&raw, Refusal::Unsupported);
            }
        }
    }
}
#[test]
fn scan_refuses_unknown_wrong_wire_overflow_truncation_and_noncanonical_fields() {
    for raw in [
        fld(4, &[]),
        fld(1, &fld(6, &[])),
        vec![0, 0],
        vec![8, 0],
        vec![10],
        vec![10, 2, 1],
        vec![0x8a, 0, 0],
        vec![10, 0x80, 0],
        [vec![0x80; 9], vec![2]].concat(),
        [vec![10], vec![0xff; 10]].concat(),
        [vi(0x2000_0000u64 << 3 | 2), vec![0]].concat(),
    ] {
        scan_bad(&raw, Refusal::Protocol);
    }
    for wire in [0, 1, 3, 4, 5, 6, 7] {
        scan_bad(&fld(1, &[8 | wire, 0]), Refusal::Protocol);
    }
    let mut bad = fields(DRIVER.as_bytes());
    bad[0] = vec![255];
    scan_bad(&response(&bad), Refusal::Protocol);
    bad = fields(DRIVER.as_bytes());
    bad[4] = vec![255];
    scan_bad(&response(&bad), Refusal::Protocol);
}
#[test]
fn scan_refuses_duplicate_singular_fields_identities_and_missing_material() {
    let parts = fields(DRIVER.as_bytes());
    let encoded = entry(&parts);
    for n in 1..=5 {
        scan_bad(
            &fld(1, &[encoded.clone(), fld(n, &[])].concat()),
            Refusal::Protocol,
        );
    }
    scan_bad(
        &[fld(1, &encoded), fld(1, &encoded)].concat(),
        Refusal::Protocol,
    );
    for index in 0..4 {
        let missing: Vec<u8> = parts
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != index)
            .flat_map(|(i, v)| fld(i as u64 + 1, v))
            .collect();
        scan_bad(&fld(1, &missing), Refusal::Protocol);
        let mut empty = parts.clone();
        empty[index].clear();
        scan_bad(&response(&empty), Refusal::Protocol);
    }
}
#[test]
fn scan_enforces_each_field_svid_response_and_field_count_boundary() {
    for (index, limit) in [ID_BYTES, CHAIN_BYTES, KEY_BYTES, BUNDLE_BYTES, HINT_BYTES]
        .into_iter()
        .enumerate()
    {
        let mut parts = fields(b"id");
        parts[index] = vec![b'a'; limit];
        assert_eq!(scan_ok(&response(&parts)), 1);
        parts[index].push(b'a');
        scan_bad(&response(&parts), Refusal::Bounds);
    }
    let rows: Vec<_> = (0..=SVIDS)
        .map(|i| response(&fields(format!("id{i}").as_bytes())))
        .collect();
    assert_eq!(scan_ok(&rows[..SVIDS].concat()), SVIDS);
    scan_bad(&rows.concat(), Refusal::Bounds);
    scan_bad(&[], Refusal::Bounds);
    let mut rows: Vec<_> = (0..SVIDS)
        .map(|i| {
            let mut p = fields(format!("d{i}").as_bytes());
            p[3] = vec![0; BUNDLE_BYTES];
            p
        })
        .collect();
    let total: usize = rows.iter().map(|p| response(p).len()).sum();
    rows.last_mut().unwrap()[3].truncate(BUNDLE_BYTES - (total - RESPONSE_BYTES));
    let mut raw: Vec<u8> = rows.iter().flat_map(|p| response(p)).collect();
    assert_eq!(raw.len(), RESPONSE_BYTES);
    assert_eq!(scan_ok(&raw), SVIDS);
    raw.push(0);
    scan_bad(&raw, Refusal::Bounds);
    // Strict singular/SVID limits make FIELDS unreachable through a valid scan;
    // exercise its shared pre-allocation guard directly at B and B+1.
    let (mut offset, mut count) = (0, FIELDS - 1);
    let stop = AtomicBool::new(false);
    assert!(field(&[10, 0, 10, 0], &mut offset, &mut count, false, &stop).is_ok());
    reject(
        field(&[10, 0, 10, 0], &mut offset, &mut count, false, &stop),
        Refusal::Bounds,
    );
}
#[test]
fn der_preflight_enforces_certificate_size_count_and_canonical_lengths() {
    let stop = AtomicBool::new(false);
    for maximum in [CHAIN_CERTS, AUTHORITIES] {
        // Structural DER sequence fixtures deliberately do not assert valid X.509.
        let mut raw: Vec<u8> = (0..maximum).flat_map(|i| [0x30, 1, i as u8]).collect();
        assert_eq!(certificates(&raw, maximum, &stop).unwrap().len(), maximum);
        raw.extend([0x30, 1, maximum as u8]);
        reject(certificates(&raw, maximum, &stop), Refusal::Bounds);
    }
    for size in [CERT_BYTES, CERT_BYTES + 1] {
        let n = size - 4;
        let mut der = vec![0x30, 0x82, (n >> 8) as u8, n as u8];
        der.resize(size, 0);
        if size == CERT_BYTES {
            assert_eq!(
                certificates(&der, CHAIN_CERTS, &stop).unwrap()[0].len(),
                size
            );
        } else {
            reject(certificates(&der, CHAIN_CERTS, &stop), Refusal::Bounds);
        }
    }
    for raw in [
        vec![],
        vec![0x31, 0],
        vec![0x30],
        vec![0x30, 2, 0],
        vec![0x30, 0x80],
        vec![0x30, 0x81, 1, 0],
        vec![0x30, 0x82, 0, 128],
        vec![0x30, 0x85],
        vec![0x30, 0, 0x30, 0],
        vec![0x30, 0, 0],
    ] {
        reject(certificates(&raw, CHAIN_CERTS, &stop), Refusal::Protocol);
    }
    let stopped = AtomicBool::new(true);
    reject(
        certificates(&[0x30, 0], CHAIN_CERTS, &stopped),
        Refusal::Deadline,
    );
    reject(scan(&response(&fields(b"id")), &stopped), Refusal::Deadline);
}

struct MaterialFixture {
    chain: Vec<u8>,
    key: Vec<u8>,
    bundle: Vec<u8>,
}
impl MaterialFixture {
    fn new(id: &str) -> Self {
        Self::until(id, 4090, 4091)
    }
    fn until(id: &str, leaf_year: i32, ca_year: i32) -> Self {
        let mut ca = CertificateParams::default();
        ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign];
        ca.not_before = date_time_ymd(2025, 1, 1);
        ca.not_after = date_time_ymd(ca_year, 1, 1);
        let key = KeyPair::generate().unwrap();
        let root = ca.self_signed(&key).unwrap();
        let issuer = Issuer::new(ca, key);
        let mut leaf = CertificateParams::default();
        leaf.is_ca = IsCa::ExplicitNoCa;
        leaf.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        leaf.extended_key_usages = vec![
            ExtendedKeyUsagePurpose::ServerAuth,
            ExtendedKeyUsagePurpose::ClientAuth,
        ];
        leaf.subject_alt_names = if id.is_empty() {
            vec![]
        } else {
            vec![SanType::URI(id.try_into().unwrap())]
        };
        leaf.not_before = date_time_ymd(2025, 1, 1);
        leaf.not_after = date_time_ymd(leaf_year, 1, 1);
        let key = KeyPair::generate().unwrap();
        let cert = leaf.signed_by(&key, &issuer).unwrap();
        Self {
            chain: cert.der().to_vec(),
            key: key.serialize_der(),
            bundle: root.der().to_vec(),
        }
    }
    fn raw(&self, id: &str) -> Vec<u8> {
        response(&[
            id.as_bytes().to_vec(),
            self.chain.clone(),
            self.key.clone(),
            self.bundle.clone(),
        ])
    }
}
#[test]
fn genuine_der_material_matches_selected_id_key_trust_and_generation() {
    let f = MaterialFixture::new(DRIVER);
    let raw = f.raw(DRIVER);
    let stop = AtomicBool::new(false);
    let a = decode_material(&raw, &selectors(), now(), &stop).unwrap();
    assert_eq!(
        a.valid_until,
        date_time_ymd(4090, 1, 1).unix_timestamp() as u64
    );
    assert_eq!(a.certified.cert[0].as_ref(), f.chain);
    assert_eq!(a.roots.len(), 1);
    a.certified.keys_match().unwrap();
    let parts = vec![
        DRIVER.as_bytes().to_vec(),
        f.chain.clone(),
        f.key.clone(),
        f.bundle.clone(),
        b"hint".to_vec(),
    ];
    let b = decode_material(&response(&parts), &selectors(), now(), &stop).unwrap();
    assert_eq!(a.generation, b.generation);
    let renewed = MaterialFixture::new(DRIVER);
    assert_ne!(
        a.generation,
        decode_material(&renewed.raw(DRIVER), &selectors(), now(), &stop)
            .unwrap()
            .generation
    );
}
#[test]
fn material_refuses_mismatch_untrusted_missing_expired_and_malformed_material() {
    let f = MaterialFixture::new(DRIVER);
    let other = MaterialFixture::new(DRIVER);
    let stop = AtomicBool::new(false);
    let check = |raw: &[u8], why| reject(decode_material(raw, &selectors(), now(), &stop), why);
    check(&f.raw(BROKER), Refusal::Tls);
    check(&MaterialFixture::new("").raw(DRIVER), Refusal::Tls);
    check(
        &MaterialFixture::until(DRIVER, 4090, 2026).raw(DRIVER),
        Refusal::Tls,
    );
    check(
        &response(&[
            DRIVER.as_bytes().to_vec(),
            f.chain.clone(),
            vec![1],
            f.bundle.clone(),
        ]),
        Refusal::Tls,
    );
    for (key, bundle) in [(other.key, f.bundle.clone()), (f.key.clone(), other.bundle)] {
        check(
            &response(&[DRIVER.as_bytes().to_vec(), f.chain.clone(), key, bundle]),
            Refusal::Tls,
        );
    }
    let mut selected = selectors();
    selected.driver_spiffe_id = "spiffe://example.test/absent".into();
    reject(
        decode_material(&f.raw(DRIVER), &selected, now(), &stop),
        Refusal::AuthorityUnavailable,
    );
    for time in [date_time_ymd(2024, 1, 1), date_time_ymd(4090, 1, 1)] {
        reject(
            decode_material(
                &f.raw(DRIVER),
                &selectors(),
                sample(time.unix_timestamp() as u64),
                &stop,
            ),
            Refusal::Tls,
        );
    }
    check(&response(&fields(DRIVER.as_bytes())), Refusal::Protocol);
    let mut broken = f.raw(DRIVER);
    broken.extend(response(&fields(BROKER.as_bytes())));
    check(&broken, Refusal::Protocol); // Even an unselected entry must validate.
    reject(
        decode_material(&f.raw(DRIVER), &selectors(), now(), &AtomicBool::new(true)),
        Refusal::Deadline,
    );
}
#[test]
fn selected_profile_rejects_invalid_comparison_records() {
    selectors().validate().unwrap();
    let changes: [fn(&mut DriverProfileSelectors); 9] = [
        |p| p.source_revision = 0,
        |p| p.workload_api_socket = "relative.sock".into(),
        |p| p.workload_api_socket = "/a/../b".into(),
        |p| p.trusted_ancestor_uids.clear(),
        |p| p.trusted_ancestor_uids = vec![0; 9],
        |p| p.driver_spiffe_id = p.broker_spiffe_id.clone(),
        |p| p.trust_domain = "elsewhere.test".into(),
        |p| p.driver_spiffe_id = "x".repeat(ID_BYTES + 1),
        |p| p.broker_spiffe_id = "invalid".into(),
    ];
    for change in changes {
        let mut p = selectors();
        change(&mut p);
        reject(p.validate(), Refusal::Configuration);
    }
}

async fn pending<F: Future + ?Sized>(mut future: Pin<&mut F>) {
    poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}
async fn bounded<F: Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .ok()
        .expect("test control did not progress")
}
#[derive(Default)]
struct Gate {
    state: Mutex<(bool, bool)>,
    condition: Condvar,
    entered: AtomicBool,
    observed: AtomicBool,
    exited: AtomicBool,
    entry: Notify,
    cancellation: Notify,
}
struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release();
    }
}
impl Gate {
    fn release(&self) {
        self.state.lock().unwrap().1 = true;
        self.condition.notify_all();
    }
    fn inspect(&self) {
        self.state.lock().unwrap().0 = true;
        self.condition.notify_all();
    }
    async fn entered(&self) {
        while !self.entered.load(Ordering::Acquire) {
            self.entry.notified().await;
        }
    }
    async fn cancelled(&self) {
        while !self.observed.load(Ordering::Acquire) {
            self.cancellation.notified().await;
        }
    }
}
fn blocked(owner: &TaskOwner) -> (Arc<Gate>, Release) {
    let gate = Arc::new(Gate::default());
    let worker = gate.clone();
    let stop = owner.stop.clone();
    owner
        .register(|| {
            tokio::task::spawn_blocking(move || {
                worker.entered.store(true, Ordering::Release);
                worker.entry.notify_one();
                let mut state = worker.state.lock().unwrap();
                while !state.0 && !state.1 {
                    state = worker.condition.wait(state).unwrap();
                }
                worker
                    .observed
                    .store(stop.load(Ordering::Acquire), Ordering::Release);
                worker.cancellation.notify_one();
                while !state.1 {
                    state = worker.condition.wait(state).unwrap();
                }
                worker.exited.store(true, Ordering::Release);
            })
        })
        .unwrap();
    (gate.clone(), Release(gate))
}
fn joined(owner: &TaskOwner) {
    let tasks = owner.registry.lock().unwrap().tasks.clone();
    assert!(tasks
        .iter()
        .all(|task| task.handle.try_lock().unwrap().is_none()));
}
#[test]
fn initial_decode_keeps_sampled_expiry_while_queued() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let fixture = MaterialFixture::new(DRIVER);
        let certificate_expiry =
            Duration::from_secs(date_time_ymd(4090, 1, 1).unix_timestamp() as u64);
        let watchdog = Duration::from_secs(5);

        // A real prompt decode admits the same certificate and selected identity.
        let (_prompt_source, prompt) = peer();
        let prompt_raw = Zeroizing::new(fixture.raw(DRIVER));
        let prompt_time = MaterialTime {
            monotonic: tokio::time::Instant::now(),
            wall: certificate_expiry - Duration::from_secs(10),
        };
        let prompt_registered = prompt.decode(prompt_raw, prompt_time).is_ok();
        let prompt_admitted = matches!(
            tokio::time::timeout(watchdog, prompt.acquire()).await,
            Ok(Ok(material)) if material.roots.len() == 1
                && material.expires == prompt_time.monotonic + Duration::from_secs(10));
        let prompt_retired = prompt.retire().await;

        let (_source, startup) = peer();
        let (gate, _release) = blocked(&startup.tasks);
        let entered = tokio::time::timeout(watchdog, gate.entered()).await.is_ok();
        let raw = Zeroizing::new(fixture.raw(DRIVER));
        let mut updates = startup.material.subscribe();
        let remaining = Duration::from_millis(1250);
        // Precise fixture wall time leaves 1.25 s on the original sample.
        // Actual wall time remains before the year-4090 certificate expiry.
        let sampled = MaterialTime {
            monotonic: tokio::time::Instant::now(),
            wall: certificate_expiry - remaining,
        };
        let horizon = sampled.monotonic + remaining;
        let registered = startup.decode(raw, sampled).is_ok();
        let before_horizon = tokio::time::Instant::now() < horizon;
        let retained = startup.tasks.registry.lock().unwrap().tasks.clone();
        let queued = retained.len() == 2
            && retained
                .iter()
                .all(|task| task.handle.try_lock().unwrap().is_some())
            && startup.material.borrow().is_none()
            && !gate.exited.load(Ordering::Acquire);

        // The sole blocking worker has physically entered our existing gate;
        // the registered decoder cannot parse until after its original horizon.
        tokio::time::sleep_until(horizon + Duration::from_millis(10)).await;
        let elapsed_while_queued = tokio::time::Instant::now() >= horizon
            && startup.material.borrow().is_none()
            && !gate.exited.load(Ordering::Acquire);
        gate.release();
        let notified = matches!(
            tokio::time::timeout(watchdog, updates.changed()).await,
            Ok(Ok(()))
        );
        // Observe the decoder's own committed refusal before retire clears it.
        let committed_tls = matches!(updates.borrow().as_ref(), Some(Err(Refusal::Tls)));
        let decoder_cancelled = startup.tasks.stop.load(Ordering::Acquire);
        let acquisition_refused = matches!(
            tokio::time::timeout(watchdog, startup.acquire_identity()).await,
            Ok(Err(Refusal::Deadline | Refusal::Tls))
        );
        let retired = startup.retire().await;
        let blocker_exited = gate.exited.load(Ordering::Acquire);

        // Every original task is retired before any result assertion.
        prompt_retired.unwrap();
        retired.unwrap();
        joined(&prompt.tasks);
        joined(&startup.tasks);
        assert!(
            prompt_registered && prompt_admitted,
            "prompt control must admit real material"
        );
        assert!(
            entered && registered && before_horizon && queued,
            "decode must be registered behind the physically entered sole blocking worker"
        );
        assert!(
            elapsed_while_queued,
            "original sampled horizon must pass before parsing"
        );
        assert!(
            notified && committed_tls && decoder_cancelled && acquisition_refused,
            "late initial decode must commit Tls and cancel, never extend its horizon"
        );
        assert!(blocker_exited);
        assert!(startup.material.borrow().is_none());
    });
}

#[tokio::test]
async fn startup_decodes_real_material_and_retains_joined_worker() {
    let (_source, startup) = peer();
    let f = MaterialFixture::new(DRIVER);
    startup
        .decode(Zeroizing::new(f.raw(DRIVER)), now())
        .unwrap();
    assert_eq!(bounded(startup.acquire()).await.unwrap().roots.len(), 1);
    bounded(startup.retire()).await.unwrap();
    joined(&startup.tasks);
    assert!(startup.material.borrow().is_none());
}
#[tokio::test]
async fn startup_cancel_wakes_waiter_and_retire_waits_for_entered_worker() {
    let (_source, startup) = peer();
    let (gate, _release) = blocked(&startup.tasks);
    bounded(gate.entered()).await;
    let mut acquisition = Box::pin(startup.acquire());
    pending(acquisition.as_mut()).await;
    startup.cancel();
    reject(bounded(acquisition).await, Refusal::Deadline);
    let mut retirement = Box::pin(startup.retire());
    pending(retirement.as_mut()).await;
    gate.inspect();
    bounded(gate.cancelled()).await;
    assert!(!gate.exited.load(Ordering::Acquire));
    pending(retirement.as_mut()).await;
    gate.release();
    bounded(retirement).await.unwrap();
    assert!(gate.exited.load(Ordering::Acquire));
    joined(&startup.tasks);
}
#[tokio::test]
async fn dropping_retire_await_keeps_actual_blocking_handle_for_retry() {
    let owner = TaskOwner::new();
    let (gate, _release) = blocked(&owner);
    bounded(gate.entered()).await;
    let mut first = Box::pin(owner.retire());
    pending(first.as_mut()).await;
    gate.inspect();
    bounded(gate.cancelled()).await;
    drop(first);
    let task = owner.registry.lock().unwrap().tasks[0].clone();
    assert!(task.handle.try_lock().unwrap().is_some());
    assert!(!gate.exited.load(Ordering::Acquire));
    let mut second = Box::pin(owner.retire());
    pending(second.as_mut()).await;
    gate.release();
    bounded(second).await.unwrap();
    joined(&owner);
}
struct PollWitness {
    polled: Arc<AtomicUsize>,
    dropped: Arc<AtomicBool>,
}
impl Future for PollWitness {
    type Output = ();
    fn poll(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<()> {
        self.polled.fetch_add(1, Ordering::SeqCst);
        Poll::Pending
    }
}
impl Drop for PollWitness {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::Release);
    }
}
#[tokio::test]
async fn retired_executor_drops_unpolled_future_and_seals_registration() {
    let owner = TaskOwner::new();
    bounded(owner.retire()).await.unwrap();
    let created = AtomicBool::new(false);
    reject(
        owner.register(|| {
            created.store(true, Ordering::SeqCst);
            tokio::spawn(async {})
        }),
        Refusal::AuthorityUnavailable,
    );
    assert!(!created.load(Ordering::SeqCst));
    let polled = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::new(AtomicBool::new(false));
    hyper::rt::Executor::execute(
        &owner,
        PollWitness {
            polled: polled.clone(),
            dropped: dropped.clone(),
        },
    );
    assert_eq!(polled.load(Ordering::SeqCst), 0);
    assert!(dropped.load(Ordering::Acquire));
    reject(bounded(owner.retire()).await, Refusal::Protocol);
    joined(&owner);
}
#[tokio::test]
async fn task_registry_boundary_rejects_before_spawning_and_joins_every_handle() {
    let owner = TaskOwner::new();
    for _ in 0..TASKS {
        owner
            .register(|| tokio::spawn(std::future::pending()))
            .unwrap();
    }
    assert_eq!(owner.registry.lock().unwrap().tasks.len(), TASKS);
    let created = AtomicBool::new(false);
    reject(
        owner.register(|| {
            created.store(true, Ordering::SeqCst);
            tokio::spawn(async {})
        }),
        Refusal::AuthorityUnavailable,
    );
    assert!(!created.load(Ordering::SeqCst));
    reject(bounded(owner.retire()).await, Refusal::Protocol);
    joined(&owner);
}
#[tokio::test]
async fn profile_withdrawal_and_source_loss_wake_pending_acquisition() {
    for withdrawal in [true, false] {
        let (source, startup) = peer();
        let mut acquisition = Box::pin(startup.acquire());
        pending(acquisition.as_mut()).await;
        if withdrawal {
            source.send_replace(true);
        } else {
            drop(source);
        }
        reject(bounded(acquisition).await, Refusal::AuthorityUnavailable);
        reject(
            startup.decode(Zeroizing::new(vec![1]), now()),
            Refusal::AuthorityUnavailable,
        );
        bounded(startup.retire()).await.unwrap();
        joined(&startup.tasks);
    }
}

#[tokio::test]
async fn same_generation_renews_but_changed_material_cancels_original_startup() {
    let (_source, startup) = peer();
    let f = MaterialFixture::new(DRIVER);
    let mut updates = startup.material.subscribe();
    startup
        .decode(Zeroizing::new(f.raw(DRIVER)), now())
        .unwrap();
    bounded(updates.changed()).await.unwrap();
    let original = bounded(startup.acquire()).await.unwrap();
    startup
        .decode(Zeroizing::new(f.raw(DRIVER)), now())
        .unwrap();
    bounded(updates.changed()).await.unwrap();
    assert_eq!(
        bounded(startup.acquire()).await.unwrap().generation,
        original.generation
    );
    assert!(!startup.tasks.stop.load(Ordering::Acquire));
    let replacement = MaterialFixture::new(DRIVER);
    startup
        .decode(Zeroizing::new(replacement.raw(DRIVER)), now())
        .unwrap();
    bounded(updates.changed()).await.unwrap();
    assert!(matches!(
        &*updates.borrow(),
        Some(Err(Refusal::AuthorityUnavailable))
    ));
    assert!(startup.tasks.stop.load(Ordering::Acquire));
    reject(bounded(startup.acquire()).await, Refusal::Deadline);
    reject(
        startup.decode(Zeroizing::new(f.raw(DRIVER)), now()),
        Refusal::Deadline,
    );
    bounded(startup.retire()).await.unwrap();
    joined(&startup.tasks);
    assert!(startup.material.borrow().is_none());
}
#[tokio::test]
async fn acquisition_refuses_material_that_expired_after_valid_decode() {
    let (_source, startup) = peer();
    let expired = MaterialFixture::until(DRIVER, 2026, 2028);
    // Real material was valid at the historical decode instant. Acquisition
    // independently checks current time instead of trusting that old success.
    let value = decode_material(
        &expired.raw(DRIVER),
        &selectors(),
        sample(date_time_ymd(2025, 6, 1).unix_timestamp() as u64),
        &AtomicBool::new(false),
    )
    .unwrap();
    startup.material.send_replace(Some(Ok(Arc::new(value))));
    reject(bounded(startup.acquire()).await, Refusal::Tls);
    assert!(startup.tasks.stop.load(Ordering::Acquire));
    bounded(startup.retire()).await.unwrap();
    joined(&startup.tasks);
}
#[test]
fn absent_runtime_refuses_registration_before_calling_spawn_factory() {
    let owner = TaskOwner::new();
    let created = AtomicBool::new(false);
    reject(
        owner.register(|| {
            created.store(true, Ordering::SeqCst);
            tokio::spawn(async {})
        }),
        Refusal::Configuration,
    );
    assert!(!created.load(Ordering::SeqCst));
    assert!(owner.registry.lock().unwrap().tasks.is_empty());
}

// Real UDS/HTTP2 peers below remain synthetic protected-profile providers.
use std::{
    convert::Infallible,
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
    sync::mpsc,
};
use tonic::codegen::Service;

#[derive(Default)]
struct Signal {
    count: AtomicUsize,
    changed: Notify,
}
impl Signal {
    fn mark(&self) {
        self.count.fetch_add(1, Ordering::AcqRel);
        self.changed.notify_one();
    }
    async fn reached(&self, count: usize) {
        while self.count.load(Ordering::Acquire) < count {
            self.changed.notified().await;
        }
    }
}
struct SocketFixture {
    directory: PathBuf,
    path: PathBuf,
    uid: u32,
}
impl SocketFixture {
    fn new() -> (Self, UnixListener) {
        let root = std::env::var_os("OCE_MEDIATION_TEST_SCRATCH")
            .or_else(|| std::env::var_os("HOME"))
            .expect("protected test scratch");
        let directory = PathBuf::from(root).join(format!(
            "identity-test-{}",
            crate::broker_rpc::random_ref().unwrap()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let path = directory.join("peer.sock");
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let uid = std::fs::metadata(&path).unwrap().uid();
        crate::broker_rpc::protected_path(&path, uid, &[0, uid]).unwrap();
        (
            Self {
                directory,
                path,
                uid,
            },
            listener,
        )
    }
    fn captured(&self) -> (watch::Sender<bool>, CapturedDriverProfile) {
        let (source, invalidated) = watch::channel(false);
        let mut selected = selectors();
        selected.workload_api_socket = self.path.clone();
        selected.workload_api_peer_uid = self.uid;
        selected.trusted_ancestor_uids = vec![0, self.uid];
        (
            source,
            CapturedDriverProfile {
                selectors: selected,
                invalidated,
            },
        )
    }
}
impl Drop for SocketFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.directory);
    }
}
#[tokio::test]
async fn connector_clone_has_one_actual_protected_socket_allowance() {
    let (socket, listener) = SocketFixture::new();
    let (_source, profile) = socket.captured();
    let startup = IdentityStartup::new(profile).unwrap();
    let mut connector = OneUseConnector::new(startup.clone());
    let mut second = connector.clone();
    let connected = bounded(connector.call("http://localhost/".parse().unwrap()))
        .await
        .unwrap();
    let (accepted, _) = bounded(listener.accept()).await.unwrap();
    assert!(bounded(second.call("http://localhost/".parse().unwrap()))
        .await
        .is_err());
    assert!(startup.tasks.stop.load(Ordering::Acquire));
    drop(connected);
    drop(accepted);
    let mut extra = Box::pin(listener.accept());
    pending(extra.as_mut()).await;
    drop(extra);
    bounded(startup.retire()).await.unwrap();
    joined(&startup.tasks);
}
#[tokio::test]
async fn connector_dropped_unpolled_call_never_restores_dial_permission() {
    let (socket, listener) = SocketFixture::new();
    let (_source, profile) = socket.captured();
    let startup = IdentityStartup::new(profile).unwrap();
    let mut connector = OneUseConnector::new(startup.clone());
    let mut second = connector.clone();
    let first = connector.call("http://localhost/".parse().unwrap());
    assert!(connector.used.load(Ordering::Acquire));
    drop(first);
    assert!(bounded(second.call("http://localhost/".parse().unwrap()))
        .await
        .is_err());
    let mut accept = Box::pin(listener.accept());
    pending(accept.as_mut()).await;
    drop(accept);
    bounded(startup.retire()).await.unwrap();
    joined(&startup.tasks);
}
#[tokio::test]
async fn connector_rejects_unselected_uri_before_socket_access() {
    for uri in [
        "https://localhost/",
        "http://other.test/",
        "http://localhost/other",
        "http://localhost/?route=other",
    ] {
        let (socket, listener) = SocketFixture::new();
        let (_source, profile) = socket.captured();
        let startup = IdentityStartup::new(profile).unwrap();
        let mut connector = OneUseConnector::new(startup.clone());
        assert!(bounded(connector.call(uri.parse().unwrap())).await.is_err());
        assert!(connector.used.load(Ordering::Acquire));
        let mut accept = Box::pin(listener.accept());
        pending(accept.as_mut()).await;
        drop(accept);
        bounded(startup.retire()).await.unwrap();
        joined(&startup.tasks);
    }
}
#[tokio::test]
async fn connector_failed_path_check_consumes_allowance_even_after_repair() {
    let (socket, listener) = SocketFixture::new();
    let (_source, profile) = socket.captured();
    let startup = IdentityStartup::new(profile).unwrap();
    let mut connector = OneUseConnector::new(startup.clone());
    let mut retry = connector.clone();
    std::fs::set_permissions(&socket.path, std::fs::Permissions::from_mode(0o666)).unwrap();
    assert!(
        bounded(connector.call("http://localhost/".parse().unwrap()))
            .await
            .is_err()
    );
    std::fs::set_permissions(&socket.path, std::fs::Permissions::from_mode(0o600)).unwrap();
    crate::broker_rpc::protected_path(&socket.path, socket.uid, &[0, socket.uid]).unwrap();
    assert!(bounded(retry.call("http://localhost/".parse().unwrap()))
        .await
        .is_err());
    let mut accept = Box::pin(listener.accept());
    pending(accept.as_mut()).await;
    drop(accept);
    bounded(startup.retire()).await.unwrap();
    joined(&startup.tasks);
}
#[tokio::test]
async fn connector_rejects_wrong_selected_uid_and_symlink_socket() {
    for symlink in [false, true] {
        let (socket, listener) = SocketFixture::new();
        let (_source, mut profile) = socket.captured();
        let link = socket.directory.join("alias.sock");
        if symlink {
            std::os::unix::fs::symlink(&socket.path, &link).unwrap();
            profile.selectors.workload_api_socket = link.clone();
        } else {
            profile.selectors.workload_api_peer_uid = socket.uid.wrapping_add(1);
        }
        let startup = IdentityStartup::new(profile).unwrap();
        let mut connector = OneUseConnector::new(startup.clone());
        assert!(
            bounded(connector.call("http://localhost/".parse().unwrap()))
                .await
                .is_err()
        );
        let mut accept = Box::pin(listener.accept());
        pending(accept.as_mut()).await;
        drop(accept);
        bounded(startup.retire()).await.unwrap();
        joined(&startup.tasks);
        if symlink {
            std::fs::remove_file(link).unwrap();
        }
    }
}

struct PeerBody {
    frames: mpsc::Receiver<Frame<Bytes>>,
    waiting: Arc<Signal>,
    dropped: Arc<Signal>,
}
impl Body for PeerBody {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        match self.frames.poll_recv(cx) {
            Poll::Ready(next) => Poll::Ready(next.map(Ok)),
            Poll::Pending => {
                self.waiting.mark();
                Poll::Pending
            }
        }
    }
}
impl Drop for PeerBody {
    fn drop(&mut self) {
        self.dropped.mark();
    }
}
struct WorkloadPeer {
    socket: SocketFixture,
    tasks: TaskOwner,
    send: mpsc::Sender<Frame<Bytes>>,
    accepted: Arc<Signal>,
    requested: Arc<Signal>,
    closed: Arc<Signal>,
    waiting: Arc<Signal>,
    dropped: Arc<Signal>,
    headers: Arc<Notify>,
}
impl WorkloadPeer {
    fn new(hold_headers: bool) -> Self {
        let (socket, listener) = SocketFixture::new();
        let tasks = TaskOwner::new();
        let (send, receive) = mpsc::channel(4);
        let receive = Arc::new(Mutex::new(Some(receive)));
        let accepted = Arc::new(Signal::default());
        let requested = Arc::new(Signal::default());
        let closed = Arc::new(Signal::default());
        let waiting = Arc::new(Signal::default());
        let dropped = Arc::new(Signal::default());
        let headers = Arc::new(Notify::new());
        let connections = accepted.clone();
        let requests = requested.clone();
        let completion = closed.clone();
        let body_waiting = waiting.clone();
        let body_drop = dropped.clone();
        let release = headers.clone();
        let owner = tasks.clone();
        tasks
            .register(|| {
                tokio::spawn(async move {
                    loop {
                        let (stream, _) = listener.accept().await.unwrap();
                        connections.mark();
                        let receive = receive.clone();
                        let requests = requests.clone();
                        let completion = completion.clone();
                        let body_waiting = body_waiting.clone();
                        let body_drop = body_drop.clone();
                        let release = release.clone();
                        let executor = owner.clone();
                        owner
                            .register(|| {
                                tokio::spawn(async move {
                                    let service = hyper::service::service_fn(
                                        move |request: http::Request<hyper::body::Incoming>| {
                                            let receive = receive.clone();
                                            let requests = requests.clone();
                                            let release = release.clone();
                                            let body_waiting = body_waiting.clone();
                                            let body_drop = body_drop.clone();
                                            async move {
                                                assert_eq!(request.method(), http::Method::POST);
                                                assert_eq!(request.uri().path(), WORKLOAD_METHOD);
                                                assert_eq!(
                                                    request.headers()["workload.spiffe.io"],
                                                    "true"
                                                );
                                                assert_eq!(
                                                    request.headers()["content-type"],
                                                    "application/grpc"
                                                );
                                                assert!(request
                                                    .headers()
                                                    .get("authorization")
                                                    .is_none());
                                                let mut body = request.into_body();
                                                let mut raw = Vec::new();
                                                while let Some(part) =
                                                    http_body_util::BodyExt::frame(&mut body).await
                                                {
                                                    let frame = part.unwrap();
                                                    if let Ok(data) = frame.into_data() {
                                                        raw.extend_from_slice(&data);
                                                    }
                                                    assert!(raw.len() <= 5);
                                                }
                                                assert_eq!(raw, [0, 0, 0, 0, 0]);
                                                requests.mark();
                                                if hold_headers {
                                                    release.notified().await;
                                                }
                                                let frames = receive
                                                    .lock()
                                                    .unwrap()
                                                    .take()
                                                    .expect("only one Workload API request");
                                                Ok::<_, Infallible>(
                                                    http::Response::builder()
                                                        .status(200)
                                                        .header("content-type", "application/grpc")
                                                        .body(PeerBody {
                                                            frames,
                                                            waiting: body_waiting,
                                                            dropped: body_drop,
                                                        })
                                                        .unwrap(),
                                                )
                                            }
                                        },
                                    );
                                    let _ = hyper::server::conn::http2::Builder::new(executor)
                                        .serve_connection(
                                            hyper_util::rt::TokioIo::new(stream),
                                            service,
                                        )
                                        .await;
                                    completion.mark();
                                })
                            })
                            .unwrap();
                    }
                })
            })
            .unwrap();
        Self {
            socket,
            tasks,
            send,
            accepted,
            requested,
            closed,
            waiting,
            dropped,
            headers,
        }
    }
    fn begin(&self) -> (watch::Sender<bool>, Arc<IdentityStartup>) {
        let (source, profile) = self.socket.captured();
        (source, IdentityStartup::begin(profile).unwrap())
    }
    async fn response(&self, raw: &[u8]) {
        bounded(self.send.send(Frame::data(Bytes::from(frame(raw)))))
            .await
            .unwrap();
    }
    async fn end(&self) {
        let mut headers = http::HeaderMap::new();
        headers.insert("grpc-status", "0".parse().unwrap());
        bounded(self.send.send(Frame::trailers(headers)))
            .await
            .unwrap();
    }
    async fn finish(self) {
        bounded(self.tasks.retire()).await.unwrap();
        joined(&self.tasks);
    }
}
#[tokio::test]
async fn actual_workload_http2_request_renews_one_stream_and_same_original_material() {
    let peer = WorkloadPeer::new(false);
    let (_source, startup) = peer.begin();
    bounded(peer.requested.reached(1)).await;
    let fixture = MaterialFixture::new(DRIVER);
    peer.response(&fixture.raw(DRIVER)).await;
    let original = bounded(startup.acquire_identity()).await.unwrap();
    let mut updates = startup.material.subscribe();
    peer.response(&fixture.raw(DRIVER)).await;
    bounded(updates.changed()).await.unwrap();
    let renewed = bounded(startup.acquire_identity()).await.unwrap();
    assert!(Arc::ptr_eq(&original.material, &renewed.material));
    assert_eq!(original.material.expires, renewed.material.expires);
    assert_eq!(peer.accepted.count.load(Ordering::Acquire), 1);
    assert_eq!(peer.requested.count.load(Ordering::Acquire), 1);
    let mut loss = Box::pin(original.loss());
    pending(loss.as_mut()).await;
    drop(loss);
    bounded(startup.retire()).await.unwrap();
    joined(&startup.tasks);
    bounded(peer.closed.reached(1)).await;
    assert!(startup.material.borrow().is_none());
    peer.finish().await;
}
#[tokio::test]
async fn actual_workload_bad_updates_and_eof_invalidate_original_without_reconnect() {
    for bad in [None, Some(vec![10]), Some(fld(2, &[])), Some(fld(3, &[]))] {
        let peer = WorkloadPeer::new(false);
        let (_source, startup) = peer.begin();
        let fixture = MaterialFixture::new(DRIVER);
        peer.response(&fixture.raw(DRIVER)).await;
        let original = bounded(startup.acquire_identity()).await.unwrap();
        if let Some(raw) = bad {
            peer.response(&raw).await;
        } else {
            peer.end().await;
        }
        let _ = bounded(original.loss()).await;
        assert!(startup.tasks.stop.load(Ordering::Acquire));
        assert!(startup.live(&original.material).is_err());
        assert!(bounded(startup.acquire()).await.is_err());
        bounded(startup.retire()).await.unwrap();
        joined(&startup.tasks);
        bounded(peer.closed.reached(1)).await;
        assert_eq!(peer.accepted.count.load(Ordering::Acquire), 1);
        assert_eq!(peer.requested.count.load(Ordering::Acquire), 1);
        peer.finish().await;
    }
}
#[tokio::test]
async fn actual_workload_changed_generation_withdrawal_and_source_loss_are_terminal() {
    for cause in 0..3 {
        let peer = WorkloadPeer::new(false);
        let (source, startup) = peer.begin();
        let fixture = MaterialFixture::new(DRIVER);
        peer.response(&fixture.raw(DRIVER)).await;
        let original = bounded(startup.acquire_identity()).await.unwrap();
        match cause {
            0 => {
                peer.response(&MaterialFixture::new(DRIVER).raw(DRIVER))
                    .await
            }
            1 => {
                source.send_replace(true);
            }
            _ => drop(source),
        }
        let _ = bounded(original.loss()).await;
        assert!(startup.tasks.stop.load(Ordering::Acquire));
        assert!(broker_tls(&startup, original.material.clone()).is_err());
        bounded(startup.retire()).await.unwrap();
        joined(&startup.tasks);
        bounded(peer.closed.reached(1)).await;
        assert_eq!(peer.accepted.count.load(Ordering::Acquire), 1);
        peer.finish().await;
    }
}
#[tokio::test]
async fn actual_workload_retire_joins_while_headers_or_idle_response_are_pending() {
    for hold_headers in [true, false] {
        let peer = WorkloadPeer::new(hold_headers);
        let (_source, startup) = peer.begin();
        bounded(peer.requested.reached(1)).await;
        if !hold_headers {
            peer.response(&MaterialFixture::new(DRIVER).raw(DRIVER))
                .await;
            bounded(startup.acquire()).await.unwrap();
            bounded(peer.waiting.reached(1)).await;
        }
        bounded(startup.retire()).await.unwrap();
        joined(&startup.tasks);
        assert!(startup.tasks.registry.lock().unwrap().sealed);
        peer.headers.notify_one();
        bounded(peer.closed.reached(1)).await;
        if !hold_headers {
            bounded(peer.dropped.reached(1)).await;
        }
        assert_eq!(peer.accepted.count.load(Ordering::Acquire), 1);
        peer.finish().await;
    }
}
#[tokio::test]
async fn actual_registered_http2_handshake_cancellation_closes_accepted_uds() {
    let (socket, listener) = SocketFixture::new();
    let entered = Arc::new(Signal::default());
    let closed = Arc::new(Signal::default());
    let entry = entered.clone();
    let closure = closed.clone();
    let peer = tokio::spawn(async move {
        let (mut connection, _) = listener.accept().await.unwrap();
        let mut preface = [0; 24];
        connection.read_exact(&mut preface).await.unwrap();
        assert_eq!(&preface, b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
        entry.mark();
        let mut data = [0; 4096];
        while connection.read(&mut data).await.unwrap() != 0 {}
        closure.mark();
    });
    let (_source, profile) = socket.captured();
    let startup = IdentityStartup::begin(profile).unwrap();
    bounded(entered.reached(1)).await;
    bounded(startup.retire()).await.unwrap();
    joined(&startup.tasks);
    bounded(closed.reached(1)).await;
    bounded(peer).await.unwrap();
    assert!(startup.tasks.registry.lock().unwrap().sealed);
}

#[derive(Clone, Copy, Debug)]
enum BrokerFault {
    None,
    WrongUri,
    MissingUri,
    DnsOnly,
    AdditionalDns,
    Ca,
    CertSign,
    CrlSign,
    NoSignature,
    Expired,
}
struct BrokerFixture {
    driver: MaterialFixture,
    server: Arc<rustls::ServerConfig>,
}
fn spiffe_leaf_params(id: &str) -> CertificateParams {
    let mut params = CertificateParams::default();
    params.is_ca = IsCa::ExplicitNoCa;
    params.subject_alt_names = vec![SanType::URI(id.try_into().unwrap())];
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![
        ExtendedKeyUsagePurpose::ServerAuth,
        ExtendedKeyUsagePurpose::ClientAuth,
    ];
    params.not_before = date_time_ymd(2025, 1, 1);
    params.not_after = date_time_ymd(4090, 1, 1);
    params
}
impl BrokerFixture {
    fn new(fault: BrokerFault) -> Self {
        let mut ca = CertificateParams::default();
        ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign];
        ca.not_before = date_time_ymd(2025, 1, 1);
        ca.not_after = date_time_ymd(4091, 1, 1);
        let root_key = KeyPair::generate().unwrap();
        let root = ca.self_signed(&root_key).unwrap();
        let issuer = Issuer::new(ca, root_key);
        let driver_key = KeyPair::generate().unwrap();
        let driver = spiffe_leaf_params(DRIVER)
            .signed_by(&driver_key, &issuer)
            .unwrap();
        let mut params = spiffe_leaf_params(BROKER);
        match fault {
            BrokerFault::None => {}
            BrokerFault::WrongUri => {
                params.subject_alt_names = vec![SanType::URI(
                    "spiffe://example.test/other".try_into().unwrap(),
                )]
            }
            BrokerFault::MissingUri => params.subject_alt_names.clear(),
            BrokerFault::DnsOnly => {
                params.subject_alt_names =
                    vec![SanType::DnsName("unrelated-dns.test".try_into().unwrap())]
            }
            BrokerFault::AdditionalDns => params
                .subject_alt_names
                .push(SanType::DnsName("unrelated-dns.test".try_into().unwrap())),
            BrokerFault::Ca => params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained),
            BrokerFault::CertSign => params.key_usages.push(KeyUsagePurpose::KeyCertSign),
            BrokerFault::CrlSign => params.key_usages.push(KeyUsagePurpose::CrlSign),
            BrokerFault::NoSignature => params.key_usages = vec![KeyUsagePurpose::KeyEncipherment],
            BrokerFault::Expired => params.not_after = date_time_ymd(2026, 1, 1),
        }
        let broker_key = KeyPair::generate().unwrap();
        let broker = params.signed_by(&broker_key, &issuer).unwrap();
        let mut roots = RootCertStore::empty();
        roots.add(root.der().clone()).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = rustls::server::WebPkiClientVerifier::builder_with_provider(
            Arc::new(roots),
            provider.clone(),
        )
        .build()
        .unwrap();
        let mut server = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_client_cert_verifier(verifier)
            .with_single_cert(
                vec![broker.der().clone()],
                PrivateKeyDer::Pkcs8(broker_key.serialize_der().into()),
            )
            .unwrap();
        server.alpn_protocols = vec![PUBLICATION_ALPN.to_vec()];
        Self {
            driver: MaterialFixture {
                chain: driver.der().to_vec(),
                key: driver_key.serialize_der(),
                bundle: root.der().to_vec(),
            },
            server: Arc::new(server),
        }
    }
    async fn identity(&self) -> (watch::Sender<bool>, Arc<IdentityStartup>, DriverIdentity) {
        let (source, startup) = peer();
        startup
            .decode(Zeroizing::new(self.driver.raw(DRIVER)), now())
            .unwrap();
        let identity = bounded(startup.acquire_identity()).await.unwrap();
        (source, startup, identity)
    }
}
struct TlsView {
    peer: Vec<u8>,
    alpn: Option<Vec<u8>>,
    kind: Option<rustls::HandshakeKind>,
    sni: Option<String>,
}
async fn mutual_exchange(
    client: Arc<rustls::ClientConfig>,
    server: Arc<rustls::ServerConfig>,
) -> (std::io::Result<TlsView>, std::io::Result<TlsView>) {
    let (client_io, server_io) = tokio::io::duplex(65536);
    let client = async move {
        let connector = tokio_rustls::TlsConnector::from(client);
        let name = rustls_pki_types::ServerName::try_from("unrelated-dns.test").unwrap();
        let mut stream = connector.connect(name, client_io).await?;
        stream.write_all(b"request").await?;
        stream.flush().await?;
        let mut reply = [0; 4];
        stream.read_exact(&mut reply).await?;
        assert_eq!(&reply, b"done");
        let session = stream.get_ref().1;
        Ok::<_, std::io::Error>(TlsView {
            peer: session.peer_certificates().unwrap()[0].to_vec(),
            alpn: session.alpn_protocol().map(<[u8]>::to_vec),
            kind: session.handshake_kind(),
            sni: None,
        })
    };
    let server = async move {
        let mut stream = tokio_rustls::TlsAcceptor::from(server)
            .accept(server_io)
            .await?;
        let mut request = [0; 7];
        stream.read_exact(&mut request).await?;
        assert_eq!(&request, b"request");
        stream.write_all(b"done").await?;
        stream.flush().await?;
        let session = stream.get_ref().1;
        Ok::<_, std::io::Error>(TlsView {
            peer: session.peer_certificates().unwrap()[0].to_vec(),
            alpn: session.alpn_protocol().map(<[u8]>::to_vec),
            kind: session.handshake_kind(),
            sni: session.server_name().map(str::to_owned),
        })
    };
    // Both real TLS futures finish in this scope, including either failure.
    bounded(async { tokio::join!(client, server) }).await
}
#[tokio::test]
async fn broker_uri_mtls_uses_original_driver_and_never_resumes_or_uses_dns() {
    let fixture = BrokerFixture::new(BrokerFault::None);
    let (_source, startup, identity) = fixture.identity().await;
    assert!(!identity.broker_tls.enable_sni);
    assert!(!identity.broker_tls.enable_early_data);
    assert_eq!(
        identity.broker_tls.alpn_protocols,
        [PUBLICATION_ALPN.to_vec()]
    );
    for _ in 0..2 {
        let (client, server) =
            mutual_exchange(identity.broker_tls.clone(), fixture.server.clone()).await;
        let client = client.unwrap();
        let server = server.unwrap();
        assert_eq!(server.peer, fixture.driver.chain);
        assert_eq!(client.alpn.as_deref(), Some(PUBLICATION_ALPN));
        assert_eq!(server.alpn.as_deref(), Some(PUBLICATION_ALPN));
        assert!(server.sni.is_none());
        assert!(matches!(
            client.kind,
            Some(rustls::HandshakeKind::Full | rustls::HandshakeKind::FullWithHelloRetryRequest)
        ));
        assert!(matches!(
            server.kind,
            Some(rustls::HandshakeKind::Full | rustls::HandshakeKind::FullWithHelloRetryRequest)
        ));
    }
    bounded(identity.retire()).await.unwrap();
    joined(&startup.tasks);
}
#[tokio::test]
async fn broker_tls_refuses_wrong_or_missing_uri_non_svid_leaf_and_expiry() {
    for fault in [
        BrokerFault::WrongUri,
        BrokerFault::MissingUri,
        BrokerFault::DnsOnly,
        BrokerFault::AdditionalDns,
        BrokerFault::Ca,
        BrokerFault::CertSign,
        BrokerFault::CrlSign,
        BrokerFault::NoSignature,
        BrokerFault::Expired,
    ] {
        let fixture = BrokerFixture::new(fault);
        let (_source, startup, identity) = fixture.identity().await;
        let (client, _) =
            mutual_exchange(identity.broker_tls.clone(), fixture.server.clone()).await;
        assert!(client.is_err(), "broker fault accepted: {fault:?}");
        bounded(identity.retire()).await.unwrap();
        joined(&startup.tasks);
    }
}
#[tokio::test]
async fn broker_tls_refuses_untrusted_peer_and_equal_but_unowned_material() {
    let fixture = BrokerFixture::new(BrokerFault::None);
    let untrusted = BrokerFixture::new(BrokerFault::None);
    let (_source, startup, identity) = fixture.identity().await;
    let (client, _) = mutual_exchange(identity.broker_tls.clone(), untrusted.server).await;
    assert!(client.is_err());
    let copy = Arc::new(
        decode_material(
            &fixture.driver.raw(DRIVER),
            &selectors(),
            now(),
            &AtomicBool::new(false),
        )
        .unwrap(),
    );
    assert_eq!(copy.generation, identity.material.generation);
    reject(broker_tls(&startup, copy), Refusal::AuthorityUnavailable);
    bounded(identity.retire()).await.unwrap();
    joined(&startup.tasks);
}
#[tokio::test]
async fn already_issued_broker_tls_refuses_withdrawal_cancel_and_original_owner_loss() {
    for cause in 0..3 {
        let fixture = BrokerFixture::new(BrokerFault::None);
        let (source, startup, identity) = fixture.identity().await;
        let config = identity.broker_tls.clone();
        match cause {
            0 => {
                source.send_replace(true);
            }
            1 => identity.cancel(),
            _ => {
                bounded(identity.retire()).await.unwrap();
                joined(&startup.tasks);
                drop(identity);
                drop(startup);
                let (client, _) = mutual_exchange(config, fixture.server).await;
                assert!(client.is_err());
                continue;
            }
        }
        let (client, _) = mutual_exchange(config, fixture.server).await;
        assert!(client.is_err());
        bounded(identity.retire()).await.unwrap();
        joined(&startup.tasks);
    }
}
#[tokio::test]
async fn monotonic_expiry_refuses_live_identity_and_loss_even_with_future_wall_expiry() {
    let (_source, startup) = peer();
    let fixture = MaterialFixture::new(DRIVER);
    let mut material = decode_material(
        &fixture.raw(DRIVER),
        &selectors(),
        now(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(material.valid_until > UnixTime::now().as_secs());
    // Private synthetic expired-clock peer; no production constructor or hook.
    material.expires = tokio::time::Instant::now();
    let material = Arc::new(material);
    startup.material.send_replace(Some(Ok(material.clone())));
    reject(startup.live(&material), Refusal::Tls);
    assert_eq!(bounded(startup.loss()).await, Refusal::Tls);
    bounded(startup.retire()).await.unwrap();
    joined(&startup.tasks);
}
#[tokio::test]
async fn actual_broker_channel_refuses_absent_alpn_after_successful_mtls() {
    let fixture = BrokerFixture::new(BrokerFault::None);
    let (socket, listener) = SocketFixture::new();
    let server_name = rustls_pki_types::ServerName::try_from("unrelated-dns.test").unwrap();
    let mut server = (*fixture.server).clone();
    server.alpn_protocols.clear();
    // Isolate the ALPN check from post-handshake ticket writes after client refusal.
    server.send_tls13_tickets = 0;
    server.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    let (_source, startup, identity) = fixture.identity().await;
    let mut peer = tokio::spawn(async move {
        let (connection, _) = listener.accept().await?;
        let stream = tokio_rustls::TlsAcceptor::from(Arc::new(server))
            .accept(connection)
            .await?;
        Ok::<_, std::io::Error>((
            stream.get_ref().1.alpn_protocol().is_none(),
            stream
                .get_ref()
                .1
                .peer_certificates()
                .is_some_and(|chain| !chain.is_empty()),
        ))
    });
    let config = crate::broker_rpc::BrokerConfig {
        socket_path: socket.path.clone(),
        peer_uid: socket.uid,
        trusted_ancestor_uids: vec![0, socket.uid],
        server_name,
        tls: identity.broker_tls.clone(),
        call_timeout: Duration::from_secs(2),
        check_interval: Duration::from_millis(20),
        max_clock_skew: Duration::from_millis(20),
    };
    let validated = config.validate_for(PUBLICATION_ALPN);
    // Retain every result until cleanup. Even unexpected client success drops its
    // actual channel before joining the peer, while preserving that success as a failure.
    let client = tokio::time::timeout(
        Duration::from_secs(5),
        crate::broker_rpc::Channel::connect_for(
            &config,
            tokio::time::Instant::now() + Duration::from_secs(3),
            PUBLICATION_ALPN,
        ),
    )
    .await
    .map(|result| result.map(drop));
    if client.is_err() {
        peer.abort();
    }
    let (peer_expired, peer_result) =
        match tokio::time::timeout(Duration::from_secs(5), &mut peer).await {
            Ok(result) => (false, result),
            Err(_) => {
                peer.abort();
                (true, peer.await)
            }
        };
    // Cancellation is followed by the real join; no timeout/drop substitutes for
    // external-peer settlement or original identity/task-owner retirement.
    let retired = identity.retire().await;
    joined(&startup.tasks);
    retired.expect("original identity retirement failed");
    validated.expect("fixture broker configuration rejected");
    assert!(
        !peer_expired,
        "external TLS peer deadline expired after cleanup"
    );
    reject(
        client.expect("client deadline expired after cleanup"),
        Refusal::Tls,
    );
    let (absent_alpn, peer_certificates) = peer_result
        .expect("external TLS peer task failed")
        .expect("external server mTLS acceptance failed");
    assert!(absent_alpn);
    assert!(peer_certificates);
}

#[tokio::test(flavor = "current_thread")]
async fn entered_registered_real_dial_is_dropped_and_joined_on_retire() {
    let (socket, listener) = SocketFixture::new();
    let (_source, profile) = socket.captured();
    let startup = IdentityStartup::new(profile).unwrap();
    let entered = Arc::new(Signal::default());
    let entry = entered.clone();
    let release = Arc::new(Notify::new());
    let held = release.clone();
    let mut connector = OneUseConnector::new(startup.clone());
    let mut dial = connector.call("http://localhost/".parse().unwrap());
    startup
        .tasks
        .register(|| {
            tokio::spawn(async move {
                // A fresh Tokio UnixStream awaits reactor write readiness after the
                // real connect syscall. Retain that same entered future at this gate.
                pending(dial.as_mut()).await;
                entry.mark();
                held.notified().await;
                let _ = dial.await;
            })
        })
        .unwrap();
    bounded(entered.reached(1)).await;
    let (mut accepted, _) = bounded(listener.accept()).await.unwrap();
    bounded(startup.retire()).await.unwrap();
    joined(&startup.tasks);
    let mut byte = [0];
    assert_eq!(bounded(accepted.read(&mut byte)).await.unwrap(), 0);
    assert!(connector.used.load(Ordering::Acquire));
    assert!(startup.tasks.registry.lock().unwrap().sealed);
}
