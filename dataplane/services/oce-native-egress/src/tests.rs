use super::*;
use ::http::{Request, Response};
use http_body_util::{BodyExt, Full};
use hyper::{body::Bytes, service::service_fn};
use hyper_util::rt::TokioIo;
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use rustls_pki_types::{PrivateKeyDer, ServerName};
use std::{
    convert::Infallible,
    net::{Ipv4Addr, SocketAddrV4},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::{timeout, Instant},
};
use tokio_rustls::{TlsAcceptor, TlsConnector};

fn certificates(name: &str) -> (Arc<ServerConfig>, Arc<ClientConfig>) {
    let (server, client, _) = certificate_bundle(&[name]);
    (server, client)
}
fn certificate_bundle(names: &[&str]) -> (Arc<ServerConfig>, Arc<ClientConfig>, String) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut params = CertificateParams::new(vec!["fixture-root".into()]).unwrap();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "Native fixture root");
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let key = KeyPair::generate().unwrap();
    let root = params.self_signed(&key).unwrap();
    let issuer = Issuer::new(params, key);
    let mut params = CertificateParams::new(
        names
            .iter()
            .map(|name| (*name).into())
            .collect::<Vec<String>>(),
    )
    .unwrap();
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let key = KeyPair::generate().unwrap();
    let cert = params.signed_by(&key, &issuer).unwrap();
    let mut server = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            PrivateKeyDer::Pkcs8(key.serialize_der().into()),
        )
        .unwrap();
    server.alpn_protocols = vec![b"http/1.1".to_vec()];
    let mut roots = RootCertStore::empty();
    roots.add(root.der().clone()).unwrap();
    let mut client = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    client.alpn_protocols = vec![b"http/1.1".to_vec()];
    (Arc::new(server), Arc::new(client), root.pem())
}
fn limits() -> Limits {
    Limits {
        header_bytes: 16384,
        header_count: 64,
        request_bytes: 1024 * 1024,
        response_bytes: 1024 * 1024,
        exchange_timeout: Duration::from_secs(5),
    }
}
fn repository() -> Repository {
    Repository::new("fixture", "repo", &"a".repeat(40)).unwrap()
}
struct Fixture {
    address: SocketAddrV4,
    trust: Arc<ClientConfig>,
    calls: Arc<AtomicUsize>,
    token: Arc<Mutex<Option<String>>>,
    tasks: Vec<JoinHandle<()>>,
    result: Arc<Mutex<Option<Result<(), Refusal>>>>,
}
impl Fixture {
    async fn start(
        origin: Origin,
        upstream_name: &str,
        status: u16,
        lease: Duration,
        authorized: bool,
    ) -> Self {
        let (server, trust) = certificates(origin.hostname());
        let (upstream_server, upstream_trust) = certificates(upstream_name);
        let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let endpoint = match upstream.local_addr().unwrap() {
            std::net::SocketAddr::V4(v) => v,
            _ => unreachable!(),
        };
        let calls = Arc::new(AtomicUsize::new(0));
        let token = Arc::new(Mutex::new(None));
        let up_calls = calls.clone();
        let up_token = token.clone();
        let upstream_task = tokio::spawn(async move {
            let (socket, _) = upstream.accept().await.unwrap();
            let Ok(tls) = TlsAcceptor::from(upstream_server).accept(socket).await else {
                return;
            };
            let handler = service_fn(move |req: Request<hyper::body::Incoming>| {
                up_calls.fetch_add(1, Ordering::SeqCst);
                *up_token.lock().unwrap() = req
                    .headers()
                    .get("authorization")
                    .map(|v| v.to_str().unwrap().to_owned());
                async move {
                    let _ = req.into_body().collect().await;
                    let mut response = Response::builder()
                        .status(status)
                        .header("connection", "close");
                    if status == 302 {
                        response = response.header("location", "https://forbidden.invalid/");
                    }
                    Ok::<_, Infallible>(
                        response
                            .body(Full::new(Bytes::from_static(b"controlled receiver")))
                            .unwrap(),
                    )
                }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .keep_alive(false)
                .serve_connection(TokioIo::new(tls), handler)
                .await;
        });
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = match listener.local_addr().unwrap() {
            std::net::SocketAddr::V4(v) => v,
            _ => unreachable!(),
        };
        let mut firewall = Firewall::new(repository(), server, limits()).unwrap();
        if authorized {
            firewall.admission = admission::Source::Fixture {
                endpoint,
                trust: upstream_trust,
                deadline: Instant::now() + lease,
                request_deadline: None,
            };
        }
        let result = Arc::new(Mutex::new(None));
        let task_result = result.clone();
        let firewall_task = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            *task_result.lock().unwrap() = Some(firewall.serve(socket).await);
        });
        Self {
            address,
            trust,
            calls,
            token,
            tasks: vec![upstream_task, firewall_task],
            result,
        }
    }
    async fn request(&self, origin: Origin, wire: &str) -> Vec<u8> {
        let socket = TcpStream::connect(self.address).await.unwrap();
        let mut tls = TlsConnector::from(self.trust.clone())
            .connect(ServerName::try_from(origin.hostname()).unwrap(), socket)
            .await
            .unwrap();
        let _ = tls.write_all(wire.as_bytes()).await;
        let mut bytes = Vec::new();
        let _ = timeout(Duration::from_secs(6), tls.read_to_end(&mut bytes))
            .await
            .unwrap();
        bytes
    }
    async fn settle(mut self) -> (usize, Option<String>, Option<Result<(), Refusal>>) {
        // The firewall returns only after its owned client driver settles.
        let firewall = self.tasks.pop().unwrap();
        timeout(Duration::from_secs(6), firewall)
            .await
            .unwrap()
            .unwrap();
        for task in self.tasks.drain(..) {
            task.abort();
            let _ = task.await;
        }
        (
            self.calls.load(Ordering::SeqCst),
            self.token.lock().unwrap().clone(),
            *self.result.lock().unwrap(),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

#[test]
fn selected_routes_and_unavailable_surfaces() {
    let repo = repository();
    for path in [
        "/fixture/repo.git/info/refs?service=git-upload-pack",
        "/fixture/repo.git/info/refs?service=git-receive-pack",
    ] {
        assert!(repo
            .allows(Origin::Git, &::http::Method::GET, &path.parse().unwrap())
            .is_ok());
    }
    for path in [
        "/repos/fixture/repo",
        "/repos/fixture/repo/issues?state=open&per_page=20",
        "/repos/fixture/repo/pulls?state=open&per_page=20",
    ] {
        assert!(repo
            .allows(Origin::Api, &::http::Method::GET, &path.parse().unwrap())
            .is_ok());
    }
    for path in [
        "/graphql",
        "/repos/foreign/repo",
        "/repos/fixture/repo/releases",
        "/repos/fixture/repo/issues?state=all",
        "https://api.github.com/repos/fixture/repo",
    ] {
        assert!(repo
            .allows(Origin::Api, &::http::Method::GET, &path.parse().unwrap())
            .is_err());
    }
}

#[tokio::test]
async fn verified_socket_forwards_native_authorization_unchanged() {
    let fixture = Fixture::start(
        Origin::Api,
        "api.github.com",
        200,
        Duration::from_secs(5),
        true,
    )
    .await;
    let response = fixture.request(Origin::Api, "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: Bearer synthetic-native\r\nConnection: close\r\n\r\n").await;
    assert!(String::from_utf8_lossy(&response).contains("controlled receiver"));
    let (calls, token, result) = fixture.settle().await;
    assert_eq!(calls, 1);
    assert_eq!(token.as_deref(), Some("Bearer synthetic-native"));
    assert_eq!(result, Some(Ok(())));
}

#[tokio::test]
async fn forbidden_authority_route_and_forwarding_reach_no_receiver() {
    for wire in [
        "GET /repos/fixture/repo HTTP/1.1\r\nHost: github.com\r\n\r\n",
        "CONNECT api.github.com:443 HTTP/1.1\r\nHost: api.github.com\r\n\r\n",
        "POST /graphql HTTP/1.1\r\nHost: api.github.com\r\nContent-Length: 0\r\n\r\n",
        "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nUpgrade: websocket\r\n\r\n",
        "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nProxy-Authorization: synthetic\r\n\r\n",
        "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nContent-Length: 1\r\n\r\nx",
    ] {
        let fixture = Fixture::start(Origin::Api, "api.github.com", 200, Duration::from_secs(5), true).await;
        let response = fixture.request(Origin::Api, wire).await;
        assert!(!String::from_utf8_lossy(&response).contains("controlled receiver"));
        assert_eq!(fixture.settle().await.0, 0);
    }
}

#[tokio::test]
async fn wrong_upstream_certificate_precedes_native_token_release() {
    let fixture = Fixture::start(
        Origin::Api,
        "wrong.invalid",
        200,
        Duration::from_secs(5),
        true,
    )
    .await;
    fixture.request(Origin::Api, "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: Bearer synthetic-native\r\n\r\n").await;
    let (calls, _, result) = fixture.settle().await;
    assert_eq!(calls, 0);
    assert_eq!(result, Some(Err(Refusal::Tls)));
}

#[tokio::test]
async fn redirects_are_neither_followed_nor_returned() {
    let fixture = Fixture::start(
        Origin::Api,
        "api.github.com",
        302,
        Duration::from_secs(5),
        true,
    )
    .await;
    let response = fixture
        .request(
            Origin::Api,
            "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\n\r\n",
        )
        .await;
    assert!(!String::from_utf8_lossy(&response).contains("forbidden.invalid"));
    let (calls, _, result) = fixture.settle().await;
    assert_eq!(calls, 1);
    assert_eq!(result, Some(Err(Refusal::Unsupported)));
}

#[tokio::test]
async fn missing_production_admission_has_zero_upstream_requests() {
    let fixture = Fixture::start(
        Origin::Api,
        "api.github.com",
        200,
        Duration::from_secs(5),
        false,
    )
    .await;
    fixture
        .request(
            Origin::Api,
            "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\n\r\n",
        )
        .await;
    let (calls, _, result) = fixture.settle().await;
    assert_eq!(calls, 0);
    assert_eq!(result, Some(Err(Refusal::AuthorityUnavailable)));
}

#[tokio::test]
async fn missing_sni_closes_before_any_upstream_request() {
    let fixture = Fixture::start(
        Origin::Api,
        "api.github.com",
        200,
        Duration::from_secs(5),
        true,
    )
    .await;
    let mut trust = (*fixture.trust).clone();
    trust.enable_sni = false;
    let socket = TcpStream::connect(fixture.address).await.unwrap();
    let mut tls = TlsConnector::from(Arc::new(trust))
        .connect(ServerName::try_from("api.github.com").unwrap(), socket)
        .await
        .unwrap();
    let _ = tls
        .write_all(b"GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\n\r\n")
        .await;
    let mut response = Vec::new();
    let _ = timeout(Duration::from_secs(6), tls.read_to_end(&mut response))
        .await
        .unwrap();
    let (calls, _, result) = fixture.settle().await;
    assert_eq!(calls, 0);
    assert_eq!(result, Some(Err(Refusal::Tls)));
}

#[tokio::test]
async fn declared_oversized_pack_is_rejected_before_upstream_effects() {
    let fixture =
        Fixture::start(Origin::Git, "github.com", 200, Duration::from_secs(5), true).await;
    fixture.request(Origin::Git,
        "POST /fixture/repo.git/git-receive-pack HTTP/1.1\r\nHost: github.com\r\nContent-Length: 1048577\r\n\r\n"
    ).await;
    let (calls, _, result) = fixture.settle().await;
    assert_eq!(calls, 0);
    assert_eq!(result, Some(Err(Refusal::Bounds)));
}

#[tokio::test]
async fn graphql_envelope_is_bounded_and_duplicate_safe() {
    for (body, expected) in [
        (
            r#"{"query":"query { viewer { login } }","variables":{}}"#,
            1,
        ),
        (
            r#"{"query":"query A { viewer { login } }","query":"query B { viewer { login } }"}"#,
            0,
        ),
        (
            r#"{"query":"query { viewer { login } }","variables":{"x":1,"x":2}}"#,
            0,
        ),
        (r#"[{"query":"query { viewer { login } }"}]"#, 0),
        (
            r#"{"query":"query { viewer { login } }","variables":[]}"#,
            0,
        ),
    ] {
        let fixture = Fixture::start(
            Origin::Api,
            "api.github.com",
            200,
            Duration::from_secs(5),
            true,
        )
        .await;
        let request = format!("POST /graphql HTTP/1.1\r\nHost: api.github.com\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",body.len());
        fixture.request(Origin::Api, &request).await;
        assert_eq!(fixture.settle().await.0, expected);
    }
}

#[tokio::test]
async fn graphql_tree_budget_rejects_before_origin_connection() {
    // A small wire body with many values can otherwise amplify into a large DOM.
    // Keep a healthy sibling request to distinguish rejection from broken TLS.
    let large_values = format!(
        "{{\"query\":\"query {{ viewer {{ login }} }}\",\"variables\":{{\"x\":[{}0]}}}}",
        "0,".repeat(20_000),
    );
    for (body, expected) in [
        (large_values, 0),
        (r#"{"query":"query { viewer { login } }"}"#.into(), 1),
    ] {
        let fixture = Fixture::start(
            Origin::Api,
            "api.github.com",
            200,
            Duration::from_secs(5),
            true,
        )
        .await;
        let request = format!("POST /graphql HTTP/1.1\r\nHost: api.github.com\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len());
        fixture.request(Origin::Api, &request).await;
        let (calls, _, result) = fixture.settle().await;
        assert_eq!(calls, expected);
        if expected == 0 {
            assert!(matches!(result, Some(Err(Refusal::Bounds))));
        }
    }
}

#[tokio::test]
async fn slow_request_expires_and_settles_upstream_driver() {
    let fixture = Fixture::start(
        Origin::Git,
        "github.com",
        200,
        Duration::from_millis(250),
        true,
    )
    .await;
    let response = fixture.request(Origin::Git, "POST /fixture/repo.git/git-receive-pack HTTP/1.1\r\nHost: github.com\r\nContent-Length: 100\r\n\r\npartial").await;
    assert!(!String::from_utf8_lossy(&response).contains("controlled receiver"));
    assert_eq!(fixture.settle().await.2, Some(Err(Refusal::Deadline)));
}

pub(crate) mod native;

#[tokio::test]
async fn shorter_request_permit_terminates_response_body_and_upstream_driver() {
    let (incoming, trust) = certificates("api.github.com");
    let (upstream_tls, upstream_trust) = certificates("api.github.com");
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let endpoint = match listener.local_addr().unwrap() {
        std::net::SocketAddr::V4(v) => v,
        _ => unreachable!(),
    };
    let upstream = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut tls = TlsAcceptor::from(upstream_tls)
            .accept(socket)
            .await
            .unwrap();
        let mut header = Vec::new();
        let mut byte = [0];
        while !header.ends_with(b"\r\n\r\n") {
            tls.read_exact(&mut byte).await.unwrap();
            header.push(byte[0]);
        }
        tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\nprefix")
            .await
            .unwrap();
        // Body stays unfinished beyond the request permit. Closing the driver
        // must close this peer even while no further body frames are available.
        let ended = timeout(Duration::from_secs(2), tls.read(&mut byte))
            .await
            .unwrap();
        assert!(ended.is_err() || ended.unwrap() == 0);
    });
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut firewall = Firewall::new(repository(), incoming, limits()).unwrap();
    firewall.admission = admission::Source::Fixture {
        endpoint,
        trust: upstream_trust,
        deadline: Instant::now() + Duration::from_secs(4),
        request_deadline: Some(Instant::now() + Duration::from_millis(500)),
    };
    let serving = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        firewall.serve(socket).await
    });
    let socket = TcpStream::connect(address).await.unwrap();
    let mut tls = TlsConnector::from(trust)
        .connect(ServerName::try_from("api.github.com").unwrap(), socket)
        .await
        .unwrap();
    tls.write_all(
        b"GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nConnection: close\r\n\r\n",
    )
    .await
    .unwrap();
    let mut received = Vec::new();
    let _ = timeout(Duration::from_secs(2), tls.read_to_end(&mut received))
        .await
        .unwrap();
    assert!(received.windows(6).any(|w| w == b"prefix"));
    assert_eq!(serving.await.unwrap(), Err(Refusal::Deadline));
    upstream.await.unwrap();
}
