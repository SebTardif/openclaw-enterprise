// Modified for OpenClaw Enterprise.
//! These tests exercise the real DNS resolver, address scrub and framed RPC
//! parser. They do not establish canonical OCE authority or kernel enforcement;
//! those require the actual authority service and disposable namespace suite.
#![allow(dead_code)]
#[path = "../src/oce/mod.rs"]
mod oce;
use ds_dnsgate::{
    handler::{ForwarderConfig, LiveReResolver},
    reresolve::{ReResolveResolved, ReResolver},
};
use hickory_proto::{
    op::{Message, MessageType},
    rr::{
        rdata::{A, CNAME},
        Name, RData, Record, RecordType,
    },
};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::net::UdpSocket;

fn operation() -> serde_json::Value {
    serde_json::json!({"method":"resolve","version":1,"operation_id":"op-server-owned","reservation_ref":"11".repeat(32),"request_sha256":"22".repeat(32),"assignment_id":"00000000-0000-0000-0000-000000000001","authority_instance_ref":"00000000-0000-0000-0000-000000000002","provider_binding_ref":"provider-a","credential_binding":{"provider_binding_ref":"provider-a","service_account_id":"account-a","credential_profile_ref":"credential-a","provider_profile_ref":"profile-a","audience_ref":"audience-a","transport_profile_ref":"transport-a"},"generation":1,"policy_version":1,"recipient":{"scheme":"https","host":"api.openai.com","port":443},"protocol":"tcp"})
}

#[test]
fn strict_rpc_rejects_duplicates_and_unknown_fields() {
    let valid = serde_json::to_string(&operation()).unwrap();
    assert!(serde_json::from_str::<oce::protocol::Request>(&valid).is_ok());
    let duplicate = valid.replacen('{', "{\"version\":1,", 1);
    assert!(serde_json::from_str::<oce::protocol::Request>(&duplicate).is_err());
    let nested = valid.replace("\"port\":443", "\"port\":443,\"port\":444");
    assert!(serde_json::from_str::<oce::protocol::Request>(&nested).is_err());
    let mut unknown = operation();
    unknown["unverified_allow"] = true.into();
    assert!(serde_json::from_value::<oce::protocol::Request>(unknown).is_err());
}

#[tokio::test]
async fn actual_framed_receiver_rejects_oversized_prefix() {
    use tokio::io::AsyncWriteExt;
    let (mut writer, mut reader) = tokio::net::UnixStream::pair().unwrap();
    writer.write_u32(65_537).await.unwrap();
    assert!(
        oce::protocol::read_frame::<oce::protocol::Request>(&mut reader)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn actual_framed_roundtrip_keeps_exact_fixed_recipient() {
    let (mut writer, mut reader) = tokio::net::UnixStream::pair().unwrap();
    oce::protocol::write_frame(&mut writer, &operation())
        .await
        .unwrap();
    let request: oce::protocol::Request = oce::protocol::read_frame(&mut reader).await.unwrap();
    match request {
        oce::protocol::Request::Resolve {
            recipient,
            generation,
            ..
        } => {
            assert!(recipient.fixed());
            assert_eq!(generation, 1);
        }
        _ => panic!("unexpected method"),
    }
}

async fn resolver_fixture(
    addresses: Vec<Ipv4Addr>,
) -> (Arc<LiveReResolver>, tokio::task::JoinHandle<()>) {
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let upstream = socket.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut bytes = [0u8; 2048];
        loop {
            let (length, peer) = socket.recv_from(&mut bytes).await.unwrap();
            let request = Message::from_vec(&bytes[..length]).unwrap();
            let query = request.queries.first().unwrap().clone();
            assert_eq!(query.query_type(), RecordType::A);
            let mut response = Message::query();
            response.metadata.id = request.metadata.id;
            response.metadata.message_type = MessageType::Response;
            response.metadata.recursion_available = true;
            response.add_query(query.clone());
            // Real CNAME following must retain the original recipient. The
            // upstream can only influence terminal addresses, never its authority.
            let target = Name::from_ascii("provider-cdn.example.").unwrap();
            if query.name() == &Name::from_ascii("api.openai.com.").unwrap() {
                response.add_answer(Record::from_rdata(
                    query.name().clone(),
                    7,
                    RData::CNAME(CNAME(target.clone())),
                ));
            }
            for ip in &addresses {
                response.add_answer(Record::from_rdata(target.clone(), 30, RData::A(A(*ip))));
            }
            socket
                .send_to(&response.to_vec().unwrap(), peer)
                .await
                .unwrap();
        }
    });
    (
        Arc::new(LiveReResolver::new(&ForwarderConfig {
            upstreams: vec![upstream],
            timeout: Duration::from_millis(500),
        })),
        task,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_resolver_follows_cname_and_keeps_chain_minimum_ttl() {
    let (resolver, task) = resolver_fixture(vec![Ipv4Addr::new(8, 8, 8, 8)]).await;
    let resolved = tokio::task::spawn_blocking(move || resolver.resolve("api.openai.com."))
        .await
        .unwrap();
    let (ip, ttl) = oce::select_answer(resolved).unwrap();
    assert_eq!(ip, Ipv4Addr::new(8, 8, 8, 8));
    assert_eq!(ttl, 7);
    task.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cname_to_private_or_mixed_answer_is_denied() {
    for addresses in [
        vec![Ipv4Addr::new(10, 0, 0, 1)],
        vec![Ipv4Addr::new(8, 8, 8, 8), Ipv4Addr::new(127, 0, 0, 1)],
    ] {
        let (resolver, task) = resolver_fixture(addresses).await;
        let resolved = tokio::task::spawn_blocking(move || resolver.resolve("api.openai.com."))
            .await
            .unwrap();
        assert!(oce::select_answer(resolved).is_err());
        task.abort();
    }
}

#[test]
fn unsupported_address_family_and_zero_ttl_have_no_admission() {
    for (address, ttl) in [
        ("::ffff:8.8.8.8", 20),
        ("2606:4700:4700::1111", 20),
        ("8.8.8.8", 0),
    ] {
        assert!(oce::select_answer(ReResolveResolved::Resolved {
            terminal_addrs: vec![address.parse().unwrap()],
            chain_min_ttl: ttl
        })
        .is_err());
    }
}

#[test]
fn actual_policy_core_fixed_origin_ceiling_defaults_to_deny() {
    use ds_dnsgate::policy::{DnsQueryCtx, PolicyCorePolicy, PolicyHook, Verdict};
    let layer = ds_contracts::pol1::parse_layer("schema_version: pol1/v0\nlayer: org\nposture: standard\nallowlist:\n  - domain: api.openai.com\n").unwrap();
    let policy = PolicyCorePolicy::new(policy_core::pol1_eval::compose(&[layer], &[]));
    let query = |host: &str| DnsQueryCtx {
        session: "assignment-a".into(),
        qname: host.into(),
        qtype: 1,
        source: "127.0.0.1:0".parse::<SocketAddr>().unwrap(),
    };
    assert!(matches!(
        policy.evaluate(&query("api.openai.com.")),
        Verdict::Allow { .. }
    ));
    assert!(!matches!(
        policy.evaluate(&query("unselected.example.")),
        Verdict::Allow { .. }
    ));
}

#[test]
fn authority_schema_binds_incarnation_credential_and_immutable_ceilings() {
    // These are protocol-consumer checks only. A JSON receipt is not proof of
    // canonical IDN, IAM, turn ownership, or actual authority implementation.
    let mut request = operation();
    request.as_object_mut().unwrap().remove("method");
    request.as_object_mut().unwrap().remove("version");
    let op: oce::protocol::Operation = serde_json::from_value(request).unwrap();
    assert!(op.valid());
    let good = serde_json::json!({"version":1,"ok":true,"authority_profile":"oce-delegated-model-v1","authority_instance_ref":op.authority_instance_ref,"authority_evidence_ref":"00000000-0000-0000-0000-000000000003","operation_id":op.operation_id,"reservation_ref":op.reservation_ref,"request_sha256":op.request_sha256,"assignment_id":op.assignment_id,"generation":op.generation,"policy_version":op.policy_version,"provider_binding_ref":op.provider_binding_ref,"credential_binding":op.credential_binding,"operation_state":"accepted","server_time_ms":1000,"valid_until_ms":2000,"dispatch_before_ms":3000,"operation_expires_at_ms":10000});
    let parsed: oce::protocol::AuthorityResponse = serde_json::from_value(good.clone()).unwrap();
    assert!(parsed.duration().is_ok());
    assert!(parsed.matches(&op));
    for (field, replacement) in [
        (
            "authority_instance_ref",
            "00000000-0000-0000-0000-000000000004",
        ),
        ("request_sha256", &"33".repeat(32)),
        ("provider_binding_ref", "other-provider"),
    ] {
        let mut changed = good.clone();
        changed[field] = replacement.into();
        let parsed: oce::protocol::AuthorityResponse = serde_json::from_value(changed).unwrap();
        assert!(!parsed.matches(&op));
    }
    let mut too_late = good.clone();
    too_late["valid_until_ms"] = 4000.into();
    let parsed: oce::protocol::AuthorityResponse =
        serde_json::from_value(too_late.clone()).unwrap();
    assert!(
        !parsed.matches(&op),
        "accepted reservations cannot slide past dispatch-before"
    );
    too_late["operation_state"] = "dispatched".into();
    let parsed: oce::protocol::AuthorityResponse = serde_json::from_value(too_late).unwrap();
    assert!(
        parsed.matches(&op),
        "an established operation uses its immutable operation ceiling"
    );
}

#[tokio::test]
async fn actual_authority_client_rejects_wrong_producer_uid_before_sending_operation() {
    use tokio::io::AsyncReadExt;
    assert_ne!(
        unsafe { libc::geteuid() },
        10003,
        "this negative transport test requires a nonauthority test runner"
    );
    let path = std::env::temp_dir().join(format!("oce-authority-role-{}.sock", std::process::id()));
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    let peer = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut byte = [0u8; 1];
        assert_eq!(
            stream.read(&mut byte).await.unwrap(),
            0,
            "wrong producer must receive no operation frame"
        );
    });
    assert!(oce::protocol::authority(&path, None).await.is_err());
    peer.await.unwrap();
    std::fs::remove_file(path).unwrap();
}
