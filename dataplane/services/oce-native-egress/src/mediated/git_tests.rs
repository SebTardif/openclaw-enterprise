//! Explicit real Git compatibility through the Rust mediated read transport.
//! Broker and GitHub are substituted at real UDS/mTLS and TLS/HTTP boundaries.
//! This fixture proves no OCC authorization, custody, or production composition.
use super::*;
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use rustls_pki_types::{PrivateKeyDer, ServerName};
use serde_json::Value;
use std::{
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::PathBuf,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UnixListener},
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

#[path = "../git_read_listener_tests.rs"]
mod listener_tests;
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
