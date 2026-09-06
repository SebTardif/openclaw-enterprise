// Modified for OpenClaw Enterprise.
//! These tests exercise real Hyper, TLS, TCP and UDS transports. Scripted wire
//! replies qualify adapter behavior, never canonical OCE identity or authority.
use super::*;
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use rustls::{ServerConnection, StreamOwned};
use std::{
    io::{self, Write},
    os::unix::{fs::PermissionsExt, net::UnixListener},
    time::{SystemTime, UNIX_EPOCH},
};
static NEXT: AtomicUsize = AtomicUsize::new(1);
const ASSIGNMENT: &str = "10000000-0000-0000-0000-000000000001";
const INSTANCE: &str = "20000000-0000-0000-0000-000000000002";
const EVIDENCE: &str = "30000000-0000-0000-0000-000000000003";
struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "oce-tls-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        Self(p)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn descriptor() -> rpc::CredentialBinding {
    rpc::CredentialBinding {
        provider_binding_ref: "provider-test".into(),
        service_account_id: "account-test".into(),
        credential_profile_ref: "api-key".into(),
        provider_profile_ref: "openai-responses".into(),
        audience_ref: "openai-api".into(),
        transport_profile_ref: "http-sse-v1".into(),
    }
}
fn body() -> String {
    json!({"model":"gpt-5.1","stream":true,"store":false,"input":[],"tool_choice":"auto","parallel_tool_calls":true,"client_metadata":{"x-codex-turn-metadata":"{\"openclaw_mediation_context\":\"turn-a\"}"}}).to_string()
}
fn wire(body: &str) -> String {
    format!("POST /v1/responses HTTP/1.1\r\nHost: localhost:8443\r\nAuthorization: Bearer workload-only-canary\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",body.len())
}
fn parts(body: &str) -> ::http::request::Parts {
    ::http::Request::builder()
        .method("POST")
        .uri("/v1/responses")
        .version(::http::Version::HTTP_11)
        .header("host", "localhost:8443")
        .header("authorization", "Bearer workload-only-canary")
        .header("content-type", "application/json")
        .header("content-length", body.len())
        .body(())
        .unwrap()
        .into_parts()
        .0
}
#[test]
fn application_policy_rejects_duplicate_security_headers_and_unselected_operations() {
    let b = body();
    assert!(http::parse_request(&parts(&b), b.clone().into_bytes(), "localhost:8443").is_ok());
    for header in ["authorization", "host", "x-codex-turn-metadata"] {
        let mut p = parts(&b);
        p.headers
            .append(header, ::http::HeaderValue::from_static("one"));
        p.headers
            .append(header, ::http::HeaderValue::from_static("two"));
        assert!(http::parse_request(&p, b.clone().into_bytes(), "localhost:8443").is_err());
    }
    for path in [
        "/v1/responses/compact",
        "/v1/responses?secret=x",
        "https://attacker.example/v1/responses",
    ] {
        let mut p = parts(&b);
        p.uri = path.parse().unwrap();
        assert!(http::parse_request(&p, b.clone().into_bytes(), "localhost:8443").is_err());
    }
    for invalid in [
        b.replace("\"model\":", "\"model\":\"other\",\"model\":"),
        b.replace("\"store\":false", "\"background\":true,\"store\":false"),
        b.replace(
            "\"input\":[]",
            "\"input\":[],\"previous_response_id\":\"other-turn\"",
        ),
        b.replace(
            "\"input\":[]",
            "\"input\":[],\"tools\":[{\"type\":\"web_search\"}]",
        ),
    ] {
        assert!(http::parse_request(
            &parts(&invalid),
            invalid.clone().into_bytes(),
            "localhost:8443"
        )
        .is_err());
    }
}
struct Certificates {
    root_pem: String,
    leaf_pem: String,
    key_pem: String,
    server: Arc<ServerConfig>,
}
fn certificates(name: &str) -> Certificates {
    let mut root = CertificateParams::new(vec!["test-root".into()]).unwrap();
    root.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    root.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let key = KeyPair::generate().unwrap();
    let cert = root.self_signed(&key).unwrap();
    let issuer = Issuer::new(root, key);
    let mut leaf = CertificateParams::new(vec![name.into()]).unwrap();
    leaf.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let key = KeyPair::generate().unwrap();
    let leaf = leaf.signed_by(&key, &issuer).unwrap();
    let mut server = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![leaf.der().clone()],
            PrivateKeyDer::Pkcs8(key.serialize_der().into()),
        )
        .unwrap();
    server.alpn_protocols = vec![b"http/1.1".to_vec()];
    Certificates {
        root_pem: cert.pem(),
        leaf_pem: leaf.pem(),
        key_pem: key.serialize_pem(),
        server: Arc::new(server),
    }
}
fn service_with_ingress(
    dir: &Dir,
    certs: &Certificates,
    port: u16,
    incoming: Option<&Certificates>,
) -> Service {
    let (incoming_certificate_path, incoming_key_path) = match incoming {
        Some(certs) => {
            let certificate = dir.0.join("incoming.pem");
            let key = dir.0.join("incoming-key.pem");
            fs::write(&certificate, &certs.leaf_pem).unwrap();
            fs::write(&key, &certs.key_pem).unwrap();
            (Some(certificate), Some(key))
        }
        None => (None, None),
    };
    let root = dir.0.join("root.pem");
    fs::write(&root, &certs.root_pem).unwrap();
    let key = dir.0.join("provider-key");
    fs::write(&key, "provider-secret-canary").unwrap();
    let mut service = Service::new(Config {
        listen: "127.0.0.1:8443".parse().unwrap(),
        listener_authority: "localhost:8443".into(),
        authority_socket: dir.0.join("authority"),
        dns_socket: dir.0.join("dns"),
        provider_key_path: key,
        provider_binding_ref: "provider-test".into(),
        credential_binding: descriptor(),
        root_ca_path: root,
        incoming_certificate_path,
        incoming_key_path,
        development_loopback_http: incoming.is_none(),
        max_concurrent: 2,
    })
    .unwrap();
    service.origin_port = port;
    service.authority.peer_uid = nix::unistd::getuid().as_raw();
    service.dns.peer_uid = nix::unistd::getuid().as_raw();
    service
}
struct WireServer {
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl WireServer {
    fn spawn(path: PathBuf, mut respond: impl FnMut(Value) -> Value + Send + 'static) -> Self {
        let listener = UnixListener::bind(path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let done = stop.clone();
        let worker = thread::spawn(move || {
            while !done.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut size = [0; 4];
                        if socket.read_exact(&mut size).is_err() {
                            continue;
                        }
                        let n = u32::from_be_bytes(size) as usize;
                        assert!(n <= 2 * 1024 * 1024);
                        let mut data = vec![0; n];
                        if socket.read_exact(&mut data).is_err() {
                            continue;
                        }
                        let request = json::parse(&data).unwrap();
                        let reply = serde_json::to_vec(&respond(request)).unwrap();
                        let _ = socket.write_all(&(reply.len() as u32).to_be_bytes());
                        let _ = socket.write_all(&reply);
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for WireServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(w) = self.worker.take() {
            w.join().unwrap();
        }
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn timed() -> Value {
    let n = now();
    json!({"version":1,"ok":true,"server_time_ms":n,"valid_until_ms":n+4000})
}
#[derive(Clone, Copy)]
enum Scenario {
    Allowed,
    DeniedInspect,
    DeniedDispatch,
    WrongCertificate,
    TruncatedResponse,
    Redirect,
    RevokedStream,
    MissingTerminal,
    JsonTerminalBait,
}
struct Observed {
    upstream: Vec<u8>,
    response: String,
    receipts: Vec<String>,
    admissions: usize,
    elapsed: Duration,
    attempts: usize,
    dispatches: usize,
    releases: usize,
    handler_error: Option<String>,
    provider_observed_close: bool,
    paused_progress: Option<(usize, usize)>,
    bound_flow: Option<Value>,
    released_flow: Option<Value>,
}
fn transport_fixture(scenario: Scenario, raw: String, fragmented: bool) -> Observed {
    transport_with_ingress(scenario, raw, fragmented, false)
}
fn transport_with_ingress(
    scenario: Scenario,
    raw: String,
    fragmented: bool,
    secure_ingress: bool,
) -> Observed {
    transport_with_controls(scenario, raw, fragmented, secure_ingress, None)
}
fn transport_with_controls(
    scenario: Scenario,
    raw: String,
    fragmented: bool,
    secure_ingress: bool,
    normal: Option<NormalStream>,
) -> Observed {
    let dir = Dir::new();
    let certs = certificates(if matches!(scenario, Scenario::WrongCertificate) {
        "attacker.example"
    } else {
        FIXED_HOST
    });
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let incoming = secure_ingress.then(|| certificates("localhost"));
    let service = service_with_ingress(
        &dir,
        &certs,
        listener.local_addr().unwrap().port(),
        incoming.as_ref(),
    );
    let upstream_done = Arc::new(AtomicBool::new(false));
    let stop = upstream_done.clone();
    let server = certs.server.clone();
    let attempts = Arc::new(AtomicUsize::new(0));
    let attempted = attempts.clone();
    let progress = Arc::new(StreamProgress::default());
    let producer_progress = progress.clone();
    let provider_observed_close = Arc::new(AtomicBool::new(false));
    let provider_closed = provider_observed_close.clone();
    let (first_seen, first_received) = std::sync::mpsc::sync_channel(1);
    let receiver = thread::spawn(move || {
        let start = Instant::now();
        let socket = loop {
            match listener.accept() {
                Ok((socket, _)) => {
                    attempted.fetch_add(1, Ordering::Relaxed);
                    break socket;
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    if stop.load(Ordering::Acquire) || start.elapsed() > Duration::from_secs(8) {
                        return Vec::new();
                    }
                    thread::sleep(Duration::from_millis(1));
                }
                Err(_) => return Vec::new(),
            }
        };
        if normal.is_some() {
            socket.set_nodelay(true).unwrap();
        }
        if matches!(normal, Some(NormalStream::PausedReader)) {
            socket2::SockRef::from(&socket)
                .set_send_buffer_size(64 * 1024)
                .unwrap();
        }
        socket
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut tls = StreamOwned::new(ServerConnection::new(server).unwrap(), socket);
        let mut received = Vec::new();
        let mut buf = [0; 8192];
        loop {
            let n = match tls.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            received.extend_from_slice(&buf[..n]);
            if let Some(end) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&received[..end]);
                let len = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|n| n.parse::<usize>().ok())
                    })
                    .unwrap();
                if received.len() >= end + 4 + len {
                    if let Some(normal) = normal {
                        normal_provider_stream(
                            &mut tls,
                            normal,
                            &first_received,
                            &producer_progress,
                            &provider_closed,
                        );
                        break;
                    }
                    let response=match scenario{Scenario::JsonTerminalBait=>b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n: alive\n\n\r\n".as_slice(),Scenario::Redirect=>b"HTTP/1.1 302 Found\r\nLocation: https://attacker.example\r\nContent-Type: application/json\r\nContent-Length: 0\r\n\r\n".as_slice(),Scenario::TruncatedResponse=>b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 100\r\n\r\ndata:x".as_slice(),_=>b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n: alive\n\n\r\n".as_slice()};
                    let _ = tls.write_all(response);
                    let _ = tls.flush();
                    if matches!(scenario, Scenario::RevokedStream) {
                        while tls
                            .write_all(b"9\r\n: alive\n\n\r\n")
                            .and_then(|_| tls.flush())
                            .is_ok()
                        {
                            thread::sleep(Duration::from_millis(30));
                        }
                    } else if !matches!(scenario, Scenario::Redirect | Scenario::TruncatedResponse)
                    {
                        if !matches!(scenario, Scenario::MissingTerminal) {
                            let terminal=b"event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_fixture\",\"status\":\"completed\"}}\n\n";
                            let _ = tls.write_all(format!("{:x}\r\n", terminal.len()).as_bytes());
                            let _ = tls.write_all(terminal);
                            let _ = tls.write_all(b"\r\n");
                        }
                        let _ = tls.write_all(b"0\r\n\r\n");
                        let _ = tls.flush();
                    }
                    tls.conn.send_close_notify();
                    let _ = tls.flush();
                    break;
                }
            }
        }
        if normal.is_some() {
            // Keep observing this listener until the exchange has ended so a
            // second connect cannot hide in its backlog after the first stream.
            loop {
                let ended_before_accept = stop.load(Ordering::Acquire);
                match listener.accept() {
                    Ok((socket, _)) => {
                        attempted.fetch_add(1, Ordering::Relaxed);
                        drop(socket);
                        // A second observed connection already fails the one-
                        // attempt assertion; do not accept an unbounded backlog.
                        break;
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        // The snapshot precedes accept: completion therefore
                        // requires a backlog observation after the end signal.
                        if ended_before_accept || start.elapsed() >= Duration::from_secs(8) {
                            break;
                        }
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => break,
                }
            }
        }
        received
    });
    let receipts = Arc::new(Mutex::new(Vec::new()));
    let admissions = Arc::new(AtomicUsize::new(0));
    let observed = receipts.clone();
    let counted = admissions.clone();
    let dispatches = Arc::new(AtomicUsize::new(0));
    let dispatched = dispatches.clone();
    let releases = Arc::new(AtomicUsize::new(0));
    let released = releases.clone();
    let bound_flow = Arc::new(Mutex::new(None));
    let released_flow = Arc::new(Mutex::new(None));
    let recorded_bind = bound_flow.clone();
    let recorded_release = released_flow.clone();
    let mut reservation = String::new();
    let mut digest = String::new();
    let mut before = 0;
    let mut expires = 0;
    let authority = WireServer::spawn(service.authority.path.clone(), move |request| {
        let method = request["method"].as_str().unwrap();
        if method == "dispatch" {
            dispatched.fetch_add(1, Ordering::Relaxed);
        }
        if method == "complete" {
            observed
                .lock()
                .unwrap()
                .push(request["outcome"].as_str().unwrap().to_owned());
            return json!({"version":1,"ok":true});
        }
        if method == "admit" {
            counted.fetch_add(1, Ordering::Relaxed);
            reservation = request["reservation_ref"].as_str().unwrap().to_owned();
            digest = request["request_sha256"].as_str().unwrap().to_owned();
            assert_eq!(request["workload_credential"], "workload-only-canary");
            let n = now();
            before = n + if matches!(normal, Some(NormalStream::IdleDeadline)) {
                1000
            } else {
                5000
            };
            expires = if matches!(normal, Some(NormalStream::IdleDeadline)) {
                n + 1200
            } else {
                before + 55_000
            };
        }
        if matches!(
            (scenario, method),
            (Scenario::DeniedInspect, "inspect")
                | (Scenario::DeniedDispatch, "dispatch")
                | (Scenario::RevokedStream, "check")
        ) {
            return json!({"version":1,"ok":false,"reason":"denied"});
        }
        let state = if matches!(method, "dispatch" | "check") {
            "dispatched"
        } else {
            "accepted"
        };
        let n = now();
        json!({"version":1,"ok":true,"authority_profile":"oce-delegated-model-v1","authority_instance_ref":INSTANCE,"authority_evidence_ref":EVIDENCE,"operation_id":"operation-a","reservation_ref":reservation,"request_sha256":digest,"assignment_id":ASSIGNMENT,"generation":1,"policy_version":1,"provider_binding_ref":"provider-test","credential_binding":descriptor(),"operation_state":state,"dispatch_before_ms":before,"operation_expires_at_ms":expires,"server_time_ms":n,"valid_until_ms":(n+4000).min(if state=="accepted"{before}else{expires})})
    });
    let dns = WireServer::spawn(service.dns.path.clone(), move |request| {
        if request["method"] == "release" {
            released.fetch_add(1, Ordering::Relaxed);
            *recorded_release.lock().unwrap() = Some(request.clone());
        }
        if request["method"] == "bind" {
            *recorded_bind.lock().unwrap() = Some(request.clone());
        }
        let mut v = timed();
        for key in [
            "operation_id",
            "reservation_ref",
            "request_sha256",
            "authority_instance_ref",
            "provider_binding_ref",
            "credential_binding",
            "recipient",
            "protocol",
            "assignment_id",
            "generation",
            "policy_version",
            "connection_ref",
        ] {
            if let Some(value) = request.get(key) {
                v[key] = value.clone();
            }
        }
        v["ip"] = json!("127.0.0.1");
        v["admission_id"] = json!("d".repeat(64));
        if request.get("connection_ref").is_some() {
            v["flow_ref"] = json!("f".repeat(64));
        }
        v
    });
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let worker = thread::spawn(move || {
        let (s, _) = listener.accept().unwrap();
        if matches!(normal, Some(NormalStream::PausedReader)) {
            // Bound the real mediator-to-client kernel queue in this controlled
            // fixture so it cannot absorb the stream while the client pauses.
            socket2::SockRef::from(&s)
                .set_send_buffer_size(4096)
                .unwrap();
        }
        service.handle(s)
    });
    let start = Instant::now();
    let (bytes, paused_progress) = if let Some(normal) = normal {
        normal_client(
            addr,
            incoming.as_ref().unwrap(),
            &raw,
            normal,
            first_seen,
            progress,
        )
    } else {
        let client = TcpStream::connect(addr).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(8)))
            .unwrap();
        trait TestIo: Read + Write {}
        impl<T: Read + Write> TestIo for T {}
        let mut client: Box<dyn TestIo> = if let Some(incoming) = incoming {
            let mut roots = RootCertStore::empty();
            for certificate in CertificateDer::pem_slice_iter(incoming.root_pem.as_bytes()) {
                roots.add(certificate.unwrap()).unwrap();
            }
            let mut config = ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            let connection =
                rustls::ClientConnection::new(Arc::new(config), "localhost".try_into().unwrap())
                    .unwrap();
            Box::new(StreamOwned::new(connection, client))
        } else {
            Box::new(client)
        };
        if fragmented {
            for c in raw.as_bytes().chunks(3) {
                client.write_all(c).unwrap();
            }
        } else {
            client.write_all(raw.as_bytes()).unwrap();
        }
        let mut bytes = Vec::new();
        let _ = client.read_to_end(&mut bytes);
        (bytes, None)
    };
    let handler_error = worker.join().unwrap().err().map(|error| error.to_string());
    upstream_done.store(true, Ordering::Release);
    let received = receiver.join().unwrap();
    let observed = Observed {
        upstream: received,
        response: String::from_utf8_lossy(&bytes).into_owned(),
        receipts: receipts.lock().unwrap().clone(),
        admissions: admissions.load(Ordering::Relaxed),
        elapsed: start.elapsed(),
        attempts: attempts.load(Ordering::Relaxed),
        dispatches: dispatches.load(Ordering::Relaxed),
        releases: releases.load(Ordering::Relaxed),
        handler_error,
        provider_observed_close: provider_observed_close.load(Ordering::Acquire),
        paused_progress,
        bound_flow: bound_flow.lock().unwrap().clone(),
        released_flow: released_flow.lock().unwrap().clone(),
    };
    drop(authority);
    drop(dns);
    observed
}
#[test]
fn real_hyper_tls_exact_body_external_custody_and_one_exchange() {
    for fragmented in [false, true] {
        let exact = format!(" \n{}\n ", body());
        let first = wire(&exact);
        let raw = if fragmented {
            first.clone()
        } else {
            format!("{first}{first}")
        };
        let observed = transport_fixture(Scenario::Allowed, raw, fragmented);
        assert_eq!(observed.admissions, 1);
        assert_eq!(observed.receipts, vec!["completed"]);
        let sent = String::from_utf8(observed.upstream).unwrap();
        assert!(sent
            .to_ascii_lowercase()
            .contains("authorization: bearer provider-secret-canary\r\n"));
        assert!(!sent.contains("workload-only-canary"));
        assert!(sent.ends_with(&exact));
        assert!(observed.response.contains(": alive"));
        assert!(!observed.response.contains("provider-secret-canary"));
    }
}
#[test]
fn real_hyper_wrong_tls_name_and_post_io_denials_send_zero_application_bytes() {
    for scenario in [
        Scenario::WrongCertificate,
        Scenario::DeniedInspect,
        Scenario::DeniedDispatch,
    ] {
        let observed = transport_fixture(scenario, wire(&body()), false);
        assert!(observed.upstream.is_empty());
        assert_eq!(observed.admissions, 1);
        assert!(!observed.receipts.contains(&"completed".into()));
    }
}
#[test]
fn real_hyper_truncated_response_and_redirect_never_complete() {
    for scenario in [Scenario::TruncatedResponse, Scenario::Redirect] {
        let observed = transport_fixture(scenario, wire(&body()), false);
        assert!(!observed.upstream.is_empty());
        assert_eq!(observed.admissions, 1);
        assert_eq!(observed.receipts, vec!["unknown"]);
    }
}
#[test]
fn real_hyper_stream_denial_closes_owned_tls_connection() {
    let observed = transport_fixture(Scenario::RevokedStream, wire(&body()), false);
    assert!(observed.response.contains(": alive"));
    assert_eq!(observed.receipts, vec!["unknown"]);
    assert!(observed.elapsed < Duration::from_secs(3));
}
#[test]
fn real_hyper_conflicting_framing_and_duplicate_credentials_never_admit() {
    let valid = wire(&body());
    for invalid in [
        valid.replacen(
            "Content-Length:",
            "Transfer-Encoding: chunked\r\nContent-Length:",
            1,
        ),
        valid.replacen("Content-Length:", "Content-Length: 1\r\nContent-Length:", 1),
        valid.replacen(
            "Authorization:",
            "Authorization: Bearer forged\r\nAuthorization:",
            1,
        ),
        valid.replacen("Host:", "Host: attacker.example\r\nHost:", 1),
        valid.replacen("Content-Type:", "Expect: 100-continue\r\nContent-Type:", 1),
    ] {
        let observed = transport_fixture(Scenario::Allowed, invalid, false);
        assert_eq!(observed.admissions, 0);
        assert!(observed.upstream.is_empty());
    }
}
fn fixture_binding() -> Binding {
    Binding {
        authority_instance_ref: INSTANCE.into(),
        request_sha256: "b".repeat(64),
        credential_binding: descriptor(),
        operation_id: "operation-a".into(),
        reservation_ref: "a".repeat(64),
        provider_binding_ref: "provider-test".into(),
        dispatch_before_ms: now() + 5000,
        operation_expires_at_ms: now() + 60_000,
        assignment_id: ASSIGNMENT.into(),
        generation: 1,
        policy_version: 1,
    }
}
fn admission() -> Admission {
    Admission {
        ip: "127.0.0.1".parse().unwrap(),
        id: "d".repeat(64),
        lease: Lease {
            deadline: Instant::now() + Duration::from_secs(5),
        },
        connection_ref: None,
        flow_ref: None,
    }
}
#[test]
fn actual_socket_monitor_dependency_loss_severs_both_owned_sockets_only() {
    fn pair() -> (TcpStream, TcpStream) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (o, _) = l.accept().unwrap();
        p.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        (o, p)
    }
    let dir = Dir::new();
    let (up, mut up_peer) = pair();
    let (down, mut down_peer) = pair();
    let (mut other, mut other_peer) = pair();
    let rpc = Rpc {
        path: dir.0.join("missing"),
        peer_uid: nix::unistd::getuid().as_raw(),
        authority: true,
    };
    let lease = Lease {
        deadline: Instant::now() + Duration::from_secs(2),
    };
    let start = Instant::now();
    let monitor = Monitor::start(
        rpc.clone(),
        rpc,
        fixture_binding(),
        "b".repeat(64),
        admission(),
        lease,
        lease,
        lease.deadline,
        up,
        down,
    )
    .unwrap();
    assert_eq!(up_peer.read(&mut [0; 1]).unwrap(), 0);
    assert_eq!(down_peer.read(&mut [0; 1]).unwrap(), 0);
    assert!(monitor.current().is_err());
    assert!(start.elapsed() < Duration::from_millis(1500));
    other.write_all(b"still usable").unwrap();
    let mut bytes = [0; 12];
    other_peer.read_exact(&mut bytes).unwrap();
    assert_eq!(&bytes, b"still usable");
}
#[test]
fn independent_socket_watchdog_closes_a_tcp_pair_at_deadline() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let c = TcpStream::connect(l.local_addr().unwrap()).unwrap();
    let (mut peer, _) = l.accept().unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let start = Instant::now();
    let _guard = SocketDeadline::new(c, Instant::now() + Duration::from_millis(60)).unwrap();
    assert_eq!(peer.read(&mut [0; 1]).unwrap(), 0);
    assert!(start.elapsed() < Duration::from_secs(1));
}
#[test]
fn authority_lease_and_descriptor_fail_closed() {
    let mut response = json!({"version":1,"ok":true,"authority_profile":"oce-delegated-model-v1","authority_instance_ref":INSTANCE,"authority_evidence_ref":EVIDENCE,"operation_id":"operation-a","reservation_ref":"a".repeat(64),"request_sha256":"b".repeat(64),"assignment_id":ASSIGNMENT,"generation":1,"policy_version":1,"provider_binding_ref":"provider-test","credential_binding":descriptor(),"operation_state":"accepted","dispatch_before_ms":5000,"operation_expires_at_ms":10000,"server_time_ms":1000,"valid_until_ms":4000});
    assert!(Binding::parse(&response).is_ok());
    response["valid_until_ms"] = json!(6000);
    assert!(Binding::parse(&response).is_err());
    response["valid_until_ms"] = json!(4000);
    response["credential_binding"]["provider_binding_ref"] = json!("wrong-account");
    assert!(Binding::parse(&response).is_err());
    assert!(rpc::lease(
        &json!({"server_time_ms":1000,"valid_until_ms":1010}),
        Instant::now() - Duration::from_millis(11)
    )
    .is_err());
}

#[test]
fn real_hyper_clean_http_without_provider_terminal_remains_unknown() {
    let observed = transport_fixture(Scenario::MissingTerminal, wire(&body()), false);
    assert!(observed.response.contains(": alive"));
    assert_eq!(observed.receipts, vec!["unknown"]);
}

#[test]
fn real_hyper_json_labelled_terminal_bytes_remain_unknown() {
    let observed = transport_fixture(Scenario::JsonTerminalBait, wire(&body()), false);
    assert!(observed.response.contains("response.completed"));
    assert_eq!(observed.receipts, vec!["unknown"]);
}

#[test]
fn application_profile_retains_client_namespace_and_search_only() {
    let mut original = json::parse(body().as_bytes()).unwrap();
    original["tools"] = json!([
        {"type":"namespace","name":"local","tools":[{"type":"function","name":"read","parameters":{"type":"object","properties":{}}}]},
        {"type":"tool_search","execution":"client"}
    ]);
    let accepted = original.to_string();
    assert!(http::parse_request(
        &parts(&accepted),
        accepted.clone().into_bytes(),
        "localhost:8443"
    )
    .is_ok());
    original["tools"][1]["execution"] = json!("server");
    let rejected = original.to_string();
    assert!(http::parse_request(
        &parts(&rejected),
        rejected.clone().into_bytes(),
        "localhost:8443"
    )
    .is_err());
}

#[test]
fn real_incoming_tls_fragmented_http_success_and_denial() {
    for scenario in [Scenario::Allowed, Scenario::DeniedInspect] {
        let exact = format!(" \n{}\n ", body());
        let observed = transport_with_ingress(scenario, wire(&exact), true, true);
        assert_eq!(observed.admissions, 1);
        if matches!(scenario, Scenario::Allowed) {
            assert_eq!(observed.receipts, vec!["completed"]);
            assert!(observed.upstream.ends_with(exact.as_bytes()));
            assert!(observed.response.contains("response.completed"));
        } else {
            assert!(observed.upstream.is_empty());
            assert!(!observed.receipts.contains(&"completed".into()));
        }
    }
}

#[test]
fn real_incoming_tls_partial_clienthello_hits_acquisition_deadline() {
    let dir = Dir::new();
    let incoming = certificates("localhost");
    let service = service_with_ingress(&dir, &certificates(FIXED_HOST), 443, Some(&incoming));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let worker = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        service.handle(socket)
    });
    let mut client = TcpStream::connect(address).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(7)))
        .unwrap();
    let start = Instant::now();
    // Begin a TLS record but never finish its header or ClientHello. This enters
    // the real incoming rustls acquisition path without sending any HTTP bytes.
    client.write_all(&[0x16, 0x03, 0x03]).unwrap();
    assert_eq!(client.read(&mut [0; 1]).unwrap(), 0);
    assert!(worker.join().unwrap().is_err());
    assert!(start.elapsed() >= Duration::from_secs(4));
    assert!(start.elapsed() < Duration::from_secs(7));
}

// These cases extend the retained local transport harness. Scripted control
// replies remain inputs; assertions cover the actual owned HTTP/TLS lifecycle.
#[derive(Clone, Copy)]
enum NormalStream {
    Completed,
    Failed,
    Incomplete,
    TerminalWithoutHttpEnd,
    ClientClose,
    IdleDeadline,
    PausedReader,
}
const CRD43_INITIAL: &str = concat!(
    ": ordinary heartbeat\r\n\r\n",
    "event: response.created\r\n",
    "data: {\"type\":\"response.created\",\"sequence_number\":0,\"response\":{\"id\":\"resp_crd43\",\"status\":\"in_progress\"}}\r\n\r\n",
    "data: {\"type\":\"response.output_text.delta\",\"sequence_number\":1,\"item_id\":\"msg_crd43\",\"output_index\":0,\"content_index\":0,\"delta\":\"Hello, 世界 🌍\"}\n\n"
);
#[derive(Default)]
struct StreamProgress {
    written: AtomicUsize,
    writing: AtomicBool,
}
const CRD43_PADDING_EVENTS: usize = 512;
const CRD43_PADDING_BYTES: usize = 16 * 1024;

fn crd43_terminal(normal: NormalStream) -> String {
    let status = match normal {
        NormalStream::Failed => "failed",
        NormalStream::Incomplete => "incomplete",
        _ => "completed",
    };
    format!("event: response.{status}\ndata: {{\"type\":\"response.{status}\",\"sequence_number\":2,\"response\":{{\"id\":\"resp_crd43\",\"status\":\"{status}\"}}}}\n\n")
}
fn crd43_write_chunk(
    tls: &mut StreamOwned<ServerConnection, TcpStream>,
    data: &[u8],
) -> io::Result<()> {
    tls.write_all(format!("{:x}\r\n", data.len()).as_bytes())?;
    tls.write_all(data)?;
    tls.write_all(b"\r\n")?;
    tls.flush()
}
fn normal_provider_stream(
    tls: &mut StreamOwned<ServerConnection, TcpStream>,
    normal: NormalStream,
    first_received: &std::sync::mpsc::Receiver<()>,
    progress: &StreamProgress,
    observed_close: &AtomicBool,
) {
    tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
    // Split actual upstream HTTP data across UTF-8, SSE and CRLF boundaries.
    // No terminal is available until the downstream has seen this first phase.
    for chunk in CRD43_INITIAL.as_bytes().chunks(3) {
        crd43_write_chunk(tls, chunk).unwrap();
    }
    first_received.recv_timeout(Duration::from_secs(3)).unwrap();
    if matches!(
        normal,
        NormalStream::ClientClose | NormalStream::IdleDeadline
    ) {
        let closed = match tls.read(&mut [0; 1]) {
            Ok(0) => true,
            Err(e) => matches!(
                e.kind(),
                io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::UnexpectedEof
            ),
            _ => false,
        };
        observed_close.store(closed, Ordering::Release);
        return;
    }
    if matches!(normal, NormalStream::PausedReader) {
        // Reuse one bounded event buffer. The downstream stops polling while
        // these writes run; no harness gate delays the provider's data writes.
        let mut padding = vec![b'z'; CRD43_PADDING_BYTES];
        padding[0] = b':';
        let n = padding.len();
        padding[n - 2..].copy_from_slice(b"\n\n");
        for _ in 0..CRD43_PADDING_EVENTS {
            progress.writing.store(true, Ordering::Release);
            let written = crd43_write_chunk(tls, &padding);
            progress.writing.store(false, Ordering::Release);
            written.unwrap();
            progress.written.fetch_add(padding.len(), Ordering::Release);
        }
    }
    for chunk in crd43_terminal(normal).as_bytes().chunks(2) {
        crd43_write_chunk(tls, chunk).unwrap();
    }
    if matches!(normal, NormalStream::TerminalWithoutHttpEnd) {
        // The client must observe the valid terminal before the provider closes
        // its TLS leg without the required HTTP ending. Flush alone is not proof.
        first_received.recv_timeout(Duration::from_secs(3)).unwrap();
    } else {
        tls.write_all(b"0\r\n\r\n").unwrap();
    }
    tls.conn.send_close_notify();
    tls.flush().unwrap();
}

fn normal_client(
    address: std::net::SocketAddr,
    certificates: &Certificates,
    raw: &str,
    normal: NormalStream,
    first_seen: std::sync::mpsc::SyncSender<()>,
    progress: Arc<StreamProgress>,
) -> (Vec<u8>, Option<(usize, usize)>) {
    use http_body_util::{BodyExt, Full};
    use hyper::body::Bytes;
    use hyper_util::rt::TokioIo;
    let mut roots = RootCertStore::empty();
    for certificate in CertificateDer::pem_slice_iter(certificates.root_pem.as_bytes()) {
        roots.add(certificate.unwrap()).unwrap();
    }
    let mut config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let body = raw.split_once("\r\n\r\n").unwrap().1.as_bytes().to_vec();
    let socket = TcpStream::connect(address).unwrap();
    socket.set_nodelay(true).unwrap();
    if matches!(normal, NormalStream::PausedReader) {
        socket2::SockRef::from(&socket)
            .set_recv_buffer_size(64 * 1024)
            .unwrap();
    }
    socket.set_nonblocking(true).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(8), async {
            let socket = tokio::net::TcpStream::from_std(socket).unwrap();
            let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
                .connect("localhost".try_into().unwrap(), socket)
                .await
                .unwrap();
            let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
                .await
                .unwrap();
            let driver = tokio::spawn(connection);
            let request = hyper::Request::builder()
                .method("POST")
                .uri("/v1/responses")
                .header("host", "localhost:8443")
                .header("authorization", "Bearer workload-only-canary")
                .header("content-type", "application/json")
                .body(Full::new(Bytes::from(body)))
                .unwrap();
            let mut response = sender.send_request(request).await.unwrap();
            assert_eq!(response.status(), hyper::StatusCode::OK);
            drop(sender);
            let mut bytes = Vec::new();
            let mut first = false;
            let mut terminal_seen = false;
            let mut paused_progress = None;
            let clean = matches!(
                normal,
                NormalStream::Completed
                    | NormalStream::Failed
                    | NormalStream::Incomplete
                    | NormalStream::PausedReader
            );
            let mut body_error = false;
            while let Some(frame) = response.body_mut().frame().await {
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(error) => {
                        assert!(
                            !clean,
                            "ordinary complete response must have clean HTTP framing: {error}"
                        );
                        body_error = true;
                        break;
                    }
                };
                let data = frame.into_data().unwrap();
                assert!(bytes.len() + data.len() <= 9 * 1024 * 1024);
                bytes.extend_from_slice(&data);
                if !first && bytes.len() >= CRD43_INITIAL.len() {
                    assert_eq!(&bytes[..CRD43_INITIAL.len()], CRD43_INITIAL.as_bytes());
                    first = true;
                    first_seen.send(()).unwrap();
                    if matches!(normal, NormalStream::ClientClose) {
                        break;
                    }
                    if matches!(normal, NormalStream::PausedReader) {
                        let pause_deadline = Instant::now() + Duration::from_secs(1);
                        let mut last = 0;
                        let mut quiet_since = Instant::now();
                        loop {
                            tokio::time::sleep(Duration::from_millis(25)).await;
                            let current = progress.written.load(Ordering::Acquire);
                            if current != last {
                                last = current;
                                quiet_since = Instant::now();
                            }
                            if current > 0
                                && progress.writing.load(Ordering::Acquire)
                                && quiet_since.elapsed() >= Duration::from_millis(150)
                            {
                                paused_progress = Some((last, current));
                                break;
                            }
                            assert!(
                                Instant::now() < pause_deadline,
                                "no bounded outstanding-write pause observed: completed_bytes={current}, writing={}, quiet_ms={}, elapsed_pause_ms={}",
                                progress.writing.load(Ordering::Acquire), quiet_since.elapsed().as_millis(),
                                (Duration::from_secs(1) - pause_deadline.saturating_duration_since(Instant::now())).as_millis()
                            );
                        }
                    }
                }
                if matches!(normal, NormalStream::TerminalWithoutHttpEnd)
                    && !terminal_seen
                    && bytes.ends_with(crd43_terminal(normal).as_bytes())
                {
                    terminal_seen = true;
                    first_seen.send(()).unwrap();
                }
            }
            assert!(first);
            if matches!(normal, NormalStream::TerminalWithoutHttpEnd) {
                assert!(terminal_seen && body_error);
            }
            drop(response);
            if clean {
                assert!(!body_error);
                tokio::time::timeout(Duration::from_secs(2), driver)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
            } else {
                driver.abort();
                let _ = driver.await;
            }
            (bytes, paused_progress)
        })
        .await
        .expect("ordinary local stream exceeded its fixture bound")
    })
}

#[test]
fn crd43_phased_unicode_stream_requires_terminal_and_clean_http() {
    for normal in [
        NormalStream::Completed,
        NormalStream::Failed,
        NormalStream::Incomplete,
    ] {
        let observed =
            transport_with_controls(Scenario::Allowed, wire(&body()), false, true, Some(normal));
        assert_eq!(
            observed.response,
            format!("{}{}", CRD43_INITIAL, crd43_terminal(normal))
        );
        assert_eq!(observed.receipts, vec!["completed"]);
        crd43_assert_one_owned_flow(&observed);
        assert!(observed.handler_error.is_none());
        // Failed/incomplete establish an ended response, not a successful model outcome.
    }
}

#[test]
fn crd43_client_close_preserves_unknown_and_one_upstream_attempt() {
    let observed = transport_with_controls(
        Scenario::Allowed,
        wire(&body()),
        false,
        true,
        Some(NormalStream::ClientClose),
    );
    assert_eq!(observed.response, CRD43_INITIAL);
    assert_eq!(observed.receipts, vec!["unknown"]);
    crd43_assert_one_owned_flow(&observed);
    assert!(observed.provider_observed_close);
    assert!(observed.elapsed < Duration::from_secs(3));
    for sink in [
        &observed.response,
        observed.handler_error.as_deref().unwrap_or(""),
    ] {
        assert!(!sink.contains("provider-secret-canary"));
        assert!(!sink.contains("workload-only-canary"));
    }
}

#[test]
fn crd43_idle_stream_ends_at_original_operation_deadline() {
    let observed = transport_with_controls(
        Scenario::Allowed,
        wire(&body()),
        false,
        true,
        Some(NormalStream::IdleDeadline),
    );
    assert_eq!(observed.response, CRD43_INITIAL);
    assert_eq!(observed.receipts, vec!["unknown"]);
    crd43_assert_one_owned_flow(&observed);
    assert!(observed.provider_observed_close);
    assert!(observed.elapsed >= Duration::from_millis(1000));
    assert!(observed.elapsed < Duration::from_secs(3));
}

#[test]
fn crd43_reader_pause_constrains_provider_then_resumes_exact_stream() {
    let observed = transport_with_controls(
        Scenario::Allowed,
        wire(&body()),
        false,
        true,
        Some(NormalStream::PausedReader),
    );
    let (before, after) = observed.paused_progress.unwrap();
    assert!(before > 0 && before < CRD43_PADDING_EVENTS * CRD43_PADDING_BYTES);
    assert_eq!(
        before, after,
        "provider writes must stop progressing while the client is paused"
    );
    assert!(observed.response.starts_with(CRD43_INITIAL));
    assert!(observed
        .response
        .ends_with(&crd43_terminal(NormalStream::PausedReader)));
    assert_eq!(
        observed.response.len(),
        CRD43_INITIAL.len()
            + CRD43_PADDING_EVENTS * CRD43_PADDING_BYTES
            + crd43_terminal(NormalStream::PausedReader).len()
    );
    let middle = &observed.response.as_bytes()[CRD43_INITIAL.len()
        ..observed.response.len() - crd43_terminal(NormalStream::PausedReader).len()];
    let mut expected = vec![b'z'; CRD43_PADDING_BYTES];
    expected[0] = b':';
    expected[CRD43_PADDING_BYTES - 2..].copy_from_slice(b"\n\n");
    let mut chunks = middle.chunks_exact(CRD43_PADDING_BYTES);
    for chunk in &mut chunks {
        assert_eq!(chunk, expected.as_slice());
    }
    assert!(chunks.remainder().is_empty());
    assert_eq!(observed.receipts, vec!["completed"]);
    crd43_assert_one_owned_flow(&observed);
}

#[test]
fn crd43_valid_tls_incomplete_body_times_out_without_exposing_canaries() {
    let complete = wire(&body());
    let body_start = complete.find("\r\n\r\n").unwrap() + 4;
    // A normal client pauses after valid TLS and headers with its request body
    // still unfinished. The actual acquisition deadline must stop the exchange.
    let observed = transport_with_ingress(
        Scenario::Allowed,
        complete[..body_start + 8].to_owned(),
        true,
        true,
    );
    assert_eq!(
        (observed.admissions, observed.dispatches, observed.attempts),
        (0, 0, 0)
    );
    assert!(observed.upstream.is_empty());
    assert!(observed.receipts.is_empty());
    assert!(observed.elapsed >= Duration::from_secs(4));
    assert!(observed.elapsed < Duration::from_secs(7));
    assert!(observed.handler_error.is_some());
    // Enumerated sinks are the actual downstream response and typed handler
    // diagnostic. CLI logs, runtime history and external traces are not captured.
    for sink in [
        &observed.response,
        observed.handler_error.as_deref().unwrap(),
    ] {
        assert!(!sink.contains("provider-secret-canary"));
        assert!(!sink.contains("workload-only-canary"));
    }
}

fn crd43_assert_one_owned_flow(observed: &Observed) {
    assert_eq!(
        (
            observed.admissions,
            observed.dispatches,
            observed.attempts,
            observed.releases
        ),
        (1, 1, 1, 1)
    );
    // Compare the actual outbound release with the actual selected bind tuple;
    // this assertion does not invent an authority or DNS authorization decision.
    let mut expected = observed.bound_flow.clone().unwrap();
    expected["method"] = json!("release");
    expected["flow_ref"] = json!("f".repeat(64));
    assert_eq!(observed.released_flow.as_ref(), Some(&expected));
}

#[test]
fn crd43_provider_terminal_without_http_end_preserves_unknown() {
    let observed = transport_with_controls(
        Scenario::Allowed,
        wire(&body()),
        false,
        true,
        Some(NormalStream::TerminalWithoutHttpEnd),
    );
    assert_eq!(
        observed.response,
        format!(
            "{}{}",
            CRD43_INITIAL,
            crd43_terminal(NormalStream::TerminalWithoutHttpEnd)
        )
    );
    assert_eq!(observed.receipts, vec!["unknown"]);
    assert!(observed.handler_error.is_some());
    crd43_assert_one_owned_flow(&observed);
}
