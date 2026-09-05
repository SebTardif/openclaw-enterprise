// Modified for OpenClaw Enterprise.
//! Real DNS producer → admission stores → snapshot sweep. Named SHM is the actual
//! storage adapter; NFT observations are recording-only and are not kernel proof.
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::Duration;

use ds_contracts::dns_admission::{AdmissionKey, AdmissionMap, AdmissionType, Instant, Provenance};
use ds_contracts::pol1::parse_layer;
use ds_dnsgate::handler::ForwarderConfig;
use ds_dnsgate::policy::{PolicyCorePolicy, TtlClamp};
use ds_dnsgate::server::{
    spawn_gate_with_stores, BoundarySnapshot, LiveAdmissions, RecordingSweepEnforcer,
    SnapshotCommitSink, SnapshotSink,
};
use ds_dnsgate::txn::{AdmissionInputs, AdmissionOutcome, AdmissionStores, RecordingSetProgrammer};
use ds_dnsgate::{CapturingSink, GateConfig};
use hickory_proto::op::{Message, MessageType, Query, ResponseCode};
use hickory_proto::rr::rdata::A;
use hickory_proto::rr::{Name, RData, Record, RecordType};
use policy_core::pol1_eval::{compose, ComposedPolicy};
use tokio::net::UdpSocket;

fn policy(revoked: bool) -> ComposedPolicy {
    let rules = if revoked {
        "allowlist:\n  - domain: sibling.example\n  - domain: other.example\nblocklist:\n  - domain: revoked.example\n    reason: revoked\n    rung: block+log\n"
    } else {
        "allowlist:\n  - domain: revoked.example\n  - domain: sibling.example\n  - domain: other.example\n"
    };
    compose(
        &[parse_layer(&format!(
            "schema_version: pol1/v0\nlayer: session\nposture: standard\n{rules}"
        ))
        .unwrap()],
        &[],
    )
}
fn key(session: &str, domain: &str) -> AdmissionKey {
    AdmissionKey {
        session_uuid: session.into(),
        original_query_fqdn: domain.into(),
    }
}
async fn query(address: std::net::SocketAddr, domain: &str) -> Message {
    let mut request = Message::query();
    request.metadata.recursion_desired = true;
    request.add_query(Query::query(
        Name::from_ascii(domain).unwrap(),
        RecordType::A,
    ));
    let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    socket
        .send_to(&request.to_vec().unwrap(), address)
        .await
        .unwrap();
    let mut bytes = [0; 4096];
    let size = tokio::time::timeout(Duration::from_secs(5), socket.recv(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    Message::from_vec(&bytes[..size]).unwrap()
}
async fn exercise<M>(stores: AdmissionStores<M, RecordingSetProgrammer>)
where
    M: AdmissionMap + Send + Sync + 'static,
{
    // This upstream controls DNS data only. The gate chooses the actual policy,
    // storage keys, session scope, transaction, and subsequent revocation.
    let upstream = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let task = tokio::spawn(async move {
        loop {
            let mut bytes = [0; 4096];
            let (size, peer) = upstream.recv_from(&mut bytes).await.unwrap();
            let request = Message::from_vec(&bytes[..size]).unwrap();
            let q = &request.queries[0];
            let mut response = Message::query();
            response.metadata = request.metadata;
            response.metadata.message_type = MessageType::Response;
            response.metadata.recursion_available = true;
            response.add_query(q.clone());
            if q.query_type() == RecordType::A {
                let addresses = if q
                    .name()
                    .to_string()
                    .eq_ignore_ascii_case("revoked.example.")
                {
                    vec![Ipv4Addr::new(8, 8, 8, 8), Ipv4Addr::new(9, 9, 9, 9)]
                } else {
                    vec![Ipv4Addr::new(9, 9, 9, 9)]
                };
                for ip in addresses {
                    response.add_answer(Record::from_rdata(q.name().clone(), 120, RData::A(A(ip))));
                }
            }
            upstream
                .send_to(&response.to_vec().unwrap(), peer)
                .await
                .unwrap();
        }
    });
    let policy = PolicyCorePolicy::new(policy(false));
    let gate = spawn_gate_with_stores(
        policy.clone(),
        GateConfig {
            fixed_session_uuid: Some("session-a".into()),
            forwarder: ForwarderConfig {
                upstreams: vec![upstream_addr],
                timeout: Duration::from_secs(5),
            },
            ..GateConfig::default()
        },
        stores.clone(),
        Arc::new(CapturingSink::new()),
    )
    .await
    .unwrap();
    for domain in ["ReVoKeD.ExAmPlE.", "sibling.example"] {
        let response = query(gate.udp_local_addr(), domain).await;
        assert_eq!(response.metadata.response_code, ResponseCode::NoError);
    }
    // Distinct session/mark ownership of the same destination must survive the
    // first session's sole-owned address withdrawal.
    assert!(matches!(
        stores.run_admission(
            &AdmissionInputs {
                session_uuid: "session-b".into(),
                session_index: 19,
                original_query_fqdn: "OtHeR.ExAmPlE.".into(),
                terminal_addrs: vec!["8.8.8.8".parse::<IpAddr>().unwrap()],
                chain_min_ttl: 120,
                ttl_floor: 1,
                ttl_ceil: 900,
                grace: 0,
                provenance: Provenance {
                    rule_id: "other".into(),
                    policy_layer: "session".into(),
                    policy_version: "before".into()
                },
                admission_type: AdmissionType::Normal,
                real_targets: vec![],
            },
            Instant::from_unix_nanos(2_000_000_000_000_000_000)
        ),
        AdmissionOutcome::Admitted { .. }
    ));
    let actual_index = stores
        .live()
        .snapshot()
        .iter()
        .find(|record| record.session == "session-a")
        .unwrap()
        .host_session_index;
    let sibling = stores.lookup(&key("session-a", "sibling.example")).unwrap();
    let other = stores.lookup(&key("session-b", "other.example")).unwrap();
    let enforcement = Arc::new(RecordingSweepEnforcer::new());
    let sink = SnapshotCommitSink::with_revocation_sweep_enforced(
        gate.boundary_zone_reloader(),
        gate.policy_reloader(),
        stores.live().clone(),
        policy,
        enforcement.clone(),
    );
    sink.commit_snapshot(&BoundarySnapshot::with_policy(
        2,
        "boundary",
        self::policy(true),
        TtlClamp {
            floor: 1,
            ceil: 900,
        },
    ));
    for domain in ["revoked.example", "REVOKED.EXAMPLE."] {
        assert!(stores.lookup(&key("session-a", domain)).is_none());
    }
    assert_eq!(
        stores.lookup(&key("session-a", "sibling.example")),
        Some(sibling)
    );
    assert_eq!(
        stores.lookup(&key("session-b", "other.example")),
        Some(other)
    );
    assert_eq!(stores.live().len(), 2);
    let withdrawals = enforcement.withdrawn();
    assert_eq!(withdrawals.len(), 1);
    assert_eq!(withdrawals[0].session, "session-a");
    assert_eq!(withdrawals[0].set_name, format!("allow4_{actual_index}"));
    assert_eq!(withdrawals[0].dst_key.address_literal(), "8.8.8.8");
    gate.shutdown().await.unwrap();
    task.abort();
    let _ = task.await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handler_sweep_uses_canonical_memory_keys_and_exact_session_ownership() {
    exercise(AdmissionStores::default()).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handler_sweep_uses_canonical_named_shm_keys_and_exact_session_ownership() {
    let name = format!(
        "/ds-dns-canonical-sweep-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let stores = AdmissionStores::with_shm_writer(
        &name,
        Arc::new(RecordingSetProgrammer::new()),
        LiveAdmissions::new(),
    )
    .unwrap();
    exercise(stores).await;
    ds_admission_shm::ShmAdmissionMap::unlink(&name).unwrap();
}
