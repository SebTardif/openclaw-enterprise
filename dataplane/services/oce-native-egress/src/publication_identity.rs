//! Bounded nonfederated Workload API decoding and retained identity startup.
//! Decoded selectors/material are not publication authority. The protected
//! profile provider and actual one-connection acquisition are separate owners.
use crate::Refusal;
use bytes::Buf;
use rustls::{sign::CertifiedKey, RootCertStore};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, UnixTime};
use spiffe::{SpiffeId, X509Bundle, X509Svid};
use std::{
    collections::BTreeSet,
    future::Future,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    sync::{watch, Mutex as AsyncMutex},
    task::JoinHandle,
};
use tonic::{
    codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder},
    Status,
};
use zeroize::Zeroizing;

pub(crate) const RESPONSE_BYTES: usize = 1_048_576;
const SVIDS: usize = 8;
const FIELDS: usize = 4096;
const ID_BYTES: usize = 2048;
const HINT_BYTES: usize = 256;
const CHAIN_BYTES: usize = 65536;
const KEY_BYTES: usize = 16384;
const BUNDLE_BYTES: usize = 131072;
const CHAIN_CERTS: usize = 16;
const AUTHORITIES: usize = 64;
const CERT_BYTES: usize = 16384;
const TASKS: usize = 64;

/// Original protected-provider comparison fields. No PEM, provider credential,
/// caller TLS configuration, verifier or allow callback belongs in this record.
#[derive(Clone)]
pub struct DriverProfileSelectors {
    pub profile_ref: String,
    pub source_revision: u64,
    pub workload_api_socket: PathBuf,
    pub workload_api_peer_uid: u32,
    pub trusted_ancestor_uids: Vec<u32>,
    pub driver_spiffe_id: String,
    pub broker_spiffe_id: String,
    pub trust_domain: String,
}
impl DriverProfileSelectors {
    fn validate(&self) -> Result<(), Refusal> {
        crate::broker_rpc::reference(&self.profile_ref)?;
        if self.source_revision == 0
            || self.workload_api_socket.as_os_str().len() > 4096
            || !self.workload_api_socket.is_absolute()
            || self.trusted_ancestor_uids.is_empty()
            || self.trusted_ancestor_uids.len() > 8
            || self.workload_api_socket.components().any(|v| {
                matches!(
                    v,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
            || self.driver_spiffe_id.len() > ID_BYTES
            || self.broker_spiffe_id.len() > ID_BYTES
            || self.trust_domain.len() > ID_BYTES
        {
            return Err(Refusal::Configuration);
        }
        let driver = SpiffeId::new(&self.driver_spiffe_id).map_err(|_| Refusal::Configuration)?;
        let broker = SpiffeId::new(&self.broker_spiffe_id).map_err(|_| Refusal::Configuration)?;
        if driver.to_string() != self.driver_spiffe_id
            || broker.to_string() != self.broker_spiffe_id
            || driver == broker
            || driver.trust_domain().as_ref() != self.trust_domain
            || broker.trust_domain() != driver.trust_domain()
        {
            return Err(Refusal::Configuration);
        }
        Ok(())
    }
}

/// Captured ONCE from the genuine original protected profile source. Fields and
/// construction are private; there is no production from-parts/fixture/allow API.
/// The original provider must retain its source lifetime and invalidate this
/// receiver on withdrawal, revision change, cancellation or source loss. Its
/// production capture/join integration is not implemented by this first chunk.
pub struct CapturedDriverProfile {
    selectors: DriverProfileSelectors,
    invalidated: watch::Receiver<bool>,
}
impl CapturedDriverProfile {
    pub fn inspect(&self) -> &DriverProfileSelectors {
        &self.selectors
    }
    fn current(&self) -> Result<(), Refusal> {
        if *self.invalidated.borrow() || self.invalidated.has_changed().is_err() {
            Err(Refusal::AuthorityUnavailable)
        } else {
            Ok(())
        }
    }
}

/// The real empty X509SVIDRequest and one complete bounded protobuf response.
/// Tonic also MUST receive max_decoding_message_size(RESPONSE_BYTES) before any
/// RPC; its length guard then precedes its internal message buffer allocation.
pub(crate) struct RawWorkloadCodec;
pub(crate) struct RawEncoder;
pub(crate) struct RawDecoder;
impl Codec for RawWorkloadCodec {
    type Encode = ();
    type Decode = Zeroizing<Vec<u8>>;
    type Encoder = RawEncoder;
    type Decoder = RawDecoder;
    fn encoder(&mut self) -> RawEncoder {
        RawEncoder
    }
    fn decoder(&mut self) -> RawDecoder {
        RawDecoder
    }
}
impl Encoder for RawEncoder {
    type Item = ();
    type Error = Status;
    fn encode(&mut self, _: (), _: &mut EncodeBuf<'_>) -> Result<(), Status> {
        Ok(())
    }
}
impl Decoder for RawDecoder {
    type Item = Zeroizing<Vec<u8>>;
    type Error = Status;
    fn decode(&mut self, source: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Status> {
        let count = source.remaining();
        if count > RESPONSE_BYTES {
            return Err(Status::resource_exhausted("identity response bounds"));
        }
        let mut bytes = Zeroizing::new(Vec::new());
        bytes
            .try_reserve_exact(count)
            .map_err(|_| Status::resource_exhausted("identity response bounds"))?;
        bytes.resize(count, 0);
        source.copy_to_slice(&mut bytes);
        Ok(Some(bytes))
    }
}

fn current(stop: &AtomicBool) -> Result<(), Refusal> {
    if stop.load(Ordering::Acquire) {
        Err(Refusal::Deadline)
    } else {
        Ok(())
    }
}
fn varint(bytes: &[u8], offset: &mut usize) -> Result<u64, Refusal> {
    let mut value = 0u64;
    for index in 0..10 {
        let b = *bytes.get(*offset).ok_or(Refusal::Protocol)?;
        *offset += 1;
        if index == 9 && b > 1 {
            return Err(Refusal::Protocol);
        }
        value |= u64::from(b & 127) << (7 * index);
        if b & 128 == 0 {
            if index != 0 && b == 0 {
                return Err(Refusal::Protocol);
            }
            return Ok(value);
        }
    }
    Err(Refusal::Protocol)
}
fn field<'a>(
    bytes: &'a [u8],
    offset: &mut usize,
    count: &mut usize,
    top: bool,
    stop: &AtomicBool,
) -> Result<(u64, &'a [u8]), Refusal> {
    current(stop)?;
    *count = count
        .checked_add(1)
        .filter(|n| *n <= FIELDS)
        .ok_or(Refusal::Bounds)?;
    let key = varint(bytes, offset)?;
    let number = key >> 3;
    // Even an empty or otherwise malformed CRL/federation occurrence refuses.
    if top && matches!(number, 2 | 3) {
        return Err(Refusal::Unsupported);
    }
    if key & 7 != 2 || number == 0 || number > 0x1fff_ffff {
        return Err(Refusal::Protocol);
    }
    let length = usize::try_from(varint(bytes, offset)?).map_err(|_| Refusal::Bounds)?;
    let end = offset
        .checked_add(length)
        .filter(|n| *n <= bytes.len())
        .ok_or(Refusal::Protocol)?;
    let result = &bytes[*offset..end];
    *offset = end;
    Ok((number, result))
}
struct WireSvid<'a> {
    id: &'a str,
    chain: &'a [u8],
    key: &'a [u8],
    bundle: &'a [u8],
}
fn scan<'a>(bytes: &'a [u8], stop: &AtomicBool) -> Result<Vec<WireSvid<'a>>, Refusal> {
    if bytes.is_empty() || bytes.len() > RESPONSE_BYTES {
        return Err(Refusal::Bounds);
    }
    let mut offset = 0;
    let mut count = 0;
    let mut svids = Vec::new();
    let mut identities = BTreeSet::new();
    while offset < bytes.len() {
        let (number, entry) = field(bytes, &mut offset, &mut count, true, stop)?;
        if number != 1 {
            return Err(Refusal::Protocol);
        }
        if svids.len() == SVIDS {
            return Err(Refusal::Bounds);
        }
        let mut cursor = 0;
        let mut fields: [Option<&[u8]>; 5] = [None; 5];
        while cursor < entry.len() {
            let (number, value) = field(entry, &mut cursor, &mut count, false, stop)?;
            let index = usize::try_from(number)
                .ok()
                .and_then(|n| n.checked_sub(1))
                .filter(|n| *n < fields.len())
                .ok_or(Refusal::Protocol)?;
            if fields[index].replace(value).is_some() {
                return Err(Refusal::Protocol);
            }
            let limit = [ID_BYTES, CHAIN_BYTES, KEY_BYTES, BUNDLE_BYTES, HINT_BYTES][index];
            if value.len() > limit {
                return Err(Refusal::Bounds);
            }
        }
        let id = std::str::from_utf8(
            fields[0]
                .filter(|b| !b.is_empty())
                .ok_or(Refusal::Protocol)?,
        )
        .map_err(|_| Refusal::Protocol)?;
        if !identities.insert(id) {
            return Err(Refusal::Protocol);
        }
        if let Some(hint) = fields[4] {
            std::str::from_utf8(hint).map_err(|_| Refusal::Protocol)?;
        }
        svids.push(WireSvid {
            id,
            chain: fields[1]
                .filter(|b| !b.is_empty())
                .ok_or(Refusal::Protocol)?,
            key: fields[2]
                .filter(|b| !b.is_empty())
                .ok_or(Refusal::Protocol)?,
            bundle: fields[3]
                .filter(|b| !b.is_empty())
                .ok_or(Refusal::Protocol)?,
        });
    }
    if svids.is_empty() {
        return Err(Refusal::Protocol);
    }
    Ok(svids)
}

/// Preflight DER sequence lengths/counts before SDK certificate allocations.
fn certificates<'a>(
    bytes: &'a [u8],
    maximum: usize,
    stop: &AtomicBool,
) -> Result<Vec<&'a [u8]>, Refusal> {
    let mut offset = 0;
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    while offset < bytes.len() {
        current(stop)?;
        if out.len() == maximum {
            return Err(Refusal::Bounds);
        }
        let start = offset;
        if bytes.get(offset) != Some(&0x30) {
            return Err(Refusal::Protocol);
        }
        offset += 1;
        let first = *bytes.get(offset).ok_or(Refusal::Protocol)?;
        offset += 1;
        let length = if first < 128 {
            usize::from(first)
        } else {
            let count = usize::from(first & 127);
            if count == 0 || count > 4 || bytes.get(offset) == Some(&0) {
                return Err(Refusal::Protocol);
            }
            let mut length = 0usize;
            for _ in 0..count {
                length = length
                    .checked_mul(256)
                    .and_then(|v| {
                        bytes
                            .get(offset)
                            .and_then(|b| v.checked_add(usize::from(*b)))
                    })
                    .ok_or(Refusal::Protocol)?;
                offset += 1;
            }
            if length < 128 {
                return Err(Refusal::Protocol);
            }
            length
        };
        let end = offset
            .checked_add(length)
            .filter(|n| *n <= bytes.len())
            .ok_or(Refusal::Protocol)?;
        if end - start > CERT_BYTES {
            return Err(Refusal::Bounds);
        }
        let cert = &bytes[start..end];
        if !seen.insert(cert) {
            return Err(Refusal::Protocol);
        }
        out.push(cert);
        offset = end;
    }
    if out.is_empty() {
        return Err(Refusal::Protocol);
    }
    Ok(out)
}
fn valid_until(certificates: &[&[u8]], now: u64, stop: &AtomicBool) -> Result<u64, Refusal> {
    let mut expiry = u64::MAX;
    for bytes in certificates {
        current(stop)?;
        let (rest, cert) = x509_parser::parse_x509_certificate(bytes).map_err(|_| Refusal::Tls)?;
        if !rest.is_empty() {
            return Err(Refusal::Tls);
        }
        let before = cert.validity().not_before.timestamp();
        let after = cert.validity().not_after.timestamp();
        if before < 0 || after < 0 || now < before as u64 || now >= after as u64 {
            return Err(Refusal::Tls);
        }
        expiry = expiry.min(after as u64);
    }
    Ok(expiry)
}

/// Actual validated material; no request/State/provider authority is implied.
/// Fields stay private until the original connector/watch owns their lifetime.
pub struct CurrentDriverMaterial {
    certified: Arc<CertifiedKey>,
    roots: Arc<RootCertStore>,
    valid_until: u64,
    generation: [u8; 32],
    expires: tokio::time::Instant,
}
// Sample before queueing: validation delay must consume the original lifetime.
// Sampling monotonic first also makes a scheduling gap between clocks conservative.
#[derive(Clone, Copy)]
struct MaterialTime {
    wall: Duration,
    monotonic: tokio::time::Instant,
}
impl MaterialTime {
    fn capture() -> Result<Self, Refusal> {
        let monotonic = tokio::time::Instant::now();
        let wall = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| Refusal::Tls)?;
        Ok(Self { wall, monotonic })
    }
}
fn decode_material(
    bytes: &[u8],
    selectors: &DriverProfileSelectors,
    sampled: MaterialTime,
    stop: &AtomicBool,
) -> Result<CurrentDriverMaterial, Refusal> {
    selectors.validate()?;
    let now = sampled.wall.as_secs();
    let entries = scan(bytes, stop)?;
    let provider = rustls::crypto::ring::default_provider();
    let mut selected = None;
    for entry in entries {
        current(stop)?;
        let declared = SpiffeId::new(entry.id).map_err(|_| Refusal::Protocol)?;
        if declared.to_string() != entry.id
            || declared.trust_domain().as_ref() != selectors.trust_domain
        {
            return Err(Refusal::Protocol);
        }
        let chain = certificates(entry.chain, CHAIN_CERTS, stop)?;
        let authorities = certificates(entry.bundle, AUTHORITIES, stop)?;
        let expiry = valid_until(&chain, now, stop)?.min(valid_until(&authorities, now, stop)?);
        let svid = X509Svid::parse_from_der(entry.chain, entry.key).map_err(|_| Refusal::Tls)?;
        if svid.spiffe_id() != &declared {
            return Err(Refusal::Tls);
        }
        let bundle = X509Bundle::parse_from_der(declared.trust_domain().clone(), entry.bundle)
            .map_err(|_| Refusal::Tls)?;
        if svid.cert_chain().len() != chain.len() || bundle.authorities().len() != authorities.len()
        {
            return Err(Refusal::Tls);
        }
        let mut roots = RootCertStore::empty();
        for der in &authorities {
            roots
                .add(CertificateDer::from(der.to_vec()))
                .map_err(|_| Refusal::Tls)?;
        }
        let der: Vec<CertificateDer<'static>> = chain
            .iter()
            .map(|b| CertificateDer::from(b.to_vec()))
            .collect();
        let parsed =
            rustls::server::ParsedCertificate::try_from(&der[0]).map_err(|_| Refusal::Tls)?;
        rustls::client::verify_server_cert_signed_by_trust_anchor(
            &parsed,
            &roots,
            &der[1..],
            UnixTime::since_unix_epoch(Duration::from_secs(now)),
            provider.signature_verification_algorithms.all,
        )
        .map_err(|_| Refusal::Tls)?;
        // Borrow the original zeroizing response; do not allocate/move a raw
        // DER copy into a maintained API whose parameter has no erasing Drop.
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(entry.key));
        let signing =
            rustls::crypto::ring::sign::any_supported_type(&key).map_err(|_| Refusal::Tls)?;
        let certified = CertifiedKey::new(der, signing);
        // Require confirmed consistency, including providers that report unknown.
        certified.keys_match().map_err(|_| Refusal::Tls)?;
        if entry.id == selectors.driver_spiffe_id {
            let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
            for part in [entry.id.as_bytes(), entry.chain, entry.bundle] {
                hash.update(&(part.len() as u64).to_be_bytes());
                hash.update(part);
            }
            selected = Some(CurrentDriverMaterial {
                certified: Arc::new(certified),
                roots: Arc::new(roots),
                valid_until: expiry,
                expires: sampled
                    .monotonic
                    .checked_add(
                        Duration::from_secs(expiry)
                            .checked_sub(sampled.wall)
                            .ok_or(Refusal::Tls)?,
                    )
                    .ok_or(Refusal::Bounds)?,
                generation: hash
                    .finish()
                    .as_ref()
                    .try_into()
                    .map_err(|_| Refusal::Protocol)?,
            });
        }
    }
    current(stop)?;
    let selected = selected.ok_or(Refusal::AuthorityUnavailable)?;
    if tokio::time::Instant::now() >= selected.expires {
        return Err(Refusal::Tls);
    }
    Ok(selected)
}

struct RegisteredTask {
    handle: AsyncMutex<Option<JoinHandle<()>>>,
}
struct Registry {
    sealed: bool,
    failed: bool,
    tasks: Vec<Arc<RegisteredTask>>,
}
#[derive(Clone)]
struct TaskOwner {
    registry: Arc<Mutex<Registry>>,
    stop: Arc<AtomicBool>,
    cancelled: watch::Sender<bool>,
}
impl TaskOwner {
    fn new() -> Self {
        let (cancelled, _) = watch::channel(false);
        Self {
            registry: Arc::new(Mutex::new(Registry {
                sealed: false,
                failed: false,
                tasks: Vec::new(),
            })),
            stop: Arc::new(AtomicBool::new(false)),
            cancelled,
        }
    }
    fn cancel(&self) {
        self.stop.store(true, Ordering::Release);
        self.cancelled.send_replace(true);
    }
    fn register(&self, create: impl FnOnce() -> JoinHandle<()>) -> Result<(), Refusal> {
        tokio::runtime::Handle::try_current().map_err(|_| Refusal::Configuration)?;
        let mut state = self.registry.lock().unwrap();
        if self.stop.load(Ordering::Acquire) || state.sealed || state.tasks.len() == TASKS {
            state.failed = true;
            self.cancel();
            return Err(Refusal::AuthorityUnavailable);
        }
        // Installation and retirement sealing share this lock. Tokio spawn does
        // not poll synchronously; the actual handle is installed before unlock.
        state.tasks.push(Arc::new(RegisteredTask {
            handle: AsyncMutex::new(Some(create())),
        }));
        Ok(())
    }
    async fn retire(&self) -> Result<(), Refusal> {
        self.cancel();
        let tasks = {
            let mut state = self.registry.lock().unwrap();
            state.sealed = true;
            state.tasks.clone()
        };
        for task in &tasks {
            let handle = task.handle.lock().await;
            if let Some(handle) = handle.as_ref() {
                handle.abort();
            }
        }
        for task in tasks {
            let mut handle = task.handle.lock().await;
            if let Some(join) = handle.as_mut() {
                if join.await.is_err_and(|e| !e.is_cancelled()) {
                    self.registry.lock().unwrap().failed = true;
                }
                *handle = None;
            }
        }
        if self.registry.lock().unwrap().failed {
            Err(Refusal::Protocol)
        } else {
            Ok(())
        }
    }
}
impl<F> hyper::rt::Executor<F> for TaskOwner
where
    F: Future<Output = ()> + Send + 'static,
{
    fn execute(&self, future: F) {
        // A post-seal future is dropped unpolled; no later dial can be started.
        let _ = self.register(|| tokio::spawn(future));
    }
}

#[derive(Default)]
struct Publications {
    sealed: bool,
    runs: Vec<(
        Arc<crate::publication::PublicationTransport>,
        crate::publication::PublicationRun,
    )>,
}
/// Original retained startup and publication-monitor ownership. Construction
/// requires the captured protected profile; selectors or fixtures grant nothing.
pub struct IdentityStartup {
    publications: Mutex<Publications>,
    profile: CapturedDriverProfile,
    tasks: TaskOwner,
    material: watch::Sender<Option<Result<Arc<CurrentDriverMaterial>, Refusal>>>,
}
impl IdentityStartup {
    fn new(profile: CapturedDriverProfile) -> Result<Arc<Self>, Refusal> {
        profile.selectors.validate()?;
        profile.current()?;
        let (material, _) = watch::channel(None);
        Ok(Arc::new(Self {
            profile,
            tasks: TaskOwner::new(),
            material,
            publications: Mutex::new(Publications::default()),
        }))
    }
    pub fn cancel(&self) {
        self.tasks.cancel();
    }
    pub async fn retire(&self) -> Result<(), Refusal> {
        self.cancel();
        let runs = {
            let mut state = self.publications.lock().unwrap();
            state.sealed = true;
            state.runs.clone()
        };
        // Join EVERY actual bound run before its registered loss-monitor can
        // be aborted. Cancelled awaits retain these exact owners for recovery.
        let mut failed = false;
        for (owner, run) in runs {
            failed |= owner.retire(&run).await.is_err();
        }
        if failed {
            self.tasks.registry.lock().unwrap().failed = true;
        }
        let joined = self.tasks.retire().await;
        self.material.send_replace(None);
        if joined.is_ok() {
            self.publications.lock().unwrap().runs.clear();
        }
        joined
    }
    pub async fn acquire(&self) -> Result<Arc<CurrentDriverMaterial>, Refusal> {
        let mut material = self.material.subscribe();
        let mut cancelled = self.tasks.cancelled.subscribe();
        let mut profile = self.profile.invalidated.clone();
        loop {
            self.profile.current()?;
            if *cancelled.borrow() {
                return Err(Refusal::Deadline);
            }
            if let Some(result) = material.borrow().clone() {
                if result.as_ref().is_ok_and(|v| {
                    v.valid_until <= UnixTime::now().as_secs()
                        || tokio::time::Instant::now() >= v.expires
                }) {
                    self.cancel();
                    return Err(Refusal::Tls);
                }
                return result;
            }
            tokio::select! {
                changed = material.changed() => if changed.is_err() { return Err(Refusal::AuthorityUnavailable); },
                _ = cancelled.changed() => return Err(Refusal::Deadline),
                _ = profile.changed() => return Err(Refusal::AuthorityUnavailable),
            }
        }
    }
    fn decode(
        self: &Arc<Self>,
        bytes: Zeroizing<Vec<u8>>,
        sampled: MaterialTime,
    ) -> Result<(), Refusal> {
        self.profile.current()?;
        current(&self.tasks.stop)?;
        let original = self.clone();
        self.tasks.register(|| {
            tokio::task::spawn_blocking(move || {
                let result = decode_material(
                    &bytes,
                    &original.profile.selectors,
                    sampled,
                    &original.tasks.stop,
                )
                .and_then(|value| {
                    original.profile.current()?;
                    current(&original.tasks.stop)?;
                    Ok(Arc::new(value))
                });
                // Only one retained decode result may commit at a time. A changed
                // relevant generation cancels the original owner, never replacing
                // the material of an operation already bound to that generation.
                let mut result = result;
                original.material.send_modify(|slot| {
                    if original.tasks.stop.load(Ordering::Acquire)
                        || original.profile.current().is_err()
                    {
                        result = Err(Refusal::AuthorityUnavailable);
                    }
                    if let (Some(Ok(previous)), Ok(next)) = (slot.as_ref(), result.as_ref()) {
                        if previous.generation != next.generation {
                            result = Err(Refusal::AuthorityUnavailable);
                        } else {
                            // Identical updates do not move the first monotonic
                            // expiry horizon or replace an operation's material.
                            result = Ok(previous.clone());
                        }
                    }
                    // Also cover delay acquiring the commit lock and reuse of an
                    // identical generation's earlier, immutable expiry horizon.
                    if result
                        .as_ref()
                        .is_ok_and(|v| tokio::time::Instant::now() >= v.expires)
                    {
                        result = Err(Refusal::Tls);
                    }
                    if result.is_err() {
                        original.cancel();
                    }
                    *slot = Some(result);
                });
            })
        })
    }
}

const STARTUP_BUDGET: Duration = Duration::from_secs(30);
const PUBLICATION_ALPN: &[u8] = b"oce-github-publication-v1";
const WORKLOAD_METHOD: &str = "/SpiffeWorkloadAPI/FetchX509SVID";

/// One original dial permission shared by all connector clones. Tonic may call
/// its internal Reconnect service; a second call fails before filesystem/socket
/// access and withdraws this original owner. The URI never supplies a route.
#[derive(Clone)]
struct OneUseConnector {
    original: Arc<IdentityStartup>,
    used: Arc<AtomicBool>,
}
impl OneUseConnector {
    fn new(original: Arc<IdentityStartup>) -> Self {
        Self {
            original,
            used: Arc::new(AtomicBool::new(false)),
        }
    }
}
fn dial_error() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "identity connection unavailable",
    )
}
impl tonic::codegen::Service<http::Uri> for OneUseConnector {
    type Response = hyper_util::rt::TokioIo<tokio::net::UnixStream>;
    type Error = std::io::Error;
    type Future =
        std::pin::Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;
    fn poll_ready(
        &mut self,
        _: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        if current(&self.original.tasks.stop).is_err() || self.original.profile.current().is_err() {
            std::task::Poll::Ready(Err(dial_error()))
        } else {
            std::task::Poll::Ready(Ok(()))
        }
    }
    fn call(&mut self, uri: http::Uri) -> Self::Future {
        let original = self.original.clone();
        // Consume before constructing/polling the future; dropping it cannot
        // restore permission. No retry after failed or cancelled first dial.
        let first = !self.used.swap(true, Ordering::AcqRel);
        Box::pin(async move {
            if !first
                || uri.scheme_str() != Some("http")
                || uri.authority().map(|v| v.as_str()) != Some("localhost")
                || uri.path() != "/"
                || uri.query().is_some()
            {
                original.fail(Refusal::AuthorityUnavailable);
                return Err(dial_error());
            }
            original.profile.current().map_err(|_| dial_error())?;
            current(&original.tasks.stop).map_err(|_| dial_error())?;
            let selected = original.profile.inspect();
            crate::broker_rpc::protected_path(
                &selected.workload_api_socket,
                selected.workload_api_peer_uid,
                &selected.trusted_ancestor_uids,
            )
            .map_err(|_| dial_error())?;
            let socket = tokio::net::UnixStream::connect(&selected.workload_api_socket)
                .await
                .map_err(|_| dial_error())?;
            if socket.peer_cred().map_err(|_| dial_error())?.uid() != selected.workload_api_peer_uid
            {
                original.fail(Refusal::AuthorityUnavailable);
                return Err(dial_error());
            }
            crate::broker_rpc::protected_path(
                &selected.workload_api_socket,
                selected.workload_api_peer_uid,
                &selected.trusted_ancestor_uids,
            )
            .map_err(|_| dial_error())?;
            original.profile.current().map_err(|_| dial_error())?;
            current(&original.tasks.stop).map_err(|_| dial_error())?;
            Ok(hyper_util::rt::TokioIo::new(socket))
        })
    }
}

impl IdentityStartup {
    /// Starts actual retained Workload API acquisition from an original captured
    /// profile. Neither selectors nor a caller ClientConfig can construct that
    /// operand. Once created, this startup is returned even if task registration
    /// fails, so its original failure and physical-retirement responsibility are
    /// retained. No PublicationRun is created by identity acquisition.
    pub fn begin(profile: CapturedDriverProfile) -> Result<Arc<Self>, Refusal> {
        let original = Self::new(profile)?;
        let retained = original.clone();
        let installed = original.tasks.register(|| {
            tokio::spawn(async move {
                if let Err(reason) = retained.watch_workload().await {
                    retained.fail(reason);
                }
            })
        });
        if let Err(reason) = installed {
            original.fail(reason);
        }
        Ok(original)
    }
    fn fail(&self, reason: Refusal) {
        self.cancel();
        self.material.send_modify(|value| {
            if !matches!(value, Some(Err(_))) {
                *value = Some(Err(reason));
            }
        });
    }
    fn live(&self, material: &Arc<CurrentDriverMaterial>) -> Result<(), Refusal> {
        self.profile.current()?;
        current(&self.tasks.stop)?;
        if UnixTime::now().as_secs() >= material.valid_until
            || tokio::time::Instant::now() >= material.expires
        {
            return Err(Refusal::Tls);
        }
        match self.material.borrow().as_ref() {
            Some(Ok(current)) if Arc::ptr_eq(current, material) => Ok(()),
            _ => Err(Refusal::AuthorityUnavailable),
        }
    }
    /// Wait for loss of THIS original identity/source generation. Callers that
    /// bind a PublicationRun must keep this waiter and cancel/join that same run
    /// on return. This is not a successful retirement receipt.
    pub async fn loss(&self) -> Refusal {
        let mut updates = self.material.subscribe();
        let mut cancelled = self.tasks.cancelled.subscribe();
        let mut profile = self.profile.invalidated.clone();
        loop {
            let failure = self
                .profile
                .current()
                .err()
                .or_else(|| current(&self.tasks.stop).err());
            if let Some(reason) = failure {
                self.cancel();
                return reason;
            }
            let observed = { updates.borrow().clone() };
            let wake = match observed {
                Some(Err(reason)) => {
                    self.cancel();
                    return reason;
                }
                Some(Ok(material)) => {
                    if let Err(reason) = self.live(&material) {
                        self.cancel();
                        return reason;
                    }
                    // The fixed monotonic horizon prevents a backward wall
                    // clock step or repeated identical update extending use.
                    material
                        .expires
                        .min(tokio::time::Instant::now() + Duration::from_millis(250))
                }
                None => tokio::time::Instant::now() + STARTUP_BUDGET,
            };
            tokio::select! {
                biased;
                _ = cancelled.changed() => { self.cancel(); return Refusal::Deadline; },
                _ = profile.changed() => { self.cancel(); return Refusal::AuthorityUnavailable; },
                changed = updates.changed() => if changed.is_err() {
                    self.cancel(); return Refusal::AuthorityUnavailable;
                },
                _ = tokio::time::sleep_until(wake) => {},
            }
        }
    }
    async fn guarded<T>(
        &self,
        future: impl Future<Output = T>,
        until: tokio::time::Instant,
    ) -> Result<T, Refusal> {
        tokio::select! {
            biased;
            reason = self.loss() => Err(reason),
            result = tokio::time::timeout_at(until, future) => result.map_err(|_| Refusal::Deadline),
        }
    }
    async fn watch_workload(self: &Arc<Self>) -> Result<(), Refusal> {
        let startup_until = tokio::time::Instant::now() + STARTUP_BUDGET;
        let endpoint = tonic::transport::Endpoint::from_static("http://localhost")
            .executor(self.tasks.clone())
            .connect_timeout(STARTUP_BUDGET)
            .concurrency_limit(1)
            .buffer_size(1);
        let channel = self
            .guarded(
                endpoint.connect_with_connector(OneUseConnector::new(self.clone())),
                startup_until,
            )
            .await?
            .map_err(|_| Refusal::AuthorityUnavailable)?;
        let mut client = tonic::client::Grpc::new(channel)
            .max_decoding_message_size(RESPONSE_BYTES)
            .max_encoding_message_size(0);
        self.guarded(client.ready(), startup_until)
            .await?
            .map_err(|_| Refusal::Io)?;
        let mut request = tonic::Request::new(());
        request.metadata_mut().insert(
            "workload.spiffe.io",
            tonic::metadata::MetadataValue::from_static("true"),
        );
        let response = self
            .guarded(
                client.server_streaming(
                    request,
                    http::uri::PathAndQuery::from_static(WORKLOAD_METHOD),
                    RawWorkloadCodec,
                ),
                startup_until,
            )
            .await?
            .map_err(|_| Refusal::Io)?;
        let mut stream = response.into_inner();
        let mut until = startup_until;
        loop {
            let bytes = self
                .guarded(stream.message(), until)
                .await?
                .map_err(|_| Refusal::Protocol)?
                .ok_or(Refusal::AuthorityUnavailable)?;
            // One bounded raw response and one decoder are outstanding. No
            // unbounded update queue or parallel replacement-generation decode.
            let mut updates = self.material.subscribe();
            self.decode(bytes, MaterialTime::capture()?)?;
            self.guarded(updates.changed(), until)
                .await?
                .map_err(|_| Refusal::AuthorityUnavailable)?;
            let material = self.acquire().await?;
            self.live(&material)?;
            until = material.expires;
        }
    }
}

/// Validated Driver material and its live original owner. Construction stays in
/// this module, and TLS configuration is not exposed as a caller-supplied grant.
/// The standalone publication factory still needs its genuine protected profile
/// producer and independently owned GitHub upstream trust initializer.
pub struct DriverIdentity {
    startup: Arc<IdentityStartup>,
    material: Arc<CurrentDriverMaterial>,
    broker_tls: Arc<rustls::ClientConfig>,
}
impl IdentityStartup {
    pub async fn acquire_identity(self: &Arc<Self>) -> Result<DriverIdentity, Refusal> {
        let material = self.acquire().await?;
        let broker_tls = broker_tls(self, material.clone())?;
        self.live(&material)?;
        Ok(DriverIdentity {
            startup: self.clone(),
            material,
            broker_tls,
        })
    }
}
impl DriverIdentity {
    pub fn current(&self) -> Result<(), Refusal> {
        self.startup.live(&self.material)
    }
    /// Enroll a retained monitor before the original transport can create work.
    /// The transport is supplied by the original protected publication factory;
    /// this method adds no request, session or upstream-trust authority.
    pub fn serve_original(
        &self,
        transport: Arc<crate::publication::PublicationTransport>,
        session: &str,
    ) -> Result<crate::publication::PublicationRun, Refusal> {
        self.current()?;
        let mut publications = self.startup.publications.lock().unwrap();
        if publications.sealed || publications.runs.len() >= TASKS {
            return Err(Refusal::AuthorityUnavailable);
        }
        let (send, receive) = tokio::sync::oneshot::channel::<crate::publication::PublicationRun>();
        let original = self.startup.clone();
        let owner = transport.clone();
        self.startup.tasks.register(|| {
            tokio::spawn(async move {
                let Ok(ticket) = receive.await else {
                    return;
                };
                tokio::select! {
                    biased;
                    _ = original.loss() => {
                        if owner.retire(&ticket).await.is_err() {
                            original.tasks.registry.lock().unwrap().failed = true;
                        }
                    },
                    _ = owner.result(&ticket) => {},
                }
            })
        })?;
        let ticket = transport.serve_original(session)?;
        publications.runs.push((transport, ticket.clone()));
        drop(publications);
        // After creation, ALWAYS return the actual original ticket. Failed
        // monitor delivery may not turn possible work into an empty Err handle.
        if send.send(ticket.clone()).is_err() {
            self.startup.tasks.registry.lock().unwrap().failed = true;
            self.startup.fail(Refusal::Protocol);
        }
        Ok(ticket)
    }
    pub async fn loss(&self) -> Refusal {
        self.startup.loss().await
    }
    pub fn cancel(&self) {
        self.startup.cancel();
    }
    pub async fn retire(&self) -> Result<(), Refusal> {
        self.startup.retire().await
    }
}

struct BrokerPeer {
    original: std::sync::Weak<IdentityStartup>,
    material: Arc<CurrentDriverMaterial>,
}
impl std::fmt::Debug for BrokerPeer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BrokerPeer")
    }
}
fn tls_error() -> rustls::Error {
    rustls::Error::General("publication broker identity refused".into())
}
impl BrokerPeer {
    fn original(&self) -> Result<Arc<IdentityStartup>, rustls::Error> {
        let original = self.original.upgrade().ok_or_else(tls_error)?;
        original.live(&self.material).map_err(|_| tls_error())?;
        Ok(original)
    }
}
impl rustls::client::danger::ServerCertVerifier for BrokerPeer {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _: &rustls_pki_types::ServerName<'_>,
        _: &[u8],
        now: UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        let original = self.original()?;
        if intermediates.len() >= CHAIN_CERTS {
            return Err(tls_error());
        }
        let mut all = Vec::with_capacity(intermediates.len() + 1);
        all.push(leaf.as_ref());
        all.extend(intermediates.iter().map(|v| v.as_ref()));
        if all.iter().any(|v| v.len() > CERT_BYTES)
            || all
                .iter()
                .try_fold(0usize, |n, v| n.checked_add(v.len()))
                .is_none_or(|n| n > CHAIN_BYTES)
        {
            return Err(tls_error());
        }
        valid_until(&all, now.as_secs(), &original.tasks.stop).map_err(|_| tls_error())?;
        let (rest, cert) =
            x509_parser::parse_x509_certificate(leaf.as_ref()).map_err(|_| tls_error())?;
        if !rest.is_empty() {
            return Err(tls_error());
        }
        let san = cert
            .subject_alternative_name()
            .map_err(|_| tls_error())?
            .ok_or_else(tls_error)?;
        match san.value.general_names.as_slice() {
            [x509_parser::extensions::GeneralName::URI(id)]
                if *id == original.profile.selectors.broker_spiffe_id => {}
            _ => return Err(tls_error()),
        }
        let constraints = cert
            .basic_constraints()
            .map_err(|_| tls_error())?
            .ok_or_else(tls_error)?;
        let usage = cert
            .key_usage()
            .map_err(|_| tls_error())?
            .ok_or_else(tls_error)?;
        if constraints.value.ca
            || !usage.value.digital_signature()
            || usage.value.key_cert_sign()
            || usage.value.crl_sign()
        {
            return Err(tls_error());
        }
        let parsed = rustls::server::ParsedCertificate::try_from(leaf).map_err(|_| tls_error())?;
        let provider = rustls::crypto::ring::default_provider();
        rustls::client::verify_server_cert_signed_by_trust_anchor(
            &parsed,
            &self.material.roots,
            intermediates,
            now,
            provider.signature_verification_algorithms.all,
        )?;
        self.original()?;
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.original()?;
        let result = rustls::crypto::verify_tls12_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )?;
        self.original()?;
        Ok(result)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.original()?;
        let result = rustls::crypto::verify_tls13_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )?;
        self.original()?;
        Ok(result)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
impl rustls::client::ResolvesClientCert for BrokerPeer {
    fn resolve(
        &self,
        _: &[&[u8]],
        schemes: &[rustls::SignatureScheme],
    ) -> Option<Arc<CertifiedKey>> {
        self.original().ok()?;
        self.material.certified.key.choose_scheme(schemes)?;
        Some(self.material.certified.clone())
    }
    fn has_certs(&self) -> bool {
        self.original().is_ok()
    }
}
fn broker_tls(
    original: &Arc<IdentityStartup>,
    material: Arc<CurrentDriverMaterial>,
) -> Result<Arc<rustls::ClientConfig>, Refusal> {
    original.live(&material)?;
    let peer = Arc::new(BrokerPeer {
        original: Arc::downgrade(original),
        material,
    });
    let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| Refusal::Tls)?
    .dangerous()
    .with_custom_certificate_verifier(peer.clone())
    .with_client_cert_resolver(peer);
    config.alpn_protocols = vec![PUBLICATION_ALPN.to_vec()];
    config.enable_sni = false;
    config.enable_early_data = false;
    config.resumption = rustls::client::Resumption::disabled();
    Ok(Arc::new(config))
}

#[cfg(test)]
#[path = "publication_identity_tests.rs"]
mod tests;
