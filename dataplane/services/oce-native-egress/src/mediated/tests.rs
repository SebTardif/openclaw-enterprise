//! Real Rust transport mechanics with an explicitly substituted broker/provider.
//! These tests do not exercise OCC authorization, custody, or committed release
//! ownership and cannot establish an integrated positive authority result.
use super::*;
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use rustls_pki_types::{PrivateKeyDer, ServerName};
use std::time::Duration;
use std::{
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, UnixListener},
    sync::Notify,
    time::timeout,
};

const TOKEN: &[u8] = b"synthetic-confidential-installation-token";
const REQUEST: &str =
    "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nConnection: close\r\n\r\n";

// A private CA signs distinct server/client leaves. The broker actually requires
// and verifies a client certificate; a resolver reporting has_certs is insufficient.
fn certificates(name: &str, mutual: bool) -> (Arc<ServerConfig>, Arc<ClientConfig>) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut params = CertificateParams::new(vec!["mediation-test-ca".into()]).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let key = KeyPair::generate().unwrap();
    let root = params.self_signed(&key).unwrap();
    let issuer = Issuer::new(params, key);
    let mut roots = RootCertStore::empty();
    roots.add(root.der().clone()).unwrap();
    let leaf = |name: &str, usage| {
        let mut params = CertificateParams::new(vec![name.to_owned()]).unwrap();
        params.extended_key_usages = vec![usage];
        let key = KeyPair::generate().unwrap();
        let cert = params.signed_by(&key, &issuer).unwrap();
        (
            vec![cert.der().clone()],
            PrivateKeyDer::Pkcs8(key.serialize_der().into()),
        )
    };
    let (cert, key) = leaf(name, ExtendedKeyUsagePurpose::ServerAuth);
    let server = ServerConfig::builder();
    let server = if mutual {
        server.with_client_cert_verifier(
            rustls::server::WebPkiClientVerifier::builder(Arc::new(roots.clone()))
                .build()
                .unwrap(),
        )
    } else {
        server.with_no_client_auth()
    };
    let mut server = server.with_single_cert(cert, key).unwrap();
    let client = ClientConfig::builder().with_root_certificates(roots);
    let mut client = if mutual {
        let (cert, key) = leaf("injector.test", ExtendedKeyUsagePurpose::ClientAuth);
        client.with_client_auth_cert(cert, key).unwrap()
    } else {
        client.with_no_client_auth()
    };
    let alpn = if mutual {
        broker_rpc::ALPN
    } else {
        b"http/1.1"
    };
    server.alpn_protocols = vec![alpn.to_vec()];
    client.alpn_protocols = vec![alpn.to_vec()];
    client.resumption = rustls::client::Resumption::disabled();
    (Arc::new(server), Arc::new(client))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    None,
    MissingBroker,
    WrongPeerUid,
    InsecureSocket,
    WrongDigest,
    WrongSession,
    WrongCertificate,
    ChangedWork,
    ChangedDns,
    ExpiredOpen,
    ExpiredDispatch,
    BadUpstreamTls,
    BrokerEofStalledBody,
    DuplicateMetadata,
    SecretOnOpen,
    SequenceGap,
    EscapedTokenEcho,
    ChunkedTokenEcho,
    OversizedMetadata,
    OversizedToken,
    PartialSecretEof,
    LostDispatchReply,
    LateValidDispatch,
    ChangedDispatchHorizon,
    ChangedCheckHorizon,
    InvalidRawToken,
    MismatchedTerminalReceipt,
    ContinueThenSuccess,
    EarlyHintsThenSuccess,
}

async fn read_frame<S: AsyncRead + Unpin>(stream: &mut S) -> Option<Value> {
    let mut sizes = [0; 8];
    if stream.read_exact(&mut sizes).await.is_err() {
        return None;
    }
    let count = u32::from_be_bytes(sizes[..4].try_into().unwrap()) as usize;
    assert!((1..=broker_rpc::FRAME_LIMIT).contains(&count));
    assert_eq!(
        &sizes[4..],
        &[0; 4],
        "client never carries credential bytes"
    );
    let mut bytes = vec![0; count];
    stream.read_exact(&mut bytes).await.unwrap();
    Some(serde_json::from_slice(&bytes).unwrap())
}
async fn write_frame<S: AsyncWrite + Unpin>(stream: &mut S, value: Value, secret: &[u8]) {
    let bytes = serde_json::to_vec(&value).unwrap();
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await
        .unwrap();
    stream
        .write_all(&(secret.len() as u32).to_be_bytes())
        .await
        .unwrap();
    stream.write_all(&bytes).await.unwrap();
    stream.write_all(secret).await.unwrap();
    stream.flush().await.unwrap();
}

struct Fixture {
    address: SocketAddrV4,
    trust: Arc<ClientConfig>,
    directory: PathBuf,
    requests: Arc<Mutex<Vec<Value>>>,
    upstream_wire: Arc<Mutex<Vec<u8>>>,
    broker_started: Arc<AtomicBool>,
    upstream_started: Arc<AtomicBool>,
    peers: Vec<JoinHandle<()>>,
    serving: Option<JoinHandle<Result<(), Refusal>>>,
}
struct Report {
    requests: Vec<Value>,
    wire: Vec<u8>,
    outcome: Result<(), Refusal>,
    broker_connected: bool,
}
impl Fixture {
    async fn start(fault: Fault) -> Self {
        let (incoming, trust) = certificates(HOST, false);
        let (upstream_tls, upstream_trust) = certificates(
            if fault == Fault::BadUpstreamTls {
                "wrong.test"
            } else {
                HOST
            },
            false,
        );
        let (broker_tls, broker_trust) = certificates("broker.test", true);
        let scratch = std::env::var_os("OCE_MEDIATION_TEST_SCRATCH")
            .or_else(|| std::env::var_os("HOME"))
            .expect("a protected HOME or OCE_MEDIATION_TEST_SCRATCH is required");
        let directory = PathBuf::from(scratch).join(format!(
            "mediation-test-{}",
            broker_rpc::random_ref().unwrap()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let socket_path = directory.join("broker.sock");
        let uid = std::fs::metadata(&directory).unwrap().uid();
        let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let SocketAddr::V4(endpoint) = upstream.local_addr().unwrap() else {
            unreachable!()
        };
        let upstream_wire = Arc::new(Mutex::new(Vec::new()));
        let upstream_started = Arc::new(AtomicBool::new(false));
        let stalled = Arc::new(Notify::new());
        let up_wire = upstream_wire.clone();
        let up_started = upstream_started.clone();
        let up_stalled = stalled.clone();
        let upstream_task = tokio::spawn(async move {
            let (socket, _) = upstream.accept().await.unwrap();
            up_started.store(true, Ordering::SeqCst);
            let Ok(mut tls) = TlsAcceptor::from(upstream_tls).accept(socket).await else {
                return;
            };
            let mut wire = Vec::new();
            let mut byte = [0];
            while !wire.ends_with(b"\r\n\r\n") {
                match tls.read(&mut byte).await {
                    Ok(1) => wire.push(byte[0]),
                    _ => {
                        *up_wire.lock().unwrap() = wire;
                        return;
                    }
                }
                assert!(wire.len() < 16384);
            }
            *up_wire.lock().unwrap() = wire;
            if fault == Fault::BrokerEofStalledBody {
                tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\nConnection: close\r\n\r\n{\"id\":1").await.unwrap();
                up_stalled.notify_one();
                // The mediator must close this leg while the response remains
                // incomplete; joining this task proves peer closure was observed.
                let result = timeout(Duration::from_secs(3), tls.read(&mut byte))
                    .await
                    .expect("stalled upstream socket was not closed");
                assert!(matches!(result, Ok(0) | Err(_)));
                return;
            }
            if matches!(fault, Fault::EscapedTokenEcho | Fault::ChunkedTokenEcho) {
                let echo = if fault == Fault::EscapedTokenEcho {
                    "\\u0073ynthetic-confidential-installation-token"
                } else {
                    "synthetic-confidential-installation-token"
                };
                let body = format!(
                    r#"{{"id":17,"name":"repo","full_name":"fixture/repo","private":true,"default_branch":"main","ignored":"{echo}"}}"#
                );
                tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
                // Five-byte chunks deliberately split both escaped JSON strings
                // and the token canary across received HTTP body frames.
                for chunk in body.as_bytes().chunks(5) {
                    tls.write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                        .await
                        .unwrap();
                    tls.write_all(chunk).await.unwrap();
                    tls.write_all(b"\r\n").await.unwrap();
                }
                tls.write_all(b"0\r\n\r\n").await.unwrap();
                tls.shutdown().await.unwrap();
                return;
            }
            let body = br#"{"id":17,"name":"repo","full_name":"fixture/repo","private":true,"default_branch":"main","ignored":"provider-only"}"#;
            let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nSet-Cookie: provider-cookie\r\nX-Provider-Secret: synthetic-confidential-installation-token\r\n\r\n", body.len());
            if matches!(
                fault,
                Fault::ContinueThenSuccess | Fault::EarlyHintsThenSuccess
            ) {
                let status = if fault == Fault::ContinueThenSuccess {
                    "100 Continue"
                } else {
                    "103 Early Hints"
                };
                let mut wire = format!("HTTP/1.1 {status}\r\nX-Interim-Secret: synthetic-confidential-installation-token\r\n\r\n{headers}").into_bytes();
                wire.extend_from_slice(body);
                // Coalesce interim and final responses so rejecting only the
                // eventual 200 cannot hide Hyper's informational-response behavior.
                // Early mediator closure can interrupt this attempted write.
                let _ = tls.write_all(&wire).await;
                let _ = tls.shutdown().await;
                return;
            }
            tls.write_all(headers.as_bytes()).await.unwrap();
            tls.write_all(body).await.unwrap();
            tls.shutdown().await.unwrap();
        });
        let requests = Arc::new(Mutex::new(Vec::new()));
        let broker_started = Arc::new(AtomicBool::new(false));
        let mut peers = vec![upstream_task];
        if fault != Fault::MissingBroker {
            let listener = UnixListener::bind(&socket_path).unwrap();
            std::fs::set_permissions(
                &socket_path,
                std::fs::Permissions::from_mode(if fault == Fault::InsecureSocket {
                    0o666
                } else {
                    0o600
                }),
            )
            .unwrap();
            let seen = requests.clone();
            let started = broker_started.clone();
            peers.push(tokio::spawn(async move {
                let (socket, _) = listener.accept().await.unwrap();
                started.store(true, Ordering::SeqCst);
                assert_eq!(socket.peer_cred().unwrap().uid(), uid);
                let mut tls = TlsAcceptor::from(broker_tls).accept(socket).await.unwrap();
                assert_eq!(tls.get_ref().1.alpn_protocol(), Some(broker_rpc::ALPN));
                assert!(!tls.get_ref().1.peer_certificates().unwrap().is_empty());
                let mut binding = serde_json::Map::new();
                let operation_until = broker_rpc::unix_ms().unwrap() + 5000;
                while let Some(request) = read_frame(&mut tls).await {
                    seen.lock().unwrap().push(request.clone());
                    let method = request["method"].as_str().unwrap();
                    if method == "open-read" {
                        assert_eq!(request["attachment_ref"], "listener-original-attachment");
                        assert_eq!(request["repository_owner"], "fixture");
                        assert_eq!(request["repository_name"], "repo");
                        // Independently computed SHA-256 of the protocol's exact
                        // LF-terminated fixture/repo canonical request text.
                        assert_eq!(request["request_sha256"], "sha256:6a8f6abe46aea98ff3eaf2fc39224e649b58e1fdcdeb80ad1730abacbede8ecd");
                        for (key, value) in [("session_ref", Value::String("a".repeat(32))), ("effect_ref", "fixture-effect".into()), ("work_binding_sha256", broker_rpc::sha256(b"substituted-binding").into()), ("request_sha256", request["request_sha256"].clone())] { binding.insert(key.into(), value); }
                    }
                    let mut reply = Value::Object(binding.clone());
                    for key in ["version", "sequence", "request_ref"] { reply[key] = request[key].clone(); }
                    reply["ok"] = true.into();
                    if method == "complete-read" {
                        reply["phase"] = "recorded".into();
                        reply["release_ref"] = request["release_ref"].clone();
                        if fault == Fault::MismatchedTerminalReceipt { reply["release_ref"] = "wrong-release".into(); }
                        write_frame(&mut tls, reply, &[]).await;
                        return;
                    }
                    let now = broker_rpc::unix_ms().unwrap();
                    reply["server_time_ms"] = now.into();
                    reply["valid_until_ms"] = (now + 2000).min(operation_until).into();
                    reply["operation_until_ms"] = operation_until.into();
                    let secret = match method {
                        "open-read" => {
                            reply["phase"] = "opened".into();
                            reply["dns_binding_ref"] = "fixture-dns".into();
                            reply["upstream_ipv4"] = "127.0.0.1".into();
                            if fault == Fault::ExpiredOpen { reply["valid_until_ms"] = now.into(); }
                            if fault == Fault::LateValidDispatch { reply["valid_until_ms"] = (now + 200).into(); }
                            &[][..]
                        }
                        "dispatch-read" => {
                            reply["phase"] = "dispatch-once".into();
                            for key in ["dns_binding_ref", "upstream_ipv4", "peer_certificate_sha256"] { reply[key] = request[key].clone(); }
                            reply["release_ref"] = "fixture-release".into();
                            match fault {
                                Fault::WrongDigest => reply["request_sha256"] = broker_rpc::sha256(b"wrong-request").into(),
                                Fault::WrongSession => reply["session_ref"] = "b".repeat(32).into(),
                                Fault::WrongCertificate => reply["peer_certificate_sha256"] = broker_rpc::sha256(b"wrong-certificate").into(),
                                Fault::ChangedWork => reply["work_binding_sha256"] = broker_rpc::sha256(b"different-work").into(),
                                Fault::ChangedDns => reply["dns_binding_ref"] = "different-dns".into(),
                                Fault::ExpiredDispatch => reply["valid_until_ms"] = now.into(),
                                Fault::ChangedDispatchHorizon => reply["operation_until_ms"] = (operation_until + 1).into(),
                                _ => {}
                            }
                            TOKEN
                        }
                        "check-read" => {
                            reply["phase"] = "current".into();
                            reply["release_ref"] = "fixture-release".into();
                            if fault == Fault::ChangedCheckHorizon { reply["operation_until_ms"] = (operation_until + 1).into(); }
                            &[][..]
                        }
                        _ => panic!("unexpected broker method"),
                    };
                    if method == "dispatch-read" && fault == Fault::LateValidDispatch {
                        // A fresh-looking positive reply cannot resurrect the
                        // preceding preparation lease after it has expired.
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        let now = broker_rpc::unix_ms().unwrap();
                        reply["server_time_ms"] = now.into();
                        reply["valid_until_ms"] = (now + 2000).into();
                        let encoded = serde_json::to_vec(&reply).unwrap();
                        let mut frame = Vec::new();
                        frame.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
                        frame.extend_from_slice(&(TOKEN.len() as u32).to_be_bytes());
                        frame.extend_from_slice(&encoded);
                        frame.extend_from_slice(TOKEN);
                        // Closing the client before this late write is expected.
                        let _ = tls.write_all(&frame).await;
                        let _ = tls.flush().await;
                        return;
                    } else if method == "dispatch-read" && fault == Fault::LostDispatchReply {
                        // The fixture recorded the dispatch correlation above,
                        // but the client receives no release acknowledgement.
                        return;
                    } else if method == "dispatch-read" && fault == Fault::PartialSecretEof {
                        let encoded = serde_json::to_vec(&reply).unwrap();
                        tls.write_all(&(encoded.len() as u32).to_be_bytes()).await.unwrap();
                        tls.write_all(&(TOKEN.len() as u32).to_be_bytes()).await.unwrap();
                        tls.write_all(&encoded).await.unwrap();
                        tls.write_all(&TOKEN[..5]).await.unwrap();
                        tls.flush().await.unwrap();
                        return;
                    } else if (method == "open-read" && fault == Fault::OversizedMetadata)
                        || (method == "dispatch-read" && fault == Fault::OversizedToken) {
                        // Send only the declarations. Bounds refusal must occur
                        // without waiting for or reading an oversized payload.
                        let metadata = if fault == Fault::OversizedMetadata { broker_rpc::FRAME_LIMIT + 1 } else { 1 };
                        let secret = if fault == Fault::OversizedToken { broker_rpc::TOKEN_LIMIT + 1 } else { 0 };
                        tls.write_all(&(metadata as u32).to_be_bytes()).await.unwrap();
                        tls.write_all(&(secret as u32).to_be_bytes()).await.unwrap();
                        tls.flush().await.unwrap();
                    } else if method == "open-read" && fault == Fault::DuplicateMetadata {
                        let encoded = serde_json::to_string(&reply).unwrap();
                        let encoded = format!("{{\"version\":2,{}", &encoded[1..]);
                        tls.write_all(&(encoded.len() as u32).to_be_bytes()).await.unwrap();
                        tls.write_all(&0_u32.to_be_bytes()).await.unwrap();
                        tls.write_all(encoded.as_bytes()).await.unwrap();
                        tls.flush().await.unwrap();
                    } else {
                        if method == "open-read" && fault == Fault::SequenceGap { reply["sequence"] = 2.into(); }
                        let secret = if method == "open-read" && fault == Fault::SecretOnOpen { TOKEN } else { secret };
                        let secret = if method == "dispatch-read" && fault == Fault::InvalidRawToken { &b"invalid\x00token"[..] } else { secret };
                        write_frame(&mut tls, reply, secret).await;
                    }
                    if method == "dispatch-read" && fault == Fault::BrokerEofStalledBody {
                        timeout(Duration::from_secs(3), stalled.notified()).await.unwrap();
                        return; // Real broker EOF after the upstream body stalls.
                    }
                }
            }));
        }
        let limits = Limits {
            header_bytes: 16384,
            header_count: 64,
            request_bytes: 1024,
            response_bytes: 16384,
            exchange_timeout: Duration::from_secs(5),
        };
        let broker = BrokerConfig {
            socket_path,
            peer_uid: if fault == Fault::WrongPeerUid {
                uid.checked_add(1).unwrap()
            } else {
                uid
            },
            trusted_ancestor_uids: vec![std::fs::metadata("/").unwrap().uid()],
            server_name: ServerName::try_from("broker.test").unwrap(),
            tls: broker_trust,
            call_timeout: Duration::from_secs(1),
            check_interval: Duration::from_millis(50),
            max_clock_skew: Duration::from_millis(50),
        };
        let mut mediator = Mediator::new(
            Repository::new("fixture", "repo", &"a".repeat(40)).unwrap(),
            incoming,
            upstream_trust,
            broker,
            limits,
            1,
        )
        .unwrap();
        mediator.test_endpoint = Some(endpoint);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let SocketAddr::V4(address) = listener.local_addr().unwrap() else {
            unreachable!()
        };
        let serving = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            mediator.serve(socket, "listener-original-attachment").await
        });
        Self {
            address,
            trust,
            directory,
            requests,
            upstream_wire,
            broker_started,
            upstream_started,
            peers,
            serving: Some(serving),
        }
    }
    async fn request(&self, wire: &str) -> Vec<u8> {
        timeout(Duration::from_secs(6), async {
            let socket = TcpStream::connect(self.address).await.unwrap();
            let mut tls = TlsConnector::from(self.trust.clone())
                .connect(ServerName::try_from(HOST).unwrap(), socket)
                .await
                .unwrap();
            tls.write_all(wire.as_bytes()).await.unwrap();
            let mut response = Vec::new();
            let _ = tls.read_to_end(&mut response).await;
            response
        })
        .await
        .expect("incoming TLS request exceeded its bound")
    }
    async fn settle(mut self) -> Report {
        let outcome = timeout(Duration::from_secs(6), self.serving.take().unwrap())
            .await
            .unwrap()
            .unwrap();
        for (index, task) in self.peers.drain(..).enumerate() {
            let started = if index == 0 {
                &self.upstream_started
            } else {
                &self.broker_started
            };
            if started.load(Ordering::SeqCst) {
                timeout(Duration::from_secs(3), task)
                    .await
                    .expect("owned peer did not settle")
                    .unwrap();
            } else {
                task.abort();
                let _ = task.await;
            }
        }
        Report {
            requests: self.requests.lock().unwrap().clone(),
            wire: self.upstream_wire.lock().unwrap().clone(),
            outcome,
            broker_connected: self.broker_started.load(Ordering::SeqCst),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = &self.serving {
            task.abort();
        }
        for task in &self.peers {
            task.abort();
        }
        let _ = std::fs::remove_file(self.directory.join("broker.sock"));
        let _ = std::fs::remove_dir(&self.directory);
    }
}

#[tokio::test]
async fn substituted_broker_real_tls_submits_one_fixed_request_and_projects_response() {
    let fixture = Fixture::start(Fault::None).await;
    let response = fixture.request("GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nX-Caller-Secret: must-not-forward\r\nX-Attachment-Ref: forged\r\nAccept: text/plain\r\nConnection: close\r\n\r\n").await;
    let report = fixture.settle().await;
    assert_eq!(report.outcome, Ok(()));
    let response = String::from_utf8(response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(response.contains("\"full_name\":\"fixture/repo\""));
    for hidden in [
        "provider-only",
        "provider-cookie",
        "synthetic-confidential",
        "must-not-forward",
    ] {
        assert!(!response.contains(hidden));
    }
    let wire = String::from_utf8(report.wire).unwrap().to_ascii_lowercase();
    let mut lines = wire.split("\r\n");
    assert_eq!(lines.next(), Some("get /repos/fixture/repo http/1.1"));
    let mut headers: Vec<_> = lines.take_while(|line| !line.is_empty()).collect();
    headers.sort_unstable();
    assert_eq!(
        headers,
        vec![
            "accept-encoding: identity",
            "accept: application/vnd.github+json",
            "authorization: bearer synthetic-confidential-installation-token",
            "connection: close",
            "host: api.github.com",
            "user-agent: oce-github-mediation"
        ]
    );
    assert_eq!(
        report
            .requests
            .iter()
            .filter(|r| r["method"] == "dispatch-read")
            .count(),
        1
    );
    assert!(report.requests.iter().any(|r| r["method"] == "check-read"));
    assert_eq!(report.requests.last().unwrap()["outcome"], "completed");
    for (index, request) in report.requests.iter().enumerate() {
        assert_eq!(request["sequence"], (index + 1) as u64);
    }
}

#[tokio::test]
async fn caller_credentials_and_unselected_routes_never_open_broker_or_upstream() {
    for wire in [
        "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nAuthorization: Bearer caller\r\n\r\n",
        "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nProxy-Authorization: caller\r\n\r\n",
        "GET /repos/fixture/repo HTTP/1.1\r\nHost: api.github.com\r\nCookie: caller\r\n\r\n",
        "GET /repos/foreign/repo HTTP/1.1\r\nHost: api.github.com\r\n\r\n",
        "GET /repos/fixture/repo?x=1 HTTP/1.1\r\nHost: api.github.com\r\n\r\n",
    ] {
        let fixture = Fixture::start(Fault::None).await;
        let response = fixture.request(wire).await;
        assert!(!response.starts_with(b"HTTP/1.1 200"));
        let report = fixture.settle().await;
        assert_eq!(report.outcome, Err(Refusal::Unsupported));
        assert!(report.requests.is_empty());
        assert!(report.wire.is_empty());
    }
}

#[tokio::test]
async fn incorrect_dispatch_bindings_and_expired_replies_emit_no_upstream_http_bytes() {
    for fault in [
        Fault::WrongDigest,
        Fault::WrongSession,
        Fault::WrongCertificate,
        Fault::ChangedWork,
        Fault::ChangedDns,
        Fault::ExpiredOpen,
        Fault::ExpiredDispatch,
        Fault::LateValidDispatch,
        Fault::ChangedDispatchHorizon,
    ] {
        let fixture = Fixture::start(fault).await;
        let response = fixture.request(REQUEST).await;
        assert!(!response.starts_with(b"HTTP/1.1 200"));
        let report = fixture.settle().await;
        assert_eq!(
            report.outcome,
            Err(
                if matches!(
                    fault,
                    Fault::ExpiredOpen
                        | Fault::ExpiredDispatch
                        | Fault::LateValidDispatch
                        | Fault::ChangedDispatchHorizon
                ) {
                    Refusal::Deadline
                } else {
                    Refusal::Protocol
                }
            ),
            "{fault:?}"
        );
        assert!(report.wire.is_empty(), "{fault:?}");
        assert_eq!(
            report
                .requests
                .iter()
                .filter(|r| r["method"] == "dispatch-read")
                .count(),
            usize::from(fault != Fault::ExpiredOpen)
        );
    }
}

#[tokio::test]
async fn absent_or_unprotected_broker_and_invalid_upstream_tls_never_release_or_submit() {
    for fault in [
        Fault::MissingBroker,
        Fault::WrongPeerUid,
        Fault::InsecureSocket,
        Fault::BadUpstreamTls,
    ] {
        let fixture = Fixture::start(fault).await;
        let response = fixture.request(REQUEST).await;
        assert!(!response.starts_with(b"HTTP/1.1 200"));
        let report = fixture.settle().await;
        assert!(report.wire.is_empty());
        assert!(!report
            .requests
            .iter()
            .any(|r| r["method"] == "dispatch-read"));
        assert_eq!(
            report.outcome,
            Err(if fault == Fault::BadUpstreamTls {
                Refusal::Tls
            } else {
                Refusal::AuthorityUnavailable
            })
        );
        if fault == Fault::BadUpstreamTls {
            assert_eq!(report.requests.last().unwrap()["outcome"], "not-dispatched");
        } else {
            assert!(
                !report.broker_connected,
                "invalid protection is rejected before UDS connection"
            );
            assert!(report.requests.is_empty());
        }
    }
}

#[tokio::test]
async fn broker_eof_cancels_stalled_upstream_body_and_joins_owned_sockets() {
    let fixture = Fixture::start(Fault::BrokerEofStalledBody).await;
    let start = Instant::now();
    let response = fixture.request(REQUEST).await;
    let report = fixture.settle().await;
    assert!(start.elapsed() < Duration::from_secs(3));
    assert!(report.outcome.is_err());
    assert!(!response.starts_with(b"HTTP/1.1 200"));
    assert!(!response.windows(7).any(|w| w == b"{\"id\":1"));
    assert!(
        !report.wire.is_empty(),
        "the body stall follows actual upstream submission"
    );
    assert_eq!(
        report
            .requests
            .iter()
            .filter(|r| r["method"] == "dispatch-read")
            .count(),
        1
    );
    assert!(!report.requests.iter().any(|r| r["outcome"] == "completed"));
}

#[tokio::test]
async fn malformed_broker_frames_never_submit_upstream_http() {
    for fault in [
        Fault::DuplicateMetadata,
        Fault::SecretOnOpen,
        Fault::SequenceGap,
        Fault::OversizedMetadata,
        Fault::OversizedToken,
        Fault::PartialSecretEof,
        Fault::LostDispatchReply,
        Fault::InvalidRawToken,
    ] {
        let fixture = Fixture::start(fault).await;
        let response = fixture.request(REQUEST).await;
        let report = fixture.settle().await;
        assert!(!response.starts_with(b"HTTP/1.1 200"));
        assert_eq!(
            report.outcome,
            Err(match fault {
                Fault::SecretOnOpen | Fault::OversizedMetadata | Fault::OversizedToken =>
                    Refusal::Bounds,
                Fault::PartialSecretEof | Fault::LostDispatchReply => Refusal::Io,
                _ => Refusal::Protocol,
            }),
            "{fault:?}"
        );
        let dispatched = matches!(
            fault,
            Fault::OversizedToken
                | Fault::PartialSecretEof
                | Fault::LostDispatchReply
                | Fault::InvalidRawToken
        );
        assert_eq!(report.requests.len(), if dispatched { 2 } else { 1 });
        if dispatched {
            assert_eq!(report.requests[1]["method"], "dispatch-read");
            assert_eq!(
                report.requests[1]["request_ref"],
                report.requests[0]["request_ref"]
            );
            assert!(!report.requests.iter().any(|r| r["outcome"] == "completed"));
        }
        assert!(report.wire.is_empty());
    }
}

#[tokio::test]
async fn escaped_and_chunk_split_token_echoes_are_suppressed_before_downstream_delivery() {
    for fault in [Fault::EscapedTokenEcho, Fault::ChunkedTokenEcho] {
        let fixture = Fixture::start(fault).await;
        let response = fixture.request(REQUEST).await;
        let report = fixture.settle().await;
        assert_eq!(report.outcome, Err(Refusal::Unsupported));
        assert!(!response.starts_with(b"HTTP/1.1 200"));
        assert!(!response.windows(12).any(|w| w == b"confidential"));
        assert!(!response.windows(6).any(|w| w == b"u0073y"));
        assert_eq!(report.requests.last().unwrap()["outcome"], "unknown");
        assert_eq!(
            report
                .requests
                .iter()
                .filter(|r| r["method"] == "dispatch-read")
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn changed_check_horizon_and_mismatched_terminal_receipt_cannot_report_success() {
    for fault in [Fault::ChangedCheckHorizon, Fault::MismatchedTerminalReceipt] {
        let fixture = Fixture::start(fault).await;
        let response = fixture.request(REQUEST).await;
        let report = fixture.settle().await;
        assert!(!report.wire.is_empty());
        assert_eq!(
            report
                .requests
                .iter()
                .filter(|r| r["method"] == "dispatch-read")
                .count(),
            1
        );
        if fault == Fault::ChangedCheckHorizon {
            assert_eq!(report.outcome, Err(Refusal::Deadline));
            assert!(!response.starts_with(b"HTTP/1.1 200"));
            assert!(report.requests.iter().any(|r| r["method"] == "check-read"));
            assert!(!report.requests.iter().any(|r| r["outcome"] == "completed"));
        } else {
            // The HTTP response was delivered before terminal recording. A bad
            // receipt cannot erase that delivery or make serve report success.
            assert!(response.starts_with(b"HTTP/1.1 200"));
            assert_eq!(report.requests.last().unwrap()["outcome"], "completed");
            assert_eq!(report.outcome, Err(Refusal::Protocol));
        }
    }
}

#[tokio::test]
async fn informational_responses_close_eligibility_before_final_success_or_header_echo() {
    for fault in [Fault::ContinueThenSuccess, Fault::EarlyHintsThenSuccess] {
        let fixture = Fixture::start(fault).await;
        let response = fixture.request(REQUEST).await;
        let report = fixture.settle().await;
        assert_eq!(report.outcome, Err(Refusal::Unsupported), "{fault:?}");
        assert!(!report.wire.is_empty());
        let response = String::from_utf8_lossy(&response);
        for forbidden in [
            "HTTP/1.1 200",
            "HTTP/1.1 100",
            "HTTP/1.1 103",
            "confidential",
            "full_name",
            "provider-only",
        ] {
            assert!(
                !response.contains(forbidden),
                "{fault:?}: leaked {forbidden}"
            );
        }
        assert_eq!(
            report
                .requests
                .iter()
                .filter(|r| r["method"] == "dispatch-read")
                .count(),
            1
        );
        assert!(!report.requests.iter().any(|r| r["outcome"] == "completed"));
    }
}
