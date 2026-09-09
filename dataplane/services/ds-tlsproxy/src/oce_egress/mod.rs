// Modified for OpenClaw Enterprise.
//! Narrow OCE credential custody transport, in private qualification.
//!
//! Fixed HTTPS api.openai.com:443 /v1/responses. Each request requires separate
//! online authority and admitted-DNS services. No DS identity issuance, Host-
//! selected credentials, transparent forwarding, CONNECT, or local allow fallback.
mod engine;
mod http;
mod json;
mod rpc;
mod sse;

use crate::reoriginate::TrustRoots;
use rpc::{Admission, Binding, Lease, Rpc};
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use rustls_pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const REQUEST_LIMIT: usize = 16 * 1024 * 1024;
const CHECK_INTERVAL: Duration = Duration::from_millis(500);
const FIXED_HOST: &str = "api.openai.com";

/// Deliberately contains no request-derived text, target, credential, or handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Malformed,
    Unsupported,
    Bounds,
    Denied,
    Dependency,
    Timeout,
    Io,
    Tls,
    Configuration,
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Refusal {}

/// Administrator-owned configuration. Incoming TLS is required except explicit
/// loopback development HTTP. The workload must not read the provider key or UDS.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub listen: SocketAddr,
    pub listener_authority: String,
    pub authority_socket: PathBuf,
    pub dns_socket: PathBuf,
    pub provider_key_path: PathBuf,
    pub provider_binding_ref: String,
    pub credential_binding: rpc::CredentialBinding,
    pub root_ca_path: PathBuf,
    pub incoming_certificate_path: Option<PathBuf>,
    pub incoming_key_path: Option<PathBuf>,
    #[serde(default)]
    pub development_loopback_http: bool,
    pub max_concurrent: usize,
    pub response_idle_timeout_ms: u64,
}

pub struct Service {
    config: Config,
    authority: Rpc,
    dns: Rpc,
    tls: Arc<ClientConfig>,
    strict_roots: TrustRoots,
    incoming: Option<Arc<ServerConfig>>,
    // Only the module's real-TLS tests may substitute a local receiver port.
    origin_port: u16,
}
impl Service {
    pub fn load(path: PathBuf) -> Result<Arc<Self>, Refusal> {
        let bytes = read_bounded(&path, 64 * 1024)?;
        let value = json::parse(&bytes)?;
        let config: Config = serde_json::from_value(value).map_err(|_| Refusal::Configuration)?;
        Self::new(config).map(Arc::new)
    }
    fn new(config: Config) -> Result<Self, Refusal> {
        config.credential_binding.validate()?;
        if config.credential_binding.provider_binding_ref != config.provider_binding_ref {
            return Err(Refusal::Configuration);
        }
        if config.provider_binding_ref.is_empty()
            || config.provider_binding_ref.len() > 128
            || !config
                .provider_binding_ref
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            || config.max_concurrent == 0
            || config.max_concurrent > 8
            || !(100..=300_000).contains(&config.response_idle_timeout_ms)
            || config.listener_authority.is_empty()
            || config.listener_authority.len() > 253
            || !config
                .listener_authority
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".:-[]".contains(&b))
            || !config.authority_socket.is_absolute()
            || !config.dns_socket.is_absolute()
            || !config.provider_key_path.is_absolute()
        {
            return Err(Refusal::Configuration);
        }
        let pem = read_bounded(&config.root_ca_path, 1024 * 1024)?;
        let certs = CertificateDer::pem_slice_iter(&pem)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| Refusal::Configuration)?;
        if certs.is_empty() {
            return Err(Refusal::Configuration);
        }
        let strict_roots =
            TrustRoots::from_der_roots(&certs).map_err(|_| Refusal::Configuration)?;
        let mut roots = RootCertStore::empty();
        for cert in certs {
            roots.add(cert).map_err(|_| Refusal::Configuration)?;
        }
        let mut tls = ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let incoming = match (&config.incoming_certificate_path, &config.incoming_key_path) {
            (Some(cert), Some(key)) if !config.development_loopback_http => {
                let chain = CertificateDer::pem_slice_iter(&read_bounded(cert, 1024 * 1024)?)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|_| Refusal::Configuration)?;
                let key_pem = Zeroizing::new(read_bounded(key, 64 * 1024)?);
                let key =
                    PrivateKeyDer::from_pem_slice(&key_pem).map_err(|_| Refusal::Configuration)?;
                let mut server = ServerConfig::builder()
                    .with_no_client_auth()
                    .with_single_cert(chain, key)
                    .map_err(|_| Refusal::Configuration)?;
                server.alpn_protocols = vec![b"http/1.1".to_vec()];
                Some(Arc::new(server))
            }
            (None, None)
                if config.development_loopback_http && config.listen.ip().is_loopback() =>
            {
                None
            }
            _ => return Err(Refusal::Configuration),
        };
        Ok(Self {
            authority: Rpc {
                path: config.authority_socket.clone(),
                peer_uid: 10003,
                authority: true,
            },
            dns: Rpc {
                path: config.dns_socket.clone(),
                peer_uid: 0,
                authority: false,
            },
            config,
            tls: Arc::new(tls),
            strict_roots,
            incoming,
            origin_port: 443,
        })
    }
    pub fn ready(&self) -> Result<(), Refusal> {
        let a = self.authority.ready()?;
        let d = self.dns.ready()?;
        a.current()?;
        d.current()
    }
    pub fn run(self: Arc<Self>) -> Result<(), Refusal> {
        self.ready()?;
        let listener = TcpListener::bind(self.config.listen).map_err(|_| Refusal::Io)?;
        let active = Arc::new(AtomicUsize::new(0));
        for socket in listener.incoming() {
            let socket = socket.map_err(|_| Refusal::Io)?;
            if active
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                    (n < self.config.max_concurrent).then_some(n + 1)
                })
                .is_err()
            {
                drop(socket);
                continue;
            }
            let service = self.clone();
            let slot = Slot(active.clone());
            // Construct the slot before spawn so a resource failure drops the
            // closure and returns its concurrency reservation immediately.
            let _ = thread::Builder::new()
                .name("oce-exchange".into())
                .spawn(move || {
                    let _slot = slot;
                    // Normal receipts go to authority; lost/malformed admission replies
                    // remain unknown and require authoritative reconciliation.
                    // Errors intentionally emit no raw request/body/credential values.
                    let _ = service.handle(socket);
                });
        }
        Err(Refusal::Io)
    }
    fn handle(&self, socket: TcpStream) -> Result<(), Refusal> {
        engine::handle(self, socket)
    }
}
// Independent socket shutdown also bounds rustls internal handshake/read loops.
struct SocketDeadline {
    done: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl SocketDeadline {
    fn new(socket: TcpStream, deadline: Instant) -> Result<Self, Refusal> {
        let done = Arc::new(AtomicBool::new(false));
        let flag = done.clone();
        let worker = thread::Builder::new()
            .name("oce-deadline".into())
            .spawn(move || {
                thread::park_timeout(deadline.saturating_duration_since(Instant::now()));
                if !flag.load(Ordering::Acquire) {
                    let _ = socket.shutdown(Shutdown::Both);
                }
            })
            .map_err(|_| Refusal::Io)?;
        Ok(Self {
            done,
            worker: Some(worker),
        })
    }
}
impl Drop for SocketDeadline {
    fn drop(&mut self) {
        self.done.store(true, Ordering::Release);
        if let Some(w) = self.worker.take() {
            w.thread().unpark();
            let _ = w.join();
        }
    }
}
// Response progress has an independent clock: a blocked currentness RPC or an
// unpolled/backpressured response body cannot postpone exact socket shutdown.
// One resettable worker per exchange is joined with the exchange's other work.
struct IdleDeadline {
    state: Arc<(Mutex<IdleState>, Condvar)>,
    timeout: Duration,
    worker: Option<thread::JoinHandle<()>>,
}
struct IdleState {
    deadline: Instant,
    stopped: bool,
    expired: bool,
}
impl IdleDeadline {
    fn start(
        timeout: Duration,
        dispatched_at: Instant,
        upstream: TcpStream,
        downstream: TcpStream,
    ) -> Result<Self, Refusal> {
        let deadline = dispatched_at.checked_add(timeout).ok_or(Refusal::Bounds)?;
        let state = Arc::new((
            Mutex::new(IdleState {
                deadline,
                stopped: false,
                expired: false,
            }),
            Condvar::new(),
        ));
        let owner = state.clone();
        let worker = thread::Builder::new()
            .name("oce-response-idle".into())
            .spawn(move || {
                let (lock, wake) = &*owner;
                let mut state = lock.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    if state.stopped {
                        return;
                    }
                    let remaining = state.deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        state.expired = true;
                        drop(state);
                        let _ = upstream.shutdown(Shutdown::Both);
                        let _ = downstream.shutdown(Shutdown::Both);
                        return;
                    }
                    // Recheck under the same lock after every wake, including
                    // spurious wakes; a reset never loses its notification.
                    state = wake
                        .wait_timeout(state, remaining)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            })
            .map_err(|_| Refusal::Io)?;
        Ok(Self {
            state,
            timeout,
            worker: Some(worker),
        })
    }
    fn current(&self) -> Result<(), Refusal> {
        let state = self.state.0.lock().map_err(|_| Refusal::Denied)?;
        if state.stopped || state.expired || Instant::now() >= state.deadline {
            Err(Refusal::Timeout)
        } else {
            Ok(())
        }
    }
    fn activity(&self) -> Result<(), Refusal> {
        let mut state = self.state.0.lock().map_err(|_| Refusal::Denied)?;
        let now = Instant::now();
        if state.stopped || state.expired || now >= state.deadline {
            return Err(Refusal::Timeout);
        }
        state.deadline = now.checked_add(self.timeout).ok_or(Refusal::Bounds)?;
        self.state.1.notify_one();
        Ok(())
    }
}
impl Drop for IdleDeadline {
    fn drop(&mut self) {
        {
            let mut state = self.state.0.lock().unwrap_or_else(|e| e.into_inner());
            state.stopped = true;
            self.state.1.notify_one();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Slot(Arc<AtomicUsize>);
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
fn recipient() -> Value {
    json!({"scheme":"https","host":FIXED_HOST,"port":443})
}
fn dns_request(
    method: &str,
    binding: &Binding,
    digest: &str,
    admission: Option<&Admission>,
) -> Value {
    let mut v = json!({"version":1,"method":method,"operation_id":binding.operation_id,"reservation_ref":binding.reservation_ref,"authority_instance_ref":binding.authority_instance_ref,"provider_binding_ref":binding.provider_binding_ref,"credential_binding":binding.credential_binding,"assignment_id":binding.assignment_id,"generation":binding.generation,"policy_version":binding.policy_version,"request_sha256":digest,"recipient":recipient(),"protocol":"tcp"});
    if let Some(a) = admission {
        v["ip"] = json!(a.ip.to_string());
        v["admission_id"] = json!(a.id);
        if let Some(c) = &a.connection_ref {
            v["connection_ref"] = json!(c);
        }
        if let Some(f) = &a.flow_ref {
            v["flow_ref"] = json!(f);
        }
    }
    v
}
fn check_authority(
    rpc: &Rpc,
    method: &str,
    binding: &Binding,
    digest: &str,
    deadline: Instant,
) -> Result<Lease, Refusal> {
    let (v,start)=rpc.call_until(&json!({"version":1,"method":method,"operation_id":binding.operation_id,"reservation_ref":binding.reservation_ref,"request_sha256":digest}),deadline)?;
    if Binding::parse(&v)? != *binding
        || binding.request_sha256 != digest
        || (matches!(method, "dispatch" | "check")
            && v.get("operation_state").and_then(Value::as_str) != Some("dispatched"))
    {
        return Err(Refusal::Denied);
    }
    rpc::lease(&v, start)
}
fn validate_dns_echo(v: &Value, binding: &Binding, digest: &str) -> Result<(), Refusal> {
    if v.get("operation_id").and_then(Value::as_str) != Some(binding.operation_id.as_str())
        || v.get("reservation_ref").and_then(Value::as_str)
            != Some(binding.reservation_ref.as_str())
        || v.get("request_sha256").and_then(Value::as_str) != Some(digest)
        || v.get("authority_instance_ref").and_then(Value::as_str)
            != Some(binding.authority_instance_ref.as_str())
        || v.get("provider_binding_ref").and_then(Value::as_str)
            != Some(binding.provider_binding_ref.as_str())
        || v.get("credential_binding")
            != Some(
                &serde_json::to_value(&binding.credential_binding)
                    .map_err(|_| Refusal::Malformed)?,
            )
        || v.get("recipient") != Some(&recipient())
        || v.get("protocol").and_then(Value::as_str) != Some("tcp")
    {
        return Err(Refusal::Denied);
    }
    Ok(())
}
fn check_dns(
    rpc: &Rpc,
    binding: &Binding,
    digest: &str,
    admission: &Admission,
    deadline: Instant,
) -> Result<Lease, Refusal> {
    let (v, start) = rpc.call_until(
        &dns_request("check", binding, digest, Some(admission)),
        deadline,
    )?;
    validate_dns_echo(&v, binding, digest)?;
    let renewed = Admission::parse(&v, start, binding)?;
    if renewed.ip != admission.ip
        || renewed.id != admission.id
        || v.get("connection_ref").and_then(Value::as_str) != admission.connection_ref.as_deref()
        || v.get("flow_ref").and_then(Value::as_str) != admission.flow_ref.as_deref()
    {
        return Err(Refusal::Denied);
    }
    Ok(renewed.lease)
}

pub(super) struct Monitor {
    deadline: Arc<Mutex<Instant>>,
    cancelled: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Monitor {
    #[allow(clippy::too_many_arguments)]
    fn start(
        authority: Rpc,
        dns: Rpc,
        binding: Binding,
        digest: String,
        admission: Admission,
        authority_lease: Lease,
        dns_lease: Lease,
        operation_deadline: Instant,
        upstream: TcpStream,
        downstream: TcpStream,
    ) -> Result<Self, Refusal> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        let expiry = Arc::new(Mutex::new(
            authority_lease
                .deadline
                .min(dns_lease.deadline)
                .min(operation_deadline),
        ));
        let expiry_writer = expiry.clone();
        let flag = cancelled.clone();
        let done = finished.clone();
        let worker = thread::Builder::new()
            .name("oce-currentness".into())
            .spawn(move || {
                let mut deadline = authority_lease
                    .deadline
                    .min(dns_lease.deadline)
                    .min(operation_deadline);
                while !done.load(Ordering::Acquire) {
                    let delay = deadline
                        .saturating_duration_since(Instant::now())
                        .min(CHECK_INTERVAL);
                    if delay.is_zero() {
                        break;
                    }
                    thread::park_timeout(delay);
                    if done.load(Ordering::Acquire) {
                        let _ = upstream.shutdown(Shutdown::Both);
                        let _ = downstream.shutdown(Shutdown::Read);
                        let _ =
                            dns.call(&dns_request("release", &binding, &digest, Some(&admission)));
                        return;
                    }
                    // Both calls share the previous expiry. A stalled dependency
                    // cannot extend a lease or delay cancellation beyond that expiry.
                    let renewed = (|| {
                        let a = check_authority(&authority, "check", &binding, &digest, deadline)?;
                        let d = check_dns(&dns, &binding, &digest, &admission, deadline)?;
                        a.current()?;
                        d.current()?;
                        Ok::<_, Refusal>(a.deadline.min(d.deadline).min(operation_deadline))
                    })();
                    match renewed {
                        Ok(next) => {
                            deadline = next;
                            *expiry_writer.lock().unwrap_or_else(|e| e.into_inner()) = next;
                        }
                        Err(_) => break,
                    }
                }
                flag.store(true, Ordering::Release);
                let _ = upstream.shutdown(Shutdown::Both);
                let _ = downstream.shutdown(Shutdown::Both);
                let _ = dns.call(&dns_request("release", &binding, &digest, Some(&admission)));
            })
            .map_err(|_| Refusal::Io)?;
        Ok(Self {
            deadline: expiry,
            cancelled,
            finished,
            worker: Some(worker),
        })
    }
    pub fn current(&self) -> Result<(), Refusal> {
        if self.cancelled.load(Ordering::Acquire)
            || Instant::now() >= *self.deadline.lock().map_err(|_| Refusal::Denied)?
        {
            Err(Refusal::Denied)
        } else {
            Ok(())
        }
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        self.finished.store(true, Ordering::Release);
        if let Some(w) = self.worker.take() {
            w.thread().unpark();
            let _ = w.join();
        }
    }
}

fn read_bounded(path: &PathBuf, max: usize) -> Result<Vec<u8>, Refusal> {
    let metadata = fs::metadata(path).map_err(|_| Refusal::Configuration)?;
    if !metadata.is_file() {
        return Err(Refusal::Configuration);
    }
    let mut data = Vec::new();
    fs::File::open(path)
        .map_err(|_| Refusal::Configuration)?
        .take((max + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| Refusal::Configuration)?;
    if data.len() > max {
        return Err(Refusal::Bounds);
    }
    Ok(data)
}
fn read_key(path: &PathBuf) -> Result<Zeroizing<String>, Refusal> {
    let data = Zeroizing::new(read_bounded(path, 8192)?);
    let key = std::str::from_utf8(&data)
        .map_err(|_| Refusal::Configuration)?
        .trim_end_matches('\n');
    if key.is_empty() || !key.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(Refusal::Configuration);
    }
    Ok(Zeroizing::new(key.to_owned()))
}

#[cfg(test)]
mod tests;
