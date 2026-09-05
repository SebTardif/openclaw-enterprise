// Modified for OpenClaw Enterprise.
//! A single HTTP/1 exchange on each leg; Hyper owns parsing and wire framing.
use super::{
    check_authority, check_dns, dns_request, http, json, read_key, recipient, rpc,
    validate_dns_echo, Admission, Binding, Monitor, Refusal, Service, SocketDeadline, FIXED_HOST,
    REQUEST_LIMIT,
};
use crate::reoriginate::validate_origin_chain_witness;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full};
use hyper::{
    body::{Body, Bytes, Frame, Incoming, SizeHint},
    header::{self, HeaderValue},
    service::service_fn,
    HeaderMap, Request, Response, StatusCode, Version,
};
use hyper_util::rt::TokioIo;
use ring::rand::{SecureRandom, SystemRandom};
use rustls_pki_types::{ServerName, UnixTime};
use serde_json::Value;
use std::{
    convert::Infallible,
    future::Future,
    net::{Shutdown, SocketAddr, TcpStream},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::{client::TlsStream, TlsAcceptor, TlsConnector};
use zeroize::Zeroizing;

const HEAD_LIMIT: usize = 16 * 1024;
const RESPONSE_LIMIT: u64 = 64 * 1024 * 1024;
type ResponseBody = UnsyncBoxBody<Bytes, Refusal>;
type SharedState = Arc<Mutex<ExchangeState>>;

#[derive(Default)]
struct ExchangeState {
    completion: Option<Completion>,
    dispatch_attempted: bool,
    upstream_eof: bool,
    provider_ended: bool,
    failure: Option<Refusal>,
    request_guard: Option<SocketDeadline>,
    unmonitored_flow: Option<Value>,
    monitor: Option<Arc<Monitor>>,
    driver: Option<tokio::task::JoinHandle<Result<(), hyper::Error>>>,
    effectful_jobs: Vec<tokio::task::JoinHandle<()>>,
}

struct Completion {
    operation_id: String,
    digest: String,
}

pub(super) fn handle(service: &Service, socket: TcpStream) -> Result<(), Refusal> {
    let shutdown = socket.try_clone().map_err(|_| Refusal::Io)?;
    socket.set_nonblocking(true).map_err(|_| Refusal::Io)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(2)
        .build()
        .map_err(|_| Refusal::Configuration)?;
    let result = runtime.block_on(async {
        let deadline = Instant::now() + Duration::from_secs(5);
        let guard = SocketDeadline::new(shutdown.try_clone().map_err(|_| Refusal::Io)?, deadline)?;
        let downstream = Arc::new(shutdown.try_clone().map_err(|_| Refusal::Io)?);
        let socket = tokio::net::TcpStream::from_std(socket).map_err(|_| Refusal::Io)?;
        match &service.incoming {
            Some(config) => {
                let stream = until(deadline, TlsAcceptor::from(config.clone()).accept(socket))
                    .await?
                    .map_err(|_| Refusal::Tls)?;
                if stream
                    .get_ref()
                    .1
                    .alpn_protocol()
                    .is_some_and(|alpn| alpn != b"http/1.1")
                {
                    return Err(Refusal::Tls);
                }
                serve(service, stream, downstream, guard, deadline).await
            }
            None => serve(service, socket, downstream, guard, deadline).await,
        }
    });
    let _ = shutdown.shutdown(Shutdown::Both);
    result
}

async fn serve<I>(
    service: &Service,
    io: I,
    downstream: Arc<TcpStream>,
    guard: SocketDeadline,
    deadline: Instant,
) -> Result<(), Refusal>
where
    I: AsyncRead + AsyncWrite + Unpin,
{
    let state = Arc::new(Mutex::new(ExchangeState {
        request_guard: Some(guard),
        ..ExchangeState::default()
    }));
    let request_state = state.clone();
    let handler = service_fn(move |request| {
        let state = request_state.clone();
        let downstream = downstream.clone();
        async move {
            let response =
                match exchange(service, request, downstream, state.clone(), deadline).await {
                    Ok(response) => response,
                    Err(error) => {
                        fail(&state, error);
                        refusal_response()
                    }
                };
            Ok::<_, Infallible>(response)
        }
    });
    let connection = hyper::server::conn::http1::Builder::new()
        // One accepted request is the complete connection contract. Buffered
        // subsequent requests can never invoke this service or reach authority.
        .keep_alive(false)
        .max_headers(64)
        .max_buf_size(HEAD_LIMIT)
        .header_read_timeout(None)
        .serve_connection(TokioIo::new(io), handler)
        .await;

    // A downstream disconnect can cancel the service future while a blocking
    // authority RPC is still committing. Observe those workers before reading
    // completion state or sending a receipt; a detached dispatch must never
    // race its own completion. Workers record known ownership before replying.
    let jobs = std::mem::take(&mut state.lock().map_err(|_| Refusal::Denied)?.effectful_jobs);
    for job in jobs {
        if job.await.is_err() {
            fail(&state, Refusal::Dependency);
        }
    }

    let (completion, attempted, eof, failure, monitor, driver, guard, unmonitored_flow) = {
        let mut state = state.lock().map_err(|_| Refusal::Denied)?;
        (
            state.completion.take(),
            state.dispatch_attempted,
            state.upstream_eof,
            state.failure,
            state.monitor.take(),
            state.driver.take(),
            state.request_guard.take(),
            state.unmonitored_flow.take(),
        )
    };
    let authorized = monitor
        .as_ref()
        .is_none_or(|monitor| monitor.current().is_ok());
    let provider_ended = state.lock().map_err(|_| Refusal::Denied)?.provider_ended;
    let completed = connection.is_ok() && failure.is_none() && eof && provider_ended && authorized;
    if let Some(driver) = driver {
        driver.abort();
        let _ = driver.await;
    }
    // Monitor destruction shuts the exact upstream socket, releases the bound
    // DNS flow, and joins its bounded blocking RPC worker before completion.
    blocking(move || {
        drop(monitor);
        drop(guard);
        Ok(())
    })
    .await?;
    if let Some(release) = unmonitored_flow {
        // A successful bind can outlive setup failure before Monitor starts.
        // Release that exact flow even when no provider request was attempted.
        let _ = call(service.dns.clone(), release, None).await;
    }
    let receipt = match (attempted, completed) {
        (false, _) => "not_dispatched",
        (true, true) => "completed",
        (true, false) => "unknown",
    };
    let recorded = match completion {
        Some(completion) => call(
            service.authority.clone(),
            json!({"version":1,"method":"complete","operation_id":completion.operation_id,
                "request_sha256":completion.digest,"outcome":receipt}),
            None,
        )
        .await
        .map(|_| ()),
        None => Ok(()),
    };
    if let Some(error) = failure {
        return Err(error);
    }
    connection.map_err(|_| Refusal::Io)?;
    if !authorized {
        return Err(Refusal::Denied);
    }
    recorded
}

async fn exchange(
    service: &Service,
    request: Request<Incoming>,
    downstream: Arc<TcpStream>,
    state: SharedState,
    request_deadline: Instant,
) -> Result<Response<ResponseBody>, Refusal> {
    let (parts, mut body) = request.into_parts();
    // Reject Expect and unsupported framing before polling Incoming: polling
    // an expected request body can cause Hyper to send an interim 100 response.
    http::validate_parts(&parts, &service.config.listener_authority)?;
    let bytes = until(request_deadline, async {
        let mut bytes = Zeroizing::new(Vec::new());
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| Refusal::Malformed)?;
            let data = frame.into_data().map_err(|_| Refusal::Unsupported)?;
            if data.len() > REQUEST_LIMIT.saturating_sub(bytes.len()) {
                return Err(Refusal::Bounds);
            }
            bytes.extend_from_slice(&data);
        }
        Ok::<_, Refusal>(bytes.to_vec())
    })
    .await??;
    let request = http::parse_request(&parts, bytes, &service.config.listener_authority)?;
    drop(
        state
            .lock()
            .map_err(|_| Refusal::Denied)?
            .request_guard
            .take(),
    );

    let reservation_ref = nonce()?;
    let admit = json!({"version":1,"method":"admit","reservation_ref":reservation_ref,
            "provider_binding_ref":service.config.provider_binding_ref,
            "workload_credential":request.workload_credential.as_str(),
            "mediation_context":request.context,"request_body":request.body.as_str(),
            "request_sha256":request.digest,"recipient":recipient(),
            "operation":"responses.create"});
    let authority = service.authority.clone();
    let admitted_state = state.clone();
    let provider_binding = service.config.provider_binding_ref.clone();
    let digest = request.digest.clone();
    let (value, started) = effectful(&state, move || {
        let (value, started) = authority.call(&admit)?;
        if json::bounded_str(&value, "reservation_ref", 64)? != reservation_ref
            || json::bounded_str(&value, "provider_binding_ref", 128)? != provider_binding
        {
            return Err(Refusal::Denied);
        }
        // Persist known ownership in the worker, including when the downstream
        // service future was cancelled before it could receive this RPC result.
        admitted_state
            .lock()
            .map_err(|_| Refusal::Denied)?
            .completion = Some(Completion {
            operation_id: json::bounded_str(&value, "operation_id", 128)?.to_owned(),
            digest,
        });
        Ok((value, started))
    })
    .await?;
    let binding = Binding::parse(&value)?;
    if binding.credential_binding != service.config.credential_binding
        || binding.request_sha256 != request.digest
        || value.get("operation_state").and_then(Value::as_str) != Some("accepted")
    {
        return Err(Refusal::Denied);
    }
    let initial_lease = rpc::lease(&value, started)?;
    let operation_ttl = binding
        .operation_expires_at_ms
        .checked_sub(rpc::safe_number(&value, "server_time_ms")?)
        .filter(|n| *n > 0)
        .ok_or(Refusal::Denied)?;
    let operation_deadline = started
        .checked_add(Duration::from_millis(operation_ttl))
        .ok_or(Refusal::Denied)?;
    let dispatch_ttl = rpc::safe_number(&value, "dispatch_before_ms")?
        .checked_sub(rpc::safe_number(&value, "server_time_ms")?)
        .filter(|ttl| *ttl > 0 && *ttl <= 5000)
        .ok_or(Refusal::Denied)?;
    let dispatch_deadline = started + Duration::from_millis(dispatch_ttl);

    let resolver = service.dns.clone();
    let resolve_request = dns_request("resolve", &binding, &request.digest, None);
    let resolve_deadline = initial_lease.deadline.min(dispatch_deadline);
    // Resolve creates a bounded pending admission. Join its worker before any
    // receipt on cancellation; an unbound pending admission retires by expiry.
    let (value, started) = effectful(&state, move || {
        resolver.call_until(&resolve_request, resolve_deadline)
    })
    .await?;
    validate_dns_echo(&value, &binding, &request.digest)?;
    let mut admission = Admission::parse(&value, started, &binding)?;
    let connect_deadline = initial_lease
        .deadline
        .min(admission.lease.deadline)
        .min(dispatch_deadline);
    let origin = connect(service, &admission, connect_deadline).await?;
    admission.connection_ref = Some(nonce()?);
    let dns = service.dns.clone();
    let flow_state = state.clone();
    let flow_binding = binding.clone();
    let digest = request.digest.clone();
    let admission = effectful(&state, move || {
        let (bound, started) = dns.call_until(
            &dns_request("bind", &flow_binding, &digest, Some(&admission)),
            connect_deadline,
        )?;
        validate_dns_echo(&bound, &flow_binding, &digest)?;
        let flow = Admission::parse(&bound, started, &flow_binding)?;
        if flow.ip != admission.ip
            || flow.id != admission.id
            || json::bounded_str(&bound, "connection_ref", 64)?
                != admission.connection_ref.as_deref().ok_or(Refusal::Denied)?
        {
            return Err(Refusal::Denied);
        }
        admission.flow_ref = Some(json::bounded_str(&bound, "flow_ref", 128)?.to_owned());
        admission.lease = flow.lease;
        flow_state
            .lock()
            .map_err(|_| Refusal::Denied)?
            .unmonitored_flow = Some(dns_request(
            "release",
            &flow_binding,
            &digest,
            Some(&admission),
        ));
        Ok(admission)
    })
    .await?;
    let key_path = service.config.provider_key_path.clone();
    let key = blocking(move || read_key(&key_path)).await?;
    let deadline = dispatch_deadline
        .min(initial_lease.deadline)
        .min(admission.lease.deadline);
    let authority = service.authority.clone();
    let dns = service.dns.clone();
    let gate_binding = binding.clone();
    let digest = request.digest.clone();
    let (admission, dns_lease) = blocking(move || {
        let authority_lease =
            check_authority(&authority, "inspect", &gate_binding, &digest, deadline)?;
        let dns_lease = check_dns(&dns, &gate_binding, &digest, &admission, deadline)?;
        initial_lease.current()?;
        admission.lease.current()?;
        authority_lease.current()?;
        dns_lease.current()?;
        Ok((admission, dns_lease))
    })
    .await?;

    let authorization = Zeroizing::new(format!("Bearer {}", key.as_str()));
    let mut auth = HeaderValue::from_str(&authorization).map_err(|_| Refusal::Configuration)?;
    auth.set_sensitive(true);
    let outbound = Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .version(Version::HTTP_11)
        .header(header::HOST, FIXED_HOST)
        .header(header::AUTHORIZATION, auth)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "text/event-stream")
        .header(header::CONNECTION, "close")
        .body(Full::new(Bytes::copy_from_slice(request.body.as_bytes())))
        .map_err(|_| Refusal::Configuration)?;
    drop(key);
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .max_headers(128)
        .max_buf_size(HEAD_LIMIT)
        .handshake(TokioIo::new(origin.stream))
        .await
        .map_err(|_| Refusal::Io)?;

    // The authority RPC may durably dispatch and then lose its response. From
    // this point every incomplete outcome is unknown, even before TLS writes.
    state
        .lock()
        .map_err(|_| Refusal::Denied)?
        .dispatch_attempted = true;
    let authority = service.authority.clone();
    let dispatch_binding = binding.clone();
    let digest = request.digest.clone();
    let authority_lease = effectful(&state, move || {
        check_authority(&authority, "dispatch", &dispatch_binding, &digest, deadline)
    })
    .await?;
    let monitor = Arc::new(Monitor::start(
        service.authority.clone(),
        service.dns.clone(),
        binding,
        request.digest,
        admission,
        authority_lease,
        dns_lease,
        operation_deadline,
        origin.control,
        downstream.try_clone().map_err(|_| Refusal::Io)?,
    )?);
    monitor.current()?;
    {
        let mut state = state.lock().map_err(|_| Refusal::Denied)?;
        state.monitor = Some(monitor.clone());
        state.unmonitored_flow = None;
        state.driver = Some(tokio::spawn(connection));
    }
    let response = sender
        .send_request(outbound)
        .await
        .map_err(|_| Refusal::Io)?;
    drop(sender);
    monitor.current()?;
    let (parts, body) = response.into_parts();
    let content_type = response_headers(parts.status, parts.version, &parts.headers)?;
    // Only the selected successful SSE transport can attest an ended Responses
    // lifecycle. JSON errors or terminal-looking bytes in another media type
    // remain unknown even when their HTTP framing completes cleanly.
    let observer = (parts.status == StatusCode::OK
        && content_type.as_bytes().split(|b| *b == b';').next() == Some(b"text/event-stream"))
    .then(super::sse::Observer::new);
    Response::builder()
        .status(parts.status)
        .version(Version::HTTP_11)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONNECTION, "close")
        .body(
            ForwardBody {
                source: body,
                observer,
                state,
                monitor,
                total: 0,
                done: false,
            }
            .boxed_unsync(),
        )
        .map_err(|_| Refusal::Configuration)
}

struct Origin {
    stream: TlsStream<tokio::net::TcpStream>,
    control: TcpStream,
}

async fn connect(
    service: &Service,
    admission: &Admission,
    deadline: Instant,
) -> Result<Origin, Refusal> {
    admission.lease.current()?;
    let address = SocketAddr::new(admission.ip, service.origin_port);
    // The only connect target is the admitted numeric address. This connector
    // performs no hostname lookup, redirect, retry, pooling, or alternate dial.
    let socket = until(
        deadline.min(Instant::now() + Duration::from_secs(3)),
        tokio::net::TcpStream::connect(address),
    )
    .await?
    .map_err(|_| Refusal::Io)?;
    let socket = socket.into_std().map_err(|_| Refusal::Io)?;
    let control = socket.try_clone().map_err(|_| Refusal::Io)?;
    let guard = SocketDeadline::new(control.try_clone().map_err(|_| Refusal::Io)?, deadline)?;
    let socket = tokio::net::TcpStream::from_std(socket).map_err(|_| Refusal::Io)?;
    let name = ServerName::try_from(FIXED_HOST).map_err(|_| Refusal::Configuration)?;
    let stream = until(
        deadline,
        TlsConnector::from(service.tls.clone()).connect(name, socket),
    )
    .await?
    .map_err(|_| Refusal::Tls)?;
    let (socket, tls) = stream.get_ref();
    if tls.alpn_protocol().is_some_and(|alpn| alpn != b"http/1.1") {
        return Err(Refusal::Tls);
    }
    validate_origin_chain_witness(
        tls.peer_certificates().ok_or(Refusal::Tls)?,
        FIXED_HOST,
        &service.strict_roots,
        UnixTime::now(),
    )
    .map_err(|_| Refusal::Tls)?;
    if socket.peer_addr().map_err(|_| Refusal::Io)? != address {
        return Err(Refusal::Denied);
    }
    admission.lease.current()?;
    drop(guard);
    Ok(Origin { stream, control })
}

fn response_headers(
    status: StatusCode,
    version: Version,
    headers: &HeaderMap,
) -> Result<HeaderValue, Refusal> {
    if version != Version::HTTP_11
        || !(200..=599).contains(&status.as_u16())
        || status.is_redirection()
        || matches!(status.as_u16(), 204 | 205 | 304)
    {
        return Err(Refusal::Unsupported);
    }
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::TRANSFER_ENCODING,
        header::CONTENT_ENCODING,
        header::UPGRADE,
        header::TRAILER,
    ] {
        if headers.get_all(name).iter().count() > 1 {
            return Err(Refusal::Malformed);
        }
    }
    if headers.contains_key(header::UPGRADE) || headers.contains_key(header::TRAILER) {
        return Err(Refusal::Unsupported);
    }
    if headers
        .get(header::CONTENT_ENCODING)
        .is_some_and(|value| value.as_bytes() != b"identity")
    {
        return Err(Refusal::Unsupported);
    }
    let transfer = headers.get(header::TRANSFER_ENCODING);
    let length = headers.get(header::CONTENT_LENGTH);
    match (transfer, length) {
        (Some(_), Some(_)) => return Err(Refusal::Malformed),
        (Some(value), None) if value.as_bytes().eq_ignore_ascii_case(b"chunked") => {}
        (None, Some(value)) => {
            let value = value.to_str().map_err(|_| Refusal::Malformed)?;
            if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(Refusal::Malformed);
            }
            if value.parse::<u64>().map_err(|_| Refusal::Malformed)? > RESPONSE_LIMIT {
                return Err(Refusal::Bounds);
            }
        }
        _ => return Err(Refusal::Unsupported),
    }
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .ok_or(Refusal::Unsupported)?;
    if !matches!(
        content_type
            .to_str()
            .map_err(|_| Refusal::Malformed)?
            .split(';')
            .next(),
        Some("text/event-stream" | "application/json")
    ) {
        return Err(Refusal::Unsupported);
    }
    Ok(content_type.clone())
}

struct ForwardBody {
    source: Incoming,
    observer: Option<super::sse::Observer>,
    state: SharedState,
    monitor: Arc<Monitor>,
    total: u64,
    done: bool,
}

impl Body for ForwardBody {
    type Data = Bytes;
    type Error = Refusal;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Refusal>>> {
        if self.done {
            return Poll::Ready(None);
        }
        if let Err(error) = self.monitor.current() {
            self.done = true;
            fail(&self.state, error);
            return Poll::Ready(Some(Err(error)));
        }
        match Pin::new(&mut self.source).poll_frame(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Some(Ok(frame))) => match frame.into_data() {
                Ok(data) => {
                    if let Some(observer) = self.observer.as_mut() {
                        if let Err(error) = observer.push(&data) {
                            self.done = true;
                            fail(&self.state, error);
                            return Poll::Ready(Some(Err(error)));
                        }
                    }
                    if data.len() as u64 > RESPONSE_LIMIT.saturating_sub(self.total) {
                        self.done = true;
                        fail(&self.state, Refusal::Bounds);
                        Poll::Ready(Some(Err(Refusal::Bounds)))
                    } else {
                        self.total += data.len() as u64;
                        Poll::Ready(Some(Ok(Frame::data(data))))
                    }
                }
                Err(_) => {
                    self.done = true;
                    fail(&self.state, Refusal::Unsupported);
                    Poll::Ready(Some(Err(Refusal::Unsupported)))
                }
            },
            Poll::Ready(Some(Err(_))) => {
                self.done = true;
                fail(&self.state, Refusal::Io);
                Poll::Ready(Some(Err(Refusal::Io)))
            }
            Poll::Ready(None) => {
                self.done = true;
                let ended = match self
                    .observer
                    .as_mut()
                    .map(super::sse::Observer::finish)
                    .transpose()
                {
                    Ok(ended) => ended.unwrap_or(false),
                    Err(error) => {
                        fail(&self.state, error);
                        return Poll::Ready(Some(Err(error)));
                    }
                };
                match self.state.lock() {
                    Ok(mut state) => {
                        state.upstream_eof = true;
                        state.provider_ended = ended;
                        Poll::Ready(None)
                    }
                    Err(_) => Poll::Ready(Some(Err(Refusal::Denied))),
                }
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        // Hyper must poll the validated EOF before it can finish the response;
        // Incoming's length hint alone cannot certify trailers or completion.
        self.done
    }

    fn size_hint(&self) -> SizeHint {
        SizeHint::default()
    }
}

fn fail(state: &SharedState, error: Refusal) {
    if let Ok(mut state) = state.lock() {
        state.failure.get_or_insert(error);
    }
}

fn refusal_response() -> Response<ResponseBody> {
    let mut response = Response::new(
        Full::new(Bytes::from_static(b"{\"error\":\"egress_denied\"}\n"))
            .map_err(|never| match never {})
            .boxed_unsync(),
    );
    *response.status_mut() = StatusCode::FORBIDDEN;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
    response
}

fn nonce() -> Result<String, Refusal> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Refusal::Configuration)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

async fn blocking<T: Send + 'static>(
    action: impl FnOnce() -> Result<T, Refusal> + Send + 'static,
) -> Result<T, Refusal> {
    tokio::task::spawn_blocking(action)
        .await
        .map_err(|_| Refusal::Dependency)?
}

async fn effectful<T: Send + 'static>(
    state: &SharedState,
    action: impl FnOnce() -> Result<T, Refusal> + Send + 'static,
) -> Result<T, Refusal> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let job = tokio::task::spawn_blocking(move || {
        let _ = sender.send(action());
    });
    state
        .lock()
        .map_err(|_| Refusal::Denied)?
        .effectful_jobs
        .push(job);
    receiver.await.map_err(|_| Refusal::Dependency)?
}

async fn call(
    rpc: rpc::Rpc,
    value: Value,
    deadline: Option<Instant>,
) -> Result<(Value, Instant), Refusal> {
    blocking(move || match deadline {
        Some(deadline) => rpc.call_until(&value, deadline),
        None => rpc.call(&value),
    })
    .await
}

async fn until<F: Future>(deadline: Instant, future: F) -> Result<F::Output, Refusal> {
    tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), future)
        .await
        .map_err(|_| Refusal::Timeout)
}
