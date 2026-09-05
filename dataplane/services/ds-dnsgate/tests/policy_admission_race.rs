// Modified for OpenClaw Enterprise.
//! Real gate/LiveReResolver policy reload races against a paused loopback DNS upstream.
//! Uses the actual snapshot sink, evaluator, in-memory admission map and recording
//! NFT programmer. It does not claim live kernel or production transport proof.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use ds_contracts::dns_admission::AdmissionKey;
use ds_contracts::pol1::parse_layer;
use ds_dnsgate::handler::{ForwarderConfig, LiveReResolver};
use ds_dnsgate::policy::{PolicyCorePolicy, TtlClamp};
use ds_dnsgate::reresolve::{
    AdmissionReResolver, ReResolveRequest, ReResolveResponse, ReResolveSeam,
};
use ds_dnsgate::server::{
    spawn_gate_with_stores, BoundarySnapshot, LiveAdmissions, SnapshotCommitSink, SnapshotSink,
};
use ds_dnsgate::txn::{AdmissionStores, RecordingSetProgrammer};
use ds_dnsgate::{CapturingSink, GateConfig};
use hickory_proto::op::{Message, MessageType, Query, ResponseCode};
use hickory_proto::rr::rdata::A;
use hickory_proto::rr::{Name, RData, Record, RecordType};
use policy_core::pol1_eval::{compose, ComposedPolicy};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::oneshot;

const DOMAIN: &str = "race.example";
const ALLOW: &str = "allowlist:\n  - domain: race.example\n";
const DENY: &str =
    "blocklist:\n  - domain: race.example\n    reason: revoked\n    rung: block+log\n";
const ASK: &str = "";

fn composed(rules: &str, version: &str) -> ComposedPolicy {
    let doc = format!("schema_version: pol1/v0\nlayer: session\nposture: standard\n{rules}");
    let mut policy = compose(&[parse_layer(&doc).unwrap()], &[]);
    policy.policy_version = version.into();
    policy
}

// The test controls only DNS timing/data; policy decisions and admission writes
// remain the real components. Receipt proves initial Allow has already happened.
async fn paused_upstream() -> (
    ForwarderConfig,
    oneshot::Receiver<()>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let config = ForwarderConfig {
        upstreams: vec![socket.local_addr().unwrap()],
        timeout: Duration::from_secs(5),
    };
    let (received, ready) = oneshot::channel();
    let (release, resume) = oneshot::channel();
    let task = tokio::spawn(async move {
        let mut bytes = [0; 4096];
        let (n, peer) = socket.recv_from(&mut bytes).await.unwrap();
        let query = Message::from_vec(&bytes[..n]).unwrap();
        received.send(()).unwrap();
        resume.await.unwrap();
        let mut answer = Message::query();
        answer.metadata = query.metadata;
        answer.metadata.message_type = MessageType::Response;
        answer.metadata.recursion_available = true;
        answer.add_query(query.queries[0].clone());
        answer.add_answer(Record::from_rdata(
            Name::from_ascii(DOMAIN).unwrap(),
            300,
            RData::A(A(Ipv4Addr::new(93, 184, 216, 34))),
        ));
        socket
            .send_to(&answer.to_vec().unwrap(), peer)
            .await
            .unwrap();
    });
    (config, ready, release, task)
}

async fn query_gate(addr: SocketAddr, tcp: bool) -> Message {
    let mut request = Message::query();
    request.metadata.recursion_desired = true;
    request.add_query(Query::query(
        Name::from_ascii(DOMAIN).unwrap(),
        RecordType::A,
    ));
    let request = request.to_vec().unwrap();
    let bytes = if tcp {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream
            .write_all(&(request.len() as u16).to_be_bytes())
            .await
            .unwrap();
        stream.write_all(&request).await.unwrap();
        let size = stream.read_u16().await.unwrap();
        let mut bytes = vec![0; usize::from(size)];
        stream.read_exact(&mut bytes).await.unwrap();
        bytes
    } else {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        socket.send_to(&request, addr).await.unwrap();
        let mut bytes = vec![0; 4096];
        let n = socket.recv(&mut bytes).await.unwrap();
        bytes.truncate(n);
        bytes
    };
    Message::from_vec(&bytes).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dns_answers_use_policy_committed_while_upstream_was_pending() {
    for tcp in [false, true] {
        for (rules, rcode) in [
            (DENY, ResponseCode::NXDomain),
            (ASK, ResponseCode::Refused),
            (ALLOW, ResponseCode::NoError),
        ] {
            let (forwarder, ready, release, upstream) = paused_upstream().await;
            let policy = PolicyCorePolicy::new(composed(ALLOW, "before"));
            let set = Arc::new(RecordingSetProgrammer::new());
            let stores = AdmissionStores::with_parts(set.clone(), LiveAdmissions::new());
            let events = CapturingSink::new();
            let gate = spawn_gate_with_stores(
                policy.clone(),
                GateConfig {
                    forwarder,
                    ..GateConfig::default()
                },
                stores.clone(),
                Arc::new(events.clone()),
            )
            .await
            .unwrap();
            let sink = SnapshotCommitSink::with_revocation_sweep(
                gate.boundary_zone_reloader(),
                gate.policy_reloader(),
                stores.live().clone(),
                policy,
            );
            let address = if tcp {
                gate.tcp_local_addr()
            } else {
                gate.udp_local_addr()
            };
            let query = tokio::spawn(query_gate(address, tcp));
            tokio::time::timeout(Duration::from_secs(5), ready)
                .await
                .unwrap()
                .unwrap();
            // The completed snapshot sweep saw no admission: DNS is still pending.
            // Releasing the old resolution must not resurrect the old Allow.
            sink.commit_snapshot(&BoundarySnapshot::with_policy(
                2,
                "boundary",
                composed(rules, "after"),
                TtlClamp { floor: 7, ceil: 7 },
            ));
            assert!(stores.live().is_empty());
            release.send(()).unwrap();
            let response = tokio::time::timeout(Duration::from_secs(5), query)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                response.metadata.response_code, rcode,
                "tcp={tcp}, rules={rules}"
            );
            let event = events.events().last().unwrap().clone();
            assert_eq!(event.provenance.policy_version, "after");
            if rcode == ResponseCode::NoError {
                let key = AdmissionKey {
                    session_uuid: stores.live().snapshot()[0].session.clone(),
                    original_query_fqdn: DOMAIN.into(),
                };
                assert_eq!(response.answers.len(), 1);
                assert_eq!(response.answers[0].ttl, 7);
                let entry = stores.lookup(&key).unwrap();
                assert_eq!(entry.provenance.policy_version, "after");
                assert_eq!(
                    entry.expires_at.unix_nanos - entry.admitted_at.unix_nanos,
                    67_000_000_000
                );
                assert_eq!(set.programmed().len(), 1);
            } else {
                assert!(response.answers.is_empty());
                assert!(stores.live().is_empty());
                assert!(set.programmed().is_empty());
            }
            upstream.await.unwrap();
            gate.shutdown().await.unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reresolve_uses_policy_committed_while_real_resolver_was_pending() {
    for rules in [DENY, ASK, ALLOW] {
        let (forwarder, ready, release, upstream) = paused_upstream().await;
        let policy = PolicyCorePolicy::new(composed(ALLOW, "before"));
        let set = Arc::new(RecordingSetProgrammer::new());
        let stores = AdmissionStores::with_parts(set.clone(), LiveAdmissions::new());
        let gate = spawn_gate_with_stores(
            policy.clone(),
            GateConfig::default(),
            stores.clone(),
            Arc::new(CapturingSink::new()),
        )
        .await
        .unwrap();
        let sink = SnapshotCommitSink::with_revocation_sweep(
            gate.boundary_zone_reloader(),
            gate.policy_reloader(),
            stores.live().clone(),
            policy.clone(),
        );
        let seam = AdmissionReResolver::new(
            LiveReResolver::new(&forwarder),
            Arc::new(policy),
            stores.clone(),
            0,
        );
        let request = ReResolveRequest {
            session_uuid: "race-session".into(),
            sni_domain: DOMAIN.into(),
        };
        let key = AdmissionKey {
            session_uuid: request.session_uuid.clone(),
            original_query_fqdn: DOMAIN.into(),
        };
        // Production dispatch also runs this synchronous real resolver on a blocking
        // thread, allowing the runtime to serve DNS and commit while it waits.
        let query = tokio::task::spawn_blocking(move || seam.reresolve(&request));
        tokio::time::timeout(Duration::from_secs(5), ready)
            .await
            .unwrap()
            .unwrap();
        sink.commit_snapshot(&BoundarySnapshot::with_policy(
            2,
            "boundary",
            composed(rules, "after"),
            TtlClamp { floor: 7, ceil: 7 },
        ));
        release.send(()).unwrap();
        let response = tokio::time::timeout(Duration::from_secs(5), query)
            .await
            .unwrap()
            .unwrap();
        if rules == ALLOW {
            assert!(matches!(response, ReResolveResponse::Admitted(_)));
            let entry = stores.lookup(&key).unwrap();
            assert_eq!(entry.provenance.policy_version, "after");
            assert_eq!(
                entry.expires_at.unix_nanos - entry.admitted_at.unix_nanos,
                7_000_000_000
            );
        } else {
            assert_eq!(response, ReResolveResponse::Denied);
            assert!(stores.lookup(&key).is_none());
            assert!(stores.live().is_empty());
            assert!(set.programmed().is_empty());
        }
        upstream.await.unwrap();
        gate.shutdown().await.unwrap();
    }
}

// Only the scheduling boundary is injected: all NFT operations delegate to the
// shipped recording programmer and all policy/map/sweep behavior stays real.
struct PausedProgrammer {
    inner: RecordingSetProgrammer,
    entered: std::sync::Mutex<Option<oneshot::Sender<()>>>,
    resume: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

impl ds_dnsgate::txn::NftSetProgrammer for PausedProgrammer {
    fn program(
        &self,
        insert: &ds_dnsgate::txn::SetInsert,
    ) -> Result<(), ds_contracts::dns_admission::AdmissionError> {
        self.inner.program(insert)?;
        if let Some(entered) = self.entered.lock().unwrap().take() {
            entered.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        }
        Ok(())
    }

    fn withdraw(
        &self,
        insert: &ds_dnsgate::txn::SetInsert,
    ) -> Result<(), ds_contracts::dns_admission::AdmissionError> {
        self.inner.withdraw(insert)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_waits_for_admission_recording_then_sweeps_the_record() {
    let (forwarder, ready, release_dns, upstream) = paused_upstream().await;
    let (entered, program_entered) = oneshot::channel();
    let (release_program, resume) = std::sync::mpsc::channel();
    let set = Arc::new(PausedProgrammer {
        inner: RecordingSetProgrammer::new(),
        entered: std::sync::Mutex::new(Some(entered)),
        resume: std::sync::Mutex::new(resume),
    });
    let policy = PolicyCorePolicy::new(composed(ALLOW, "before"));
    let stores = AdmissionStores::with_parts(set, LiveAdmissions::new());
    let gate = spawn_gate_with_stores(
        policy.clone(),
        GateConfig::default(),
        stores.clone(),
        Arc::new(CapturingSink::new()),
    )
    .await
    .unwrap();
    let sink = SnapshotCommitSink::with_revocation_sweep(
        gate.boundary_zone_reloader(),
        gate.policy_reloader(),
        stores.live().clone(),
        policy.clone(),
    );
    let seam = AdmissionReResolver::new(
        LiveReResolver::new(&forwarder),
        Arc::new(policy.clone()),
        stores.clone(),
        0,
    );
    let request = ReResolveRequest {
        session_uuid: "race-session".into(),
        sni_domain: DOMAIN.into(),
    };
    let key = AdmissionKey {
        session_uuid: request.session_uuid.clone(),
        original_query_fqdn: DOMAIN.into(),
    };
    let admission = tokio::task::spawn_blocking(move || seam.reresolve(&request));
    ready.await.unwrap();
    release_dns.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), program_entered)
        .await
        .unwrap()
        .unwrap();
    // DNS and the final Allow evaluation completed, but the map/live registry have
    // not been written yet. Snapshot commit must wait for that recording boundary.
    let (started, commit_started) = oneshot::channel();
    let (committed, mut commit_done) = oneshot::channel();
    let commit = tokio::task::spawn_blocking(move || {
        started.send(()).unwrap();
        sink.commit_snapshot(&BoundarySnapshot::with_policy(
            2,
            "boundary",
            composed(DENY, "after"),
            TtlClamp::DEFAULT,
        ));
        committed.send(()).unwrap();
    });
    commit_started.await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut commit_done)
            .await
            .is_err()
    );
    assert_eq!(policy.current_policy_version(), "before");
    release_program.send(()).unwrap();
    assert!(matches!(
        admission.await.unwrap(),
        ReResolveResponse::Admitted(_)
    ));
    tokio::time::timeout(Duration::from_secs(5), commit_done)
        .await
        .unwrap()
        .unwrap();
    commit.await.unwrap();
    // The sweep must see and revoke the actual record minted before the reload.
    assert_eq!(policy.current_policy_version(), "after");
    assert!(stores.lookup(&key).is_none());
    assert!(stores.live().is_empty());
    upstream.await.unwrap();
    gate.shutdown().await.unwrap();
}
