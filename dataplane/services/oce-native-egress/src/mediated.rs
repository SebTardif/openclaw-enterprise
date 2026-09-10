//! Fixed repository metadata and explicitly selected Git read mediation. Configuration grants no authority: every
//! use requires the real broker's authenticated original-work admission/release.
pub use crate::broker_rpc::BrokerConfig;
use crate::{
    broker_rpc::{self, Session},
    git_protocol::{self, Command, Operation},
    http as native_http, Limits, Refusal, Repository,
};
use ::http::{header, HeaderValue, Method, Request, Response, StatusCode, Version};
use base64::Engine;
use ds_tlsproxy::swap::{substitute_authorization, FetchedCredential, SubstitutedHeader};
use ds_tlsproxy::telemetry_http::Fingerprint;
use http_body_util::{BodyExt, Full};
use hyper::{
    body::{Bytes, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use std::{
    convert::Infallible,
    io::Read,
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    net::TcpStream,
    sync::{oneshot, watch, Mutex as AsyncMutex, Semaphore},
    task::JoinHandle,
    time::{timeout_at, Instant},
};
use tokio_rustls::{TlsAcceptor, TlsConnector};
use zeroize::Zeroizing;

const HOST: &str = "api.github.com";
const EMPTY_SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const GIT_HOST: &str = "github.com";
const GIT_REQUEST_LIMIT: u64 = 4 * 1024 * 1024;
type Body = Full<Bytes>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Profile {
    Metadata,
    GitRead,
}
impl Profile {
    fn host(self) -> &'static str {
        match self {
            Self::Metadata => HOST,
            Self::GitRead => GIT_HOST,
        }
    }
}

/// A separate profile from native bearer-token forwarding. The trusted listener
/// supplies an original attachment locator; it is never read from HTTP headers.
/// The authentic broker must resolve that locator against its actual injector
/// identity and original Work. A copied locator/configuration is not an allow.
pub struct Mediator {
    profile: Profile,
    repository: Repository,
    incoming: Arc<rustls::ServerConfig>,
    upstream: Arc<rustls::ClientConfig>,
    broker: BrokerConfig,
    limits: Limits,
    concurrency: Semaphore,
    #[cfg(test)]
    test_endpoint: Option<SocketAddrV4>,
    #[cfg(test)]
    test_pack_control: Option<Arc<crate::git_pack::test_control::Control>>,
}
impl Mediator {
    pub fn new(
        repository: Repository,
        incoming: Arc<rustls::ServerConfig>,
        upstream: Arc<rustls::ClientConfig>,
        broker: BrokerConfig,
        limits: Limits,
        max_concurrent: usize,
    ) -> Result<Self, Refusal> {
        Self::with_profile(
            repository,
            incoming,
            upstream,
            broker,
            limits,
            max_concurrent,
            Profile::Metadata,
        )
    }

    /// Explicit Git protocol-v2 discovery/upload-pack successor. Requires the
    /// original Git-read admission and identity owner; metadata grants do not apply.
    pub fn new_git_read(
        repository: Repository,
        incoming: Arc<rustls::ServerConfig>,
        upstream: Arc<rustls::ClientConfig>,
        broker: BrokerConfig,
        limits: Limits,
        max_concurrent: usize,
    ) -> Result<Self, Refusal> {
        Self::with_profile(
            repository,
            incoming,
            upstream,
            broker,
            limits,
            max_concurrent,
            Profile::GitRead,
        )
    }

    fn with_profile(
        repository: Repository,
        incoming: Arc<rustls::ServerConfig>,
        upstream: Arc<rustls::ClientConfig>,
        broker: BrokerConfig,
        limits: Limits,
        max_concurrent: usize,
        profile: Profile,
    ) -> Result<Self, Refusal> {
        let limits = limits.validate()?;
        match profile {
            Profile::Metadata => broker.validate()?,
            Profile::GitRead => broker.validate_for(broker_rpc::GIT_ALPN)?,
        }
        let response_cap = if profile == Profile::Metadata {
            16 * 1024 * 1024
        } else {
            64 * 1024 * 1024
        };
        if incoming.alpn_protocols != [b"http/1.1".to_vec()]
            || incoming.max_early_data_size != 0
            || upstream.alpn_protocols != [b"http/1.1".to_vec()]
            || upstream.enable_early_data
            || max_concurrent == 0
            || max_concurrent > 1024
            || limits.response_bytes > response_cap
        {
            return Err(Refusal::Configuration);
        }
        let mut upstream_config = (*upstream).clone();
        upstream_config.resumption = rustls::client::Resumption::disabled();
        Ok(Self {
            profile,
            repository,
            incoming,
            upstream: Arc::new(upstream_config),
            broker,
            limits,
            concurrency: Semaphore::new(max_concurrent),
            #[cfg(test)]
            test_endpoint: None,
            #[cfg(test)]
            test_pack_control: None,
        })
    }

    /// Own exactly one accepted TLS/HTTP connection and its original attachment.
    /// No listener, trust source, attachment producer or production grant is
    /// synthesized here. All sockets and async drivers remain request-owned.
    pub async fn serve(&self, socket: TcpStream, attachment_ref: &str) -> Result<(), Refusal> {
        let _slot = self
            .concurrency
            .try_acquire()
            .map_err(|_| Refusal::Bounds)?;
        broker_rpc::reference(attachment_ref)?;
        let outer = Instant::now() + self.limits.exchange_timeout;
        let (changes, mut deadlines) = watch::channel(Lease {
            deadline: outer,
            refusal: None,
        });
        let state = Arc::new(Mutex::new(Owned::default()));
        let outcome = {
            let operation = async {
                let tls = TlsAcceptor::from(self.incoming.clone())
                    .accept(socket)
                    .await
                    .map_err(|_| Refusal::Tls)?;
                if tls.get_ref().1.server_name() != Some(self.profile.host())
                    || tls
                        .get_ref()
                        .1
                        .alpn_protocol()
                        .is_some_and(|a| a != b"http/1.1")
                {
                    return Err(Refusal::Tls);
                }
                // Equal duplicate Content-Length and TE+CL are normalized by
                // Hyper. Check the original bounded headers before that occurs.
                let tls = crate::ingress::checked(tls, self.limits).await?;
                let handler = service_fn(|request| {
                    let state = state.clone();
                    let changes = changes.clone();
                    async move {
                        let response = match self
                            .exchange(request, attachment_ref, outer, &state, &changes)
                            .await
                        {
                            Ok(response) => response,
                            Err(reason) => {
                                state.lock().unwrap().refusal = Some(reason);
                                unavailable(self.profile)
                            }
                        };
                        Ok::<_, Infallible>(response)
                    }
                });
                hyper::server::conn::http1::Builder::new()
                    .keep_alive(false)
                    .max_headers(self.limits.header_count)
                    .max_buf_size(self.limits.header_bytes)
                    .serve_connection(TokioIo::new(tls), handler)
                    .await
                    .map_err(|_| Refusal::Protocol)
            };
            tokio::select! {
                biased;
                reason = lost(&mut deadlines) => Err(reason),
                result = operation => result,
            }
        };
        // As in the native/DS transport, abort is followed by join. Dropping the
        // serve future still aborts via Task::drop; normal exits join every task.
        let (tasks, session, attempted, ready, refusal) = {
            let mut owned = state.lock().unwrap();
            (
                std::mem::take(&mut owned.tasks),
                owned.session.take(),
                owned.attempted,
                owned.ready,
                owned.refusal,
            )
        };
        for task in &tasks {
            task.cancel();
            if let Some(handle) = &task.handle {
                handle.abort();
            }
        }
        for mut task in tasks {
            if let Some(handle) = task.handle.take() {
                let _ = handle.await;
            }
        }
        let final_lease = *changes.borrow();
        let lease_result = if let Some(error) = final_lease.refusal {
            Err(error)
        } else if Instant::now() >= final_lease.deadline {
            Err(Refusal::Deadline)
        } else {
            Ok(())
        };
        let result = outcome.and(refusal.map_or(Ok(()), Err)).and(lease_result);
        if let Some(session) = session {
            let completion = if !attempted {
                "not-dispatched"
            } else if ready && result.is_ok() {
                "completed"
            } else {
                "unknown"
            };
            let receipt = timeout_at(Instant::now() + self.broker.call_timeout, async {
                session
                    .lock()
                    .await
                    .complete(completion, Instant::now() + self.broker.call_timeout)
                    .await
            })
            .await
            .unwrap_or(Err(Refusal::Deadline));
            result.and(receipt)
        } else {
            result
        }
    }

    async fn exchange(
        &self,
        request: Request<Incoming>,
        attachment: &str,
        outer: Instant,
        state: &Arc<Mutex<Owned>>,
        changes: &watch::Sender<Lease>,
    ) -> Result<Response<Body>, Refusal> {
        // No second/pipelined request can obtain another release on this socket.
        {
            let mut owned = state.lock().unwrap();
            if owned.request_seen {
                return Err(Refusal::Protocol);
            }
            owned.request_seen = true;
        }
        let (owner, name) = self.repository.components();
        let prepared = prepare(request, self.profile, owner, name, self.limits).await?;
        let opened = match prepared.git {
            None => {
                Session::open(
                    &self.broker,
                    attachment,
                    owner,
                    name,
                    &prepared.digest,
                    outer,
                )
                .await?
            }
            Some((operation, _)) => {
                Session::open_git_read(
                    &self.broker,
                    attachment,
                    owner,
                    name,
                    &prepared.digest,
                    outer,
                    operation_name(operation),
                    prepared.body.len() as u64,
                    &prepared.body_hash,
                )
                .await?
            }
        };
        let session = Arc::new(AsyncMutex::new(opened));
        let (address, deadline) = {
            let session = session.lock().await;
            (session.address, session.deadline)
        };
        state.lock().unwrap().session = Some(session.clone());
        publish_deadline(changes, deadline);
        let endpoint = self.endpoint(address)?;
        let socket = TcpStream::connect(endpoint)
            .await
            .map_err(|_| Refusal::Io)?;
        if socket.peer_addr().map_err(|_| Refusal::Io)? != SocketAddr::V4(endpoint) {
            return Err(Refusal::Io);
        }
        let tls = TlsConnector::from(self.upstream.clone())
            .connect(
                rustls_pki_types::ServerName::try_from(self.profile.host())
                    .map_err(|_| Refusal::Tls)?,
                socket,
            )
            .await
            .map_err(|_| Refusal::Tls)?;
        if tls
            .get_ref()
            .1
            .alpn_protocol()
            .is_some_and(|a| a != b"http/1.1")
        {
            return Err(Refusal::Tls);
        }
        let certificate = tls
            .get_ref()
            .1
            .peer_certificates()
            .and_then(|c| c.first())
            .ok_or(Refusal::Tls)?;
        let peer_digest = broker_rpc::sha256(certificate.as_ref());
        let (mut sender, driver) = hyper::client::conn::http1::Builder::new()
            .max_headers(self.limits.header_count)
            .max_buf_size(self.limits.header_bytes)
            .handshake(TokioIo::new(tls))
            .await
            .map_err(|_| Refusal::Protocol)?;
        state
            .lock()
            .unwrap()
            .tasks
            .push(Task::new(tokio::spawn(async move {
                let _ = driver.await;
            })));
        // Install online supervision before the effectful dispatch call. It is
        // independent of upstream body polling and downstream backpressure.
        let monitor_session = session.clone();
        let monitor_changes = changes.clone();
        let interval = self.broker.check_interval;
        let monitor = tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let result = {
                    let mut session = monitor_session.lock().await;
                    if session.release_ref.is_none() {
                        continue;
                    }
                    session.check().await
                };
                match result {
                    Ok(deadline) => {
                        publish_deadline(&monitor_changes, deadline);
                    }
                    Err(reason) => {
                        monitor_changes.send_replace(Lease {
                            deadline: Instant::now(),
                            refusal: Some(reason),
                        });
                        return;
                    }
                }
            }
        });
        state.lock().unwrap().tasks.push(Task::new(monitor));
        state.lock().unwrap().attempted = true;
        let raw = {
            let mut session = session.lock().await;
            let raw = session.dispatch(&peer_digest).await?;
            publish_deadline(changes, session.deadline);
            raw
        };
        // Reuse the actual DS substitution primitive, without its legacy
        // registry/NoSwap branch, grant cache or long-lived-key fetcher.
        let token = FetchedCredential::new(raw.take(), Fingerprint::new("protected-release"));
        // Git's fixed username and encoded password never enter a URL, argv or
        // guest configuration. Every directly owned encoding buffer is erased.
        let encoded = if self.profile == Profile::GitRead {
            Some(git_credential(&token)?)
        } else {
            None
        };
        let replacement = match &encoded {
            Some(value) => substitute_authorization("Basic", value),
            None => substitute_authorization("Bearer", &token),
        };
        let mut auth = HeaderValue::from_maybe_shared(Bytes::from_owner(HeaderOwner(replacement)))
            .map_err(|_| Refusal::Protocol)?;
        auth.set_sensitive(true);
        let mut builder = Request::builder()
            .method(prepared.method())
            .uri(&prepared.path)
            .version(Version::HTTP_11)
            .header(header::HOST, self.profile.host())
            .header(header::ACCEPT, prepared.accept())
            .header(header::ACCEPT_ENCODING, "identity")
            .header(
                header::USER_AGENT,
                if self.profile == Profile::GitRead {
                    "oce-github-git-read"
                } else {
                    "oce-github-mediation"
                },
            )
            .header(header::CONNECTION, "close")
            .header(header::AUTHORIZATION, auth);
        if let Some((operation, _)) = prepared.git {
            builder = builder.header("git-protocol", "version=2");
            if matches!(operation, Operation::UploadPack) {
                builder = builder
                    .header(
                        header::CONTENT_TYPE,
                        "application/x-git-upload-pack-request",
                    )
                    .header(header::CONTENT_LENGTH, prepared.body.len());
            }
        }
        let git = prepared.git;
        let mut outbound = builder
            .body(Full::new(Bytes::from_owner(BodyOwner(prepared.body))))
            .map_err(|_| Refusal::Protocol)?;
        // Hyper otherwise consumes 1xx replies internally. A later 200 must
        // not conceal an unsupported informational response.
        let informational_changes = changes.clone();
        hyper::ext::on_informational(&mut outbound, move |_| {
            informational_changes.send_replace(Lease {
                deadline: Instant::now(),
                refusal: Some(Refusal::Unsupported),
            });
        });
        session.lock().await.current()?;
        if let Some(reason) = changes.borrow().refusal {
            return Err(reason);
        }
        // Exactly one send; after it is polled, failure is an unknown outcome.
        let response = sender
            .send_request(outbound)
            .await
            .map_err(|_| Refusal::Protocol)?;
        if let Some(reason) = changes.borrow().refusal {
            return Err(reason);
        }
        let projection = match git {
            None => project(response, &token, owner, name, self.limits).await?,
            Some((operation, command)) => {
                project_git(
                    response,
                    &token,
                    encoded.as_ref().ok_or(Refusal::Protocol)?,
                    operation,
                    command,
                    self.limits,
                    state,
                    #[cfg(test)]
                    self.test_pack_control.clone(),
                )
                .await?
            }
        };
        drop(encoded);
        drop(token);
        let deadline = session.lock().await.check().await?;
        publish_deadline(changes, deadline);
        state.lock().unwrap().ready = true;
        Ok(projection)
    }

    fn endpoint(&self, address: Ipv4Addr) -> Result<SocketAddrV4, Refusal> {
        #[cfg(test)]
        if let Some(endpoint) = self.test_endpoint {
            if address == *endpoint.ip() && address.is_loopback() {
                return Ok(endpoint);
            }
        }
        // Fixed public GitHub port; protected DNS bindings still require the
        // broker's genuine current DNS/attachment owner at dispatch and checks.
        if !crate::dns::public_ipv4(address) {
            return Err(Refusal::Unsupported);
        }
        Ok(SocketAddrV4::new(address, 443))
    }
}

#[derive(Clone, Copy)]
struct Lease {
    deadline: Instant,
    refusal: Option<Refusal>,
}
#[derive(Default)]
struct Owned {
    tasks: Vec<Task>,
    session: Option<Arc<AsyncMutex<Session>>>,
    request_seen: bool,
    attempted: bool,
    ready: bool,
    refusal: Option<Refusal>,
}
struct Task {
    handle: Option<JoinHandle<()>>,
    stop: Option<Arc<AtomicBool>>,
}
impl Task {
    fn new(handle: JoinHandle<()>) -> Self {
        Self {
            handle: Some(handle),
            stop: None,
        }
    }
    fn cancel(&self) {
        if let Some(stop) = &self.stop {
            stop.store(true, Ordering::Release);
        }
    }
}
impl Drop for Task {
    fn drop(&mut self) {
        self.cancel();
        if let Some(task) = &self.handle {
            task.abort();
        }
    }
}
struct HeaderOwner(SubstitutedHeader);
impl AsRef<[u8]> for HeaderOwner {
    fn as_ref(&self) -> &[u8] {
        self.0.expose()
    }
}

fn publish_deadline(changes: &watch::Sender<Lease>, deadline: Instant) {
    changes.send_modify(|lease| {
        if lease.refusal.is_none() {
            lease.deadline = deadline;
        }
    });
}

async fn lost(deadlines: &mut watch::Receiver<Lease>) -> Refusal {
    loop {
        let lease = *deadlines.borrow_and_update();
        if let Some(reason) = lease.refusal {
            return reason;
        }
        tokio::select! {
            _=tokio::time::sleep_until(lease.deadline)=>return Refusal::Deadline,
            result=deadlines.changed()=>if result.is_err(){return Refusal::AuthorityUnavailable;},
        }
    }
}
fn validate_request(
    parts: &::http::request::Parts,
    path: &str,
    limits: Limits,
) -> Result<(), Refusal> {
    native_http::headers(&parts.headers, limits.header_bytes, limits.header_count)?;
    if parts.version != Version::HTTP_11
        || parts.method != Method::GET
        || parts.uri.scheme().is_some()
        || parts.uri.authority().is_some()
        || parts.uri.path() != path
        || parts.uri.query().is_some()
        || parts.headers.get(header::HOST).is_none_or(|h| h != HOST)
        || [
            header::AUTHORIZATION,
            header::PROXY_AUTHORIZATION,
            header::COOKIE,
            header::TRANSFER_ENCODING,
            header::CONTENT_ENCODING,
        ]
        .iter()
        .any(|h| parts.headers.contains_key(h))
        || parts
            .headers
            .get(header::CONTENT_LENGTH)
            .is_some_and(|h| h != "0")
    {
        return Err(Refusal::Unsupported);
    }
    Ok(())
}
fn request_digest(path: &str) -> String {
    broker_rpc::sha256(format!("oce.github.metadata.v2\nGET\nhttps\n{HOST}\n443\n{path}\naccept:application/vnd.github+json\naccept-encoding:identity\nuser-agent:oce-github-mediation\nconnection:close\nbody-sha256:{EMPTY_SHA}\n").as_bytes())
}
fn unavailable(profile: Profile) -> Response<Body> {
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header(header::CONNECTION, "close")
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Full::new(Bytes::from_static(match profile {
            Profile::Metadata => b"GitHub metadata unavailable.\n",
            Profile::GitRead => b"GitHub Git read unavailable.\n",
        })))
        .unwrap()
}

async fn project(
    response: Response<Incoming>,
    token: &FetchedCredential,
    owner: &str,
    name: &str,
    limits: Limits,
) -> Result<Response<Body>, Refusal> {
    let (parts, body) = response.into_parts();
    native_http::headers(&parts.headers, limits.header_bytes, limits.header_count)?;
    if parts.status != StatusCode::OK
        || parts
            .headers
            .get(header::CONTENT_ENCODING)
            .is_some_and(|v| v != "identity")
        || parts
            .headers
            .get(header::CONTENT_TYPE)
            .is_none_or(|v| v != "application/json" && v != "application/json; charset=utf-8")
    {
        return Err(Refusal::Unsupported);
    }
    let mut body = native_http::Bounded::new(body, limits.response_bytes);
    // Allocate before any reflected credential byte arrives, then never grow:
    // reallocation would free the previous secret-bearing allocation unwiped.
    let mut bytes = Zeroizing::new(Vec::new());
    bytes
        .try_reserve_exact(limits.response_bytes as usize)
        .map_err(|_| Refusal::Bounds)?;
    while let Some(frame) = body.frame().await {
        let frame = frame?;
        let data = frame.data_ref().ok_or(Refusal::Unsupported)?;
        bytes.extend_from_slice(data);
    }
    let value = crate::json::OwnedJson(crate::json::parse(&bytes)?);
    // Scan decoded strings too: escaped/chunk-split credential echoes must not
    // escape through a selected string field. Upstream headers are all dropped.
    if contains_token(&value.0, token.expose()) {
        return Err(Refusal::Unsupported);
    }
    let object = value.0.as_object().ok_or(Refusal::Protocol)?;
    let id = object
        .get("id")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or(Refusal::Protocol)?;
    let full_name = format!("{owner}/{name}");
    if object.get("name").and_then(Value::as_str) != Some(name)
        || object.get("full_name").and_then(Value::as_str) != Some(&full_name)
    {
        return Err(Refusal::Unsupported);
    }
    let private = object
        .get("private")
        .and_then(Value::as_bool)
        .ok_or(Refusal::Protocol)?;
    let branch = object
        .get("default_branch")
        .and_then(Value::as_str)
        .ok_or(Refusal::Protocol)?;
    if branch.is_empty()
        || branch.len() > 255
        || !branch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
    {
        return Err(Refusal::Unsupported);
    }
    let result=serde_json::to_vec(&serde_json::json!({"id":id,"name":name,"full_name":full_name,"private":private,"default_branch":branch})).map_err(|_|Refusal::Protocol)?;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONNECTION, "close")
        .body(Full::new(Bytes::from(result)))
        .unwrap())
}
fn contains_token(value: &Value, token: &[u8]) -> bool {
    match value {
        Value::String(s) => s.as_bytes().windows(token.len()).any(|w| w == token),
        Value::Array(values) => values.iter().any(|v| contains_token(v, token)),
        Value::Object(values) => values.iter().any(|(k, v)| {
            k.as_bytes().windows(token.len()).any(|w| w == token) || contains_token(v, token)
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod git_tests;

struct BodyOwner(Zeroizing<Vec<u8>>);
impl AsRef<[u8]> for BodyOwner {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}
struct Prepared {
    path: String,
    git: Option<(Operation, Option<Command>)>,
    digest: String,
    body_hash: String,
    body: Zeroizing<Vec<u8>>,
}
impl Prepared {
    fn method(&self) -> Method {
        if matches!(self.git, Some((Operation::UploadPack, _))) {
            Method::POST
        } else {
            Method::GET
        }
    }
    fn accept(&self) -> &'static str {
        match self.git {
            None => "application/vnd.github+json",
            Some((op, _)) => git_content_type(op),
        }
    }
}
fn operation_name(operation: Operation) -> &'static str {
    match operation {
        Operation::Discovery => "discovery",
        Operation::UploadPack => "upload-pack",
    }
}
fn git_content_type(operation: Operation) -> &'static str {
    match operation {
        Operation::Discovery => "application/x-git-upload-pack-advertisement",
        Operation::UploadPack => "application/x-git-upload-pack-result",
    }
}
async fn prepare(
    request: Request<Incoming>,
    profile: Profile,
    owner: &str,
    name: &str,
    limits: Limits,
) -> Result<Prepared, Refusal> {
    let (parts, mut body) = request.into_parts();
    if profile == Profile::Metadata {
        let path = format!("/repos/{owner}/{name}");
        validate_request(&parts, &path, limits)?;
        // Prove EOF before admission, including absence of trailers.
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| Refusal::Protocol)?;
            if frame.data_ref().is_none_or(|b| !b.is_empty()) {
                return Err(Refusal::Unsupported);
            }
        }
        return Ok(Prepared {
            digest: request_digest(&path),
            path,
            git: None,
            body_hash: broker_rpc::sha256(b""),
            body: Zeroizing::new(Vec::new()),
        });
    }
    let operation = validate_git_request(&parts, owner, name, limits)?;
    let compressed = parts.headers.contains_key(header::CONTENT_ENCODING);
    let mut bounded = native_http::Bounded::new(body, limits.request_bytes.min(GIT_REQUEST_LIMIT));
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(frame) = bounded.frame().await {
        let frame = frame?;
        let data = frame.data_ref().ok_or(Refusal::Unsupported)?;
        bytes.try_reserve(data.len()).map_err(|_| Refusal::Bounds)?;
        bytes.extend_from_slice(data);
    }
    let bytes = normalize_git_body(
        bytes,
        compressed,
        limits.request_bytes.min(GIT_REQUEST_LIMIT),
    )?;
    let command = match operation {
        Operation::Discovery => {
            if !bytes.is_empty() {
                return Err(Refusal::Unsupported);
            }
            None
        }
        Operation::UploadPack => Some(git_protocol::request(&bytes)?),
    };
    // The selected fetch profile requests self-contained packs: remove only the
    // validated thin-pack argument before binding the final outgoing bytes.
    let bytes = if command == Some(Command::Fetch) {
        git_protocol::without_thin_pack(bytes)?
    } else {
        bytes
    };
    let path = parts
        .uri
        .path_and_query()
        .ok_or(Refusal::Protocol)?
        .as_str()
        .to_owned();
    let body_hash = broker_rpc::sha256(&bytes);
    let digest = git_request_digest(operation, &path, bytes.len(), &body_hash);
    Ok(Prepared {
        path,
        git: Some((operation, command)),
        digest,
        body_hash,
        body: bytes,
    })
}
fn validate_git_request(
    parts: &::http::request::Parts,
    owner: &str,
    name: &str,
    limits: Limits,
) -> Result<Operation, Refusal> {
    native_http::headers(&parts.headers, limits.header_bytes, limits.header_count)?;
    if parts.version != Version::HTTP_11
        || parts.uri.scheme().is_some()
        || parts.uri.authority().is_some()
        || parts
            .headers
            .get(header::HOST)
            .is_none_or(|h| h != GIT_HOST)
        || parts
            .headers
            .get("git-protocol")
            .is_none_or(|h| h != "version=2")
        || [
            header::AUTHORIZATION,
            header::PROXY_AUTHORIZATION,
            header::COOKIE,
        ]
        .iter()
        .any(|h| parts.headers.contains_key(h))
        || parts
            .headers
            .get(header::CONTENT_ENCODING)
            .is_some_and(|h| h != "gzip")
    {
        return Err(Refusal::Unsupported);
    }
    let target = parts
        .uri
        .path_and_query()
        .ok_or(Refusal::Unsupported)?
        .as_str();
    let operation = if parts.method == Method::GET
        && target == format!("/{owner}/{name}.git/info/refs?service=git-upload-pack")
    {
        if [
            header::TRANSFER_ENCODING,
            header::CONTENT_ENCODING,
            header::CONTENT_TYPE,
        ]
        .iter()
        .any(|h| parts.headers.contains_key(h))
            || parts
                .headers
                .get(header::CONTENT_LENGTH)
                .is_some_and(|h| h != "0")
        {
            return Err(Refusal::Unsupported);
        }
        Operation::Discovery
    } else if parts.method == Method::POST
        && target == format!("/{owner}/{name}.git/git-upload-pack")
    {
        if parts
            .headers
            .get(header::CONTENT_TYPE)
            .is_none_or(|h| h != "application/x-git-upload-pack-request")
        {
            return Err(Refusal::Unsupported);
        }
        Operation::UploadPack
    } else {
        return Err(Refusal::Unsupported);
    };
    if let Some(length) = parts.headers.get(header::CONTENT_LENGTH) {
        let text = length.to_str().map_err(|_| Refusal::Protocol)?;
        if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Refusal::Protocol);
        }
        if text.parse::<u64>().map_err(|_| Refusal::Bounds)?
            > limits.request_bytes.min(GIT_REQUEST_LIMIT)
        {
            return Err(Refusal::Bounds);
        }
    }
    Ok(operation)
}
fn normalize_git_body(
    bytes: Zeroizing<Vec<u8>>,
    gzip: bool,
    limit: u64,
) -> Result<Zeroizing<Vec<u8>>, Refusal> {
    if bytes.len() as u64 > limit {
        return Err(Refusal::Bounds);
    }
    if !gzip {
        return Ok(bytes);
    }
    // bufread::GzDecoder consumes exactly one member and validates its CRC and
    // length on EOF. A bounded extra byte detects overflow without draining a
    // compression bomb; the remaining slice rejects extra members and tails.
    let mut decoder = flate2::bufread::GzDecoder::new(bytes.as_slice());
    let mut decoded = Zeroizing::new(Vec::new());
    decoded
        .try_reserve_exact((limit + 1) as usize)
        .map_err(|_| Refusal::Bounds)?;
    decoder
        .by_ref()
        .take(limit + 1)
        .read_to_end(&mut decoded)
        .map_err(|_| Refusal::Protocol)?;
    if decoded.len() as u64 > limit {
        return Err(Refusal::Bounds);
    }
    if !decoder.get_ref().is_empty() {
        return Err(Refusal::Protocol);
    }
    Ok(decoded)
}
fn git_request_digest(operation: Operation, path: &str, bytes: usize, body_hash: &str) -> String {
    let method = match operation {
        Operation::Discovery => "GET",
        Operation::UploadPack => "POST",
    };
    let content_type = match operation {
        Operation::Discovery => "",
        Operation::UploadPack => "application/x-git-upload-pack-request",
    };
    broker_rpc::sha256(format!("oce.github.git-read.v3\n{}\n{method}\nhttps\n{GIT_HOST}\n443\n{path}\naccept:{}\naccept-encoding:identity\ncontent-type:{content_type}\ngit-protocol:version=2\nuser-agent:oce-github-git-read\nconnection:close\nbody-bytes:{bytes}\nbody-sha256:{}\n", operation_name(operation), git_content_type(operation), &body_hash[7..]).as_bytes())
}
fn git_credential(token: &FetchedCredential) -> Result<FetchedCredential, Refusal> {
    const PREFIX: &[u8] = b"x-access-token:";
    let mut plaintext = Zeroizing::new(Vec::with_capacity(PREFIX.len() + token.expose().len()));
    plaintext.extend_from_slice(PREFIX);
    plaintext.extend_from_slice(token.expose());
    let encoded_len = base64::encoded_len(plaintext.len(), true).ok_or(Refusal::Bounds)?;
    let mut encoded = Zeroizing::new(vec![0; encoded_len]);
    let written = base64::engine::general_purpose::STANDARD
        .encode_slice(&plaintext, &mut encoded)
        .map_err(|_| Refusal::Protocol)?;
    if written != encoded_len {
        return Err(Refusal::Protocol);
    }
    Ok(FetchedCredential::new(
        std::mem::take(&mut *encoded),
        Fingerprint::new("protected-git-release"),
    ))
}
async fn project_git(
    response: Response<Incoming>,
    token: &FetchedCredential,
    encoded: &FetchedCredential,
    operation: Operation,
    command: Option<Command>,
    limits: Limits,
    state: &Arc<Mutex<Owned>>,
    #[cfg(test)] test_control: Option<Arc<crate::git_pack::test_control::Control>>,
) -> Result<Response<Body>, Refusal> {
    let (parts, body) = response.into_parts();
    native_http::headers(&parts.headers, limits.header_bytes, limits.header_count)?;
    if parts.status != StatusCode::OK
        || parts
            .headers
            .get(header::CONTENT_ENCODING)
            .is_some_and(|v| v != "identity")
        || parts
            .headers
            .get(header::CONTENT_TYPE)
            .is_none_or(|v| v != git_content_type(operation))
    {
        return Err(Refusal::Unsupported);
    }
    let mut body = native_http::Bounded::new(body, limits.response_bytes);
    let mut bytes = Zeroizing::new(Vec::new());
    bytes
        .try_reserve_exact(limits.response_bytes as usize)
        .map_err(|_| Refusal::Bounds)?;
    while let Some(frame) = body.frame().await {
        let frame = frame?;
        bytes.extend_from_slice(frame.data_ref().ok_or(Refusal::Unsupported)?);
    }
    // Parsing and bounded object reconstruction run off the async workers so
    // online supervision keeps polling. Abort is cooperative AND joined: Tokio
    // cannot forcibly cancel a blocking job that has already started.
    let raw = Zeroizing::new(token.expose().to_vec());
    let basic = Zeroizing::new(encoded.expose().to_vec());
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let (send, receive) = oneshot::channel();
    let handle = tokio::task::spawn_blocking(move || {
        #[cfg(test)]
        let _test_scope = crate::git_pack::test_control::Scope::install(test_control);
        let result = (|| {
            let secrets = [raw.as_slice(), basic.as_slice()];
            if git_protocol::contains_credential_with_cancel(
                operation,
                command,
                &bytes,
                &secrets,
                Some(&worker_stop),
            )? {
                return Err(Refusal::Unsupported);
            }
            if operation == Operation::UploadPack && command == Some(Command::Fetch) {
                if let Some(pack) = git_protocol::pack_stream(&bytes, &worker_stop)? {
                    crate::git_pack::validate(&pack, &secrets, &worker_stop)?;
                }
            }
            if worker_stop.load(Ordering::Acquire) {
                return Err(Refusal::Deadline);
            }
            Ok(bytes)
        })();
        drop(raw);
        drop(basic);
        let _ = send.send(result);
    });
    state.lock().unwrap().tasks.push(Task {
        handle: Some(handle),
        stop: Some(stop),
    });
    let bytes = receive.await.map_err(|_| Refusal::Protocol)??;
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, git_content_type(operation))
        .header(header::CONNECTION, "close")
        .body(Full::new(Bytes::from_owner(BodyOwner(bytes))))
        .map_err(|_| Refusal::Protocol)?)
}

#[cfg(test)]
mod preparation_tests;
