use crate::{http, Firewall, Origin, Refusal};
use ::http::{header, HeaderValue, Request, Response, StatusCode};
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full};
use hyper::{
    body::{Bytes, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use rustls_pki_types::ServerName;
use std::{
    convert::Infallible,
    sync::{Arc, Mutex},
};
use tokio::{
    net::TcpStream,
    sync::watch,
    task::JoinHandle,
    time::{timeout_at, Instant},
};
use tokio_rustls::{TlsAcceptor, TlsConnector};

type Body = UnsyncBoxBody<Bytes, Refusal>;
#[derive(Default)]
struct State {
    drivers: Vec<Driver>,
    deadline: Option<Instant>,
    deadline_changes: Option<watch::Sender<Instant>>,
    refusal: Option<Refusal>,
}
struct Driver(Option<JoinHandle<Result<(), hyper::Error>>>);
impl Drop for Driver {
    fn drop(&mut self) {
        if let Some(task) = &self.0 {
            task.abort();
        }
    }
}

pub(crate) async fn serve(firewall: &Firewall, socket: TcpStream) -> Result<(), Refusal> {
    let deadline = Instant::now() + firewall.limits.exchange_timeout;
    let state = Arc::new(Mutex::new(State::default()));
    let outcome = timeout_at(deadline, async {
        let tls = TlsAcceptor::from(firewall.incoming.clone())
            .accept(socket)
            .await
            .map_err(|_| Refusal::Tls)?;
        if tls
            .get_ref()
            .1
            .alpn_protocol()
            .is_some_and(|alpn| alpn != b"http/1.1")
        {
            return Err(Refusal::Tls);
        }
        let sni = Origin::from_host(tls.get_ref().1.server_name().ok_or(Refusal::Tls)?)?;
        let permit = firewall
            .admission
            .current(sni, crate::admission::Check::Connection)?;
        let lease_deadline = permit.deadline.min(deadline);
        let (changes, deadlines) = watch::channel(lease_deadline);
        {
            let mut state = state.lock().unwrap();
            state.deadline = Some(lease_deadline);
            state.deadline_changes = Some(changes);
        }
        let handler = service_fn(|request| {
            let state = state.clone();
            async move {
                let result = exchange(firewall, sni, request, state.clone()).await;
                let response = match result {
                    Ok(response) => response,
                    Err(reason) => {
                        state.lock().unwrap().refusal = Some(reason);
                        Response::builder()
                            .status(StatusCode::BAD_GATEWAY)
                            .header(header::CONNECTION, "close")
                            .body(
                                Full::new(Bytes::from_static(b"Native HTTPS unavailable.\n"))
                                    .map_err(|never| match never {})
                                    .boxed_unsync(),
                            )
                            .unwrap()
                    }
                };
                Ok::<_, Infallible>(response)
            }
        });
        let connection = hyper::server::conn::http1::Builder::new()
            .keep_alive(false)
            .max_headers(firewall.limits.header_count)
            .max_buf_size(firewall.limits.header_bytes)
            .serve_connection(TokioIo::new(tls), handler);
        tokio::select! {
            result = connection => result.map_err(|_| Refusal::Protocol)?,
            _ = lease_expired(deadlines) => return Err(Refusal::Deadline),
        }
        Ok(())
    })
    .await
    .unwrap_or(Err(Refusal::Deadline));
    // Never detach the upstream driver. Expiry, parser failure and caller-side
    // completion all close its socket and join cancellation before returning.
    let (drivers, refusal) = {
        let mut state = state.lock().unwrap();
        (std::mem::take(&mut state.drivers), state.refusal)
    };
    for mut driver in drivers {
        if let Some(task) = driver.0.take() {
            task.abort();
            let _ = task.await;
        }
    }
    outcome.and(refusal.map_or(Ok(()), Err))
}

async fn lease_expired(mut deadlines: watch::Receiver<Instant>) {
    loop {
        let deadline = *deadlines.borrow_and_update();
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return,
            changed = deadlines.changed() => if changed.is_err() { return; },
        }
    }
}

async fn exchange(
    firewall: &Firewall,
    origin: Origin,
    request: Request<Incoming>,
    state: Arc<Mutex<State>>,
) -> Result<Response<Body>, Refusal> {
    let (mut parts, body) = request.into_parts();
    http::request(firewall, &parts, origin)?;
    let permit = firewall
        .admission
        .current(origin, crate::admission::Check::Request)?;
    // A shorter request-time lease governs the whole connection, including
    // response streaming and periods when downstream backpressure stops polls.
    let deadline = {
        let mut state = state.lock().unwrap();
        let deadline = state
            .deadline
            .ok_or(Refusal::AuthorityUnavailable)?
            .min(permit.deadline);
        state.deadline = Some(deadline);
        state
            .deadline_changes
            .as_ref()
            .ok_or(Refusal::AuthorityUnavailable)?
            .send_replace(deadline);
        deadline
    };
    let result = timeout_at(deadline, async {
        let body = if origin == Origin::Api && parts.uri.path() == "/graphql" {
            Full::new(http::graphql(body, firewall.limits.request_bytes).await?)
                .map_err(|never| match never {})
                .boxed_unsync()
        } else {
            http::Bounded::new(body, firewall.limits.request_bytes).boxed()
        };
        let socket = TcpStream::connect(permit.endpoint)
            .await
            .map_err(|_| Refusal::Io)?;
        if socket.peer_addr().map_err(|_| Refusal::Io)? != std::net::SocketAddr::V4(permit.endpoint)
        {
            return Err(Refusal::Io);
        }
        let tls = TlsConnector::from(permit.trust)
            .connect(
                ServerName::try_from(origin.hostname()).map_err(|_| Refusal::Tls)?,
                socket,
            )
            .await
            .map_err(|_| Refusal::Tls)?;
        if tls
            .get_ref()
            .1
            .alpn_protocol()
            .is_some_and(|alpn| alpn != b"http/1.1")
        {
            return Err(Refusal::Tls);
        }
        // No request or token reaches an upstream before its actual TLS verifies.
        parts
            .headers
            .insert(header::HOST, HeaderValue::from_static(origin.hostname()));
        parts
            .headers
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
        let (mut sender, driver) = hyper::client::conn::http1::Builder::new()
            .max_headers(firewall.limits.header_count)
            .max_buf_size(firewall.limits.header_bytes)
            .handshake(TokioIo::new(tls))
            .await
            .map_err(|_| Refusal::Protocol)?;
        state
            .lock()
            .unwrap()
            .drivers
            .push(Driver(Some(tokio::spawn(driver))));
        let response = sender
            .send_request(Request::from_parts(parts, body))
            .await
            .map_err(|_| Refusal::Protocol)?;
        let (mut parts, body) = response.into_parts();
        if parts.status.is_redirection() || parts.status.is_informational() {
            return Err(Refusal::Unsupported);
        }
        http::headers(
            &parts.headers,
            firewall.limits.header_bytes,
            firewall.limits.header_count,
        )?;
        parts
            .headers
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
        Ok(Response::from_parts(
            parts,
            http::Bounded::new(body, firewall.limits.response_bytes).boxed(),
        ))
    })
    .await;
    result.unwrap_or(Err(Refusal::Deadline))
}
