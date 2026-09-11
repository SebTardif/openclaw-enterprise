//! Authored transport/format regressions. Execution is deliberately UNRUN in
//! this source handoff. Synthetic comparison records and test mTLS peers do not
//! exercise genuine Work, State, GitObjectCustody, identity or provider grants.
use super::*;
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use rustls_pki_types::{PrivateKeyDer, ServerName};
use std::{
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::PathBuf,
    sync::{atomic::AtomicUsize, Condvar},
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpListener, UnixListener},
    sync::Notify,
    time::timeout,
};

const TOKEN: &[u8] = b"synthetic-publication-confidential-token";
pub(super) const SESSION: &str = "0123456789abcdef0123456789abcdef";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Stage {
    Prepared,
    Observed,
}
/// Test-only finite synchronization after actual graph/body preparation or
/// actual response attribution, never a product authority or drain callback.
pub(super) struct Control {
    stage: Stage,
    entered: AtomicBool,
    cancelled: AtomicBool,
    released: AtomicBool,
    pub(super) finished: AtomicBool,
    entry: Notify,
    cancellation: Notify,
    panic_after_release: AtomicBool,
    mutex: Mutex<()>,
    condition: Condvar,
}
impl Control {
    pub(super) fn new(stage: Stage) -> Arc<Self> {
        Arc::new(Self {
            stage,
            entered: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            released: AtomicBool::new(false),
            finished: AtomicBool::new(false),
            panic_after_release: AtomicBool::new(false),
            entry: Notify::new(),
            cancellation: Notify::new(),
            mutex: Mutex::new(()),
            condition: Condvar::new(),
        })
    }
    pub(super) fn enter(&self, stage: Stage, stop: &AtomicBool) {
        if stage != self.stage {
            return;
        }
        self.entered.store(true, Ordering::Release);
        self.entry.notify_one();
        let until = std::time::Instant::now() + Duration::from_secs(5);
        let mut guard = self.mutex.lock().unwrap();
        while !self.released.load(Ordering::Acquire) {
            if stop.load(Ordering::Acquire) && !self.cancelled.swap(true, Ordering::AcqRel) {
                self.cancellation.notify_one();
            }
            assert!(
                std::time::Instant::now() < until,
                "finite test gate expired"
            );
            guard = self
                .condition
                .wait_timeout(guard, Duration::from_millis(5))
                .unwrap()
                .0;
        }
        self.finished.store(true, Ordering::Release);
        // Test-only negative fault after actual response attribution and the
        // held-worker barrier. The real spawn_blocking JoinHandle sees panic.
        if self.panic_after_release.load(Ordering::Acquire) {
            panic!("controlled publication worker panic after attribution");
        }
    }
    pub(super) async fn entered(&self) {
        while !self.entered.load(Ordering::Acquire) {
            self.entry.notified().await;
        }
    }
    pub(super) async fn cancelled(&self) {
        while !self.cancelled.load(Ordering::Acquire) {
            self.cancellation.notified().await;
        }
    }
    pub(super) fn release(&self) {
        self.released.store(true, Ordering::Release);
        self.condition.notify_all();
    }
    pub(super) fn panic_after_release(&self) {
        self.panic_after_release.store(true, Ordering::Release);
    }
}

fn certificates(name: &str, mutual: bool) -> (Arc<ServerConfig>, Arc<ClientConfig>) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut params = CertificateParams::new(vec!["publication-test-ca".into()]).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    let key = KeyPair::generate().unwrap();
    let root = params.self_signed(&key).unwrap();
    let issuer = Issuer::new(params, key);
    let mut roots = RootCertStore::empty();
    roots.add(root.der().clone()).unwrap();
    let leaf = |name: &str, usage| {
        let mut params = CertificateParams::new(vec![name.into()]).unwrap();
        params.extended_key_usages = vec![usage];
        let key = KeyPair::generate().unwrap();
        let cert = params.signed_by(&key, &issuer).unwrap();
        (
            vec![cert.der().clone()],
            PrivateKeyDer::Pkcs8(key.serialize_der().into()),
        )
    };
    let (cert, key) = leaf(name, ExtendedKeyUsagePurpose::ServerAuth);
    let builder = ServerConfig::builder();
    let builder = if mutual {
        builder.with_client_cert_verifier(
            rustls::server::WebPkiClientVerifier::builder(Arc::new(roots.clone()))
                .build()
                .unwrap(),
        )
    } else {
        builder.with_no_client_auth()
    };
    let mut server = builder.with_single_cert(cert, key).unwrap();
    let builder = ClientConfig::builder().with_root_certificates(roots);
    let mut client = if mutual {
        let (cert, key) = leaf(
            "publication-client.test",
            ExtendedKeyUsagePurpose::ClientAuth,
        );
        builder.with_client_auth_cert(cert, key).unwrap()
    } else {
        builder.with_no_client_auth()
    };
    let alpn = if mutual { ALPN } else { b"http/1.1" };
    server.alpn_protocols = vec![alpn.to_vec()];
    client.alpn_protocols = vec![alpn.to_vec()];
    (Arc::new(server), Arc::new(client))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn oid(kind: &str, data: &[u8]) -> String {
    let mut hash = ring::digest::Context::new(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY);
    hash.update(format!("{kind} {}\0", data.len()).as_bytes());
    hash.update(data);
    hex(hash.finish().as_ref())
}
fn binary_id(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}
fn packed(objects: &BTreeMap<String, (u8, Vec<u8>)>) -> Vec<u8> {
    let mut pack = b"PACK\0\0\0\x02".to_vec();
    pack.extend_from_slice(&(objects.len() as u32).to_be_bytes());
    for (kind, data) in objects.values() {
        let mut size = data.len();
        let mut head = vec![(kind << 4) | (size as u8 & 15)];
        size >>= 4;
        while size != 0 {
            *head.last_mut().unwrap() |= 128;
            head.push((size & 127) as u8);
            size >>= 7;
        }
        pack.extend(head);
        let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        z.write_all(data).unwrap();
        pack.extend(z.finish().unwrap());
    }
    let checksum = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &pack);
    pack.extend_from_slice(checksum.as_ref());
    pack
}
struct Capture {
    objects: BTreeMap<String, (u8, Vec<u8>)>,
    pack: Vec<u8>,
    graph: Value,
    base: String,
    proposed: String,
}
fn capture(blob: &[u8]) -> Capture {
    capture_with_commit_delimiters(blob, "\n", "\n")
}
fn capture_with_commit_delimiters(blob: &[u8], tree_ending: &str, parent_ending: &str) -> Capture {
    let blob_id = oid("blob", blob);
    let mut tree = b"100644 file.txt\0".to_vec();
    tree.extend(binary_id(&blob_id));
    let tree_id = oid("tree", &tree);
    let identity = "author Example <example@example.test> 1 +0000\ncommitter Example <example@example.test> 1 +0000\n";
    let base = format!("tree {tree_id}\n{identity}\nbase\n").into_bytes();
    let base_id = oid("commit", &base);
    let proposed =
        format!("tree {tree_id}{tree_ending}parent {base_id}{parent_ending}{identity}\nproposed\n")
            .into_bytes();
    let proposed_id = oid("commit", &proposed);
    let objects = BTreeMap::from([
        (blob_id, (3, blob.to_vec())),
        (tree_id, (2, tree)),
        (base_id.clone(), (1, base)),
        (proposed_id.clone(), (1, proposed)),
    ]);
    let pack = packed(&objects);
    let entries: Vec<_> = objects
        .iter()
        .map(|(id, (kind, bytes))| {
            json!({"bytes":bytes.len(),"oid":id,
        "sha256":broker_rpc::sha256(bytes),"type":match kind {1=>"commit",2=>"tree",_=>"blob"}})
        })
        .collect();
    let material = json!({"version":1,"objectFormat":"sha1","baseOid":base_id,"proposedOid":proposed_id,"objects":entries});
    let graph = json!({"version":1,"objectFormat":"sha1","baseOid":base_id,"proposedOid":proposed_id,
        "graphDigest":publication_digest("object-graph",&material).unwrap(),"objectCount":objects.len(),
        "rawBytes":objects.values().map(|(_,b)|b.len()).sum::<usize>(),"packBytes":pack.len(),"packSha256":broker_rpc::sha256(&pack)});
    Capture {
        objects,
        pack,
        graph,
        base: base_id,
        proposed: proposed_id,
    }
}
fn opened(capture: &Capture, push: bool) -> Value {
    let request = json!({"version":1,"repository":{"installationId":"installation:one","githubHost":"github.com",
        "appId":"1","githubInstallationId":"2","repositoryId":"3"},"baseBranch":"main","baseOid":capture.base,
        "targetBranch":"work/fixed","expectedTarget":{"kind":"existing","oid":capture.base},"proposedOid":capture.proposed,
        "draftPullRequest":{"title":"A fixed title","body":"A fixed body","draft":true},"actions":["push","create-draft-pr"]});
    let work = json!({"installationId":"installation:one","namespaceId":"namespace:one","agentId":"agent:one",
        "agentRevisionRef":"revision:one","workRef":"work:one","workRevision":1,"authorityRef":"authority:one",
        "authorityRevision":"authority-revision:one","operationRef":"operation:one","invocationRef":"invocation:one",
        "requestDigest":publication_digest("request",&request).unwrap(),"executionBindingDigest":format!("sha256:{}","a".repeat(64)),
        "requesterPrincipalId":"principal:one"});
    let mut candidate = json!({"version":1,"work":work,"request":request,"graph":capture.graph});
    let action = publication_digest("candidate-actions", &candidate).unwrap();
    candidate["actionDigest"] = action.clone().into();
    json!({"version":1,"sequence":1,"session_ref":SESSION,"ok":true,"phase":"opened","candidate":candidate,
        "call_ref":"call:original","effect":{"version":1,"effectRef":if push {"effect:push"}else{"effect:pr"},
        "kind":if push {"push"}else{"create-draft-pr"},"candidateRef":"candidate:one","approvalRef":"approval:one",
        "actionDigest":action,"confirmedPushEffectRef":if push {Value::Null}else{json!("effect:push")}},
        "action_digest":action,"repository_owner":"fixture","repository_name":"repo","dns_binding_ref":"dns:one","upstream_ipv4":"127.0.0.1"})
}
fn refresh(value: &mut Value) {
    let now = broker_rpc::unix_ms().unwrap();
    value["server_time_ms"] = now.into();
    value["valid_until_ms"] = (now + 2000).into();
}
fn packet(data: &[u8]) -> Vec<u8> {
    let mut out = format!("{:04x}", data.len() + 4).into_bytes();
    out.extend_from_slice(data);
    out
}
fn report_status() -> Vec<u8> {
    let mut out = packet(b"unpack ok\n");
    out.extend(packet(b"ok refs/heads/work/fixed\n"));
    out.extend_from_slice(b"0000");
    out
}
fn pr(capture: &Capture) -> Value {
    json!({"number":7,"html_url":"https://github.com/fixture/repo/pull/7","title":"A fixed title","body":"A fixed body","draft":true,
        "base":{"ref":"main","sha":capture.base,"repo":{"id":3,"name":"repo","owner":{"login":"fixture"}}},
        "head":{"ref":"work/fixed","sha":capture.proposed,"repo":{"id":3}}})
}
async fn read_frame<S: AsyncRead + Unpin>(stream: &mut S) -> Option<Value> {
    let mut head = [0; 8];
    stream.read_exact(&mut head).await.ok()?;
    let length = u32::from_be_bytes(head[..4].try_into().unwrap()) as usize;
    assert!((1..=METADATA).contains(&length));
    assert_eq!(&head[4..], &[0; 4]);
    let mut data = vec![0; length];
    stream.read_exact(&mut data).await.ok()?;
    Some(serde_json::from_slice(&data).unwrap())
}
async fn write_frame<S: AsyncWrite + Unpin>(stream: &mut S, value: &Value, payload: &[u8]) -> bool {
    let data = serde_json::to_vec(value).unwrap();
    let write = async {
        stream.write_all(&(data.len() as u32).to_be_bytes()).await?;
        stream
            .write_all(&(payload.len() as u32).to_be_bytes())
            .await?;
        stream.write_all(&data).await?;
        stream.write_all(payload).await?;
        stream.flush().await
    };
    write.await.is_ok()
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Fault {
    None,
    WrongSession,
    ChangedBody,
    LostTerminal,
    StalledBody,
    EscapedToken,
    ChangedPr,
    Informational,
}
pub(super) struct Fixture {
    pub(super) owner: Arc<PublicationTransport>,
    pub(super) run: PublicationRun,
    pub(super) directory: PathBuf,
    pub(super) peers: Vec<JoinHandle<()>>,
    pub(super) frames: Arc<Mutex<Vec<Value>>>,
    pub(super) http: Arc<Mutex<Vec<u8>>>,
    upstream_closed: Arc<AtomicBool>,
    pub(super) premature_terminal: Arc<AtomicBool>,
    pub(super) prepared: Arc<AtomicUsize>,
}
impl Fixture {
    pub(super) async fn start(
        push: bool,
        fault: Fault,
        control: Option<Arc<Control>>,
        blob: &[u8],
    ) -> Self {
        let capture = capture(blob);
        let mut first = opened(&capture, push);
        let operation = broker_rpc::unix_ms().unwrap() + 10000;
        first["operation_until_ms"] = operation.into();
        refresh(&mut first);
        let host = if push { "github.com" } else { "api.github.com" };
        let (up_tls, up_trust) = certificates(host, false);
        let (broker_tls, broker_trust) = certificates("broker.test", true);
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let SocketAddr::V4(endpoint) = listener.local_addr().unwrap() else {
            panic!()
        };
        let directory = PathBuf::from(
            std::env::var_os("OCE_MEDIATION_TEST_SCRATCH")
                .or_else(|| std::env::var_os("HOME"))
                .unwrap(),
        )
        .join(format!(
            "publication-test-{}",
            broker_rpc::random_ref().unwrap()
        ));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let path = directory.join("broker.sock");
        let broker = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let uid = std::fs::metadata(&directory).unwrap().uid();
        let config = BrokerConfig {
            socket_path: path,
            peer_uid: uid,
            trusted_ancestor_uids: vec![0, uid],
            server_name: ServerName::try_from("broker.test").unwrap(),
            tls: broker_trust,
            call_timeout: Duration::from_secs(2),
            check_interval: Duration::from_millis(20),
            max_clock_skew: Duration::from_millis(20),
        };
        let mut owner =
            PublicationTransport::new(config, up_trust, Duration::from_secs(10), 2).unwrap();
        let inner = Arc::get_mut(&mut owner).unwrap();
        inner.endpoint = Some(endpoint);
        inner.control = control.clone();
        let frames = Arc::new(Mutex::new(Vec::new()));
        let recorded = frames.clone();
        let http = Arc::new(Mutex::new(Vec::new()));
        let http_record = http.clone();
        let upstream_closed = Arc::new(AtomicBool::new(false));
        let closed = upstream_closed.clone();
        let premature_terminal = Arc::new(AtomicBool::new(false));
        let premature = premature_terminal.clone();
        let prepared = Arc::new(AtomicUsize::new(0));
        let preparations = prepared.clone();
        let mut response = if push {
            report_status()
        } else {
            serde_json::to_vec(&pr(&capture)).unwrap()
        };
        if fault == Fault::ChangedPr {
            let mut value = pr(&capture);
            value["head"]["sha"] = "f".repeat(40).into();
            response = serde_json::to_vec(&value).unwrap();
        }
        if fault == Fault::EscapedToken {
            let mut value = pr(&capture);
            value["title"] = std::str::from_utf8(TOKEN).unwrap().into();
            let text = serde_json::to_string(&value).unwrap();
            let escaped = TOKEN
                .iter()
                .map(|b| format!("\\u{b:04x}"))
                .collect::<String>();
            response = text
                .replace(std::str::from_utf8(TOKEN).unwrap(), &escaped)
                .into_bytes();
        }
        let upstream = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let Ok(mut stream) = tokio_rustls::TlsAcceptor::from(up_tls).accept(socket).await
            else {
                return;
            };
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                match stream.read(&mut byte).await {
                    Ok(1) => request.push(byte[0]),
                    _ => {
                        closed.store(true, Ordering::Release);
                        return;
                    }
                }
                assert!(request.len() <= 16384);
            }
            let text = std::str::from_utf8(&request).unwrap().to_ascii_lowercase();
            let length = text
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse::<usize>()
                .unwrap();
            assert!(length <= protocol::PACK_LIMIT + 1024);
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await.unwrap();
            request.extend(body);
            *http_record.lock().unwrap() = request;
            if fault == Fault::Informational {
                stream
                    .write_all(b"HTTP/1.1 103 Early Hints\r\n\r\n")
                    .await
                    .unwrap();
            }
            let mime = if push {
                "application/x-git-receive-pack-result"
            } else {
                "application/json"
            };
            let code = if push { 200 } else { 201 };
            let header=format!("HTTP/1.1 {code} Result\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len());
            if stream.write_all(header.as_bytes()).await.is_ok() {
                let payload = if fault == Fault::StalledBody {
                    &response[..1]
                } else {
                    response.as_slice()
                };
                let _ = stream.write_all(payload).await;
                let _ = stream.flush().await;
            }
            let mut tail = [0; 1];
            match stream.read(&mut tail).await {
                Ok(0) | Err(_) => closed.store(true, Ordering::Release),
                Ok(_) => panic!("unexpected second HTTP request"),
            }
        });
        let broker_task = tokio::spawn(async move {
            let (socket, _) = broker.accept().await.unwrap();
            let Ok(mut stream) = tokio_rustls::TlsAcceptor::from(broker_tls)
                .accept(socket)
                .await
            else {
                return;
            };
            while let Some(request) = read_frame(&mut stream).await {
                recorded.lock().unwrap().push(request.clone());
                let mut value = request.clone();
                value.as_object_mut().unwrap().remove("method");
                value["ok"] = true.into();
                let payload = match request["method"].as_str().unwrap() {
                    "open-publication" => {
                        value = first.clone();
                        refresh(&mut value);
                        if fault == Fault::WrongSession {
                            value["session_ref"] = "f".repeat(32).into();
                        }
                        if push {
                            capture.pack.as_slice()
                        } else {
                            &[]
                        }
                    }
                    "prepared-publication" => {
                        preparations.fetch_add(1, Ordering::AcqRel);
                        value["phase"] = "committed".into();
                        value["release_ref"] = "release:one".into();
                        value["operation_until_ms"] = operation.into();
                        refresh(&mut value);
                        if fault == Fault::ChangedBody {
                            value["body_sha256"] = format!("sha256:{}", "f".repeat(64)).into();
                        }
                        TOKEN
                    }
                    "check-publication" => {
                        value["phase"] = "current".into();
                        value["operation_until_ms"] = operation.into();
                        refresh(&mut value);
                        &[]
                    }
                    "result-publication" => {
                        if control.as_ref().is_some_and(|c| {
                            c.entered.load(Ordering::Acquire) && !c.finished.load(Ordering::Acquire)
                        }) {
                            premature.store(true, Ordering::Release);
                        }
                        if fault == Fault::LostTerminal {
                            return;
                        }
                        value.as_object_mut().unwrap().remove("outcome");
                        value["phase"] = "recorded".into();
                        &[]
                    }
                    _ => panic!("unexpected operation"),
                };
                if !write_frame(&mut stream, &value, payload).await {
                    return;
                }
                if request["method"] == "result-publication" {
                    return;
                }
            }
        });
        let run = owner.serve_original(SESSION).unwrap();
        Self {
            owner,
            run,
            directory,
            peers: vec![upstream, broker_task],
            frames,
            http,
            upstream_closed,
            premature_terminal,
            prepared,
        }
    }
    async fn finish(self) {
        self.owner.close().await.unwrap();
        for peer in &self.peers {
            peer.abort()
        }
        for peer in self.peers {
            let _ = peer.await;
        }
        std::fs::remove_dir_all(self.directory).unwrap();
    }
}

#[test]
fn fixed_push_has_one_command_and_exact_original_pack() {
    let capture = capture(b"content");
    let stop = AtomicBool::new(false);
    let graph = crate::git_pack::publication_graph(
        &capture.pack,
        &capture.proposed,
        &capture.base,
        &capture.base,
        &stop,
        &[],
    )
    .unwrap();
    assert_eq!(graph.graph_digest, capture.graph["graphDigest"]);
    assert_eq!(graph.object_count, 4);
    let body = protocol::push_body(
        "work/fixed",
        &capture.base,
        &capture.proposed,
        Zeroizing::new(capture.pack.clone()),
    )
    .unwrap();
    let command = format!(
        "{} {} refs/heads/work/fixed\0report-status\n",
        capture.base, capture.proposed
    );
    let prefix = format!("{:04x}{command}0000", command.len() + 4);
    assert_eq!(&body[..prefix.len()], prefix.as_bytes());
    assert_eq!(&body[prefix.len()..], capture.pack);
    assert!(protocol::push_body(
        "main\nother",
        protocol::ZERO_OID,
        &capture.proposed,
        Zeroizing::new(capture.pack)
    )
    .is_err());
}
#[test]
fn complete_graph_and_fast_forward_are_separate_checks() {
    let mut capture = capture(b"content");
    let stop = AtomicBool::new(false);
    assert!(crate::git_pack::publication_graph(
        &capture.pack,
        &capture.base,
        &capture.proposed,
        &capture.proposed,
        &stop,
        &[]
    )
    .is_err());
    capture
        .objects
        .insert(oid("blob", b"unreachable"), (3, b"unreachable".to_vec()));
    assert!(crate::git_pack::publication_graph(
        &packed(&capture.objects),
        &capture.proposed,
        &capture.base,
        &capture.base,
        &stop,
        &[]
    )
    .is_err());
    capture.objects.remove(&capture.base);
    assert!(crate::git_pack::publication_graph(
        &packed(&capture.objects),
        &capture.proposed,
        &capture.base,
        &capture.base,
        &stop,
        &[]
    )
    .is_err());
}
// Every delimiter fixture rebuilds object IDs, the sorted complete PACK and
// its checksum, and graph/action digests. Rejection must come from commit
// syntax; stale correspondence data cannot satisfy the negative assertions.
#[test]
fn publication_commit_preserves_lf_headers() {
    let capture = capture_with_commit_delimiters(b"content", "\n", "\n");
    let plan = Plan::parse(&opened(&capture, true)).unwrap();
    let body = plan
        .body(
            Zeroizing::new(capture.pack.clone()),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(body.ends_with(&capture.pack));
}
#[test]
fn publication_commit_refuses_crlf_tree_header() {
    let capture = capture_with_commit_delimiters(b"content", "\r\n", "\n");
    let plan = Plan::parse(&opened(&capture, true)).unwrap();
    assert!(matches!(
        plan.body(Zeroizing::new(capture.pack), &AtomicBool::new(false)),
        Err(Refusal::Protocol)
    ));
}
#[test]
fn publication_commit_refuses_crlf_parent_header() {
    let capture = capture_with_commit_delimiters(b"content", "\n", "\r\n");
    let plan = Plan::parse(&opened(&capture, true)).unwrap();
    assert!(matches!(
        plan.body(Zeroizing::new(capture.pack), &AtomicBool::new(false)),
        Err(Refusal::Protocol)
    ));
}
#[test]
fn reconstructed_publication_content_cannot_smuggle_released_token() {
    // A short credential may legally use a stored DEFLATE block. Give this
    // reconstruction test its own repetitive secret; keep transport TOKEN separate.
    let canary = b"synthetic-compressed-publication-canary-".repeat(128);
    let capture = capture(&canary);
    let stop = AtomicBool::new(false);
    assert!(
        capture.pack.len() < canary.len(),
        "fixture must compress the canary"
    );
    assert!(!capture
        .pack
        .windows(canary.len())
        .any(|v| v == canary.as_slice()));
    assert!(crate::git_pack::publication_graph(
        &capture.pack,
        &capture.proposed,
        &capture.base,
        &capture.base,
        &stop,
        &[]
    )
    .is_ok());
    assert!(matches!(
        crate::git_pack::publication_graph(
            &capture.pack,
            &capture.proposed,
            &capture.base,
            &capture.base,
            &stop,
            &[canary.as_slice()]
        ),
        Err(Refusal::Unsupported)
    ));
}
#[test]
fn status_requires_the_only_selected_ref_and_terminal_flush() {
    assert!(matches!(
        protocol::push_status(&report_status(), "work/fixed"),
        Ok(protocol::PushStatus::Pushed)
    ));
    let mut rejected = packet(b"unpack ok\n");
    rejected.extend(packet(b"ng refs/heads/work/fixed stale info\n"));
    rejected.extend_from_slice(b"0000");
    assert!(matches!(
        protocol::push_status(&rejected, "work/fixed"),
        Ok(protocol::PushStatus::Rejected)
    ));
    let mut trailing = report_status();
    trailing.extend_from_slice(b"0000");
    let mut truncated = report_status();
    truncated.truncate(truncated.len() - 4);
    let mut sideband = vec![1];
    sideband.extend(report_status());
    for bad in [trailing, truncated, sideband] {
        assert!(protocol::push_status(&bad, "work/fixed").is_err());
    }
    let mut extra = packet(b"unpack ok\n");
    extra.extend(packet(b"ok refs/heads/other\n"));
    extra.extend_from_slice(b"0000");
    assert!(protocol::push_status(&extra, "work/fixed").is_err());
}
#[test]
fn draft_body_and_candidate_are_closed_and_canonical() {
    assert_eq!(
        &*protocol::draft_body("main", "work/fixed", "T", "line\n").unwrap(),
        br#"{"base":"main","body":"line\n","draft":true,"head":"work/fixed","title":"T"}"#
    );
    let capture = capture(b"content");
    let mut value = opened(&capture, false);
    assert!(Plan::parse(&value).is_ok());
    value["candidate"]["request"]["url"] = "https://other.test".into();
    assert!(Plan::parse(&value).is_err());
    assert!(publication_reference(&format!("a{}@+", "b".repeat(253))).is_ok());
    assert!(publication_reference(&"a".repeat(257)).is_err());
}
#[test]
fn response_projection_retains_changed_observed_oid_without_atomic_claim() {
    let capture = capture(b"content");
    let plan = Plan::parse(&opened(&capture, false)).unwrap();
    let mut value = pr(&capture);
    value["head"]["sha"] = "f".repeat(40).into();
    let response = http::Response::builder()
        .status(201)
        .header(header::CONTENT_TYPE, "application/json")
        .body(())
        .unwrap();
    let (parts, _) = response.into_parts();
    let result = observe(
        &parts,
        &serde_json::to_vec(&value).unwrap(),
        &plan,
        &[TOKEN],
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(result.0["kind"], "unknown");
    assert_eq!(result.0["pullRequest"]["number"], "7");
    assert_eq!(result.0["pullRequest"]["headOid"], "f".repeat(40));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_tls_push_once_and_original_result_survives_retirement() {
    let fixture = Fixture::start(true, Fault::None, None, b"content").await;
    let result = timeout(Duration::from_secs(5), fixture.owner.result(&fixture.run))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.inspect()["outcome"]["kind"], "pushed");
    assert!(result.terminal_recorded());
    fixture.owner.retire(&fixture.run).await.unwrap();
    let again = fixture.owner.result(&fixture.run).await.unwrap();
    assert!(Arc::ptr_eq(&result, &again));
    assert!(fixture.owner.serve_original(SESSION).is_err());
    assert_eq!(fixture.prepared.load(Ordering::Acquire), 1);
    let bytes = fixture.http.lock().unwrap().clone();
    let text =
        std::str::from_utf8(&bytes[..bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4])
            .unwrap();
    assert!(text.starts_with("POST /fixture/repo.git/git-receive-pack HTTP/1.1\r\n"));
    assert_eq!(
        text.to_ascii_lowercase().matches("authorization:").count(),
        1
    );
    let raw = format!("x-access-token:{}", std::str::from_utf8(TOKEN).unwrap());
    assert!(text.contains(&base64::engine::general_purpose::STANDARD.encode(raw)));
    timeout(Duration::from_secs(3), async {
        while !fixture.upstream_closed.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    fixture.finish().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_tls_pr_keeps_observed_attribution_when_terminal_is_lost() {
    let fixture = Fixture::start(false, Fault::LostTerminal, None, b"content").await;
    let result = timeout(Duration::from_secs(5), fixture.owner.result(&fixture.run))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.inspect()["outcome"]["kind"], "draft-pr-created");
    assert_eq!(
        result.inspect()["outcome"]["pullRequest"]["url"],
        "https://github.com/fixture/repo/pull/7"
    );
    assert!(!result.terminal_recorded());
    fixture.owner.retire(&fixture.run).await.unwrap();
    assert!(Arc::ptr_eq(
        &result,
        &fixture.owner.result(&fixture.run).await.unwrap()
    ));
    fixture.finish().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_tls_changed_pr_is_retained_and_escaped_token_is_suppressed() {
    for fault in [Fault::ChangedPr, Fault::EscapedToken, Fault::Informational] {
        let fixture = Fixture::start(false, fault, None, b"content").await;
        let result = timeout(Duration::from_secs(5), fixture.owner.result(&fixture.run))
            .await
            .unwrap()
            .unwrap();
        let outcome = result.inspect();
        assert_eq!(outcome["outcome"]["kind"], "unknown");
        if fault == Fault::ChangedPr {
            assert_eq!(outcome["outcome"]["pullRequest"]["headOid"], "f".repeat(40));
        } else {
            assert!(outcome["outcome"]["pullRequest"].is_null());
        }
        assert!(!serde_json::to_vec(&outcome)
            .unwrap()
            .windows(TOKEN.len())
            .any(|v| v == TOKEN));
        fixture.finish().await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_tls_wrong_original_binding_and_compressed_credential_never_submit() {
    for (fault, blob) in [
        (Fault::WrongSession, b"content".as_slice()),
        (Fault::ChangedBody, b"content"),
        (Fault::None, TOKEN),
    ] {
        let fixture = Fixture::start(true, fault, None, blob).await;
        let _ = timeout(Duration::from_secs(5), fixture.owner.result(&fixture.run))
            .await
            .unwrap();
        assert!(fixture.http.lock().unwrap().is_empty());
        fixture.finish().await;
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_entered_preparation_is_physically_joined_before_result() {
    let control = Control::new(Stage::Prepared);
    let fixture = Fixture::start(true, Fault::None, Some(control.clone()), b"content").await;
    timeout(Duration::from_secs(3), control.entered())
        .await
        .unwrap();
    let owner = fixture.owner.clone();
    let run = fixture.run.clone();
    let retired = tokio::spawn(async move { owner.retire(&run).await });
    timeout(Duration::from_secs(3), control.cancelled())
        .await
        .unwrap();
    assert!(!retired.is_finished());
    assert!(!control.finished.load(Ordering::Acquire));
    assert!(fixture.http.lock().unwrap().is_empty());
    assert_eq!(fixture.prepared.load(Ordering::Acquire), 0);
    assert!(!fixture
        .frames
        .lock()
        .unwrap()
        .iter()
        .any(|f| f["method"] == "result-publication"));
    control.release();
    retired.await.unwrap().unwrap();
    assert!(control.finished.load(Ordering::Acquire));
    assert!(!fixture.premature_terminal.load(Ordering::Acquire));
    assert_eq!(
        fixture.owner.result(&fixture.run).await.unwrap().inspect()["outcome"]["kind"],
        "not-dispatched"
    );
    fixture.finish().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_retirement_cannot_drop_worker_or_known_observation() {
    let control = Control::new(Stage::Observed);
    let fixture = Fixture::start(false, Fault::None, Some(control.clone()), b"content").await;
    timeout(Duration::from_secs(3), control.entered())
        .await
        .unwrap();
    let owner = fixture.owner.clone();
    let run = fixture.run.clone();
    let first = tokio::spawn(async move { owner.retire(&run).await });
    timeout(Duration::from_secs(3), control.cancelled())
        .await
        .unwrap();
    assert!(!first.is_finished());
    first.abort();
    let _ = first.await;
    let owner = fixture.owner.clone();
    let run = fixture.run.clone();
    let second = tokio::spawn(async move { owner.retire(&run).await });
    assert!(!control.finished.load(Ordering::Acquire));
    assert!(!second.is_finished());
    assert!(!fixture
        .frames
        .lock()
        .unwrap()
        .iter()
        .any(|f| f["method"] == "result-publication"));
    control.release();
    second.await.unwrap().unwrap();
    assert!(!fixture.premature_terminal.load(Ordering::Acquire));
    assert_eq!(
        fixture.owner.result(&fixture.run).await.unwrap().inspect()["outcome"]["kind"],
        "draft-pr-created"
    );
    fixture.finish().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_closes_an_actual_stalled_upstream_body() {
    let fixture = Fixture::start(true, Fault::StalledBody, None, b"content").await;
    timeout(Duration::from_secs(3), async {
        while fixture.http.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    fixture.owner.retire(&fixture.run).await.unwrap();
    timeout(Duration::from_secs(3), async {
        while !fixture.upstream_closed.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        fixture.owner.result(&fixture.run).await.unwrap().inspect()["outcome"]["kind"],
        "unknown"
    );
    fixture.finish().await;
}

#[test]
fn only_explicit_null_description_normalizes_to_empty() {
    let capture = capture(b"content");
    let mut value = pr(&capture);
    value["body"] = Value::Null;
    assert_eq!(protocol::pull_request(&value).unwrap().0.body, "");
    value.as_object_mut().unwrap().remove("body");
    assert!(protocol::pull_request(&value).is_err());
    value["body"] = false.into();
    assert!(protocol::pull_request(&value).is_err());
}
#[test]
fn supervisor_digest_is_recursive_and_duplicate_keys_refuse() {
    let left = SupervisorRecord::parse(br#"{"z":{"b":1,"a":2},"a":true}"#).unwrap();
    let right = SupervisorRecord::parse(br#"{"a":true,"z":{"a":2,"b":1}}"#).unwrap();
    assert_eq!(
        left.canonical_sha256().unwrap(),
        right.canonical_sha256().unwrap()
    );
    assert!(SupervisorRecord::parse(br#"{"x":1,"\u0078":2}"#).is_err());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn other_original_transport_cannot_retire_a_run() {
    let one = Fixture::start(true, Fault::None, None, b"one").await;
    let two = Fixture::start(true, Fault::None, None, b"two").await;
    assert!(matches!(
        one.owner.retire(&two.run).await,
        Err(Refusal::Protocol)
    ));
    one.owner.retire(&one.run).await.unwrap();
    two.owner.retire(&two.run).await.unwrap();
    one.finish().await;
    two.finish().await;
}
