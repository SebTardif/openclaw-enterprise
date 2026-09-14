//! Private consumer for the original protected READ launcher only.
//! Frames and descriptor numbers are comparison data, never provider authority.
//! Native retains its actual acquired material lease, original listener binding,
//! executable and child until this owner's joins, complete output and child exit.
use super::{json, Refusal};
use oce_native_egress::{
    git_read_listener::GitReadListener, mediated::BrokerConfig, Limits, Repository,
};
#[cfg(test)]
use rustls::client::danger::ServerCertVerifier as _;
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime},
    sign::CertifiedKey,
    RootCertStore,
};
use serde_json::{json as value, Map, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::{Component, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{oneshot, watch},
    time::Instant,
};
use zeroize::Zeroizing;

const META: usize = 16384;
const MATERIAL: usize = 1048576;
const SAFE: u64 = 9007199254740991;
const ALPN: &[u8] = b"oce-github-git-read-v3";
#[derive(Clone)]
struct Context {
    incarnation: String,
    session: String,
    generation: String,
}
impl Context {
    fn frame(&self, kind: &str, sequence: u64) -> Value {
        value!({"version":1,"kind":kind,"incarnation":self.incarnation,
            "session_ref":self.session,"source_generation":self.generation,"sequence":sequence})
    }
    fn matches(&self, v: &Value, kind: &str, sequence: u64) -> Result<(), Refusal> {
        if integer(v, "version", 1, 1)? != 1
            || text(v, "kind")? != kind
            || integer(v, "sequence", sequence, sequence)? != sequence
            || text(v, "incarnation")? != self.incarnation
            || text(v, "session_ref")? != self.session
            || text(v, "source_generation")? != self.generation
        {
            return Err(Refusal::Protocol);
        }
        Ok(())
    }
}
fn object<'a>(v: &'a Value, names: &[&str]) -> Result<&'a Map<String, Value>, Refusal> {
    let out = v.as_object().ok_or(Refusal::Protocol)?;
    if out.len() != names.len() || names.iter().any(|n| !out.contains_key(*n)) {
        return Err(Refusal::Protocol);
    }
    Ok(out)
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, Refusal> {
    v.get(key).and_then(Value::as_str).ok_or(Refusal::Protocol)
}
fn integer(v: &Value, key: &str, low: u64, high: u64) -> Result<u64, Refusal> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n >= low && *n <= high.min(SAFE))
        .ok_or(Refusal::Bounds)
}
fn hex(s: &str, size: usize) -> bool {
    s.len() == size
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn reference(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
}
fn spiffe(s: &str, domain: &str) -> bool {
    let Some(rest) = s.strip_prefix("spiffe://") else {
        return false;
    };
    let Some((host, path)) = rest.split_once('/') else {
        return false;
    };
    host == domain
        && !path.is_empty()
        && s.len() <= 2048
        && path.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
        })
}
struct Raw {
    metadata: json::OwnedJson,
    material: Zeroizing<Vec<u8>>,
}
fn frame(reader: &mut impl Read, material_allowed: bool) -> Result<Raw, Refusal> {
    let mut lengths = [0; 8];
    reader.read_exact(&mut lengths).map_err(|_| Refusal::Io)?;
    let n = u32::from_be_bytes(lengths[..4].try_into().unwrap()) as usize;
    let m = u32::from_be_bytes(lengths[4..].try_into().unwrap()) as usize;
    if n == 0 || n > META || m > MATERIAL || (!material_allowed && m != 0) {
        return Err(Refusal::Bounds);
    }
    let mut bytes = Zeroizing::new(vec![0; n]);
    reader.read_exact(&mut bytes).map_err(|_| Refusal::Io)?;
    let metadata = json::OwnedJson(json::parse(&bytes)?);
    let mut material = Zeroizing::new(vec![0; m]);
    reader.read_exact(&mut material).map_err(|_| Refusal::Io)?;
    Ok(Raw { metadata, material })
}
#[derive(Clone, Copy)]
struct Sample {
    wall: Duration,
    monotonic: Instant,
}
impl Sample {
    fn capture() -> Result<Self, Refusal> {
        let monotonic = Instant::now();
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Refusal::Tls)?;
        Ok(Self { wall, monotonic })
    }
}
struct Layout {
    incoming: Vec<usize>,
    incoming_key: usize,
    web: Vec<usize>,
    driver: Vec<usize>,
    driver_key: usize,
    broker: Vec<usize>,
}
fn lengths(v: &Value, key: &str, cap: usize) -> Result<Vec<usize>, Refusal> {
    let values = v
        .get(key)
        .and_then(Value::as_array)
        .ok_or(Refusal::Protocol)?;
    if values.is_empty() || values.len() > cap {
        return Err(Refusal::Bounds);
    }
    values
        .iter()
        .map(|v| {
            v.as_u64()
                .filter(|n| (1..=65536).contains(n))
                .map(|n| n as usize)
                .ok_or(Refusal::Bounds)
        })
        .collect()
}
struct Initial {
    context: Context,
    repository: Repository,
    attachment: String,
    driver_id: String,
    broker_id: String,
    path: PathBuf,
    peer_uid: u32,
    ancestors: Vec<u32>,
    call: Duration,
    check: Duration,
    skew: Duration,
    limits: Limits,
    maximum: usize,
    layout: Layout,
    until_ms: u64,
    expires: Instant,
}
fn initial(v: &Value, bytes: usize, sample: Sample) -> Result<Initial, Refusal> {
    object(
        v,
        &[
            "version",
            "kind",
            "incarnation",
            "session_ref",
            "sequence",
            "source_generation",
            "valid_until_ms",
            "repository",
            "attachment_ref",
            "profile",
            "broker",
            "limits",
            "material",
        ],
    )?;
    let context = Context {
        incarnation: text(v, "incarnation")?.into(),
        session: text(v, "session_ref")?.into(),
        generation: text(v, "source_generation")?.into(),
    };
    if !hex(&context.incarnation, 32) || !hex(&context.session, 32) || !hex(&context.generation, 64)
    {
        return Err(Refusal::Protocol);
    }
    context.matches(v, "start", 1)?;
    let repo = &v["repository"];
    object(repo, &["owner", "name", "commit"])?;
    let repository = Repository::new(
        text(repo, "owner")?,
        text(repo, "name")?,
        text(repo, "commit")?,
    )?;
    let attachment = text(v, "attachment_ref")?.to_owned();
    if !reference(&attachment) {
        return Err(Refusal::Configuration);
    }
    let profile = &v["profile"];
    object(
        profile,
        &[
            "protocol_version",
            "operation_policy",
            "transport_profile_ref",
            "trust_domain",
            "crl_count",
            "driver_spiffe_id",
            "broker_spiffe_id",
        ],
    )?;
    if integer(profile, "protocol_version", 3, 3)? != 3
        || integer(profile, "crl_count", 0, 0)? != 0
        || text(profile, "operation_policy")? != "github-git-read-rpc-v3"
        || text(profile, "transport_profile_ref")? != "owned-child-stdio-github-git-read-v3"
    {
        return Err(Refusal::Configuration);
    }
    let domain = text(profile, "trust_domain")?;
    if domain.is_empty()
        || domain.len() > 255
        || !domain
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-_".contains(&b))
    {
        return Err(Refusal::Configuration);
    }
    let driver_id = text(profile, "driver_spiffe_id")?.to_owned();
    let broker_id = text(profile, "broker_spiffe_id")?.to_owned();
    if !spiffe(&driver_id, domain) || !spiffe(&broker_id, domain) {
        return Err(Refusal::Configuration);
    }
    let broker = &v["broker"];
    object(
        broker,
        &[
            "socket_path",
            "peer_uid",
            "trusted_ancestor_uids",
            "call_timeout_ms",
            "check_interval_ms",
            "max_clock_skew_ms",
        ],
    )?;
    let spelling = text(broker, "socket_path")?;
    let path = PathBuf::from(spelling);
    if !path.is_absolute()
        || spelling.len() > 103
        || spelling.bytes().any(|b| b <= 32 || b == 127)
        || spelling
            .split('/')
            .skip(1)
            .any(|c| c.is_empty() || c == "." || c == "..")
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(Refusal::Configuration);
    }
    let peer_uid = integer(broker, "peer_uid", 0, u32::MAX as u64)? as u32;
    let ancestors = broker["trusted_ancestor_uids"]
        .as_array()
        .ok_or(Refusal::Protocol)?;
    if ancestors.is_empty() || ancestors.len() > 8 {
        return Err(Refusal::Bounds);
    }
    let ancestors = ancestors
        .iter()
        .map(|v| {
            v.as_u64()
                .filter(|n| *n <= u32::MAX as u64)
                .map(|n| n as u32)
                .ok_or(Refusal::Bounds)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if ancestors
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
        != ancestors.len()
    {
        return Err(Refusal::Configuration);
    }
    let call = Duration::from_millis(integer(broker, "call_timeout_ms", 1, 30000)?);
    let check = Duration::from_millis(integer(broker, "check_interval_ms", 1, 30000)?);
    let skew = Duration::from_millis(integer(broker, "max_clock_skew_ms", 0, 30000)?);
    let limits = &v["limits"];
    object(
        limits,
        &[
            "header_bytes",
            "header_count",
            "request_bytes",
            "response_bytes",
            "exchange_timeout_ms",
            "maximum_connections",
        ],
    )?;
    let maximum = integer(limits, "maximum_connections", 1, 128)? as usize;
    let limits = Limits {
        header_bytes: integer(limits, "header_bytes", 8192, 1048576)? as usize,
        header_count: integer(limits, "header_count", 1, 1024)? as usize,
        request_bytes: integer(limits, "request_bytes", 1, 4194304)?,
        response_bytes: integer(limits, "response_bytes", 1, 67108864)?,
        exchange_timeout: Duration::from_millis(integer(limits, "exchange_timeout_ms", 1, 30000)?),
    };
    let m = &v["material"];
    object(
        m,
        &[
            "incoming_chain",
            "incoming_key",
            "public_web_roots",
            "driver_chain",
            "driver_key",
            "broker_roots",
        ],
    )?;
    let layout = Layout {
        incoming: lengths(m, "incoming_chain", 8)?,
        incoming_key: integer(m, "incoming_key", 1, 16384)? as usize,
        web: lengths(m, "public_web_roots", 128)?,
        driver: lengths(m, "driver_chain", 8)?,
        driver_key: integer(m, "driver_key", 1, 16384)? as usize,
        broker: lengths(m, "broker_roots", 128)?,
    };
    let total = layout
        .incoming
        .iter()
        .chain(&layout.web)
        .chain(&layout.driver)
        .chain(&layout.broker)
        .try_fold(
            layout
                .incoming_key
                .checked_add(layout.driver_key)
                .ok_or(Refusal::Bounds)?,
            |n, size| n.checked_add(*size).ok_or(Refusal::Bounds),
        )?;
    if total != bytes || bytes == 0 || bytes > MATERIAL {
        return Err(Refusal::Bounds);
    }
    let until_ms = integer(v, "valid_until_ms", 1, SAFE)?;
    let remaining = Duration::from_millis(until_ms)
        .checked_sub(sample.wall)
        .ok_or(Refusal::Deadline)?;
    if remaining.is_zero() || remaining > Duration::from_secs(86400) {
        return Err(Refusal::Deadline);
    }
    let expires = sample
        .monotonic
        .checked_add(remaining)
        .ok_or(Refusal::Deadline)?;
    if Instant::now() >= expires {
        return Err(Refusal::Deadline);
    }
    Ok(Initial {
        context,
        repository,
        attachment,
        driver_id,
        broker_id,
        path,
        peer_uid,
        ancestors,
        call,
        check,
        skew,
        limits,
        maximum,
        layout,
        until_ms,
        expires,
    })
}

// This locally retained lifetime follows the actual original parent generation.
// Its boolean/time values do not replace the parent's genuine source custody.
struct Lease {
    stopped: AtomicBool,
    failed: AtomicBool,
    reason: Mutex<Option<Refusal>>,
    expires: Instant,
    until_ms: u64,
    wake: watch::Sender<bool>,
}
impl Lease {
    fn current(&self) -> Result<(), Refusal> {
        if self.stopped.load(Ordering::Acquire) || self.failed.load(Ordering::Acquire) {
            return Err(Refusal::AuthorityUnavailable);
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Refusal::Tls)?;
        if Instant::now() >= self.expires || now >= Duration::from_millis(self.until_ms) {
            return Err(Refusal::Deadline);
        }
        Ok(())
    }
    fn stop(&self, reason: Option<Refusal>) {
        if let Ok(mut saved) = self.reason.lock() {
            if saved.is_none() {
                *saved = reason;
            }
        } else {
            self.failed.store(true, Ordering::Release);
        }
        self.stopped.store(true, Ordering::Release);
        self.wake.send_replace(true);
    }
    fn fail(&self) {
        self.failed.store(true, Ordering::Release);
        self.stop(Some(Refusal::Protocol));
    }
}
fn tls_error() -> rustls::Error {
    rustls::Error::General("READ identity refused".into())
}
fn live(lease: &Lease) -> Result<(), rustls::Error> {
    lease.current().map_err(|_| tls_error())
}
fn certs<'a>(
    bytes: &'a [u8],
    offset: &mut usize,
    lengths: &[usize],
) -> Result<Vec<&'a [u8]>, Refusal> {
    lengths.iter().map(|n| take(bytes, offset, *n)).collect()
}
fn take<'a>(bytes: &'a [u8], offset: &mut usize, n: usize) -> Result<&'a [u8], Refusal> {
    let end = offset
        .checked_add(n)
        .filter(|n| *n <= bytes.len())
        .ok_or(Refusal::Bounds)?;
    let result = &bytes[*offset..end];
    *offset = end;
    Ok(result)
}
fn certificate<'a>(
    der: &'a [u8],
    lease: &Lease,
) -> Result<x509_parser::certificate::X509Certificate<'a>, Refusal> {
    lease.current()?;
    if der.is_empty() || der.len() > 65536 {
        return Err(Refusal::Bounds);
    }
    let (rest, cert) = x509_parser::parse_x509_certificate(der).map_err(|_| Refusal::Tls)?;
    if !rest.is_empty() {
        return Err(Refusal::Tls);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Refusal::Tls)?
        .as_secs();
    let before = cert.validity().not_before.timestamp();
    let after = cert.validity().not_after.timestamp();
    if before < 0
        || after < 0
        || now < before as u64
        || now >= after as u64
        || Duration::from_secs(after as u64) < Duration::from_millis(lease.until_ms)
    {
        return Err(Refusal::Tls);
    }
    Ok(cert)
}
fn uri(der: &[u8], expected: &str, lease: &Lease) -> Result<(), Refusal> {
    let cert = certificate(der, lease)?;
    let san = cert
        .subject_alternative_name()
        .map_err(|_| Refusal::Tls)?
        .ok_or(Refusal::Tls)?;
    match san.value.general_names.as_slice() {
        [x509_parser::extensions::GeneralName::URI(id)] if *id == expected => {}
        _ => return Err(Refusal::Tls),
    }
    let bc = cert
        .basic_constraints()
        .map_err(|_| Refusal::Tls)?
        .ok_or(Refusal::Tls)?;
    let ku = cert
        .key_usage()
        .map_err(|_| Refusal::Tls)?
        .ok_or(Refusal::Tls)?;
    if bc.value.ca
        || !ku.value.digital_signature()
        || ku.value.key_cert_sign()
        || ku.value.crl_sign()
    {
        return Err(Refusal::Tls);
    }
    Ok(())
}
fn roots(certs: &[&[u8]], lease: &Lease) -> Result<Arc<RootCertStore>, Refusal> {
    let mut out = RootCertStore::empty();
    let mut seen = std::collections::BTreeSet::new();
    for der in certs {
        let cert = certificate(der, lease)?;
        if !cert
            .basic_constraints()
            .map_err(|_| Refusal::Tls)?
            .is_some_and(|b| b.value.ca)
            || !seen.insert(*der)
        {
            return Err(Refusal::Tls);
        }
        out.add(CertificateDer::from(der.to_vec()))
            .map_err(|_| Refusal::Tls)?;
    }
    Ok(Arc::new(out))
}
fn certified(chain: &[&[u8]], key: &[u8], lease: &Lease) -> Result<Arc<CertifiedKey>, Refusal> {
    for der in chain {
        certificate(der, lease)?;
    }
    let chain = chain
        .iter()
        .map(|d| CertificateDer::from(d.to_vec()))
        .collect();
    // Borrow raw PKCS8 bytes in the original zeroizing frame. There is no
    // application-owned key.to_vec allocation passed to a non-erasing API.
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key));
    let key = rustls::crypto::ring::sign::any_supported_type(&key).map_err(|_| Refusal::Tls)?;
    let certified = CertifiedKey::new(chain, key);
    certified.keys_match().map_err(|_| Refusal::Tls)?;
    Ok(Arc::new(certified))
}
fn chain(
    leaf: &CertificateDer<'_>,
    intermediate: &[CertificateDer<'_>],
    roots: &RootCertStore,
    lease: &Lease,
    now: UnixTime,
) -> Result<(), rustls::Error> {
    live(lease)?;
    if intermediate.len() >= 8 {
        return Err(tls_error());
    }
    certificate(leaf.as_ref(), lease).map_err(|_| tls_error())?;
    for der in intermediate {
        certificate(der.as_ref(), lease).map_err(|_| tls_error())?;
    }
    let parsed = rustls::server::ParsedCertificate::try_from(leaf)?;
    rustls::client::verify_server_cert_signed_by_trust_anchor(
        &parsed,
        roots,
        intermediate,
        now,
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .all,
    )?;
    live(lease)
}
struct Incoming {
    key: Arc<CertifiedKey>,
    lease: Arc<Lease>,
}
impl std::fmt::Debug for Incoming {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ReadIncomingIdentity")
    }
}
impl rustls::server::ResolvesServerCert for Incoming {
    fn resolve(&self, hello: rustls::server::ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        self.lease.current().ok()?;
        if hello.server_name() != Some("github.com") {
            return None;
        }
        self.key.key.choose_scheme(hello.signature_schemes())?;
        Some(self.key.clone())
    }
}
struct BrokerPeer {
    roots: Arc<RootCertStore>,
    key: Arc<CertifiedKey>,
    expected: String,
    lease: Arc<Lease>,
}
impl std::fmt::Debug for BrokerPeer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ReadBrokerIdentity")
    }
}
impl rustls::client::danger::ServerCertVerifier for BrokerPeer {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        intermediate: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        now: UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        live(&self.lease)?;
        uri(leaf.as_ref(), &self.expected, &self.lease).map_err(|_| tls_error())?;
        chain(leaf, intermediate, &self.roots, &self.lease, now)?;
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        sig: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        live(&self.lease)?;
        let result = rustls::crypto::verify_tls12_signature(
            message,
            cert,
            sig,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )?;
        live(&self.lease)?;
        Ok(result)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        sig: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        live(&self.lease)?;
        let result = rustls::crypto::verify_tls13_signature(
            message,
            cert,
            sig,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )?;
        live(&self.lease)?;
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
        self.lease.current().ok()?;
        self.key.key.choose_scheme(schemes)?;
        Some(self.key.clone())
    }
    fn has_certs(&self) -> bool {
        self.lease.current().is_ok()
    }
}
struct WebPeer {
    verifier: Arc<rustls::client::WebPkiServerVerifier>,
    lease: Arc<Lease>,
}
impl std::fmt::Debug for WebPeer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ReadPublicWebTrust")
    }
}
impl rustls::client::danger::ServerCertVerifier for WebPeer {
    fn verify_server_cert(
        &self,
        leaf: &CertificateDer<'_>,
        intermediate: &[CertificateDer<'_>],
        name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        live(&self.lease)?;
        if name != &ServerName::try_from("github.com").map_err(|_| tls_error())?
            || intermediate.len() >= 8
            || leaf.as_ref().len() > 65536
            || intermediate.iter().any(|c| c.as_ref().len() > 65536)
        {
            return Err(tls_error());
        }
        let result = self
            .verifier
            .verify_server_cert(leaf, intermediate, name, ocsp, now)?;
        live(&self.lease)?;
        Ok(result)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        sig: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        live(&self.lease)?;
        let result = self.verifier.verify_tls12_signature(message, cert, sig)?;
        live(&self.lease)?;
        Ok(result)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        sig: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        live(&self.lease)?;
        let result = self.verifier.verify_tls13_signature(message, cert, sig)?;
        live(&self.lease)?;
        Ok(result)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.verifier.supported_verify_schemes()
    }
}
#[derive(Clone)]
struct Materials {
    incoming: Arc<rustls::ServerConfig>,
    upstream: Arc<rustls::ClientConfig>,
    broker: Arc<rustls::ClientConfig>,
}
fn materials(start: &Initial, bytes: &[u8], lease: Arc<Lease>) -> Result<Materials, Refusal> {
    lease.current()?;
    let mut offset = 0;
    let incoming = certs(bytes, &mut offset, &start.layout.incoming)?;
    let incoming_key = take(bytes, &mut offset, start.layout.incoming_key)?;
    let web = certs(bytes, &mut offset, &start.layout.web)?;
    let driver = certs(bytes, &mut offset, &start.layout.driver)?;
    let driver_key = take(bytes, &mut offset, start.layout.driver_key)?;
    let broker = certs(bytes, &mut offset, &start.layout.broker)?;
    if offset != bytes.len() {
        return Err(Refusal::Bounds);
    }
    let cert = certificate(incoming[0], &lease)?;
    let san = cert
        .subject_alternative_name()
        .map_err(|_| Refusal::Tls)?
        .ok_or(Refusal::Tls)?;
    match san.value.general_names.as_slice() {
        [x509_parser::extensions::GeneralName::DNSName("github.com")] => {}
        _ => return Err(Refusal::Tls),
    }
    if cert
        .basic_constraints()
        .map_err(|_| Refusal::Tls)?
        .is_some_and(|b| b.value.ca)
    {
        return Err(Refusal::Tls);
    }
    uri(driver[0], &start.driver_id, &lease)?;
    let incoming = certified(&incoming, incoming_key, &lease)?;
    let driver = certified(&driver, driver_key, &lease)?;
    let broker_roots = roots(&broker, &lease)?;
    let web_roots = roots(&web, &lease)?;
    chain(
        &driver.cert[0],
        &driver.cert[1..],
        &broker_roots,
        &lease,
        UnixTime::now(),
    )
    .map_err(|_| Refusal::Tls)?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut incoming = rustls::ServerConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| Refusal::Tls)?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(Incoming {
            key: incoming,
            lease: lease.clone(),
        }));
    incoming.alpn_protocols = vec![b"http/1.1".to_vec()];
    incoming.max_early_data_size = 0;
    incoming.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    incoming.send_tls13_tickets = 0;
    let peer = Arc::new(BrokerPeer {
        roots: broker_roots,
        key: driver,
        expected: start.broker_id.clone(),
        lease: lease.clone(),
    });
    let mut broker = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|_| Refusal::Tls)?
        .dangerous()
        .with_custom_certificate_verifier(peer.clone())
        .with_client_cert_resolver(peer);
    broker.alpn_protocols = vec![ALPN.to_vec()];
    broker.enable_sni = false;
    broker.enable_early_data = false;
    broker.resumption = rustls::client::Resumption::disabled();
    let verifier =
        rustls::client::WebPkiServerVerifier::builder_with_provider(web_roots, provider.clone())
            .build()
            .map_err(|_| Refusal::Tls)?;
    let mut upstream = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| Refusal::Tls)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(WebPeer {
            verifier,
            lease: lease.clone(),
        }))
        .with_no_client_auth();
    upstream.alpn_protocols = vec![b"http/1.1".to_vec()];
    upstream.enable_early_data = false;
    upstream.resumption = rustls::client::Resumption::disabled();
    lease.current()?;
    Ok(Materials {
        incoming: Arc::new(incoming),
        upstream: Arc::new(upstream),
        broker: Arc::new(broker),
    })
}

struct Output {
    sender: Option<mpsc::SyncSender<(Vec<u8>, oneshot::Sender<Result<(), Refusal>>)>>,
    worker: Option<JoinHandle<Result<(), Refusal>>>,
}
impl Output {
    fn start(mut writer: impl Write + Send + 'static) -> Result<Self, Refusal> {
        let (sender, receiver) =
            mpsc::sync_channel::<(Vec<u8>, oneshot::Sender<Result<(), Refusal>>)>(1);
        let worker = std::thread::Builder::new()
            .name("read-control-output".into())
            .spawn(move || {
                while let Ok((bytes, reply)) = receiver.recv() {
                    let result = writer
                        .write_all(&(bytes.len() as u32).to_be_bytes())
                        .and_then(|_| writer.write_all(&0u32.to_be_bytes()))
                        .and_then(|_| writer.write_all(&bytes))
                        .and_then(|_| writer.flush())
                        .map_err(|_| Refusal::Io);
                    let failed = result.is_err();
                    if reply.send(result).is_err() || failed {
                        return Err(Refusal::Io);
                    }
                }
                Ok(())
            })
            .map_err(|_| Refusal::Io)?;
        Ok(Self {
            sender: Some(sender),
            worker: Some(worker),
        })
    }
    async fn send(&self, v: &Value) -> Result<(), Refusal> {
        let bytes = serde_json::to_vec(v).map_err(|_| Refusal::Protocol)?;
        if bytes.is_empty() || bytes.len() > META {
            return Err(Refusal::Bounds);
        }
        let (reply, done) = oneshot::channel();
        self.sender
            .as_ref()
            .ok_or(Refusal::Io)?
            .send((bytes, reply))
            .map_err(|_| Refusal::Io)?;
        done.await.map_err(|_| Refusal::Io)?
    }
    fn join(&mut self) -> Result<(), Refusal> {
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            worker.join().map_err(|_| Refusal::Io)??;
        }
        Ok(())
    }
}
struct InputGuard {
    lease: Arc<Lease>,
    returned: bool,
}
impl Drop for InputGuard {
    fn drop(&mut self) {
        if !self.returned {
            self.lease.fail();
        }
    }
}
struct Run {
    lease: Arc<Lease>,
    listener: Option<Arc<GitReadListener>>,
    material: Option<Materials>,
    input: Option<JoinHandle<Result<(), Refusal>>>,
    output: Output,
}
impl Run {
    fn reader(
        &mut self,
        mut reader: impl Read + Send + 'static,
        context: Context,
    ) -> Result<(), Refusal> {
        let lease = self.lease.clone();
        self.input = Some(
            std::thread::Builder::new()
                .name("read-control-input".into())
                .spawn(move || {
                    let mut guard = InputGuard {
                        lease: lease.clone(),
                        returned: false,
                    };
                    let result = (|| {
                        let raw = frame(&mut reader, false)?;
                        let v = &raw.metadata.0;
                        object(
                            v,
                            &[
                                "version",
                                "kind",
                                "incarnation",
                                "session_ref",
                                "source_generation",
                                "sequence",
                                "reason",
                            ],
                        )?;
                        context.matches(v, "cancel", 2)?;
                        let reason = match text(v, "reason")? {
                            "requested" => None,
                            "source-lost" => Some(Refusal::AuthorityUnavailable),
                            _ => return Err(Refusal::Protocol),
                        };
                        lease.stop(reason);
                        let mut extra = [0; 1];
                        if reader.read(&mut extra).map_err(|_| Refusal::Io)? != 0 {
                            return Err(Refusal::Protocol);
                        }
                        Ok(())
                    })();
                    if result.is_err() {
                        lease.fail();
                    }
                    guard.returned = true;
                    result
                })
                .map_err(|_| Refusal::Io)?,
        );
        Ok(())
    }
    async fn drain(&mut self) -> Result<(), Refusal> {
        let mut failure = None;
        if let Some(listener) = &self.listener {
            if let Err(e) = listener.retire().await {
                failure = Some(e);
                self.lease.fail();
            }
        }
        // Keep the actual reader handle until its successful return; EOF alone
        // neither clears this handle nor stands in for listener/worker joins.
        if let Some(input) = self.input.take() {
            match input.join() {
                Ok(Ok(())) => {}
                _ => {
                    failure = Some(Refusal::Protocol);
                    self.lease.fail();
                }
            }
        }
        if self.lease.failed.load(Ordering::Acquire) {
            return Err(failure.unwrap_or(Refusal::Protocol));
        }
        self.listener.take();
        self.material.take();
        Ok(())
    }
}
fn retain(run: Run) -> ! {
    // Unexpected history never drops a possibly live owner or invents a retire
    // receipt. The native original owner retains unresolved responsibility.
    let _original = run;
    loop {
        std::thread::park();
    }
}
async fn stopped(lease: &Lease) {
    let mut changed = lease.wake.subscribe();
    loop {
        if *changed.borrow() {
            return;
        }
        if changed.changed().await.is_err() {
            return;
        }
    }
}
fn code(reason: Refusal) -> &'static str {
    match reason {
        Refusal::Configuration => "Configuration",
        Refusal::AuthorityUnavailable => "AuthorityUnavailable",
        Refusal::Unsupported => "Unsupported",
        Refusal::Bounds => "Bounds",
        Refusal::Deadline => "Deadline",
        Refusal::Tls => "Tls",
        Refusal::Io => "Io",
        Refusal::Protocol => "Protocol",
    }
}
pub(super) async fn serve(
    listener: TcpListener,
    mut reader: impl Read + Send + 'static,
    writer: impl Write + Send + 'static,
) -> Result<(), Refusal> {
    // Pair clocks before any queued/read/decoding delay. No fresh post-decode
    // monotonic anchor can extend the original supplied validity horizon.
    let sample = Sample::capture()?;
    let raw = frame(&mut reader, true)?;
    let start = initial(&raw.metadata.0, raw.material.len(), sample)?;
    let address = listener.local_addr().map_err(|_| Refusal::Configuration)?;
    if !address.is_ipv4() {
        return Err(Refusal::Configuration);
    }
    let (wake, _) = watch::channel(false);
    let lease = Arc::new(Lease {
        stopped: AtomicBool::new(false),
        failed: AtomicBool::new(false),
        reason: Mutex::new(None),
        expires: start.expires,
        until_ms: start.until_ms,
        wake,
    });
    let output = Output::start(writer)?;
    let mut run = Run {
        lease: lease.clone(),
        listener: None,
        material: None,
        input: None,
        output,
    };
    if run.reader(reader, start.context.clone()).is_err() {
        retain(run);
    }
    let material = materials(&start, &raw.material, lease.clone());
    drop(raw);
    let context = start.context.clone();
    let ready = match material {
        Ok(material) => {
            // Retain these same configs beyond the listener's internal input
            // release until the control reader also physically joins.
            run.material = Some(material.clone());
            let broker = BrokerConfig {
                socket_path: start.path,
                peer_uid: start.peer_uid,
                trusted_ancestor_uids: start.ancestors,
                // SNI is disabled; this inert name never supplies peer identity.
                server_name: ServerName::from(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)),
                tls: material.broker,
                call_timeout: start.call,
                check_interval: start.check,
                max_clock_skew: start.skew,
            };
            let serving = tokio::net::TcpListener::from_std(listener)
                .map_err(|_| Refusal::Io)
                .and_then(|listener| {
                    lease.current()?;
                    GitReadListener::start(
                        listener,
                        start.repository,
                        material.incoming,
                        material.upstream,
                        broker,
                        start.attachment,
                        start.limits,
                        start.maximum,
                    )
                });
            match serving {
                Ok(listener) => {
                    run.listener = Some(listener);
                    Ok(())
                }
                Err(reason) => Err(reason),
            }
        }
        Err(reason) => {
            drop(listener);
            Err(reason)
        }
    };
    let mut first = context.frame(if ready.is_ok() { "ready" } else { "refused" }, 1);
    if let Err(reason) = ready {
        first["code"] = code(reason).into();
        lease.stop(Some(reason));
    } else {
        first["listener_address"] = address.to_string().into();
    }
    if run.output.send(&first).await.is_err() {
        lease.fail();
    }
    if ready.is_ok() {
        let listener = run.listener.as_ref().expect("retained listener").clone();
        tokio::select! {biased;
            _=stopped(&lease)=>{},
            _=tokio::time::sleep_until(lease.expires)=>lease.stop(Some(Refusal::Deadline)),
            _=listener.result()=>lease.fail(),
        }
    }
    if run.drain().await.is_err() {
        retain(run);
    }
    let mut retired = context.frame("retired", 2);
    retired["startup"] = if ready.is_ok() { "ready" } else { "refused" }.into();
    retired["reason"] = match lease.reason.lock() {
        Ok(reason) => reason
            .map(|v| Value::String(code(v).into()))
            .unwrap_or(Value::Null),
        Err(_) => retain(run),
    };
    if run.output.send(&retired).await.is_err() || run.output.join().is_err() {
        retain(run);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{
        BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
        KeyUsagePurpose, SanType,
    };
    use std::{io::Cursor, net::Shutdown, os::unix::net::UnixStream};
    const DRIVER: &str = "spiffe://fixture.test/read-driver";
    const BROKER: &str = "spiffe://fixture.test/read-broker";
    fn metadata() -> Value {
        let until = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60000;
        value!({"version":1,"kind":"start","incarnation":"a".repeat(32),"session_ref":"b".repeat(32),
            "source_generation":"c".repeat(64),"sequence":1,"valid_until_ms":until,
            "repository":{"owner":"fixture","name":"repo","commit":"d".repeat(40)},
            "attachment_ref":"fixture:original-read","profile":{"protocol_version":3,
                "operation_policy":"github-git-read-rpc-v3","transport_profile_ref":"owned-child-stdio-github-git-read-v3",
                "trust_domain":"fixture.test","crl_count":0,"driver_spiffe_id":DRIVER,"broker_spiffe_id":BROKER},
            "broker":{"socket_path":"/run/fixture/broker.sock","peer_uid":1,"trusted_ancestor_uids":[0,1],
                "call_timeout_ms":1000,"check_interval_ms":100,"max_clock_skew_ms":100},
            "limits":{"header_bytes":16384,"header_count":48,"request_bytes":262144,"response_bytes":2097152,
                "exchange_timeout_ms":5000,"maximum_connections":2},
            "material":{"incoming_chain":[1],"incoming_key":1,"public_web_roots":[1],
                "driver_chain":[1],"driver_key":1,"broker_roots":[1]}})
    }
    fn encoded(v: &Value, body: &[u8]) -> Vec<u8> {
        let metadata = serde_json::to_vec(v).unwrap();
        let mut result = (metadata.len() as u32).to_be_bytes().to_vec();
        result.extend((body.len() as u32).to_be_bytes());
        result.extend(metadata);
        result.extend(body);
        result
    }
    fn lease(start: &Initial) -> Arc<Lease> {
        let (wake, _) = watch::channel(false);
        Arc::new(Lease {
            stopped: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            reason: Mutex::new(None),
            expires: start.expires,
            until_ms: start.until_ms,
            wake,
        })
    }
    fn parsed(v: &Value, bytes: usize) -> Result<Initial, Refusal> {
        initial(v, bytes, Sample::capture().unwrap())
    }
    #[test]
    fn closed_start_profile_repository_lengths_and_real_listener_cap() {
        assert!(parsed(&metadata(), 6).is_ok());
        for fault in [
            "unknown",
            "version",
            "operation",
            "profile",
            "snapshot",
            "cross-domain",
            "crl",
            "capacity",
            "suffix",
            "path",
            "ancestor",
        ] {
            let mut v = metadata();
            let mut bytes = 6;
            match fault {
                "unknown" => v["provider_token"] = "refuse".into(),
                "version" => v["version"] = 2.into(),
                "operation" => {
                    v["profile"]["operation_policy"] = "github-metadata-read-rpc-v2".into()
                }
                "profile" => v["profile"]["transport_profile_ref"] = "arbitrary".into(),
                "snapshot" => v["repository"]["commit"] = "d".repeat(39).into(),
                "cross-domain" => {
                    v["profile"]["broker_spiffe_id"] = "spiffe://foreign.test/read-broker".into()
                }
                "crl" => v["profile"]["crl_count"] = 1.into(),
                "capacity" => v["limits"]["maximum_connections"] = 129.into(),
                "suffix" => bytes = 7,
                "path" => v["broker"]["socket_path"] = "/run/./broker.sock".into(),
                "ancestor" => v["broker"]["trusted_ancestor_uids"] = value!([0, 0]),
                _ => unreachable!(),
            }
            assert!(parsed(&v, bytes).is_err(), "{fault}");
        }
    }
    #[test]
    fn identity_and_reference_predicates_have_absolute_ends() {
        for bad in [
            "spiffe://fixture.test/a/",
            "spiffe://fixture.test/./a",
            "spiffe://fixture.test/a//b",
            "spiffe://fixture.test/a%2fb",
            "spiffe://fixture.test/a\n",
            "spiffe://fixture.test/a?b",
        ] {
            assert!(!spiffe(bad, "fixture.test"));
        }
        for bad in ["_first", "a+next", "a@next", "a\n", "a "] {
            assert!(!reference(bad));
        }
        assert!(spiffe(DRIVER, "fixture.test"));
        assert!(reference("a._:/-"));
    }
    #[test]
    fn path_and_safe_integer_limits_refuse_before_material_use() {
        for bad in ["relative", "/a//b", "/a/../b", "/a/b/", "/a b", "/a\nb"] {
            let mut v = metadata();
            v["broker"]["socket_path"] = bad.into();
            assert!(parsed(&v, 6).is_err());
        }
        let mut v = metadata();
        v["valid_until_ms"] = (SAFE + 1).into();
        assert!(parsed(&v, 6).is_err());
        let mut v = metadata();
        v["limits"]["maximum_connections"] = 128.into();
        assert!(parsed(&v, 6).is_ok());
    }
    struct Short<R>(R);
    impl<R: Read> Read for Short<R> {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            let n = b.len().min(1);
            self.0.read(&mut b[..n])
        }
    }
    #[test]
    fn original_frame_handles_short_reads_and_coalesced_records() {
        let v = metadata();
        let mut wire = encoded(&v, &[1, 2, 3, 4, 5, 6]);
        wire.extend(encoded(&value!({"next":true}), &[]));
        let mut input = Short(Cursor::new(wire));
        let first = frame(&mut input, true).unwrap();
        assert_eq!(&*first.material, &[1, 2, 3, 4, 5, 6]);
        assert!(parsed(&first.metadata.0, 6).is_ok());
        assert_eq!(frame(&mut input, false).unwrap().metadata.0["next"], true);
    }
    #[test]
    fn duplicate_metadata_suffix_on_control_truncation_and_prefix_caps_refuse() {
        let mut bytes = encoded(&value!({"a":1}), &[]);
        let text = br#"{"a":1,"\u0061":2}"#;
        bytes.clear();
        bytes.extend((text.len() as u32).to_be_bytes());
        bytes.extend(0u32.to_be_bytes());
        bytes.extend(text);
        assert!(matches!(
            frame(&mut Cursor::new(bytes), false),
            Err(Refusal::Protocol)
        ));
        assert!(matches!(
            frame(&mut Cursor::new(encoded(&value!({}), &[1])), false),
            Err(Refusal::Bounds)
        ));
        for (a, b) in [(0, 0), (META + 1, 0), (1, MATERIAL + 1)] {
            let mut bytes = (a as u32).to_be_bytes().to_vec();
            bytes.extend((b as u32).to_be_bytes());
            assert!(matches!(
                frame(&mut Cursor::new(bytes), true),
                Err(Refusal::Bounds)
            ));
        }
        let wire = encoded(&metadata(), &[1, 2, 3, 4, 5, 6]);
        assert!(matches!(
            frame(&mut Cursor::new(&wire[..wire.len() - 1]), true),
            Err(Refusal::Io)
        ));
    }
    #[test]
    fn original_predecode_monotonic_anchor_cannot_be_refreshed() {
        let mut v = metadata();
        let capture = Sample::capture().unwrap();
        v["valid_until_ms"] = (capture.wall.as_millis() as u64 + 1000).into();
        let prompt = initial(&v, 6, capture).unwrap();
        assert_eq!(
            prompt.expires,
            capture.monotonic + Duration::from_millis(v["valid_until_ms"].as_u64().unwrap())
                - capture.wall
        );
        let delayed = Sample {
            wall: capture.wall,
            monotonic: capture.monotonic - Duration::from_secs(2),
        };
        assert!(matches!(initial(&v, 6, delayed), Err(Refusal::Deadline)));
        v["valid_until_ms"] = (capture.wall.as_millis() as u64 + 86400001).into();
        assert!(initial(&v, 6, capture).is_err());
    }
    struct Fixture {
        metadata: Value,
        bytes: Zeroizing<Vec<u8>>,
        broker: CertificateDer<'static>,
    }
    fn fixture() -> Fixture {
        let mut ca = CertificateParams::default();
        ca.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        let key = KeyPair::generate().unwrap();
        let root = ca.self_signed(&key).unwrap();
        let issuer = Issuer::new(ca, key);
        let leaf = |san: SanType| {
            let mut p = CertificateParams::default();
            p.is_ca = IsCa::ExplicitNoCa;
            p.subject_alt_names = vec![san];
            p.key_usages = vec![KeyUsagePurpose::DigitalSignature];
            p.extended_key_usages = vec![
                ExtendedKeyUsagePurpose::ClientAuth,
                ExtendedKeyUsagePurpose::ServerAuth,
            ];
            let key = KeyPair::generate().unwrap();
            let cert = p.signed_by(&key, &issuer).unwrap();
            (cert.der().clone(), Zeroizing::new(key.serialize_der()))
        };
        let (incoming, ik) = leaf(SanType::DnsName("github.com".try_into().unwrap()));
        let (driver, dk) = leaf(SanType::URI(DRIVER.try_into().unwrap()));
        let (broker, _) = leaf(SanType::URI(BROKER.try_into().unwrap()));
        let mut metadata = metadata();
        metadata["material"] = value!({"incoming_chain":[incoming.len()],"incoming_key":ik.len(),
            "public_web_roots":[root.der().len()],"driver_chain":[driver.len()],"driver_key":dk.len(),"broker_roots":[root.der().len()]});
        let mut bytes = Zeroizing::new(Vec::new());
        for part in [
            incoming.as_ref(),
            ik.as_slice(),
            root.der().as_ref(),
            driver.as_ref(),
            dk.as_slice(),
            root.der().as_ref(),
        ] {
            bytes.extend_from_slice(part);
        }
        Fixture {
            metadata,
            bytes,
            broker,
        }
    }
    #[test]
    fn actual_material_constructor_matches_keys_and_fixed_tls_profiles() {
        let fixture = fixture();
        let start = parsed(&fixture.metadata, fixture.bytes.len()).unwrap();
        let lease = lease(&start);
        let material = materials(&start, &fixture.bytes, lease.clone()).unwrap();
        assert_eq!(material.incoming.alpn_protocols, vec![b"http/1.1".to_vec()]);
        assert_eq!(material.incoming.send_tls13_tickets, 0);
        assert!(!material.incoming.session_storage.can_cache());
        assert_eq!(material.broker.alpn_protocols, vec![ALPN.to_vec()]);
        assert!(!material.broker.enable_sni);
        assert!(material.broker.client_auth_cert_resolver.has_certs());
        assert_eq!(material.upstream.alpn_protocols, vec![b"http/1.1".to_vec()]);
        lease.stop(Some(Refusal::AuthorityUnavailable));
        assert!(!material.broker.client_auth_cert_resolver.has_certs());
    }
    #[test]
    fn actual_material_refuses_valid_wrong_key_untrusted_driver_wrong_uri_and_loss() {
        for fault in ["key", "trust", "uri", "loss"] {
            let mut fixture = fixture();
            if fault == "uri" {
                fixture.metadata["profile"]["driver_spiffe_id"] =
                    "spiffe://fixture.test/wrong".into();
            }
            if fault == "key" {
                // Valid PKCS8 for a different generated key: reach keys_match,
                // rather than merely exercising malformed DER rejection.
                let n = fixture.metadata["material"]["incoming_chain"][0]
                    .as_u64()
                    .unwrap() as usize;
                let old = fixture.metadata["material"]["incoming_key"]
                    .as_u64()
                    .unwrap() as usize;
                let wrong = Zeroizing::new(KeyPair::generate().unwrap().serialize_der());
                fixture.bytes.splice(n..n + old, wrong.iter().copied());
                fixture.metadata["material"]["incoming_key"] = wrong.len().into();
            }
            if fault == "trust" {
                // A valid independent CA must fail actual Driver path trust.
                let other = self::fixture();
                let other_len = other.metadata["material"]["broker_roots"][0]
                    .as_u64()
                    .unwrap() as usize;
                let old_len = fixture.metadata["material"]["broker_roots"][0]
                    .as_u64()
                    .unwrap() as usize;
                let end = fixture.bytes.len();
                fixture.bytes.splice(
                    end - old_len..end,
                    other.bytes[other.bytes.len() - other_len..].iter().copied(),
                );
                fixture.metadata["material"]["broker_roots"][0] = other_len.into();
            }
            let start = parsed(&fixture.metadata, fixture.bytes.len()).unwrap();
            let lease = lease(&start);
            if fault == "loss" {
                lease.stop(Some(Refusal::AuthorityUnavailable));
            }
            assert!(materials(&start, &fixture.bytes, lease).is_err(), "{fault}");
        }
    }
    #[test]
    fn actual_broker_verifier_requires_original_uri_trust_and_live_generation() {
        let f = fixture();
        let start = parsed(&f.metadata, f.bytes.len()).unwrap();
        let lease = lease(&start);
        let mut offset = 0;
        certs(&f.bytes, &mut offset, &start.layout.incoming).unwrap();
        take(&f.bytes, &mut offset, start.layout.incoming_key).unwrap();
        certs(&f.bytes, &mut offset, &start.layout.web).unwrap();
        let driver = certs(&f.bytes, &mut offset, &start.layout.driver).unwrap();
        let key = take(&f.bytes, &mut offset, start.layout.driver_key).unwrap();
        let ca = certs(&f.bytes, &mut offset, &start.layout.broker).unwrap();
        let peer = BrokerPeer {
            roots: roots(&ca, &lease).unwrap(),
            key: certified(&driver, key, &lease).unwrap(),
            expected: BROKER.into(),
            lease: lease.clone(),
        };
        let name = ServerName::from(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
        assert!(peer
            .verify_server_cert(&f.broker, &[], &name, &[], UnixTime::now())
            .is_ok());
        assert!(peer
            .verify_server_cert(&peer.key.cert[0], &[], &name, &[], UnixTime::now())
            .is_err());
        lease.stop(Some(Refusal::AuthorityUnavailable));
        assert!(peer
            .verify_server_cert(&f.broker, &[], &name, &[], UnixTime::now())
            .is_err());
    }
    fn cancel(context: &Context, reason: &str) -> Vec<u8> {
        let mut v = context.frame("cancel", 2);
        v["reason"] = reason.into();
        encoded(&v, &[])
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_control_reader_requires_cancel_then_actual_halfclose_join() {
        let start = parsed(&metadata(), 6).unwrap();
        let lease = lease(&start);
        let (input, mut parent) = UnixStream::pair().unwrap();
        let mut run = Run {
            lease: lease.clone(),
            listener: None,
            material: None,
            input: None,
            output: Output::start(Vec::new()).unwrap(),
        };
        run.reader(input, start.context.clone()).unwrap();
        parent
            .write_all(&cancel(&start.context, "requested"))
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), stopped(&lease))
            .await
            .unwrap();
        assert!(
            !run.input.as_ref().unwrap().is_finished(),
            "reader must wait for original halfclose"
        );
        parent.shutdown(Shutdown::Write).unwrap();
        assert!(run.drain().await.is_ok());
        assert!(run.input.is_none());
        run.output.join().unwrap();
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn actual_control_trailing_wrong_context_and_thread_panic_are_sticky() {
        for fault in ["trailing", "context", "eof", "panic"] {
            let start = parsed(&metadata(), 6).unwrap();
            let lease = lease(&start);
            let mut run = Run {
                lease: lease.clone(),
                listener: None,
                material: None,
                input: None,
                output: Output::start(Vec::new()).unwrap(),
            };
            if fault == "panic" {
                run.reader(PanicRead, start.context.clone()).unwrap();
            } else {
                let mut data = cancel(&start.context, "source-lost");
                if fault == "trailing" {
                    data.push(1);
                }
                if fault == "eof" {
                    data.clear();
                }
                if fault == "context" {
                    let mut wrong = start.context.clone();
                    wrong.generation = "e".repeat(64);
                    data = cancel(&wrong, "requested");
                }
                run.reader(Cursor::new(data), start.context).unwrap();
            }
            assert!(run.drain().await.is_err(), "{fault}");
            assert!(run.input.is_none());
            assert!(lease.failed.load(Ordering::Acquire));
            run.output.join().unwrap();
        }
    }
    struct PanicRead;
    impl Read for PanicRead {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("controlled actual input worker failure")
        }
    }
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    #[tokio::test]
    async fn actual_output_failure_requires_consuming_failed_thread_join() {
        let mut out = Output::start(Broken).unwrap();
        assert_eq!(
            out.send(&value!({"kind":"retired"})).await,
            Err(Refusal::Io)
        );
        assert_eq!(out.join(), Err(Refusal::Io));
        assert!(out.worker.is_none());
    }
}
