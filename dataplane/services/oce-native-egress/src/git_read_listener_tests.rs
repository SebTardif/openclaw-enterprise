//! Synthetic socket/TLS peers for the retained original Git-read listener.
//! Reuses original peers and PACK controls.
use super::*;
use crate::git_pack::test_control::Control;
use crate::git_read_listener::{GitReadListener, ListenerSnapshot};
use std::{
    future::{poll_fn, Future},
    pin::Pin,
    task::Poll,
};
use tokio::{sync::oneshot, task::JoinHandle};

const ATTACHMENT: &str = "original-git-read-attachment";
const DISCOVERY: &[u8] = b"GET /fixture/repo.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nConnection: close\r\n\r\n";

fn listener_limits() -> Limits {
    Limits {
        header_bytes: 16384,
        header_count: 64,
        request_bytes: 4_194_304,
        response_bytes: 2 * 1024 * 1024,
        exchange_timeout: Duration::from_secs(10),
    }
}
struct Inputs {
    directory: PathBuf,
    socket: PathBuf,
    uid: u32,
    incoming: Arc<ServerConfig>,
    guest: Arc<ClientConfig>,
    upstream_server: Arc<ServerConfig>,
    upstream: Arc<ClientConfig>,
    broker_server: Arc<ServerConfig>,
    broker_trust: Arc<ClientConfig>,
}
impl Inputs {
    fn new() -> Self {
        let scratch = PathBuf::from(
            std::env::var_os("OCE_MEDIATION_TEST_SCRATCH")
                .or_else(|| std::env::var_os("HOME"))
                .expect("protected test scratch"),
        );
        let directory = scratch.join(format!(
            "git-listener-{}",
            broker_rpc::random_ref().unwrap()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let uid = std::fs::metadata(&directory).unwrap().uid();
        let socket = directory.join("broker.sock");
        let (incoming, guest, _) = tls_pair(GIT_HOST, false);
        let (upstream_server, upstream, _) = tls_pair(GIT_HOST, false);
        let (broker_server, broker_trust, _) = tls_pair("git-broker.test", true);
        Self {
            directory,
            socket,
            uid,
            incoming,
            guest,
            upstream_server,
            upstream,
            broker_server,
            broker_trust,
        }
    }
    fn repository(&self) -> Repository {
        Repository::new("fixture", "repo", &"a".repeat(40)).unwrap()
    }
    fn broker_config(&self) -> BrokerConfig {
        let mut config =
            isolated_broker_config(self.socket.clone(), self.broker_trust.clone(), self.uid);
        config.call_timeout = Duration::from_secs(5);
        config
    }
    async fn start(&self, cap: usize) -> Running {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let owner = GitReadListener::start(
            listener,
            self.repository(),
            self.incoming.clone(),
            self.upstream.clone(),
            self.broker_config(),
            ATTACHMENT.into(),
            listener_limits(),
            cap,
        )
        .unwrap();
        Running { owner, address }
    }
    async fn fixture(
        &self,
        endpoint: std::net::SocketAddrV4,
        control: Option<Arc<Control>>,
    ) -> Running {
        let mut mediator = Mediator::new_git_read(
            self.repository(),
            self.incoming.clone(),
            self.upstream.clone(),
            self.broker_config(),
            listener_limits(),
            1,
        )
        .unwrap();
        mediator.test_endpoint = Some(endpoint);
        mediator.test_pack_control = control;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let owner =
            GitReadListener::start_fixture(listener, mediator, ATTACHMENT.into(), 1).unwrap();
        Running { owner, address }
    }
    fn broker_peer(&self) -> (JoinHandle<()>, Arc<Mutex<Vec<Value>>>) {
        let listener = UnixListener::bind(&self.socket).unwrap();
        std::fs::set_permissions(&self.socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        let records = Arc::new(Mutex::new(Vec::new()));
        let seen = records.clone();
        let tls = self.broker_server.clone();
        let uid = self.uid;
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            broker_connection(socket, tls, seen, uid, None, None).await;
        });
        (task, records)
    }
    async fn provider(
        &self,
        path: &'static str,
        expected: Vec<u8>,
        body: Vec<u8>,
        content_type: &'static str,
    ) -> (std::net::SocketAddrV4, JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let SocketAddr::V4(endpoint) = listener.local_addr().unwrap() else {
            unreachable!()
        };
        let tls = self.upstream_server.clone();
        let task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let tls = TlsAcceptor::from(tls).accept(socket).await.unwrap();
            let handler = service_fn(move |request: Request<Incoming>| {
                let expected = expected.clone();
                let body = body.clone();
                async move {
                    assert_eq!(request.uri().path(), path);
                    assert_eq!(request.headers()[header::AUTHORIZATION], PROTECTED_AUTH);
                    assert_eq!(request.headers()[header::HOST], GIT_HOST);
                    assert_eq!(
                        request
                            .into_body()
                            .collect()
                            .await
                            .unwrap()
                            .to_bytes()
                            .as_ref(),
                        expected
                    );
                    Ok::<_, Infallible>(
                        Response::builder()
                            .status(200)
                            .header(header::CONTENT_TYPE, content_type)
                            .header(header::CONNECTION, "close")
                            .body(Full::new(Bytes::from(body)))
                            .unwrap(),
                    )
                }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .keep_alive(false)
                .serve_connection(TokioIo::new(tls), handler)
                .await;
        });
        (endpoint, task)
    }
}
impl Drop for Inputs {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket);
        let _ = std::fs::remove_dir(&self.directory);
    }
}
struct Running {
    owner: Arc<GitReadListener>,
    address: SocketAddr,
}
impl Drop for Running {
    fn drop(&mut self) {
        self.owner.cancel();
    }
}
struct ReleasePack(Arc<Control>);
impl Drop for ReleasePack {
    fn drop(&mut self) {
        self.0.release();
    }
}
async fn bounded_listener<F: Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(5), future)
        .await
        .ok()
        .expect("listener watchdog")
}
async fn observed(
    owner: &GitReadListener,
    predicate: impl Fn(&ListenerSnapshot) -> bool,
) -> ListenerSnapshot {
    bounded_listener(async {
        loop {
            let snapshot = owner.snapshot();
            if predicate(&snapshot) {
                return snapshot;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
}
fn all_joined(owner: &GitReadListener) {
    let snapshot = owner.snapshot();
    assert!(snapshot.closing && snapshot.accept_joined);
    assert_eq!(snapshot.registered, snapshot.finished);
}
async fn pending_listener<F: Future + ?Sized>(mut future: Pin<&mut F>) {
    poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}
async fn closed(socket: &mut TcpStream) -> bool {
    let mut byte = [0];
    matches!(
        timeout(Duration::from_secs(2), socket.read(&mut byte)).await,
        Ok(Ok(0)) | Ok(Err(_))
    )
}

#[tokio::test]
async fn listener_rejects_configuration_before_accepting() {
    let inputs = Inputs::new();
    for (cap, attachment) in [
        (0, ATTACHMENT),
        (129, ATTACHMENT),
        (1, ""),
        (1, "bad\nattachment"),
    ] {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let result = GitReadListener::start(
            listener,
            inputs.repository(),
            inputs.incoming.clone(),
            inputs.upstream.clone(),
            inputs.broker_config(),
            attachment.into(),
            listener_limits(),
            cap,
        );
        assert_eq!(
            result.err(),
            Some(if cap == 1 {
                Refusal::Protocol
            } else {
                Refusal::Configuration
            })
        );
        assert!(TcpStream::connect(address).await.is_err());
    }
}

#[tokio::test]
async fn listener_cancel_joins_pending_accept_and_seals_original_owner() {
    let inputs = Inputs::new();
    let running = inputs.start(1).await;
    let mut result = Box::pin(running.owner.result());
    pending_listener(result.as_mut()).await;
    drop(result);
    running.owner.cancel();
    assert_eq!(bounded_listener(running.owner.retire()).await, Ok(()));
    assert_eq!(bounded_listener(running.owner.result()).await, Ok(()));
    assert_eq!(bounded_listener(running.owner.retire()).await, Ok(()));
    all_joined(&running.owner);
    assert_eq!(running.owner.snapshot().registered, 0);
    assert!(TcpStream::connect(running.address).await.is_err());
}

#[tokio::test]
async fn listener_caps_actual_tls_tasks_reuses_slot_and_cancels_held_handshake() {
    let inputs = Inputs::new();
    let running = inputs.start(1).await;
    let first = TcpStream::connect(running.address).await.unwrap();
    observed(&running.owner, |s| s.registered == 1 && s.finished == 0).await;
    let mut excess = TcpStream::connect(running.address).await.unwrap();
    assert!(
        closed(&mut excess).await,
        "overflow must close before task registration"
    );
    assert_eq!(running.owner.snapshot().registered, 1);
    drop(first);
    observed(&running.owner, |s| s.finished == 1).await;
    let mut next = TcpStream::connect(running.address).await.unwrap();
    observed(&running.owner, |s| s.registered == 2 && s.finished == 1).await;
    running.owner.cancel();
    let retired = bounded_listener(running.owner.retire()).await;
    let next_closed = closed(&mut next).await;
    assert_eq!(retired, Ok(()));
    assert!(next_closed);
    all_joined(&running.owner);
    assert_eq!(running.owner.snapshot().registered, 2);
}

#[tokio::test]
async fn listener_serves_discovery_with_the_fixed_original_attachment() {
    let inputs = Inputs::new();
    let (broker, records) = inputs.broker_peer();
    let mut body = git_packet(b"version 2\n");
    body.extend(git_packet(b"ls-refs\n"));
    body.extend(git_packet(b"fetch\n"));
    body.extend_from_slice(b"0000");
    let (endpoint, upstream) = inputs
        .provider(
            "/fixture/repo.git/info/refs",
            Vec::new(),
            body.clone(),
            "application/x-git-upload-pack-advertisement",
        )
        .await;
    let running = inputs.fixture(endpoint, None).await;
    for (index, wire) in [
    b"GET /fixture/repo.git/info/refs?service=git-receive-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\n\r\n".as_slice(),
    b"GET /foreign/repo.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\n\r\n",
  ].into_iter().enumerate() {
    let response = raw_request(running.address, inputs.guest.clone(), wire).await;
    assert!(!response.starts_with(b"HTTP/1.1 200"));
    assert!(records.lock().unwrap().is_empty());
    observed(&running.owner, |s| s.finished == index + 1).await;
  }
    let response = raw_request(running.address, inputs.guest.clone(), DISCOVERY).await;
    observed(&running.owner, |s| s.finished == 3).await;
    running.owner.cancel();
    let retired = bounded_listener(running.owner.retire()).await;
    bounded_listener(upstream).await.unwrap();
    bounded_listener(broker).await.unwrap();
    assert_eq!(retired, Ok(()));
    all_joined(&running.owner);
    assert!(response.starts_with(b"HTTP/1.1 200") && response.ends_with(&body));
    assert!(!response
        .windows(SYNTHETIC_TOKEN.len())
        .any(|w| w == SYNTHETIC_TOKEN));
    let records = records.lock().unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|r| r["method"] == "open-read")
            .count(),
        1
    );
    assert_eq!(records[0]["attachment_ref"], ATTACHMENT);
    assert_eq!(
        records
            .iter()
            .filter(|r| r["method"] == "dispatch-read")
            .count(),
        1
    );
    assert_eq!(records.last().unwrap()["method"], "complete-read");
    assert_eq!(records.last().unwrap()["outcome"], "completed");
}

#[tokio::test]
async fn listener_cancel_closes_the_original_held_broker_reply() {
    let inputs = Inputs::new();
    let listener = UnixListener::bind(&inputs.socket).unwrap();
    std::fs::set_permissions(&inputs.socket, std::fs::Permissions::from_mode(0o600)).unwrap();
    let tls = inputs.broker_server.clone();
    let uid = inputs.uid;
    let (entered, entry) = oneshot::channel();
    let broker = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        assert_eq!(socket.peer_cred().unwrap().uid(), uid);
        let mut tls = TlsAcceptor::from(tls).accept(socket).await.unwrap();
        let mut first = [0];
        tls.read_exact(&mut first).await.unwrap();
        entered.send(()).unwrap();
        let mut rest = Vec::new();
        let result = tls.read_to_end(&mut rest).await;
        (first, rest, result)
    });
    let running = inputs.start(1).await;
    let address = running.address;
    let guest = inputs.guest.clone();
    let client = tokio::spawn(async move { raw_request(address, guest, DISCOVERY).await });
    bounded_listener(entry).await.unwrap();
    let before = running.owner.snapshot();
    assert_eq!((before.registered, before.finished), (1, 0));
    assert!(!broker.is_finished());
    running.owner.cancel();
    let retired = bounded_listener(running.owner.retire()).await;
    let response = bounded_listener(client).await.unwrap();
    let (_first, _rest, _eof) = bounded_listener(broker).await.unwrap();
    assert_eq!(retired, Ok(()));
    assert!(response.is_empty());
    all_joined(&running.owner);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn listener_cancelled_retire_keeps_real_pack_worker_and_sampled_receipt_order() {
    let inputs = Inputs::new();
    let control = Control::new();
    let _release = ReleasePack(control.clone());
    let (broker, records) = inputs.broker_peer();
    let mut fetch = git_packet(b"command=fetch\n");
    fetch.extend(git_packet(b"object-format=sha1\n"));
    fetch.extend_from_slice(b"0001");
    fetch.extend(git_packet(format!("want {}\n", "a".repeat(40)).as_bytes()));
    fetch.extend(git_packet(b"done\n"));
    fetch.extend_from_slice(b"0000");
    let (endpoint, upstream) = inputs
        .provider(
            "/fixture/repo.git/git-upload-pack",
            fetch.clone(),
            framed_pack(&reference_delta_canary_pack()),
            "application/x-git-upload-pack-result",
        )
        .await;
    let running = inputs.fixture(endpoint, Some(control.clone())).await;
    let mut wire = format!("POST /fixture/repo.git/git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nContent-Type: application/x-git-upload-pack-request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", fetch.len()).into_bytes();
    wire.extend(fetch);
    let address = running.address;
    let guest = inputs.guest.clone();
    let client = tokio::spawn(async move { raw_request(address, guest, &wire).await });
    bounded_listener(control.wait_entered()).await;
    running.owner.cancel();
    bounded_listener(control.wait_cancelled()).await;
    let mut first = Box::pin(running.owner.retire());
    pending_listener(first.as_mut()).await;
    drop(first);
    let held = running.owner.snapshot();
    assert!(held.closing && held.registered == 1 && held.finished == 0);
    assert!(control.is_entered() && control.is_cancelled() && !control.is_finished());
    assert!(!control.is_released());
    // Sampled while held; the original PACK fixture checks the exact receipt point.
    assert!(!records
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "complete-read"));
    let mut retry = Box::pin(running.owner.retire());
    pending_listener(retry.as_mut()).await;
    control.release();
    let retired = bounded_listener(retry).await;
    let response = bounded_listener(client).await.unwrap();
    bounded_listener(upstream).await.unwrap();
    bounded_listener(broker).await.unwrap();
    assert_eq!(retired, Ok(()));
    all_joined(&running.owner);
    assert!(control.is_finished() && response.is_empty());
    let records = records.lock().unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|r| r["method"] == "dispatch-read")
            .count(),
        1
    );
    assert_eq!(records.last().unwrap()["method"], "complete-read");
    assert_eq!(records.last().unwrap()["outcome"], "unknown");
    assert_eq!(
        records.last().unwrap()["release_ref"],
        "fixture-git-release"
    );
}

#[derive(Debug)]
struct PanicCertificateResolver;
impl rustls::server::ResolvesServerCert for PanicCertificateResolver {
    fn resolve(
        &self,
        _: rustls::server::ClientHello<'_>,
    ) -> Option<Arc<rustls::sign::CertifiedKey>> {
        panic!("actual connection resolver panic");
    }
}
#[tokio::test]
async fn listener_real_connection_panic_is_sticky_after_every_retire() {
    let mut inputs = Inputs::new();
    let mut incoming = ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(PanicCertificateResolver));
    incoming.alpn_protocols = vec![b"http/1.1".to_vec()];
    inputs.incoming = Arc::new(incoming);
    let running = inputs.start(1).await;
    let socket = TcpStream::connect(running.address).await.unwrap();
    let handshake = TlsConnector::from(inputs.guest.clone())
        .connect(ServerName::try_from(GIT_HOST).unwrap(), socket);
    assert!(bounded_listener(handshake).await.is_err());
    assert_eq!(
        bounded_listener(running.owner.result()).await,
        Err(Refusal::Protocol)
    );
    assert_eq!(
        bounded_listener(running.owner.retire()).await,
        Err(Refusal::Protocol)
    );
    assert_eq!(
        bounded_listener(running.owner.retire()).await,
        Err(Refusal::Protocol)
    );
    assert_eq!(
        bounded_listener(running.owner.result()).await,
        Err(Refusal::Protocol)
    );
    all_joined(&running.owner);
    assert_eq!(running.owner.snapshot().registered, 1);
}
