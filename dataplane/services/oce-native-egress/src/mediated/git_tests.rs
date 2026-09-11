//! Explicit real Git compatibility through the Rust mediated read transport.
//! Broker and GitHub are substituted at real UDS/mTLS and TLS/HTTP boundaries.
//! This fixture proves no OCC authorization, custody, or production composition.
use super::*;
use crate::tests::native::{base_environment, command, success};
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use rustls_pki_types::{PrivateKeyDer, ServerName};
use std::{
    collections::BTreeMap,
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UnixListener},
    task::JoinSet,
    time::timeout,
};

const GIT_HOST: &str = "github.com";
const GIT_ALPN: &[u8] = b"oce-github-git-read-v3";
const SYNTHETIC_TOKEN: &[u8] = b"synthetic-git-read-installation-token";
// base64("x-access-token:synthetic-git-read-installation-token")
const PROTECTED_AUTH: &str =
    "Basic eC1hY2Nlc3MtdG9rZW46c3ludGhldGljLWdpdC1yZWFkLWluc3RhbGxhdGlvbi10b2tlbg==";

fn git_packet(data: &[u8]) -> Vec<u8> {
    let mut packet = format!("{:04x}", data.len() + 4).into_bytes();
    packet.extend_from_slice(data);
    packet
}

fn framed_pack(pack: &[u8]) -> Vec<u8> {
    let mut body = git_packet(b"packfile\n");
    for chunk in pack.chunks(16 * 1024) {
        let mut band = vec![1];
        band.extend_from_slice(chunk);
        body.extend(git_packet(&band));
    }
    body.extend_from_slice(b"0000");
    body
}

fn reference_delta_canary_pack() -> Vec<u8> {
    // Neither this reordered base nor the inflated delta instructions contain
    // the complete canary. It appears only after REF_DELTA reconstruction.
    let split = SYNTHETIC_TOKEN.len() / 2;
    let suffix = &SYNTHETIC_TOKEN[split..];
    let prefix = &SYNTHETIC_TOKEN[..split];
    let mut base = suffix.to_vec();
    base.extend_from_slice(b"SEPARATOR");
    base.extend_from_slice(prefix);
    assert!(base.len() < 128 && SYNTHETIC_TOKEN.len() < 128);
    let delta = vec![
        base.len() as u8,
        SYNTHETIC_TOKEN.len() as u8,
        0x91,
        (suffix.len() + 9) as u8,
        prefix.len() as u8,
        0x90,
        suffix.len() as u8,
    ];
    for bytes in [&base, &delta] {
        assert!(!bytes
            .windows(SYNTHETIC_TOKEN.len())
            .any(|w| w == SYNTHETIC_TOKEN));
    }
    let mut hash = ring::digest::Context::new(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY);
    hash.update(format!("blob {}\0", base.len()).as_bytes());
    hash.update(&base);
    let base_oid = hash.finish();
    let entry = |kind: u8, data: &[u8], reference: &[u8]| {
        let mut size = data.len();
        let mut header = vec![(kind << 4) | (size as u8 & 15)];
        size >>= 4;
        while size != 0 {
            *header.last_mut().unwrap() |= 128;
            header.push((size & 127) as u8);
            size >>= 7;
        }
        header.extend_from_slice(reference);
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
        std::io::Write::write_all(&mut encoder, data).unwrap();
        header.extend(encoder.finish().unwrap());
        header
    };
    let mut pack = b"PACK\0\0\0\x02\0\0\0\x02".to_vec();
    pack.extend(entry(3, &base, &[]));
    pack.extend(entry(7, &delta, base_oid.as_ref()));
    let checksum = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &pack);
    pack.extend_from_slice(checksum.as_ref());
    pack
}

async fn verify_received_delta_pack(
    git: &Path,
    checkout: &Path,
    env: &BTreeMap<String, String>,
    previous: &[PathBuf],
) -> Vec<PathBuf> {
    let indexes: Vec<_> = std::fs::read_dir(checkout.join(".git/objects/pack"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "idx") && !previous.contains(path))
        .collect();
    let mut deltas = 0;
    for index in &indexes {
        let verified = success(git, &["verify-pack", "-v", index.to_str().unwrap()], env).await;
        deltas += verified
            .lines()
            .filter(|line| {
                let fields: Vec<_> = line.split_whitespace().collect();
                fields.len() == 7
                    && fields[0].len() == 40
                    && fields[5].parse::<usize>().is_ok_and(|depth| depth > 0)
            })
            .count();
    }
    assert!(
        deltas > 0,
        "actual received pack must contain at least one internal delta object"
    );
    indexes
}

fn tls_pair(name: &str, mutual: bool) -> (Arc<ServerConfig>, Arc<ClientConfig>, String) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut params = CertificateParams::new(vec!["git-mediation-test-ca".into()]).unwrap();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "Git mediation fixture root");
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
        let certificate = params.signed_by(&key, &issuer).unwrap();
        (
            vec![certificate.der().clone()],
            PrivateKeyDer::Pkcs8(key.serialize_der().into()),
        )
    };
    let (chain, key) = leaf(name, ExtendedKeyUsagePurpose::ServerAuth);
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
    let mut server = server.with_single_cert(chain, key).unwrap();
    let client = ClientConfig::builder().with_root_certificates(roots);
    let mut client = if mutual {
        let (chain, key) = leaf("git-injector.test", ExtendedKeyUsagePurpose::ClientAuth);
        client.with_client_auth_cert(chain, key).unwrap()
    } else {
        client.with_no_client_auth()
    };
    let alpn = if mutual { GIT_ALPN } else { b"http/1.1" };
    server.alpn_protocols = vec![alpn.to_vec()];
    client.alpn_protocols = vec![alpn.to_vec()];
    client.resumption = rustls::client::Resumption::disabled();
    (Arc::new(server), Arc::new(client), root.pem())
}

// Independently spells the external v3 contract, without the production request
// builder. The fixture later pairs each declaration with actual upstream bytes.
fn canonical_digest(operation: &str, body_hash: &str, body_bytes: u64) -> String {
    let (method, target, accept, content_type) = match operation {
        "discovery" => (
            "GET",
            "/fixture/repo.git/info/refs?service=git-upload-pack",
            "application/x-git-upload-pack-advertisement",
            "",
        ),
        "upload-pack" => (
            "POST",
            "/fixture/repo.git/git-upload-pack",
            "application/x-git-upload-pack-result",
            "application/x-git-upload-pack-request",
        ),
        _ => panic!("unsupported Git operation reached broker"),
    };
    broker_rpc::sha256(format!("oce.github.git-read.v3\n{operation}\n{method}\nhttps\ngithub.com\n443\n{target}\naccept:{accept}\naccept-encoding:identity\ncontent-type:{content_type}\ngit-protocol:version=2\nuser-agent:oce-github-git-read\nconnection:close\nbody-bytes:{body_bytes}\nbody-sha256:{}\n", body_hash.strip_prefix("sha256:").unwrap()).as_bytes())
}

async fn broker_connection(
    socket: tokio::net::UnixStream,
    tls: Arc<ServerConfig>,
    records: Arc<Mutex<Vec<Value>>>,
    uid: u32,
    wrong_version_at: Option<u32>,
    pack_control: Option<Arc<crate::git_pack::test_control::Control>>,
) {
    assert_eq!(socket.peer_cred().unwrap().uid(), uid);
    let mut stream = TlsAcceptor::from(tls).accept(socket).await.unwrap();
    assert_eq!(stream.get_ref().1.alpn_protocol(), Some(GIT_ALPN));
    assert!(!stream.get_ref().1.peer_certificates().unwrap().is_empty());
    let operation_until = broker_rpc::unix_ms().unwrap() + 60_000;
    let mut binding = serde_json::Map::new();
    let mut sequence = 0;
    loop {
        let mut lengths = [0; 8];
        if stream.read_exact(&mut lengths).await.is_err() {
            return;
        }
        let metadata_bytes = u32::from_be_bytes(lengths[..4].try_into().unwrap()) as usize;
        assert!((1..=16384).contains(&metadata_bytes));
        assert_eq!(&lengths[4..], &[0; 4]);
        let mut metadata = vec![0; metadata_bytes];
        stream.read_exact(&mut metadata).await.unwrap();
        let request: Value = serde_json::from_slice(&metadata).unwrap();
        records.lock().unwrap().push(request.clone());
        sequence += 1;
        assert_eq!(request["version"], 3);
        assert_eq!(request["sequence"], sequence);
        let method = request["method"].as_str().unwrap();
        if sequence == 1 {
            assert_eq!(method, "open-read");
            assert_eq!(request["attachment_ref"], "original-git-read-attachment");
            assert_eq!(request["repository_owner"], "fixture");
            assert_eq!(request["repository_name"], "repo");
            assert_eq!(request["git_protocol"], "version=2");
            let operation = request["git_operation"].as_str().unwrap();
            let bytes = request["body_bytes"].as_u64().unwrap();
            let hash = request["body_sha256"].as_str().unwrap();
            if operation == "discovery" {
                assert_eq!(bytes, 0);
                assert_eq!(hash, broker_rpc::sha256(b""));
            } else {
                assert!((1..=4_194_304).contains(&bytes));
            }
            assert_eq!(
                request["request_sha256"],
                canonical_digest(operation, hash, bytes)
            );
            binding.insert(
                "session_ref".into(),
                broker_rpc::random_ref().unwrap().into(),
            );
            binding.insert(
                "effect_ref".into(),
                format!(
                    "fixture-effect-{}",
                    request["request_ref"].as_str().unwrap()
                )
                .into(),
            );
            binding.insert(
                "work_binding_sha256".into(),
                broker_rpc::sha256(b"substituted-original-work").into(),
            );
            binding.insert("request_sha256".into(), request["request_sha256"].clone());
        } else {
            for (key, value) in &binding {
                assert_eq!(&request[key], value);
            }
        }
        let mut reply = Value::Object(binding.clone());
        for key in ["version", "sequence", "request_ref"] {
            reply[key] = request[key].clone();
        }
        reply["ok"] = true.into();
        if wrong_version_at == Some(sequence) {
            reply["version"] = 2.into();
        }
        let secret = if method == "complete-read" {
            if let Some(control) = &pack_control {
                assert!(control.is_cancelled());
                assert!(control.is_released());
                assert!(
                    control.is_finished(),
                    "terminal receipt must follow actual PACK worker drain"
                );
            }
            reply["phase"] = "recorded".into();
            reply["release_ref"] = request["release_ref"].clone();
            &[][..]
        } else {
            let now = broker_rpc::unix_ms().unwrap();
            reply["server_time_ms"] = now.into();
            reply["valid_until_ms"] = (now + 5000).min(operation_until).into();
            reply["operation_until_ms"] = operation_until.into();
            match method {
                "open-read" => {
                    reply["phase"] = "opened".into();
                    reply["dns_binding_ref"] = "fixture-git-dns".into();
                    reply["upstream_ipv4"] = "127.0.0.1".into();
                    &[][..]
                }
                "dispatch-read" => {
                    assert_eq!(sequence, 2);
                    reply["phase"] = "dispatch-once".into();
                    for key in [
                        "dns_binding_ref",
                        "upstream_ipv4",
                        "peer_certificate_sha256",
                    ] {
                        reply[key] = request[key].clone();
                    }
                    reply["release_ref"] = "fixture-git-release".into();
                    SYNTHETIC_TOKEN
                }
                "check-read" => {
                    reply["phase"] = "current".into();
                    reply["release_ref"] = "fixture-git-release".into();
                    if pack_control
                        .as_ref()
                        .is_some_and(|control| control.is_entered())
                    {
                        // The cancellation test's next check is 250 ms away.
                        // This valid 100 ms lease expires first, leaving the
                        // broker connection writable for original completion.
                        reply["valid_until_ms"] = (now + 100).into();
                    }
                    &[][..]
                }
                _ => panic!("unsupported broker method"),
            }
        };
        let metadata = serde_json::to_vec(&reply).unwrap();
        stream
            .write_all(&(metadata.len() as u32).to_be_bytes())
            .await
            .unwrap();
        stream
            .write_all(&(secret.len() as u32).to_be_bytes())
            .await
            .unwrap();
        stream.write_all(&metadata).await.unwrap();
        stream.write_all(secret).await.unwrap();
        stream.flush().await.unwrap();
        if method == "complete-read" {
            return;
        }
    }
}

async fn raw_request(address: SocketAddr, trust: Arc<ClientConfig>, wire: &[u8]) -> Vec<u8> {
    timeout(Duration::from_secs(5), async {
        let socket = TcpStream::connect(address).await.unwrap();
        let mut tls = TlsConnector::from(trust)
            .connect(ServerName::try_from(GIT_HOST).unwrap(), socket)
            .await
            .unwrap();
        tls.write_all(wire).await.unwrap();
        let mut response = Vec::new();
        let _ = tls.read_to_end(&mut response).await;
        response
    })
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit prepared Git 2.55.0 manifest and protected private scratch"]
async fn pinned_git_clones_and_fetches_through_mediated_read_profile() {
    let manifest_path =
        std::env::var("OCE_NATIVE_FIREWALL_TOOLS").expect("explicit pinned tool manifest");
    let scratch = PathBuf::from(
        std::env::var("OCE_NATIVE_FIREWALL_SCRATCH").expect("explicit protected scratch"),
    );
    assert!(scratch.is_absolute() && scratch.is_dir());
    let manifest: Value = serde_json::from_slice(&std::fs::read(manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["execution"], "local-synthetic-only");
    assert_eq!(manifest["git"]["version"], "2.55.0");
    assert_eq!(
        manifest["git"]["commit"],
        "e9019fcafe0040228b8631c30f97ae1adb61bcdc"
    );
    let home = scratch.join(format!(
        "mediated-git-{}",
        broker_rpc::random_ref().unwrap()
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&home)
        .unwrap();
    let base = base_environment(&home, manifest["gitExecPath"].as_str().unwrap());
    for name in ["git", "gitRemoteHttp", "gitRemoteHttps", "gitHttpBackend"] {
        let path = manifest[name]["path"].as_str().unwrap();
        assert!(Path::new(path).is_absolute());
        let digest = success(Path::new("/usr/bin/sha256sum"), &[path], &base).await;
        assert_eq!(
            digest.split_whitespace().next().unwrap(),
            manifest[name]["sha256"]
        );
    }
    let git = PathBuf::from(manifest["git"]["path"].as_str().unwrap());
    let backend = PathBuf::from(manifest["gitHttpBackend"]["path"].as_str().unwrap());
    assert_eq!(
        success(&git, &["--version"], &base).await.trim(),
        "git version 2.55.0"
    );
    let seed = home.join("seed");
    let bare_root = home.join("bare");
    let bare = bare_root.join("fixture/repo.git");
    let checkout = home.join("checkout");
    std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
    success(
        &git,
        &[
            "-c",
            "init.templateDir=",
            "init",
            "--initial-branch=main",
            seed.to_str().unwrap(),
        ],
        &base,
    )
    .await;
    std::fs::write(seed.join("file.txt"), "first trusted graph\n").unwrap();
    // Distinct similar blobs make the actual Git provider emit internal deltas.
    // Deterministic noisy content avoids relying on zlib's trivial repetition.
    let mut generator = 0x1234_5678_u32;
    let similar: Vec<u8> = (0..64 * 1024)
        .map(|_| {
            generator = generator
                .wrapping_mul(1_664_525)
                .wrapping_add(1_013_904_223);
            b'a' + ((generator >> 16) % 26) as u8
        })
        .collect();
    for index in 0..6 {
        let mut body = similar.clone();
        body.extend_from_slice(format!("\ndistinct blob {index}\n").as_bytes());
        std::fs::write(seed.join(format!("similar-{index}.txt")), body).unwrap();
    }
    success(&git, &["-C", seed.to_str().unwrap(), "add", "."], &base).await;
    success(
        &git,
        &[
            "-C",
            seed.to_str().unwrap(),
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "First fixture commit",
        ],
        &base,
    )
    .await;
    let first = success(
        &git,
        &["-C", seed.to_str().unwrap(), "rev-parse", "HEAD"],
        &base,
    )
    .await
    .trim()
    .to_owned();
    success(
        &git,
        &[
            "clone",
            "--bare",
            seed.to_str().unwrap(),
            bare.to_str().unwrap(),
        ],
        &base,
    )
    .await;
    // The substituted provider itself also disables writes. The tested mediator
    // must reject receive-pack before reaching this independent protection.
    success(
        &git,
        &[
            "--git-dir",
            bare.to_str().unwrap(),
            "config",
            "http.receivepack",
            "false",
        ],
        &base,
    )
    .await;
    let (upstream_tls, upstream_trust, _) = tls_pair(GIT_HOST, false);
    let (incoming_tls, incoming_trust, ca_pem) = tls_pair(GIT_HOST, false);
    let (broker_tls, broker_trust, _) = tls_pair("git-broker.test", true);
    let ca_path = home.join("incoming-ca.pem");
    std::fs::write(&ca_path, ca_pem).unwrap();
    let socket_path = home.join("broker.sock");
    let broker = UnixListener::bind(&socket_path).unwrap();
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let uid = std::fs::metadata(&home).unwrap().uid();
    let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let SocketAddr::V4(endpoint) = upstream.local_addr().unwrap() else {
        unreachable!()
    };
    let records = Arc::new(Mutex::new(Vec::<Value>::new()));
    let upstream_records = Arc::new(Mutex::new(Vec::<Value>::new()));
    let outcomes = Arc::new(Mutex::new(Vec::<Result<(), Refusal>>::new()));
    let provider_fault_body = Arc::new(Mutex::new(None::<Vec<u8>>));
    let (shutdown, stop) = watch::channel(false);
    let mut tasks = Vec::new();
    let mut broker_stop = stop.clone();
    let broker_records = records.clone();
    tasks.push(tokio::spawn(async move {
        let mut owned = JoinSet::new();
        loop { tokio::select! {
            _ = broker_stop.changed() => break,
            result = owned.join_next(), if !owned.is_empty() => { result.unwrap().unwrap(); },
            accepted = broker.accept() => {
                let (socket, _) = accepted.unwrap();
                owned.spawn(broker_connection(socket, broker_tls.clone(), broker_records.clone(), uid, None, None));
            }
        }}
        while let Some(result) = owned.join_next().await { result.unwrap(); }
    }));
    let mut upstream_stop = stop.clone();
    let backend_env = base.clone();
    let up_records = upstream_records.clone();
    let upstream_fault = provider_fault_body.clone();
    tasks.push(tokio::spawn(async move {
        let mut owned = JoinSet::new();
        loop { tokio::select! {
            _ = upstream_stop.changed() => break,
            result = owned.join_next(), if !owned.is_empty() => { result.unwrap().unwrap(); },
            accepted = upstream.accept() => {
                let (socket, _) = accepted.unwrap();
                let tls = upstream_tls.clone(); let backend = backend.clone(); let env = backend_env.clone(); let root = bare_root.clone(); let seen = up_records.clone(); let fault = upstream_fault.clone();
                owned.spawn(async move {
                    let tls = TlsAcceptor::from(tls).accept(socket).await.unwrap();
                    let handler = service_fn(move |request: Request<Incoming>| {
                        let backend = backend.clone(); let mut env = env.clone(); let root = root.clone(); let seen = seen.clone(); let fault = fault.clone();
                        async move {
                            let (parts, body) = request.into_parts();
                            assert_eq!(parts.headers.get_all(header::AUTHORIZATION).iter().count(), 1);
                            assert_eq!(parts.headers[header::AUTHORIZATION], PROTECTED_AUTH);
                            assert_eq!(parts.headers[header::HOST], GIT_HOST);
                            assert_eq!(parts.headers["git-protocol"], "version=2");
                            assert_eq!(parts.headers[header::ACCEPT_ENCODING], "identity");
                            assert_eq!(parts.headers[header::USER_AGENT], "oce-github-git-read");
                            assert!(!parts.headers.contains_key(header::COOKIE));
                            assert!(!parts.headers.contains_key(header::CONTENT_ENCODING), "upstream receives normalized retained packet bytes");
                            let target = parts.uri.to_string();
                            let operation = match (parts.method.as_str(), target.as_str()) {
                                ("GET", "/fixture/repo.git/info/refs?service=git-upload-pack") => "discovery",
                                ("POST", "/fixture/repo.git/git-upload-pack") => "upload-pack",
                                _ => panic!("unselected operation reached actual Git backend"),
                            };
                            let bytes = body.collect().await.unwrap().to_bytes();
                            assert!(!bytes.windows(b"thin-pack\n".len()).any(|w| w == b"thin-pack\n"), "provider receives a self-contained pack request");
                            let body_hash = broker_rpc::sha256(&bytes);
                            seen.lock().unwrap().push(serde_json::json!({"operation":operation,"target":target,"body_bytes":bytes.len(),"body_sha256":body_hash,"request_sha256":canonical_digest(operation,&body_hash,bytes.len() as u64)}));
                            let malicious = fault.lock().unwrap().take();
                            if let Some(body) = malicious {
                                assert_eq!(operation, "upload-pack");
                                return Ok::<_, Infallible>(Response::builder().status(200)
                                    .header(header::CONTENT_TYPE, "application/x-git-upload-pack-result")
                                    .header(header::CONNECTION, "close")
                                    .body(Full::new(Bytes::from(body))).unwrap());
                            }
                            env.insert("GIT_PROJECT_ROOT".into(), root.to_str().unwrap().into());
                            env.insert("GIT_HTTP_EXPORT_ALL".into(), "1".into());
                            env.insert("PATH_INFO".into(), parts.uri.path().into());
                            env.insert("QUERY_STRING".into(), parts.uri.query().unwrap_or("").into());
                            env.insert("REQUEST_METHOD".into(), parts.method.as_str().into());
                            env.insert("CONTENT_TYPE".into(), parts.headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").into());
                            env.insert("CONTENT_LENGTH".into(), bytes.len().to_string());
                            env.insert("HTTP_GIT_PROTOCOL".into(), "version=2".into());
                            let output = command(&backend, &[], &env, Some(bytes.to_vec())).await;
                            assert!(output.status.success(), "actual git-http-backend failed");
                            let split = output.stdout.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
                            let headers = std::str::from_utf8(&output.stdout[..split]).unwrap();
                            let mut response = Response::builder();
                            for line in headers.split("\r\n") {
                                let (name, value) = line.split_once(':').unwrap();
                                if name.eq_ignore_ascii_case("status") { response = response.status(value.split_whitespace().next().unwrap().parse::<u16>().unwrap()); }
                                else { response = response.header(name, value.trim()); }
                            }
                            Ok::<_, Infallible>(response.body(Full::new(Bytes::copy_from_slice(&output.stdout[split + 4..]))).unwrap())
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new().keep_alive(false).serve_connection(TokioIo::new(tls), handler).await;
                });
            }
        }}
        while let Some(result) = owned.join_next().await { result.unwrap(); }
    }));
    let broker_config = BrokerConfig {
        socket_path: socket_path.clone(),
        peer_uid: uid,
        trusted_ancestor_uids: vec![std::fs::metadata("/").unwrap().uid()],
        server_name: ServerName::try_from("git-broker.test").unwrap(),
        tls: broker_trust,
        call_timeout: Duration::from_secs(3),
        check_interval: Duration::from_millis(100),
        max_clock_skew: Duration::from_millis(50),
    };
    let limits = Limits {
        header_bytes: 16384,
        header_count: 64,
        request_bytes: 4_194_304,
        response_bytes: 67_108_864,
        exchange_timeout: Duration::from_secs(15),
    };
    let mut mediator = Mediator::new_git_read(
        Repository::new("fixture", "repo", &first).unwrap(),
        incoming_tls,
        upstream_trust,
        broker_config,
        limits,
        16,
    )
    .unwrap();
    mediator.test_endpoint = Some(endpoint);
    let mediator = Arc::new(mediator);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut mediator_stop = stop.clone();
    let serving_outcomes = outcomes.clone();
    tasks.push(tokio::spawn(async move {
        let mut owned = JoinSet::new();
        loop { tokio::select! {
            _ = mediator_stop.changed() => break,
            result = owned.join_next(), if !owned.is_empty() => { result.unwrap().unwrap(); },
            accepted = listener.accept() => {
                let (socket, _) = accepted.unwrap(); let mediator = mediator.clone(); let outcomes = serving_outcomes.clone();
                owned.spawn(async move { let result = mediator.serve(socket, "original-git-read-attachment").await; outcomes.lock().unwrap().push(result); });
            }
        }}
        while let Some(result) = owned.join_next().await { result.unwrap(); }
    }));
    // Only this local fixture CONNECT router maps github.com:443 to loopback.
    let proxy = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let mut proxy_stop = stop.clone();
    tasks.push(tokio::spawn(async move {
        let mut owned = JoinSet::new();
        loop { tokio::select! {
            _ = proxy_stop.changed() => break,
            result = owned.join_next(), if !owned.is_empty() => { result.unwrap().unwrap(); },
            accepted = proxy.accept() => {
                let (mut socket, _) = accepted.unwrap();
                owned.spawn(async move {
                    let mut header = Vec::new(); let mut byte = [0];
                    while !header.ends_with(b"\r\n\r\n") {
                        if socket.read_exact(&mut byte).await.is_err() { return; }
                        header.push(byte[0]); assert!(header.len() <= 8192);
                    }
                    assert_eq!(std::str::from_utf8(&header).unwrap().lines().next(), Some("CONNECT github.com:443 HTTP/1.1"));
                    let mut target = TcpStream::connect(address).await.unwrap();
                    socket.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut target).await;
                });
            }
        }}
        while let Some(result) = owned.join_next().await { result.unwrap(); }
    }));
    // A fully cleared environment and empty credential helper configure ordinary
    // Git without any provider token, extra Authorization header, or token URL.
    let mut native: BTreeMap<String, String> = base.clone();
    for (name, value) in [
        ("HTTPS_PROXY", proxy_url.as_str()),
        ("https_proxy", proxy_url.as_str()),
        ("GIT_SSL_CAINFO", ca_path.to_str().unwrap()),
        ("SSL_CERT_FILE", ca_path.to_str().unwrap()),
        ("GIT_CONFIG_COUNT", "5"),
        ("GIT_CONFIG_KEY_0", "http.version"),
        ("GIT_CONFIG_VALUE_0", "HTTP/1.1"),
        ("GIT_CONFIG_KEY_1", "http.followRedirects"),
        ("GIT_CONFIG_VALUE_1", "false"),
        ("GIT_CONFIG_KEY_2", "protocol.version"),
        ("GIT_CONFIG_VALUE_2", "2"),
        ("GIT_CONFIG_KEY_3", "credential.helper"),
        ("GIT_CONFIG_VALUE_3", ""),
        ("GIT_CONFIG_KEY_4", "fetch.unpackLimit"),
        ("GIT_CONFIG_VALUE_4", "1"),
    ] {
        native.insert(name.into(), value.into());
    }
    assert!(!native
        .values()
        .any(|value| value.contains("Authorization") || value.contains("synthetic-git-read")));

    // Invalid write routes, repository, caller credential and packet bodies must
    // fail before broker open-read or an upstream Git request.
    for wire in [
        "GET /fixture/repo.git/info/refs?service=git-receive-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\n\r\n",
        "GET /foreign/repo.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\n\r\n",
        "POST /fixture/repo.git/git-receive-pack HTTP/1.1\r\nHost: github.com\r\nContent-Length: 0\r\nGit-Protocol: version=2\r\n\r\n",
        "GET /fixture/repo.git/info/refs?service=git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nAuthorization: Basic caller\r\n\r\n",
        "POST /fixture/repo.git/git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nContent-Type: application/x-git-upload-pack-request\r\nContent-Length: 4\r\n\r\nzzzz",
        "POST /fixture/repo.git/git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nContent-Type: application/x-git-upload-pack-request\r\nContent-Encoding: gzip\r\nContent-Length: 4\r\n\r\nzzzz",
        // Use valid pkt-lines so only ambiguous raw HTTP framing is under test.
        // Hyper may normalize these headers before the service sees Parts.
        "POST /fixture/repo.git/git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nContent-Type: application/x-git-upload-pack-request\r\nTransfer-Encoding: chunked\r\nContent-Length: 72\r\n\r\n48\r\n0014command=ls-refs\n0017object-format=sha1\n00010009peel\n000csymrefs\n0000\r\n0\r\n\r\n",
        "POST /fixture/repo.git/git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nContent-Type: application/x-git-upload-pack-request\r\nContent-Length: 72\r\nTransfer-Encoding: chunked\r\n\r\n48\r\n0014command=ls-refs\n0017object-format=sha1\n00010009peel\n000csymrefs\n0000\r\n0\r\n\r\n",
        "POST /fixture/repo.git/git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nContent-Type: application/x-git-upload-pack-request\r\nContent-Length: 72\r\nContent-Length: 72\r\n\r\n0014command=ls-refs\n0017object-format=sha1\n00010009peel\n000csymrefs\n0000",
    ] {
        let response = raw_request(address, incoming_trust.clone(), wire.as_bytes()).await;
        assert!(!response.starts_with(b"HTTP/1.1 200"));
        assert!(records.lock().unwrap().is_empty());
        assert!(upstream_records.lock().unwrap().is_empty());
    }
    // Exercise gzip normalization on an actual TLS request and Git backend.
    // This is raw-socket compatibility evidence, not a claim that this small
    // ordinary Git clone triggers the client's automatic compression threshold.
    let ls_refs = b"0014command=ls-refs\n0017object-format=sha1\n00010009peel\n000csymrefs\n0000";
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut encoder, ls_refs).unwrap();
    let compressed = encoder.finish().unwrap();
    let mut wire = format!("POST /fixture/repo.git/git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nContent-Type: application/x-git-upload-pack-request\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", compressed.len()).into_bytes();
    wire.extend_from_slice(&compressed);
    let response = raw_request(address, incoming_trust.clone(), &wire).await;
    assert!(response.starts_with(b"HTTP/1.1 200"));
    let normalized_hash = broker_rpc::sha256(ls_refs);
    assert!(records
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "open-read"
            && r["body_sha256"] == normalized_hash
            && r["body_bytes"] == ls_refs.len()));
    assert!(upstream_records
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["body_sha256"] == normalized_hash && r["body_bytes"] == ls_refs.len()));
    success(
        &git,
        &[
            "clone",
            "--no-recurse-submodules",
            "https://github.com/fixture/repo.git",
            checkout.to_str().unwrap(),
        ],
        &native,
    )
    .await;
    assert_eq!(
        success(
            &git,
            &["-C", checkout.to_str().unwrap(), "rev-parse", "HEAD"],
            &native
        )
        .await
        .trim(),
        first
    );
    assert_eq!(
        std::fs::read_to_string(checkout.join("file.txt")).unwrap(),
        "first trusted graph\n"
    );
    let initial_packs = verify_received_delta_pack(&git, &checkout, &native, &[]).await;

    // The trusted provider fixture advances its repository locally. The tested
    // client receives the second graph only through the mediated fetch path.
    std::fs::write(seed.join("file.txt"), "second trusted graph\n").unwrap();
    for index in 0..6 {
        let mut body = similar.clone();
        body.extend_from_slice(format!("\nsecond distinct blob {index}\n").as_bytes());
        std::fs::write(seed.join(format!("similar-{index}.txt")), body).unwrap();
    }
    success(&git, &["-C", seed.to_str().unwrap(), "add", "."], &base).await;
    success(
        &git,
        &[
            "-C",
            seed.to_str().unwrap(),
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-m",
            "Second fixture commit",
        ],
        &base,
    )
    .await;
    let second = success(
        &git,
        &["-C", seed.to_str().unwrap(), "rev-parse", "HEAD"],
        &base,
    )
    .await
    .trim()
    .to_owned();
    assert_ne!(first, second);
    success(
        &git,
        &[
            "--git-dir",
            bare.to_str().unwrap(),
            "fetch",
            seed.to_str().unwrap(),
            "main:main",
        ],
        &base,
    )
    .await;
    success(
        &git,
        &["-C", checkout.to_str().unwrap(), "fetch", "origin", &second],
        &native,
    )
    .await;
    success(
        &git,
        &[
            "-C",
            checkout.to_str().unwrap(),
            "checkout",
            "--detach",
            &second,
        ],
        &native,
    )
    .await;
    assert_eq!(
        success(
            &git,
            &["-C", checkout.to_str().unwrap(), "rev-parse", "HEAD"],
            &native
        )
        .await
        .trim(),
        second
    );
    assert_eq!(
        std::fs::read_to_string(checkout.join("file.txt")).unwrap(),
        "second trusted graph\n"
    );
    verify_received_delta_pack(&git, &checkout, &native, &initial_packs).await;
    // A real Git push must fail in the read-only profile before provider or
    // broker admission, even though the same client just fetched successfully.
    let prior_opens = records
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r["method"] == "open-read")
        .count();
    let prior_upstream = upstream_records.lock().unwrap().len();
    let rejected_push = command(
        &git,
        &[
            "-C",
            checkout.to_str().unwrap(),
            "push",
            "origin",
            &format!("{second}:refs/heads/blocked-write"),
        ],
        &native,
        None,
    )
    .await;
    assert!(!rejected_push.status.success());
    assert_eq!(
        records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r["method"] == "open-read")
            .count(),
        prior_opens
    );
    assert_eq!(upstream_records.lock().unwrap().len(), prior_upstream);
    let absent_ref = command(
        &git,
        &[
            "--git-dir",
            bare.to_str().unwrap(),
            "show-ref",
            "--verify",
            "refs/heads/blocked-write",
        ],
        &base,
        None,
    )
    .await;
    assert!(!absent_ref.status.success());
    let config = std::fs::read_to_string(checkout.join(".git/config")).unwrap();
    assert!(!config.contains("synthetic-git-read") && !config.contains("Authorization"));
    // The substituted provider now returns valid PACKs containing the protected
    // canary. Validate both with the pinned Git before testing native rejection.
    let hashed = command(
        &git,
        &["-C", seed.to_str().unwrap(), "hash-object", "-w", "--stdin"],
        &base,
        Some(SYNTHETIC_TOKEN.to_vec()),
    )
    .await;
    assert!(hashed.status.success());
    let token_oid = String::from_utf8(hashed.stdout).unwrap().trim().to_owned();
    let packed = command(
        &git,
        &[
            "-C",
            seed.to_str().unwrap(),
            "pack-objects",
            "--stdout",
            "--no-reuse-object",
            "--no-reuse-delta",
        ],
        &base,
        Some(format!("{token_oid}\n").into_bytes()),
    )
    .await;
    assert!(packed.status.success());
    let packs = [packed.stdout, reference_delta_canary_pack()];
    let mut fault_refs = Vec::new();
    for (index, pack) in packs.into_iter().enumerate() {
        assert!(pack.starts_with(b"PACK"));
        assert!(!pack
            .windows(SYNTHETIC_TOKEN.len())
            .any(|w| w == SYNTHETIC_TOKEN));
        let validation = home.join(format!("canary-validation-{index}.git"));
        success(
            &git,
            &[
                "-c",
                "init.templateDir=",
                "init",
                "--bare",
                validation.to_str().unwrap(),
            ],
            &base,
        )
        .await;
        let indexed = command(
            &git,
            &[
                "--git-dir",
                validation.to_str().unwrap(),
                "index-pack",
                "--stdin",
            ],
            &base,
            Some(pack.clone()),
        )
        .await;
        assert!(
            indexed.status.success(),
            "pinned Git rejected generated canary PACK: {}",
            String::from_utf8_lossy(&indexed.stderr)
        );
        let reconstructed = command(
            &git,
            &[
                "--git-dir",
                validation.to_str().unwrap(),
                "cat-file",
                "blob",
                &token_oid,
            ],
            &base,
            None,
        )
        .await;
        assert!(reconstructed.status.success());
        assert_eq!(reconstructed.stdout, SYNTHETIC_TOKEN);
        let provider_body = framed_pack(&pack);
        assert!(!provider_body
            .windows(SYNTHETIC_TOKEN.len())
            .any(|w| w == SYNTHETIC_TOKEN));
        *provider_fault_body.lock().unwrap() = Some(provider_body);
        let mut fetch = git_packet(b"command=fetch\n");
        fetch.extend(git_packet(b"object-format=sha1\n"));
        fetch.extend_from_slice(b"0001");
        fetch.extend(git_packet(format!("want {second}\n").as_bytes()));
        fetch.extend(git_packet(b"done\n"));
        fetch.extend_from_slice(b"0000");
        let prior = records.lock().unwrap().len();
        let mut wire = format!("POST /fixture/repo.git/git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nContent-Type: application/x-git-upload-pack-request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", fetch.len()).into_bytes();
        wire.extend(fetch);
        let response = raw_request(address, incoming_trust.clone(), &wire).await;
        assert!(
            !response.starts_with(b"HTTP/1.1 200"),
            "compressed/reconstructed token PACK {index} must be suppressed"
        );
        assert!(!response
            .windows(SYNTHETIC_TOKEN.len())
            .any(|w| w == SYNTHETIC_TOKEN));
        assert!(
            provider_fault_body.lock().unwrap().is_none(),
            "fault response must reach the real upstream TLS exchange"
        );
        let records = records.lock().unwrap();
        let opened = records[prior..]
            .iter()
            .find(|r| r["method"] == "open-read")
            .unwrap();
        fault_refs.push(opened["request_ref"].clone());
    }
    shutdown.send(true).unwrap();
    for task in tasks {
        timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
    }
    std::fs::remove_file(socket_path).unwrap();
    let records = records.lock().unwrap();
    let received = upstream_records.lock().unwrap();
    let opened: Vec<_> = records
        .iter()
        .filter(|r| r["method"] == "open-read")
        .collect();
    assert!(
        opened
            .iter()
            .filter(|r| r["git_operation"] == "discovery")
            .count()
            >= 2
    );
    assert!(
        opened
            .iter()
            .filter(|r| r["git_operation"] == "upload-pack")
            .count()
            >= 2
    );
    assert_eq!(opened.len(), received.len());
    for request in &opened {
        let reference = &request["request_ref"];
        let round: Vec<_> = records
            .iter()
            .filter(|r| &r["request_ref"] == reference)
            .collect();
        assert_eq!(
            round
                .iter()
                .filter(|r| r["method"] == "dispatch-read")
                .count(),
            1
        );
        assert_eq!(
            round.last().unwrap()["outcome"],
            if fault_refs.contains(reference) {
                "unknown"
            } else {
                "completed"
            }
        );
        assert!(received
            .iter()
            .any(|r| r["request_sha256"] == request["request_sha256"]
                && r["body_sha256"] == request["body_sha256"]
                && r["body_bytes"] == request["body_bytes"]));
    }
    assert!(received
        .iter()
        .all(|r| !r["target"].as_str().unwrap().contains("receive-pack")));
    assert_eq!(
        outcomes
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.is_ok())
            .count(),
        opened.len() - fault_refs.len()
    );
    // Retain only the small synthetic Git graph and CA as private test evidence.
}

fn isolated_broker_config(path: PathBuf, tls: Arc<ClientConfig>, uid: u32) -> BrokerConfig {
    BrokerConfig {
        socket_path: path,
        peer_uid: uid,
        trusted_ancestor_uids: vec![std::fs::metadata("/").unwrap().uid()],
        server_name: ServerName::try_from("git-broker.test").unwrap(),
        tls,
        call_timeout: Duration::from_secs(1),
        check_interval: Duration::from_millis(100),
        max_clock_skew: Duration::from_millis(50),
    }
}

#[tokio::test]
async fn actual_git_broker_sessions_reject_metadata_version_and_cannot_retry() {
    // This exercises Session over authenticated UDS, with substituted reply
    // bytes. It does not fabricate an OCC operation or prove upstream identity.
    let scratch = PathBuf::from(
        std::env::var_os("OCE_MEDIATION_TEST_SCRATCH")
            .or_else(|| std::env::var_os("HOME"))
            .expect("protected test scratch"),
    );
    for wrong_version_at in [1, 2, 3] {
        let directory = scratch.join(format!("git-version-{}", broker_rpc::random_ref().unwrap()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let path = directory.join("broker.sock");
        let uid = std::fs::metadata(&directory).unwrap().uid();
        let (server, trust, _) = tls_pair("git-broker.test", true);
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let config = isolated_broker_config(path.clone(), trust, uid);
        let records = Arc::new(Mutex::new(Vec::new()));
        let seen = records.clone();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            broker_connection(socket, server, seen, uid, Some(wrong_version_at), None).await;
        });
        let empty = broker_rpc::sha256(b"");
        let digest = canonical_digest("discovery", &empty, 0);
        let opened = Session::open_git_read(
            &config,
            "original-git-read-attachment",
            "fixture",
            "repo",
            &digest,
            Instant::now() + Duration::from_secs(3),
            "discovery",
            0,
            &empty,
        )
        .await;
        if wrong_version_at == 1 {
            assert!(matches!(opened, Err(Refusal::Protocol)));
        } else {
            let mut session = opened.unwrap();
            let peer_hash = broker_rpc::sha256(b"substituted-peer-certificate-digest");
            let dispatched = session.dispatch(&peer_hash).await;
            if wrong_version_at == 2 {
                assert!(matches!(dispatched, Err(Refusal::Protocol)));
            } else {
                drop(dispatched.unwrap());
                assert_eq!(session.check().await, Err(Refusal::Protocol));
            }
            // All later operations remain poisoned: no release retry, renewal,
            // completion write, reconnect, or second session is available.
            assert!(session.current().is_err());
            assert!(session.dispatch(&peer_hash).await.is_err());
            assert!(session.check().await.is_err());
            assert!(session
                .complete("unknown", Instant::now() + Duration::from_secs(1))
                .await
                .is_err());
            drop(session);
        }
        timeout(Duration::from_secs(2), peer)
            .await
            .unwrap()
            .unwrap();
        let records = records.lock().unwrap();
        assert_eq!(records.len(), wrong_version_at as usize);
        assert!(records.iter().all(|r| r["version"] == 3));
        assert_eq!(
            records
                .iter()
                .filter(|r| r["method"] == "dispatch-read")
                .count(),
            usize::from(wrong_version_at > 1)
        );
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}

#[test]
fn metadata_and_git_constructors_reject_each_others_broker_alpn() {
    let home = PathBuf::from(std::env::var_os("HOME").expect("test HOME"));
    let uid = std::fs::metadata(&home).unwrap().uid();
    let (incoming, _, _) = tls_pair(GIT_HOST, false);
    let (_, upstream, _) = tls_pair(GIT_HOST, false);
    let (_, git_trust, _) = tls_pair("git-broker.test", true);
    let mut metadata_trust = (*git_trust).clone();
    metadata_trust.alpn_protocols = vec![broker_rpc::ALPN.to_vec()];
    let metadata_config = isolated_broker_config(
        home.join("unused-metadata.sock"),
        Arc::new(metadata_trust),
        uid,
    );
    let git_config = isolated_broker_config(home.join("unused-git.sock"), git_trust, uid);
    let limits = Limits {
        header_bytes: 16384,
        header_count: 64,
        request_bytes: 4_194_304,
        response_bytes: 1024 * 1024,
        exchange_timeout: Duration::from_secs(5),
    };
    assert!(matches!(
        Mediator::new_git_read(
            Repository::new("fixture", "repo", &"a".repeat(40)).unwrap(),
            incoming.clone(),
            upstream.clone(),
            metadata_config,
            limits,
            1
        ),
        Err(Refusal::Configuration)
    ));
    assert!(matches!(
        Mediator::new(
            Repository::new("fixture", "repo", &"a".repeat(40)).unwrap(),
            incoming,
            upstream,
            git_config,
            limits,
            1
        ),
        Err(Refusal::Configuration)
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn original_lease_cancels_actual_delta_worker_before_terminal_receipt() {
    use crate::git_pack::test_control::Control;

    let control = Control::new();
    struct ReleaseOnDrop(Arc<Control>);
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            self.0.release();
        }
    }
    let _release_on_panic = ReleaseOnDrop(control.clone());
    let scratch = PathBuf::from(
        std::env::var_os("OCE_MEDIATION_TEST_SCRATCH")
            .or_else(|| std::env::var_os("HOME"))
            .expect("protected test scratch"),
    );
    let directory = scratch.join(format!("git-cancel-{}", broker_rpc::random_ref().unwrap()));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .unwrap();
    let socket_path = directory.join("broker.sock");
    let uid = std::fs::metadata(&directory).unwrap().uid();
    let (broker_tls, broker_trust, _) = tls_pair("git-broker.test", true);
    let (incoming, incoming_trust, _) = tls_pair(GIT_HOST, false);
    let (upstream_tls, upstream_trust, _) = tls_pair(GIT_HOST, false);
    let broker_listener = UnixListener::bind(&socket_path).unwrap();
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let records = Arc::new(Mutex::new(Vec::new()));
    let seen = records.clone();
    let broker_control = control.clone();
    let broker = tokio::spawn(async move {
        let (socket, _) = broker_listener.accept().await.unwrap();
        broker_connection(socket, broker_tls, seen, uid, None, Some(broker_control)).await;
    });
    let mut fetch = git_packet(b"command=fetch\n");
    fetch.extend(git_packet(b"object-format=sha1\n"));
    fetch.extend_from_slice(b"0001");
    fetch.extend(git_packet(format!("want {}\n", "a".repeat(40)).as_bytes()));
    fetch.extend(git_packet(b"done\n"));
    fetch.extend_from_slice(b"0000");
    let expected_fetch = fetch.clone();
    let response_body = framed_pack(&reference_delta_canary_pack());
    let upstream_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let SocketAddr::V4(endpoint) = upstream_listener.local_addr().unwrap() else {
        unreachable!()
    };
    let upstream = tokio::spawn(async move {
        let (socket, _) = upstream_listener.accept().await.unwrap();
        let tls = TlsAcceptor::from(upstream_tls)
            .accept(socket)
            .await
            .unwrap();
        let handler = service_fn(move |request: Request<Incoming>| {
            let expected = expected_fetch.clone();
            let body = response_body.clone();
            async move {
                assert_eq!(request.uri().path(), "/fixture/repo.git/git-upload-pack");
                assert_eq!(request.headers()[header::AUTHORIZATION], PROTECTED_AUTH);
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
                        .header(header::CONTENT_TYPE, "application/x-git-upload-pack-result")
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
    let mut config = isolated_broker_config(socket_path.clone(), broker_trust, uid);
    config.check_interval = Duration::from_millis(250);
    config.max_clock_skew = Duration::from_millis(10);
    let limits = Limits {
        header_bytes: 16384,
        header_count: 64,
        request_bytes: 4_194_304,
        response_bytes: 2 * 1024 * 1024,
        exchange_timeout: Duration::from_secs(5),
    };
    let mut mediator = Mediator::new_git_read(
        Repository::new("fixture", "repo", &"a".repeat(40)).unwrap(),
        incoming,
        upstream_trust,
        config,
        limits,
        1,
    )
    .unwrap();
    mediator.test_endpoint = Some(endpoint);
    mediator.test_pack_control = Some(control.clone());
    let incoming_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let address = incoming_listener.local_addr().unwrap();
    let mut serving = tokio::spawn(async move {
        let (socket, _) = incoming_listener.accept().await.unwrap();
        mediator.serve(socket, "original-git-read-attachment").await
    });
    let mut wire = format!("POST /fixture/repo.git/git-upload-pack HTTP/1.1\r\nHost: github.com\r\nGit-Protocol: version=2\r\nContent-Type: application/x-git-upload-pack-request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", fetch.len()).into_bytes();
    wire.extend(fetch);
    let client = tokio::spawn(async move { raw_request(address, incoming_trust, &wire).await });

    // The test gate sits after a real delta-copy operation, not before worker
    // scheduling. The actual broker lease now drives the product watchdog.
    timeout(Duration::from_secs(2), control.wait_entered())
        .await
        .unwrap();
    assert!(control.is_entered());
    timeout(Duration::from_secs(2), control.wait_cancelled())
        .await
        .unwrap();
    assert!(control.is_cancelled());
    assert!(!control.is_released());
    assert!(!control.is_finished());
    assert!(
        !serving.is_finished(),
        "serve must retain and join the cancelled PACK worker"
    );
    assert!(
        timeout(Duration::from_millis(100), &mut serving)
            .await
            .is_err(),
        "serve must remain unsettled while its cancelled PACK worker is gated"
    );
    assert!(!records
        .lock()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "complete-read"));

    control.release();
    assert_eq!(
        timeout(Duration::from_secs(2), serving)
            .await
            .unwrap()
            .unwrap(),
        Err(Refusal::Deadline)
    );
    assert!(control.is_finished());
    let response = timeout(Duration::from_secs(2), client)
        .await
        .unwrap()
        .unwrap();
    assert!(
        response.is_empty(),
        "watchdog cancellation must close incoming TLS without guest HTTP bytes"
    );
    timeout(Duration::from_secs(2), upstream)
        .await
        .unwrap()
        .unwrap();
    timeout(Duration::from_secs(2), broker)
        .await
        .unwrap()
        .unwrap();
    let records = records.lock().unwrap();
    assert_eq!(
        records
            .iter()
            .filter(|r| r["method"] == "dispatch-read")
            .count(),
        1
    );
    assert!(records.iter().any(|r| r["method"] == "check-read"));
    assert_eq!(records.last().unwrap()["method"], "complete-read");
    assert_eq!(records.last().unwrap()["outcome"], "unknown");
    assert_eq!(
        records.last().unwrap()["release_ref"],
        "fixture-git-release"
    );
    std::fs::remove_file(socket_path).unwrap();
    std::fs::remove_dir(directory).unwrap();
}

#[path = "../git_read_listener_tests.rs"]
mod listener_tests;
