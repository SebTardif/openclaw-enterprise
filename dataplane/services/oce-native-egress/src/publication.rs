//! Fixed publication transport driven only by the original authenticated native
//! owner. Comparison records and session locators never supply authorization.
pub use crate::broker_rpc::BrokerConfig;
use crate::{broker_rpc, json::OwnedJson, publication_protocol as protocol, Refusal};
use base64::Engine;
use ds_tlsproxy::swap::{substitute_authorization, FetchedCredential, SubstitutedHeader};
use ds_tlsproxy::telemetry_http::Fingerprint;
use http::{header, HeaderValue, Request, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UnixStream},
    sync::{oneshot, watch, Mutex as AsyncMutex, Semaphore},
    task::JoinHandle,
    time::{timeout_at, Instant},
};
use tokio_rustls::{client::TlsStream, TlsConnector};
use zeroize::{Zeroize, Zeroizing};

const ALPN: &[u8] = b"oce-github-publication-v1";
const METADATA: usize = 262144;
const MAX_TIME: u64 = 253402300799999;
const COMMON: &[&str] = &["version", "sequence", "session_ref"];
const BINDING: &[&str] = &["call_ref", "effect", "action_digest"];
const ROUTE: &[&str] = &[
    "repository_owner",
    "repository_name",
    "dns_binding_ref",
    "upstream_ipv4",
];
const PREPARED: &[&str] = &[
    "request_sha256",
    "body_sha256",
    "body_bytes",
    "peer_certificate_sha256",
];
const TIMES: &[&str] = &["server_time_ms", "valid_until_ms", "operation_until_ms"];

/// A factual original run result. Only this transport constructs one, after its
/// workers and upstream driver retire. The actual native supervisor must retain
/// it until its original observer accepts custody, even after operation-IPC loss.
pub struct RetiredPublication {
    observation: OwnedJson,
    terminal_recorded: bool,
}
impl RetiredPublication {
    pub fn inspect(&self) -> Value {
        self.observation.0.clone()
    }
    pub fn terminal_recorded(&self) -> bool {
        self.terminal_recorded
    }
}

struct Run {
    owner: Arc<()>,
    cancel: watch::Sender<bool>,
    result: watch::Sender<Option<Result<Arc<RetiredPublication>, Refusal>>>,
    handle: AsyncMutex<Option<JoinHandle<()>>>,
    owned: Arc<Mutex<Owned>>,
    stop: Arc<AtomicBool>,
    failed: AtomicBool,
}
/// Original physical-work ticket; dropping a caller future cannot cancel or
/// forget its retained task. Retirement explicitly cancels and joins that task.
#[derive(Clone)]
pub struct PublicationRun(Arc<Run>);

pub struct PublicationTransport {
    broker: BrokerConfig,
    upstream: Arc<rustls::ClientConfig>,
    operation_timeout: Duration,
    slots: Arc<Semaphore>,
    identity: Arc<()>,
    runs: Mutex<BTreeMap<String, Arc<Run>>>,
    seen: Mutex<BTreeSet<String>>,
    closing: AtomicBool,
    #[cfg(test)]
    endpoint: Option<SocketAddrV4>,
    #[cfg(test)]
    control: Option<Arc<tests::Control>>,
}
impl PublicationTransport {
    /// The original identity owner supplies actual trust/SVID configuration.
    /// There is no default broker, file token, grant callback or positive source.
    pub fn new(
        broker: BrokerConfig,
        upstream: Arc<rustls::ClientConfig>,
        operation_timeout: Duration,
        maximum_pending: usize,
    ) -> Result<Arc<Self>, Refusal> {
        broker.validate_for(ALPN)?;
        if upstream.alpn_protocols != [b"http/1.1".to_vec()]
            || upstream.enable_early_data
            || operation_timeout.is_zero()
            || operation_timeout > Duration::from_secs(120)
            || maximum_pending == 0
            || maximum_pending > 64
        {
            return Err(Refusal::Configuration);
        }
        let mut upstream = (*upstream).clone();
        upstream.resumption = rustls::client::Resumption::disabled();
        Ok(Arc::new(Self {
            broker,
            upstream: Arc::new(upstream),
            operation_timeout,
            slots: Arc::new(Semaphore::new(maximum_pending)),
            identity: Arc::new(()),
            runs: Mutex::new(BTreeMap::new()),
            seen: Mutex::new(BTreeSet::new()),
            closing: AtomicBool::new(false),
            #[cfg(test)]
            endpoint: None,
            #[cfg(test)]
            control: None,
        }))
    }

    /// Begins a connection to an already enrolled original native session. The
    /// peer supplies and recognizes the fixed candidate, capture, effect and call.
    /// No upstream HTTP request occurs before its separate committed response.
    pub fn serve_original(self: &Arc<Self>, session_ref: &str) -> Result<PublicationRun, Refusal> {
        session_reference(session_ref)?;
        let runtime = tokio::runtime::Handle::try_current().map_err(|_| Refusal::Configuration)?;
        if self.closing.load(Ordering::Acquire) {
            return Err(Refusal::AuthorityUnavailable);
        }
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Refusal::Bounds)?;
        {
            let mut seen = self.seen.lock().unwrap();
            // Bounded lifetime tombstones prevent a local repeated locator from
            // starting another operation, including after prepared retirement.
            if seen.len() >= 4096 || !seen.insert(session_ref.to_owned()) {
                return Err(Refusal::Bounds);
            }
        }
        let (cancel, receiver) = watch::channel(false);
        let (result, _) = watch::channel(None);
        let run = Arc::new(Run {
            owner: self.identity.clone(),
            cancel,
            result,
            handle: AsyncMutex::new(None),
            owned: Arc::new(Mutex::new(Owned::default())),
            stop: Arc::new(AtomicBool::new(false)),
            failed: AtomicBool::new(false),
        });
        let mut active = self.runs.lock().unwrap();
        if self.closing.load(Ordering::Acquire) {
            return Err(Refusal::AuthorityUnavailable);
        }
        active.insert(session_ref.to_owned(), run.clone());
        let owner = self.clone();
        let retained = run.clone();
        let reference = session_ref.to_owned();
        let handle = runtime.spawn(async move {
            let result = owner
                .execute(&reference, receiver, &retained.owned, &retained.stop)
                .await
                .map(Arc::new);
            drop(slot);
            retained.result.send_replace(Some(result));
        });
        *run.handle.try_lock().map_err(|_| Refusal::Protocol)? = Some(handle);
        drop(active);
        Ok(PublicationRun(run))
    }

    fn recognize(&self, run: &PublicationRun) -> Result<(), Refusal> {
        if Arc::ptr_eq(&run.0.owner, &self.identity) {
            Ok(())
        } else {
            Err(Refusal::Protocol)
        }
    }
    pub async fn result(&self, run: &PublicationRun) -> Result<Arc<RetiredPublication>, Refusal> {
        self.recognize(run)?;
        // Observe the original task itself, rather than treating a result-channel
        // message or an operation socket EOF as proof of physical completion.
        let _ = self.join_run(run).await;
        run.0.result.borrow().clone().ok_or(Refusal::Protocol)?
    }
    async fn join_run(&self, run: &PublicationRun) -> Result<(), Refusal> {
        let mut handle = run.0.handle.lock().await;
        if let Some(task) = handle.as_mut() {
            if task.await.is_err() {
                run.0.failed.store(true, Ordering::Release);
            }
            *handle = None;
        }
        // Also recover children retained before an unexpected worker failure.
        // Holding the same handle lock serializes concurrent retirement callers.
        drain(&run.0.owned, &run.0.stop).await;
        if run.0.owned.lock().unwrap().child_failed {
            run.0.failed.store(true, Ordering::Release);
        }
        if run.0.result.borrow().is_none() {
            let recovered = run
                .0
                .owned
                .lock()
                .unwrap()
                .observation
                .as_ref()
                .map(|value| {
                    Arc::new(RetiredPublication {
                        observation: OwnedJson(value.0.clone()),
                        terminal_recorded: false,
                    })
                })
                .ok_or(Refusal::Protocol);
            run.0.result.send_replace(Some(recovered));
        }
        if run.0.failed.load(Ordering::Acquire) {
            Err(Refusal::Protocol)
        } else {
            Ok(())
        }
    }
    /// Cancellation of this await leaves the original JoinHandle retained. A
    /// later call joins that same physical work; no timeout is a drain receipt.
    pub async fn retire(&self, run: &PublicationRun) -> Result<(), Refusal> {
        self.recognize(run)?;
        run.0.stop.store(true, Ordering::Release);
        run.0.cancel.send_replace(true);
        self.join_run(run).await?;
        self.runs
            .lock()
            .unwrap()
            .retain(|_, value| !Arc::ptr_eq(value, &run.0));
        Ok(())
    }
    pub async fn close(&self) -> Result<(), Refusal> {
        let runs: Vec<_> = {
            let active = self.runs.lock().unwrap();
            self.closing.store(true, Ordering::Release);
            active.values().cloned().map(PublicationRun).collect()
        };
        for run in &runs {
            run.0.cancel.send_replace(true);
        }
        let mut failed = false;
        for run in &runs {
            failed |= self.retire(run).await.is_err();
        }
        if failed {
            Err(Refusal::Protocol)
        } else {
            Ok(())
        }
    }

    async fn execute(
        &self,
        reference: &str,
        mut cancel: watch::Receiver<bool>,
        owned: &Arc<Mutex<Owned>>,
        stop: &Arc<AtomicBool>,
    ) -> Result<RetiredPublication, Refusal> {
        let outer = Instant::now() + self.operation_timeout;
        let (changes, mut lease) = watch::channel(Lease {
            until: outer,
            refusal: None,
        });
        let result = if *cancel.borrow() {
            Err(Refusal::Deadline)
        } else {
            tokio::select! {
                biased;
                _ = cancel.changed() => Err(Refusal::Deadline),
                reason = lost(&mut lease) => Err(reason),
                result = self.exchange(reference, outer, &changes, owned, stop) => result,
            }
        };
        drain(owned, stop).await;
        let (session, observation) = {
            let mut state = owned.lock().unwrap();
            (
                state.session.take(),
                state.observation.as_ref().map(|v| OwnedJson(v.0.clone())),
            )
        };
        let Some(observation) = observation else {
            return Err(result.err().unwrap_or(Refusal::Protocol));
        };
        let mut recorded = false;
        if let Some(session) = session {
            let mut session = session.lock().await;
            let mut terminal = binding(&observation.0)?;
            terminal["release_ref"] = session
                .release_ref
                .clone()
                .map_or(Value::Null, Value::String);
            terminal["outcome"] = observation.0["outcome"].clone();
            recorded = session
                .call("result-publication", terminal, true)
                .await
                .is_ok();
        }
        // A later check or terminal-channel failure cannot overwrite a factual
        // observation already obtained from the attributed fixed HTTP response.
        Ok(RetiredPublication {
            observation,
            terminal_recorded: recorded,
        })
    }

    async fn exchange(
        &self,
        reference: &str,
        outer: Instant,
        changes: &watch::Sender<Lease>,
        owned: &Arc<Mutex<Owned>>,
        stop: &Arc<AtomicBool>,
    ) -> Result<(), Refusal> {
        let channel = broker_rpc::Channel::connect_for(&self.broker, outer, ALPN).await?;
        let mut wire = Wire::new(channel.into_stream(), &self.broker, reference, outer)?;
        let opened = wire.call("open-publication", json!({}), false).await?;
        let plan = Arc::new(Plan::parse(&opened.value.0)?);
        wire.fixed = OwnedJson(binding(&opened.value.0)?);
        wire.route = OwnedJson(projection(&opened.value.0, ROUTE)?);
        wire.lease(&opened.value.0, opened.started, true)?;
        publish(changes, wire.deadline);
        let session = Arc::new(AsyncMutex::new(wire));
        {
            let mut owned = owned.lock().unwrap();
            owned.observation = Some(OwnedJson(json!({"call_ref": plan.call_ref,
                "effect": plan.effect.0, "action_digest": plan.action_digest,
                "outcome": {"kind":"not-dispatched"}})));
            owned.session = Some(session.clone());
        }
        let pack = opened.payload;
        let work_plan = plan.clone();
        let worker_stop = stop.clone();
        let (send, receive) = oneshot::channel();
        #[cfg(test)]
        let control = self.control.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let prepared = work_plan.body(pack, &worker_stop).and_then(|body| {
                let hash = bounded_sha256(&body, &worker_stop)?;
                #[cfg(test)]
                if let Some(control) = control {
                    control.enter(tests::Stage::Prepared, &worker_stop);
                }
                Ok((body, hash))
            });
            let _ = send.send(prepared);
        });
        owned.lock().unwrap().tasks.push(Task::new(worker));
        let (body, body_hash) = receive.await.map_err(|_| Refusal::Protocol)??;
        let request_hash = plan.request_digest(&body_hash, body.len());
        let address: Ipv4Addr = plan.address.parse().map_err(|_| Refusal::Protocol)?;
        let endpoint = self.endpoint(address)?;
        let socket = TcpStream::connect(endpoint)
            .await
            .map_err(|_| Refusal::Io)?;
        if socket.peer_addr().map_err(|_| Refusal::Io)? != SocketAddr::V4(endpoint) {
            return Err(Refusal::Io);
        }
        let tls = TlsConnector::from(self.upstream.clone())
            .connect(
                rustls_pki_types::ServerName::try_from(plan.host()).map_err(|_| Refusal::Tls)?,
                socket,
            )
            .await
            .map_err(|_| Refusal::Tls)?;
        if tls
            .get_ref()
            .1
            .alpn_protocol()
            .is_some_and(|v| v != b"http/1.1")
        {
            return Err(Refusal::Tls);
        }
        let peer = tls
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|c| c.first())
            .ok_or(Refusal::Tls)?;
        let peer_hash = broker_rpc::sha256(peer.as_ref());
        let (mut sender, driver) = hyper::client::conn::http1::Builder::new()
            .max_headers(64)
            .max_buf_size(16384)
            .handshake(TokioIo::new(tls))
            .await
            .map_err(|_| Refusal::Protocol)?;
        let driver = tokio::spawn(async move {
            let _ = driver.await;
        });
        owned.lock().unwrap().tasks.push(Task::new(driver));
        let mut committed = {
            let mut session = session.lock().await;
            session.prepared = OwnedJson(json!({"request_sha256": request_hash,
                "body_sha256": body_hash, "body_bytes": body.len(), "peer_certificate_sha256": peer_hash}));
            let request = session.operands(false)?;
            let committed = session.call("prepared-publication", request, false).await?;
            session.lease(&committed.value.0, committed.started, false)?;
            let release = string(&committed.value.0, "release_ref")?.to_owned();
            broker_rpc::reference(&release)?;
            session.release_ref = Some(release);
            publish(changes, session.deadline);
            committed
        };
        owned
            .lock()
            .unwrap()
            .observation
            .as_mut()
            .ok_or(Refusal::Protocol)?
            .0["outcome"] = json!({"kind":"unknown","pullRequest":null});
        let token = FetchedCredential::new(
            std::mem::take(&mut *committed.payload),
            Fingerprint::new("protected-publication-release"),
        );
        let encoded = credential(&token, plan.push)?;
        let monitor_session = session.clone();
        let monitor_changes = changes.clone();
        let interval = self.broker.check_interval;
        let monitor = tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let checked = async {
                    let mut session = monitor_session.lock().await;
                    let request = session.operands(true)?;
                    let frame = session.call("check-publication", request, false).await?;
                    session.lease(&frame.value.0, frame.started, false)?;
                    Ok::<Instant, Refusal>(session.deadline)
                }
                .await;
                match checked {
                    Ok(deadline) => publish(&monitor_changes, deadline),
                    Err(reason) => {
                        monitor_changes.send_replace(Lease {
                            until: Instant::now(),
                            refusal: Some(reason),
                        });
                        return;
                    }
                }
            }
        });
        owned.lock().unwrap().tasks.push(Task::new(monitor));
        // All direct copies needed by blocking work have their own erasing
        // owner. The monitor and hard lease continue polling during these scans.
        let work_plan = plan.clone();
        let worker_stop = stop.clone();
        let raw = Zeroizing::new(token.expose().to_vec());
        let spelling = Zeroizing::new(encoded.expose().to_vec());
        let (send, receive) = oneshot::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let checked = (|| {
                let secrets = [raw.as_slice(), spelling.as_slice()];
                let patterns = patterns(&secrets)?;
                if contains_json(&work_plan.candidate.0, &patterns, &worker_stop)?
                    || contains(&body, &patterns, &worker_stop)?
                {
                    return Err(Refusal::Unsupported);
                }
                if work_plan.push {
                    let length = integer(&work_plan.candidate.0["graph"], "packBytes")? as usize;
                    let offset = body.len().checked_sub(length).ok_or(Refusal::Protocol)?;
                    crate::git_pack::publication_graph(
                        &body[offset..],
                        &work_plan.proposed,
                        &work_plan.base_oid,
                        &work_plan.old,
                        &worker_stop,
                        &secrets,
                    )?;
                }
                Ok(body)
            })();
            let _ = send.send(checked);
        });
        owned.lock().unwrap().tasks.push(Task::new(worker));
        let body = receive.await.map_err(|_| Refusal::Protocol)??;
        let header = substitute_authorization(if plan.push { "Basic" } else { "Bearer" }, &encoded);
        let mut authorization =
            HeaderValue::from_maybe_shared(Bytes::from_owner(HeaderOwner(header)))
                .map_err(|_| Refusal::Protocol)?;
        authorization.set_sensitive(true);
        let mut request = Request::builder()
            .method("POST")
            .uri(plan.path())
            .header(header::HOST, plan.host())
            .header(header::ACCEPT, plan.accept())
            .header(header::ACCEPT_ENCODING, "identity")
            .header(header::CONTENT_TYPE, plan.content_type())
            .header(header::USER_AGENT, "oce-github-publication")
            .header(header::CONNECTION, "close")
            .header(header::CONTENT_LENGTH, body.len())
            .header(header::AUTHORIZATION, authorization);
        if !plan.push {
            request = request.header("x-github-api-version", "2022-11-28");
        }
        let mut request = request
            .body(Full::new(Bytes::from_owner(BodyOwner(body))))
            .map_err(|_| Refusal::Protocol)?;
        let informational = changes.clone();
        hyper::ext::on_informational(&mut request, move |_| {
            informational.send_replace(Lease {
                until: Instant::now(),
                refusal: Some(Refusal::Unsupported),
            });
        });
        session.lock().await.current()?;
        if stop.load(Ordering::Acquire) || changes.borrow().refusal.is_some() {
            return Err(Refusal::Deadline);
        }
        // The original use was consumed before committed was sent. This is the
        // only upstream submission, with the same retained body and TLS peer.
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| Refusal::Io)?;
        if changes.borrow().refusal.is_some() {
            return Err(Refusal::Unsupported);
        }
        let (parts, bytes) = acquire(response).await?;
        if changes.borrow().refusal.is_some() {
            return Err(Refusal::Unsupported);
        }
        let work_plan = plan.clone();
        let worker_stop = stop.clone();
        let raw = Zeroizing::new(token.expose().to_vec());
        let spelling = Zeroizing::new(encoded.expose().to_vec());
        let original = owned.clone();
        let (send, receive) = oneshot::channel();
        #[cfg(test)]
        let control = self.control.clone();
        let worker = tokio::task::spawn_blocking(move || {
            let observed = observe(
                &parts,
                &bytes,
                &work_plan,
                &[raw.as_slice(), spelling.as_slice()],
                &worker_stop,
            );
            if let Ok(outcome) = &observed {
                // Enroll the actual attributed observation before outward
                // notification. Cancellation of the receiver cannot discard it.
                if let Some(value) = original.lock().unwrap().observation.as_mut() {
                    value.0["outcome"] = outcome.0.clone();
                }
                #[cfg(test)]
                if let Some(control) = control {
                    control.enter(tests::Stage::Observed, &worker_stop);
                }
            }
            let _ = send.send(observed.map(|_| ()));
        });
        owned.lock().unwrap().tasks.push(Task::new(worker));
        drop(encoded);
        drop(token);
        receive.await.map_err(|_| Refusal::Protocol)??;
        Ok(())
    }

    fn endpoint(&self, address: Ipv4Addr) -> Result<SocketAddrV4, Refusal> {
        #[cfg(test)]
        if let Some(endpoint) = self.endpoint {
            if address.is_loopback() && *endpoint.ip() == address {
                return Ok(endpoint);
            }
        }
        if !crate::dns::public_ipv4(address) {
            return Err(Refusal::Unsupported);
        }
        Ok(SocketAddrV4::new(address, 443))
    }
}

#[derive(Default)]
struct Owned {
    child_failed: bool,
    tasks: Vec<Arc<Task>>,
    session: Option<Arc<AsyncMutex<Wire>>>,
    observation: Option<OwnedJson>,
}
struct Task {
    handle: AsyncMutex<Option<JoinHandle<()>>>,
}
impl Task {
    fn new(handle: JoinHandle<()>) -> Arc<Self> {
        Arc::new(Self {
            handle: AsyncMutex::new(Some(handle)),
        })
    }
}
async fn drain(owned: &Arc<Mutex<Owned>>, stop: &AtomicBool) {
    stop.store(true, Ordering::Release);
    let tasks = owned.lock().unwrap().tasks.clone();
    // Retain every original handle throughout both awaits. Cancellation of a
    // recovery/retirement future cannot detach the work it was trying to join.
    for task in &tasks {
        let handle = task.handle.lock().await;
        if let Some(handle) = handle.as_ref() {
            handle.abort();
        }
    }
    for task in tasks {
        let mut handle = task.handle.lock().await;
        if let Some(task) = handle.as_mut() {
            // Abort cancellation is expected; panic/other join failure remains
            // sticky even after every original handle has physically joined.
            // Preserve any factual observation independently of this failure.
            if task.await.is_err_and(|error| !error.is_cancelled()) {
                owned.lock().unwrap().child_failed = true;
            }
            *handle = None;
        }
    }
}
struct BodyOwner(Zeroizing<Vec<u8>>);
impl AsRef<[u8]> for BodyOwner {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}
struct HeaderOwner(SubstitutedHeader);
impl AsRef<[u8]> for HeaderOwner {
    fn as_ref(&self) -> &[u8] {
        self.0.expose()
    }
}
#[derive(Clone, Copy)]
struct Lease {
    until: Instant,
    refusal: Option<Refusal>,
}
fn publish(sender: &watch::Sender<Lease>, until: Instant) {
    sender.send_modify(|lease| {
        if lease.refusal.is_none() {
            lease.until = until;
        }
    });
}
async fn lost(receiver: &mut watch::Receiver<Lease>) -> Refusal {
    loop {
        let lease = *receiver.borrow_and_update();
        if let Some(reason) = lease.refusal {
            return reason;
        }
        tokio::select! {
            _ = tokio::time::sleep_until(lease.until) => return Refusal::Deadline,
            changed = receiver.changed() => if changed.is_err() { return Refusal::AuthorityUnavailable; },
        }
    }
}

struct Frame {
    value: OwnedJson,
    payload: Zeroizing<Vec<u8>>,
    started: Instant,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum WireStage {
    Open,
    Prepare,
    Check,
    Terminal,
}
struct Wire {
    stage: WireStage,
    stream: TlsStream<UnixStream>,
    reference: String,
    sequence: u32,
    live: bool,
    terminal_only: bool,
    fixed: OwnedJson,
    route: OwnedJson,
    prepared: OwnedJson,
    release_ref: Option<String>,
    call_timeout: Duration,
    skew: Duration,
    origin: (Instant, u64),
    operation_until: Option<u64>,
    operation_deadline: Instant,
    deadline: Instant,
}
impl Wire {
    fn new(
        stream: TlsStream<UnixStream>,
        config: &BrokerConfig,
        reference: &str,
        outer: Instant,
    ) -> Result<Self, Refusal> {
        Ok(Self {
            stage: WireStage::Open,
            stream,
            reference: reference.to_owned(),
            sequence: 0,
            live: true,
            terminal_only: false,
            fixed: OwnedJson(json!({})),
            route: OwnedJson(json!({})),
            prepared: OwnedJson(json!({})),
            release_ref: None,
            call_timeout: config.call_timeout,
            skew: config.max_clock_skew,
            origin: (Instant::now(), broker_rpc::unix_ms()?),
            operation_until: None,
            operation_deadline: outer,
            deadline: outer,
        })
    }
    fn current(&self) -> Result<(), Refusal> {
        if !self.live || self.terminal_only {
            return Err(Refusal::AuthorityUnavailable);
        }
        if Instant::now() >= self.deadline {
            return Err(Refusal::Deadline);
        }
        let expected = self.origin.1 + self.origin.0.elapsed().as_millis() as u64;
        if broker_rpc::unix_ms()?.abs_diff(expected) > self.skew.as_millis() as u64 {
            return Err(Refusal::Deadline);
        }
        Ok(())
    }
    fn lease(&mut self, value: &Value, started: Instant, first: bool) -> Result<(), Refusal> {
        self.current()?;
        let server = integer(value, "server_time_ms")?;
        let until = integer(value, "valid_until_ms")?;
        let operation = integer(value, "operation_until_ms")?;
        if server >= until
            || until > operation
            || operation > MAX_TIME
            || (!first && self.operation_until != Some(operation))
        {
            return Err(Refusal::Deadline);
        }
        let expected = self.origin.1 + started.duration_since(self.origin.0).as_millis() as u64;
        if server.abs_diff(expected)
            > self.skew.as_millis() as u64 + started.elapsed().as_millis() as u64
        {
            return Err(Refusal::Deadline);
        }
        if first {
            self.operation_until = Some(operation);
            let horizon = operation
                .checked_sub(self.origin.1)
                .ok_or(Refusal::Deadline)?;
            self.operation_deadline = self
                .operation_deadline
                .min(self.origin.0 + Duration::from_millis(horizon));
        }
        let interval = Duration::from_millis(until - server)
            .checked_sub(self.skew)
            .ok_or(Refusal::Deadline)?;
        self.deadline = (started + interval).min(self.operation_deadline);
        self.current()
    }
    fn operands(&self, release: bool) -> Result<Value, Refusal> {
        let mut value = self.fixed.0.clone();
        let map = value.as_object_mut().ok_or(Refusal::Protocol)?;
        for source in [&self.route.0, &self.prepared.0] {
            for (key, value) in source.as_object().ok_or(Refusal::Protocol)? {
                map.insert(key.clone(), value.clone());
            }
        }
        if release {
            map.insert(
                "release_ref".into(),
                self.release_ref.clone().ok_or(Refusal::Protocol)?.into(),
            );
        }
        Ok(value)
    }
    async fn call(&mut self, method: &str, value: Value, terminal: bool) -> Result<Frame, Refusal> {
        if !self.live || (self.terminal_only && !terminal) {
            return Err(Refusal::AuthorityUnavailable);
        }
        let allowed = match method {
            "open-publication" => !terminal && self.stage == WireStage::Open,
            "prepared-publication" => !terminal && self.stage == WireStage::Prepare,
            "check-publication" => !terminal && self.stage == WireStage::Check,
            "result-publication" => {
                terminal && matches!(self.stage, WireStage::Prepare | WireStage::Check)
            }
            _ => false,
        };
        if !allowed {
            self.live = false;
            return Err(Refusal::Protocol);
        }
        if terminal {
            self.stage = WireStage::Terminal;
        } else {
            self.current()?;
        }
        self.sequence = self.sequence.checked_add(1).ok_or(Refusal::Protocol)?;
        let mut request = OwnedJson(value);
        let object = request.0.as_object_mut().ok_or(Refusal::Protocol)?;
        object.insert("version".into(), 1.into());
        object.insert("sequence".into(), self.sequence.into());
        object.insert("session_ref".into(), self.reference.clone().into());
        object.insert("method".into(), method.into());
        let encoded =
            Zeroizing::new(serde_json::to_vec(&request.0).map_err(|_| Refusal::Protocol)?);
        if encoded.is_empty() || encoded.len() > METADATA {
            return Err(Refusal::Bounds);
        }
        let started = Instant::now();
        let deadline = if terminal {
            started + self.call_timeout
        } else {
            self.deadline.min(started + self.call_timeout)
        };
        self.live = false;
        let exchange = async {
            self.stream
                .write_all(&(encoded.len() as u32).to_be_bytes())
                .await
                .map_err(|_| Refusal::Io)?;
            self.stream
                .write_all(&0u32.to_be_bytes())
                .await
                .map_err(|_| Refusal::Io)?;
            self.stream
                .write_all(&encoded)
                .await
                .map_err(|_| Refusal::Io)?;
            self.stream.flush().await.map_err(|_| Refusal::Io)?;
            let mut lengths = [0; 8];
            self.stream
                .read_exact(&mut lengths)
                .await
                .map_err(|_| Refusal::Io)?;
            let metadata = u32::from_be_bytes(lengths[..4].try_into().unwrap()) as usize;
            let payload = u32::from_be_bytes(lengths[4..].try_into().unwrap()) as usize;
            if metadata == 0 || metadata > METADATA {
                return Err(Refusal::Bounds);
            }
            let mut bytes = Zeroizing::new(vec![0; metadata]);
            self.stream
                .read_exact(&mut bytes)
                .await
                .map_err(|_| Refusal::Io)?;
            let value = OwnedJson(crate::json::parse(&bytes)?);
            if value.0["version"] != 1
                || value.0["sequence"] != self.sequence
                || value.0["session_ref"] != self.reference
            {
                return Err(Refusal::Protocol);
            }
            if value.0["ok"] == false {
                fields(&value.0, &[COMMON, &["ok", "code"]])?;
                if payload != 0 || !matches!(value.0["code"].as_str(), Some("denied" | "cancelled"))
                {
                    return Err(Refusal::Protocol);
                }
                self.terminal_only = true;
                self.live = true;
                return Err(Refusal::AuthorityUnavailable);
            }
            if value.0["ok"] != true {
                return Err(Refusal::Protocol);
            }
            let expected_phase = match method {
                "open-publication" => {
                    fields(
                        &value.0,
                        &[COMMON, BINDING, ROUTE, TIMES, &["ok", "phase", "candidate"]],
                    )?;
                    let push = value.0["effect"]["kind"] == "push";
                    if (push && !(32..=protocol::PACK_LIMIT).contains(&payload))
                        || (!push && payload != 0)
                    {
                        return Err(Refusal::Bounds);
                    }
                    "opened"
                }
                "prepared-publication" | "check-publication" => {
                    fields(
                        &value.0,
                        &[
                            COMMON,
                            BINDING,
                            ROUTE,
                            PREPARED,
                            TIMES,
                            &["ok", "phase", "release_ref"],
                        ],
                    )?;
                    if method == "prepared-publication" {
                        if !(1..=broker_rpc::TOKEN_LIMIT).contains(&payload) {
                            return Err(Refusal::Bounds);
                        }
                        "committed"
                    } else {
                        if payload != 0
                            || value.0["release_ref"].as_str() != self.release_ref.as_deref()
                        {
                            return Err(Refusal::Protocol);
                        }
                        "current"
                    }
                }
                "result-publication" => {
                    fields(
                        &value.0,
                        &[COMMON, BINDING, &["ok", "phase", "release_ref"]],
                    )?;
                    if payload != 0 || value.0["release_ref"] != request.0["release_ref"] {
                        return Err(Refusal::Protocol);
                    }
                    "recorded"
                }
                _ => return Err(Refusal::Protocol),
            };
            if value.0["phase"] != expected_phase {
                return Err(Refusal::Protocol);
            }
            self.stage = match expected_phase {
                "opened" => WireStage::Prepare,
                "committed" | "current" => WireStage::Check,
                _ => WireStage::Terminal,
            };
            for key in BINDING.iter().chain(ROUTE.iter()).chain(PREPARED.iter()) {
                if let Some(expected) = request.0.get(*key) {
                    if value.0.get(*key) != Some(expected) {
                        return Err(Refusal::Protocol);
                    }
                }
            }
            let mut payload = Zeroizing::new(vec![0; payload]);
            self.stream
                .read_exact(&mut payload)
                .await
                .map_err(|_| Refusal::Io)?;
            if expected_phase == "committed" && payload.iter().any(|b| !(b'!'..=b'~').contains(b)) {
                return Err(Refusal::Protocol);
            }
            Ok(Frame {
                value,
                payload,
                started,
            })
        };
        let result = timeout_at(deadline, exchange)
            .await
            .unwrap_or(Err(Refusal::Deadline));
        if result.is_ok() {
            self.live = !terminal;
        }
        result
    }
}

fn fields(value: &Value, groups: &[&[&str]]) -> Result<(), Refusal> {
    let object = value.as_object().ok_or(Refusal::Protocol)?;
    let expected: BTreeSet<_> = groups
        .iter()
        .flat_map(|keys| keys.iter().copied())
        .collect();
    if object.len() != expected.len() || object.keys().any(|key| !expected.contains(key.as_str())) {
        return Err(Refusal::Protocol);
    }
    Ok(())
}
fn projection(value: &Value, keys: &[&str]) -> Result<Value, Refusal> {
    let mut out = serde_json::Map::new();
    for key in keys {
        out.insert(
            (*key).into(),
            value.get(*key).ok_or(Refusal::Protocol)?.clone(),
        );
    }
    Ok(out.into())
}
fn binding(value: &Value) -> Result<Value, Refusal> {
    projection(value, BINDING)
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, Refusal> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Refusal::Protocol)
}
fn integer(value: &Value, key: &str) -> Result<u64, Refusal> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_TIME)
        .ok_or(Refusal::Protocol)
}
fn session_reference(value: &str) -> Result<(), Refusal> {
    if value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(Refusal::Protocol)
    }
}
fn digest_reference(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn publication_reference(value: &str) -> Result<(), Refusal> {
    if value.is_empty()
        || value.len() > 256
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b":._/@+-".contains(&b))
    {
        return Err(Refusal::Protocol);
    }
    Ok(())
}

struct Plan {
    candidate: OwnedJson,
    effect: OwnedJson,
    call_ref: String,
    action_digest: String,
    owner: String,
    repository: String,
    repository_id: String,
    address: String,
    push: bool,
    base: String,
    base_oid: String,
    target: String,
    old: String,
    proposed: String,
    title: String,
    body_text: String,
}
impl Plan {
    fn parse(value: &Value) -> Result<Self, Refusal> {
        let candidate = value.get("candidate").ok_or(Refusal::Protocol)?;
        fields(
            candidate,
            &[&["version", "work", "request", "graph", "actionDigest"]],
        )?;
        let request = &candidate["request"];
        let graph = &candidate["graph"];
        let work = &candidate["work"];
        fields(
            request,
            &[&[
                "version",
                "repository",
                "baseBranch",
                "baseOid",
                "targetBranch",
                "expectedTarget",
                "proposedOid",
                "draftPullRequest",
                "actions",
            ]],
        )?;
        fields(
            &request["repository"],
            &[&[
                "installationId",
                "githubHost",
                "appId",
                "githubInstallationId",
                "repositoryId",
            ]],
        )?;
        fields(&request["draftPullRequest"], &[&["title", "body", "draft"]])?;
        fields(
            graph,
            &[&[
                "version",
                "objectFormat",
                "proposedOid",
                "baseOid",
                "graphDigest",
                "objectCount",
                "rawBytes",
                "packSha256",
                "packBytes",
            ]],
        )?;
        fields(
            work,
            &[&[
                "installationId",
                "namespaceId",
                "agentId",
                "agentRevisionRef",
                "workRef",
                "workRevision",
                "authorityRef",
                "authorityRevision",
                "operationRef",
                "invocationRef",
                "requestDigest",
                "executionBindingDigest",
                "requesterPrincipalId",
            ]],
        )?;
        let effect = &value["effect"];
        fields(
            effect,
            &[&[
                "version",
                "effectRef",
                "kind",
                "candidateRef",
                "approvalRef",
                "actionDigest",
                "confirmedPushEffectRef",
            ]],
        )?;
        for key in [
            "installationId",
            "namespaceId",
            "agentId",
            "agentRevisionRef",
            "workRef",
            "authorityRef",
            "authorityRevision",
            "operationRef",
            "invocationRef",
            "requesterPrincipalId",
        ] {
            publication_reference(string(work, key)?)?;
        }
        for key in ["effectRef", "candidateRef", "approvalRef"] {
            publication_reference(string(effect, key)?)?;
        }
        for key in ["appId", "githubInstallationId", "repositoryId"] {
            if !protocol::decimal(string(&request["repository"], key)?) {
                return Err(Refusal::Protocol);
            }
        }
        publication_reference(string(&request["repository"], "installationId")?)?;
        let call_ref = string(value, "call_ref")?;
        publication_reference(call_ref)?;
        let owner = string(value, "repository_owner")?;
        let repository = string(value, "repository_name")?;
        broker_rpc::reference(string(value, "dns_binding_ref")?)?;
        let push = match string(effect, "kind")? {
            "push" => true,
            "create-draft-pr" => false,
            _ => return Err(Refusal::Protocol),
        };
        if push {
            if !effect["confirmedPushEffectRef"].is_null() {
                return Err(Refusal::Protocol);
            }
        } else {
            let confirmed = string(effect, "confirmedPushEffectRef")?;
            publication_reference(confirmed)?;
            if confirmed == string(effect, "effectRef")? {
                return Err(Refusal::Protocol);
            }
        }
        let base = string(request, "baseBranch")?;
        let target = string(request, "targetBranch")?;
        let base_oid = string(request, "baseOid")?;
        let proposed = string(request, "proposedOid")?;
        let expected = &request["expectedTarget"];
        let old = match string(expected, "kind")? {
            "create" => {
                fields(expected, &[&["kind"]])?;
                protocol::ZERO_OID
            }
            "existing" => {
                fields(expected, &[&["kind", "oid"]])?;
                let old = string(expected, "oid")?;
                if !protocol::oid(old) || old == proposed {
                    return Err(Refusal::Protocol);
                }
                old
            }
            _ => return Err(Refusal::Protocol),
        };
        let title = string(&request["draftPullRequest"], "title")?;
        let body_text = string(&request["draftPullRequest"], "body")?;
        let action_digest = string(value, "action_digest")?;
        if candidate["version"] != 1
            || request["version"] != 1
            || graph["version"] != 1
            || effect["version"] != 1
            || graph["objectFormat"] != "sha1"
            || request["repository"]["githubHost"] != "github.com"
            || request["repository"]["installationId"] != work["installationId"]
            || request["actions"] != json!(["push", "create-draft-pr"])
            || request["draftPullRequest"]["draft"] != true
            || integer(work, "workRevision")? == 0
            || !protocol::component(owner)
            || !protocol::component(repository)
            || !protocol::branch(base)
            || !protocol::branch(target)
            || base == target
            || !protocol::oid(base_oid)
            || !protocol::oid(proposed)
            || !protocol::text(title, body_text)
            || graph["baseOid"] != base_oid
            || graph["proposedOid"] != proposed
            || candidate["actionDigest"] != action_digest
            || effect["actionDigest"] != action_digest
            || !digest_reference(action_digest)
            || !digest_reference(string(work, "executionBindingDigest")?)
            || !digest_reference(string(graph, "graphDigest")?)
            || !digest_reference(string(graph, "packSha256")?)
            || !(1..=8192).contains(&integer(graph, "objectCount")?)
            || !(1..=67108864).contains(&integer(graph, "rawBytes")?)
            || !(32..=83886080).contains(&integer(graph, "packBytes")?)
            || string(work, "requestDigest")? != publication_digest("request", request)?
        {
            return Err(Refusal::Protocol);
        }
        let material = OwnedJson(projection(
            candidate,
            &["version", "work", "request", "graph"],
        )?);
        if action_digest != publication_digest("candidate-actions", &material.0)? {
            return Err(Refusal::Protocol);
        }
        Ok(Self {
            candidate: OwnedJson(candidate.clone()),
            effect: OwnedJson(effect.clone()),
            call_ref: call_ref.into(),
            action_digest: action_digest.into(),
            owner: owner.into(),
            repository: repository.into(),
            repository_id: string(&request["repository"], "repositoryId")?.into(),
            address: string(value, "upstream_ipv4")?.into(),
            push,
            base: base.into(),
            base_oid: base_oid.into(),
            target: target.into(),
            old: old.into(),
            proposed: proposed.into(),
            title: title.into(),
            body_text: body_text.into(),
        })
    }
    fn body(
        &self,
        pack: Zeroizing<Vec<u8>>,
        cancel: &AtomicBool,
    ) -> Result<Zeroizing<Vec<u8>>, Refusal> {
        if !self.push {
            if !pack.is_empty() || cancel.load(Ordering::Acquire) {
                return Err(Refusal::Protocol);
            }
            return protocol::draft_body(&self.base, &self.target, &self.title, &self.body_text);
        }
        let graph = &self.candidate.0["graph"];
        if pack.len() as u64 != integer(graph, "packBytes")?
            || bounded_sha256(&pack, cancel)? != string(graph, "packSha256")?
        {
            return Err(Refusal::Protocol);
        }
        let actual = crate::git_pack::publication_graph(
            &pack,
            &self.proposed,
            &self.base_oid,
            &self.old,
            cancel,
            &[],
        )?;
        if actual.object_count as u64 != integer(graph, "objectCount")?
            || actual.raw_bytes as u64 != integer(graph, "rawBytes")?
            || actual.graph_digest != string(graph, "graphDigest")?
        {
            return Err(Refusal::Protocol);
        }
        protocol::push_body(&self.target, &self.old, &self.proposed, pack)
    }
    fn host(&self) -> &'static str {
        if self.push {
            "github.com"
        } else {
            "api.github.com"
        }
    }
    fn path(&self) -> String {
        if self.push {
            format!("/{}/{}.git/git-receive-pack", self.owner, self.repository)
        } else {
            format!("/repos/{}/{}/pulls", self.owner, self.repository)
        }
    }
    fn accept(&self) -> &'static str {
        if self.push {
            "application/x-git-receive-pack-result"
        } else {
            "application/vnd.github+json"
        }
    }
    fn content_type(&self) -> &'static str {
        if self.push {
            "application/x-git-receive-pack-request"
        } else {
            "application/json"
        }
    }
    fn request_digest(&self, hash: &str, bytes: usize) -> String {
        broker_rpc::sha256(format!("oce.github.publication.v1\n{}\nPOST\nhttps\n{}\n443\n{}\naccept:{}\naccept-encoding:identity\ncontent-type:{}\nx-github-api-version:{}\nuser-agent:oce-github-publication\nconnection:close\nbody-bytes:{bytes}\nbody-sha256:{}\n",
            if self.push { "push" } else { "create-draft-pr" }, self.host(), self.path(), self.accept(), self.content_type(),
            if self.push { "" } else { "2022-11-28" }, &hash[7..]).as_bytes())
    }
}

impl Drop for Plan {
    fn drop(&mut self) {
        for value in [
            &mut self.call_ref,
            &mut self.action_digest,
            &mut self.owner,
            &mut self.repository,
            &mut self.repository_id,
            &mut self.address,
            &mut self.base,
            &mut self.base_oid,
            &mut self.target,
            &mut self.old,
            &mut self.proposed,
            &mut self.title,
            &mut self.body_text,
        ] {
            value.zeroize();
        }
    }
}

fn canonical_json(value: &Value) -> Result<Zeroizing<Vec<u8>>, Refusal> {
    fn append(out: &mut Zeroizing<Vec<u8>>, bytes: &[u8]) -> Result<(), Refusal> {
        if out
            .len()
            .checked_add(bytes.len())
            .is_none_or(|n| n > METADATA)
        {
            return Err(Refusal::Bounds);
        }
        out.extend_from_slice(bytes);
        Ok(())
    }
    fn encode(value: &Value, out: &mut Zeroizing<Vec<u8>>) -> Result<(), Refusal> {
        match value {
            Value::Array(values) => {
                append(out, b"[")?;
                for (i, v) in values.iter().enumerate() {
                    if i != 0 {
                        append(out, b",")?;
                    }
                    encode(v, out)?;
                }
                append(out, b"]")?;
            }
            Value::Object(values) => {
                append(out, b"{")?;
                let mut keys: Vec<_> = values.keys().collect();
                keys.sort();
                for (i, key) in keys.iter().enumerate() {
                    if i != 0 {
                        append(out, b",")?;
                    }
                    let escaped =
                        Zeroizing::new(serde_json::to_vec(key).map_err(|_| Refusal::Protocol)?);
                    append(out, &escaped)?;
                    append(out, b":")?;
                    encode(&values[*key], out)?;
                }
                append(out, b"}")?;
            }
            _ => {
                let bytes =
                    Zeroizing::new(serde_json::to_vec(value).map_err(|_| Refusal::Protocol)?);
                append(out, &bytes)?;
            }
        }
        Ok(())
    }
    let mut bytes = Zeroizing::new(Vec::new());
    bytes
        .try_reserve_exact(METADATA)
        .map_err(|_| Refusal::Bounds)?;
    encode(value, &mut bytes)?;
    Ok(bytes)
}
fn publication_digest(domain: &str, value: &Value) -> Result<String, Refusal> {
    let bytes = canonical_json(value)?;
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    hash.update(format!("oce/repository-publication/v1/{domain}\0").as_bytes());
    hash.update(&bytes);
    Ok(format!(
        "sha256:{}",
        hash.finish()
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}
/// Bounded duplicate-aware supervisor comparison data. This parser supplies no
/// identity, session, Work, State, capture, credential or completion authority.
pub struct SupervisorRecord(OwnedJson);
impl SupervisorRecord {
    pub fn parse(bytes: &[u8]) -> Result<Self, Refusal> {
        if bytes.is_empty() || bytes.len() > METADATA {
            return Err(Refusal::Bounds);
        }
        Ok(Self(OwnedJson(crate::json::parse(bytes)?)))
    }
    pub fn value(&self) -> &Value {
        &self.0 .0
    }
    pub fn canonical_sha256(&self) -> Result<String, Refusal> {
        Ok(broker_rpc::sha256(&canonical_json(&self.0 .0)?))
    }
}

fn bounded_sha256(bytes: &[u8], stop: &AtomicBool) -> Result<String, Refusal> {
    let mut hash = ring::digest::Context::new(&ring::digest::SHA256);
    for chunk in bytes.chunks(65536) {
        if stop.load(Ordering::Acquire) {
            return Err(Refusal::Deadline);
        }
        hash.update(chunk);
    }
    Ok(format!(
        "sha256:{}",
        hash.finish()
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}

fn credential(token: &FetchedCredential, basic: bool) -> Result<FetchedCredential, Refusal> {
    let bytes = if basic {
        let mut raw = Zeroizing::new(Vec::with_capacity(15 + token.expose().len()));
        raw.extend_from_slice(b"x-access-token:");
        raw.extend_from_slice(token.expose());
        let length = base64::encoded_len(raw.len(), true).ok_or(Refusal::Bounds)?;
        let mut encoded = Zeroizing::new(vec![0; length]);
        let written = base64::engine::general_purpose::STANDARD
            .encode_slice(&raw, &mut *encoded)
            .map_err(|_| Refusal::Protocol)?;
        if written != length {
            return Err(Refusal::Protocol);
        }
        std::mem::take(&mut *encoded)
    } else {
        token.expose().to_vec()
    };
    Ok(FetchedCredential::new(
        bytes,
        Fingerprint::new("protected-publication-substitution"),
    ))
}

fn patterns<'a>(secrets: &[&'a [u8]]) -> Result<Vec<crate::git_pack::Pattern<'a>>, Refusal> {
    secrets
        .iter()
        .map(|s| crate::git_pack::Pattern::new(s))
        .collect()
}
fn contains(
    bytes: &[u8],
    patterns: &[crate::git_pack::Pattern<'_>],
    stop: &AtomicBool,
) -> Result<bool, Refusal> {
    for pattern in patterns {
        if pattern.matches(bytes, stop)? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn contains_json(
    value: &Value,
    patterns: &[crate::git_pack::Pattern<'_>],
    stop: &AtomicBool,
) -> Result<bool, Refusal> {
    if stop.load(Ordering::Acquire) {
        return Err(Refusal::Deadline);
    }
    match value {
        Value::String(text) => contains(text.as_bytes(), patterns, stop),
        Value::Array(values) => {
            for v in values {
                if contains_json(v, patterns, stop)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Value::Object(values) => {
            for (key, value) in values {
                if contains(key.as_bytes(), patterns, stop)?
                    || contains_json(value, patterns, stop)?
                {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        _ => Ok(false),
    }
}

async fn acquire(
    response: http::Response<Incoming>,
) -> Result<(http::response::Parts, Zeroizing<Vec<u8>>), Refusal> {
    let (parts, body) = response.into_parts();
    crate::http::headers(&parts.headers, 16384, 64)?;
    if parts
        .headers
        .get(header::CONTENT_ENCODING)
        .is_some_and(|v| v != "identity")
    {
        return Err(Refusal::Unsupported);
    }
    let mut body = crate::http::Bounded::new(body, protocol::RESPONSE_LIMIT as u64);
    let mut bytes = Zeroizing::new(Vec::new());
    bytes
        .try_reserve_exact(protocol::RESPONSE_LIMIT)
        .map_err(|_| Refusal::Bounds)?;
    while let Some(frame) = body.frame().await {
        bytes.extend_from_slice(frame?.data_ref().ok_or(Refusal::Unsupported)?);
    }
    Ok((parts, bytes))
}
fn observe(
    parts: &http::response::Parts,
    bytes: &[u8],
    plan: &Plan,
    secrets: &[&[u8]],
    stop: &AtomicBool,
) -> Result<OwnedJson, Refusal> {
    let patterns = patterns(secrets)?;
    if contains(bytes, &patterns, stop)? {
        return Err(Refusal::Unsupported);
    }
    if plan.push {
        if parts.status != StatusCode::OK
            || parts
                .headers
                .get(header::CONTENT_TYPE)
                .is_none_or(|v| v != "application/x-git-receive-pack-result")
        {
            return Err(Refusal::Protocol);
        }
        return Ok(OwnedJson(
            match protocol::push_status(bytes, &plan.target)? {
                protocol::PushStatus::Pushed => {
                    json!({"kind":"pushed", "ref":format!("refs/heads/{}", plan.target), "oldOid":plan.old, "newOid":plan.proposed})
                }
                protocol::PushStatus::Rejected => json!({"kind":"rejected", "reason":"upstream"}),
            },
        ));
    }
    if parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| !matches!(v, "application/json" | "application/json; charset=utf-8"))
    {
        return Err(Refusal::Protocol);
    }
    let parsed = OwnedJson(crate::json::parse(&bytes)?);
    if contains_json(&parsed.0, &patterns, stop)? {
        return Err(Refusal::Unsupported);
    }
    let (observation, same_repository) = protocol::pull_request(&parsed.0)?;
    let matches = parts.status == StatusCode::CREATED
        && same_repository
        && observation.repository_id == plan.repository_id
        && observation.url
            == format!(
                "https://github.com/{}/{}/pull/{}",
                plan.owner, plan.repository, observation.number
            )
        && observation.base_branch == plan.base
        && observation.base_oid == plan.base_oid
        && observation.head_branch == plan.target
        && observation.head_oid == plan.proposed
        && observation.title == plan.title
        && observation.body == plan.body_text
        && observation.draft;
    Ok(OwnedJson(
        json!({"kind":if matches {"draft-pr-created"} else {"unknown"}, "pullRequest":observation.value()}),
    ))
}

#[cfg(test)]
#[path = "publication_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "publication_retirement_tests.rs"]
mod retirement_tests;
