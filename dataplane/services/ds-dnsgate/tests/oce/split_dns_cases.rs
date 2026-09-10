// Modified for OpenClaw Enterprise.
//! Finite loopback wire tests. Response fixtures exercise DNS mechanics only;
//! they do not establish authentic attachment, work, endpoint or gVisor authority.

use super::*;
use crate::{
    handler::{ForwarderConfig, LiveReResolver},
    reresolve::{ReResolveResolved, ReResolver},
};
use hickory_server::proto::op::Query;
use hickory_server::proto::rr::Name;
use source::{Fixture, FixtureState};
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
};

fn query(name: &str, kind: RecordType) -> Message {
    let mut message = Message::query();
    message.metadata.id = 42;
    message.add_query(Query::query(Name::from_ascii(name).unwrap(), kind));
    message
}

fn fixture() -> Fixture {
    Fixture {
        original: [1, 2, 3],
        state: Arc::new(Mutex::new(FixtureState {
            binding: [1, 2, 3],
            endpoint: Ipv4Addr::new(10, 44, 0, 8),
            deadline: Instant::now() + Duration::from_secs(30),
            active: true,
        })),
        delay: Duration::ZERO,
    }
}

async fn mechanism(fixture: Fixture) -> Running {
    let bind: SocketAddr = "127.0.0.1:0".parse().unwrap();
    crate::server::selected_transport::spawn(
        bind,
        bind,
        Handler {
            source: Source::response_fixture(fixture),
        },
    )
    .await
    .unwrap()
}

async fn udp_raw(address: SocketAddr, raw: &[u8]) -> Option<Message> {
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    socket.connect(address).await.unwrap();
    socket.send(raw).await.unwrap();
    let mut response = [0u8; 4096];
    let count = tokio::time::timeout(Duration::from_millis(400), socket.recv(&mut response))
        .await
        .ok()?
        .ok()?;
    Some(Message::from_vec(&response[..count]).unwrap())
}

async fn tcp_raw(address: SocketAddr, raw: &[u8]) -> Option<Message> {
    let mut socket = TcpStream::connect(address).await.unwrap();
    socket.write_u16(raw.len() as u16).await.unwrap();
    socket.write_all(raw).await.unwrap();
    let count = tokio::time::timeout(Duration::from_millis(400), socket.read_u16())
        .await
        .ok()?
        .ok()?;
    let mut response = vec![0u8; usize::from(count)];
    tokio::time::timeout(Duration::from_millis(400), socket.read_exact(&mut response))
        .await
        .ok()?
        .ok()?;
    Some(Message::from_vec(&response).unwrap())
}

async fn both(gate: &Running, message: &Message) -> [Message; 2] {
    let wire = message.to_vec().unwrap();
    let (udp, tcp) = tokio::join!(
        udp_raw(gate.udp_local_addr(), &wire),
        tcp_raw(gate.tcp_local_addr(), &wire)
    );
    [udp.expect("UDP response"), tcp.expect("TCP response")]
}

fn no_address(message: &Message, code: ResponseCode) {
    // BADVERS and BADSIG share wire code 16; Hickory decodes that number as
    // BADSIG even in an EDNS response. Compare the actual protocol value.
    assert_eq!(u16::from(message.metadata.response_code), u16::from(code));
    assert!(message.answers.is_empty());
    assert!(message.authorities.is_empty());
    assert!(message.additionals.is_empty());
    assert!(!message.metadata.recursion_available);
    assert!(!message.metadata.authentic_data);
}

#[tokio::test]
async fn production_listener_refuses_without_attachment_supplier() {
    let gate = spawn(Config {
        listen: "127.0.0.1:0".parse().unwrap(),
    })
    .await
    .unwrap();
    assert_eq!(gate.udp_local_addr(), gate.tcp_local_addr());
    for name in ["github.com.", "api.github.com.", "api.openai.com."] {
        for response in both(&gate, &query(name, RecordType::A)).await {
            no_address(&response, ResponseCode::ServFail);
        }
    }
    for response in both(&gate, &query("arbitrary.example.", RecordType::A)).await {
        no_address(&response, ResponseCode::Refused);
    }
    gate.shutdown().await.unwrap();
    assert!(spawn(Config {
        listen: "0.0.0.0:0".parse().unwrap()
    })
    .await
    .is_err());
}

#[tokio::test]
async fn response_mechanism_has_selected_names_zero_ttl_and_udp_tcp_parity() {
    let gate = mechanism(fixture()).await;
    for name in ["github.com.", "API.GitHub.COM.", "api.openai.com."] {
        for response in both(&gate, &query(name, RecordType::A)).await {
            assert_eq!(response.metadata.response_code, ResponseCode::NoError);
            assert_eq!(response.metadata.id, 42);
            assert_eq!(response.answers.len(), 1);
            assert_eq!(response.answers[0].ttl, 0);
            assert_eq!(
                response.answers[0].data.ip_addr(),
                Some(Ipv4Addr::new(10, 44, 0, 8).into())
            );
            assert_eq!(response.answers[0].name, Name::from_ascii(name).unwrap());
        }
        for kind in [RecordType::AAAA, RecordType::HTTPS, RecordType::SVCB] {
            for response in both(&gate, &query(name, kind)).await {
                no_address(&response, ResponseCode::NoError);
            }
        }
    }
    for name in [
        "api.github.com.evil.example.",
        "evilgithub.com.",
        "uploads.github.com.",
        "github.com.search.example.",
        "10.44.0.8.",
        ".",
    ] {
        for response in both(&gate, &query(name, RecordType::A)).await {
            no_address(&response, ResponseCode::Refused);
        }
    }
    for kind in [
        RecordType::ANY,
        RecordType::TXT,
        RecordType::CNAME,
        RecordType::MX,
        RecordType::AXFR,
    ] {
        for response in both(&gate, &query("github.com.", kind)).await {
            no_address(&response, ResponseCode::Refused);
        }
    }
    gate.shutdown().await.unwrap();
}

#[tokio::test]
async fn response_mechanism_rechecks_withdrawal_expiry_and_each_binding_component() {
    let source = fixture();
    let gate = mechanism(source.clone()).await;
    let question = query("api.github.com.", RecordType::A);
    assert_eq!(both(&gate, &question).await[0].answers.len(), 1);
    source.state.lock().unwrap().active = false;
    for response in both(&gate, &question).await {
        no_address(&response, ResponseCode::ServFail);
    }
    source.state.lock().unwrap().active = true;
    for index in 0..3 {
        source.state.lock().unwrap().binding[index] += 10;
        for response in both(&gate, &question).await {
            no_address(&response, ResponseCode::ServFail);
        }
        source.state.lock().unwrap().binding = source.original;
    }
    source.state.lock().unwrap().deadline = Instant::now();
    for response in both(&gate, &question).await {
        no_address(&response, ResponseCode::ServFail);
    }
    gate.shutdown().await.unwrap();
}

#[tokio::test]
async fn response_mechanism_timeout_and_withdrawal_during_source_read_are_closed() {
    let mut source = fixture();
    source.delay = Duration::from_millis(300);
    let gate = mechanism(source).await;
    for response in both(&gate, &query("github.com.", RecordType::A)).await {
        no_address(&response, ResponseCode::ServFail);
    }
    gate.shutdown().await.unwrap();
    let mut source = fixture();
    source.delay = Duration::from_millis(80);
    let gate = mechanism(source.clone()).await;
    let state = source.state.clone();
    let withdrawal = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        state.lock().unwrap().active = false;
    });
    for response in both(&gate, &query("github.com.", RecordType::A)).await {
        no_address(&response, ResponseCode::ServFail);
    }
    withdrawal.await.unwrap();
    gate.shutdown().await.unwrap();
}

#[tokio::test]
async fn grammar_rejects_query_shape_opcode_class_records_and_edns() {
    let gate = mechanism(fixture()).await;
    let base = query("github.com.", RecordType::A);
    let mut cases = Vec::new();
    let mut changed = base.clone();
    changed.metadata.op_code = OpCode::Update;
    cases.push((changed, ResponseCode::NotImp));
    let mut changed = base.clone();
    changed.queries.clear();
    cases.push((changed, ResponseCode::FormErr));
    let mut changed = base.clone();
    changed.add_query(base.queries[0].clone());
    cases.push((changed, ResponseCode::FormErr));
    let mut changed = base.clone();
    changed.queries[0].set_query_class(DNSClass::CH);
    cases.push((changed, ResponseCode::Refused));
    let mut changed = base.clone();
    changed.add_answer(Record::from_rdata(
        Name::from_ascii("github.com.").unwrap(),
        2,
        RData::A(A(Ipv4Addr::LOCALHOST)),
    ));
    cases.push((changed, ResponseCode::FormErr));
    let mut changed = base.clone();
    changed.add_additional(Record::from_rdata(
        Name::from_ascii("github.com.").unwrap(),
        2,
        RData::A(A(Ipv4Addr::LOCALHOST)),
    ));
    cases.push((changed, ResponseCode::FormErr));
    let mut changed = base.clone();
    let mut edns = Edns::new();
    edns.set_version(1);
    changed.edns = Some(edns);
    cases.push((changed, ResponseCode::BADVERS));
    for (message, code) in cases {
        for response in both(&gate, &message).await {
            no_address(&response, code);
        }
    }
    let mut with_edns = base.clone();
    let mut edns = Edns::new();
    edns.set_max_payload(4096);
    with_edns.edns = Some(edns);
    for response in both(&gate, &with_edns).await {
        assert_eq!(response.answers.len(), 1);
        assert_eq!(response.edns.unwrap().max_payload(), 512);
    }
    let mut trailing = base.to_vec().unwrap();
    trailing.push(0);
    for response in [
        udp_raw(gate.udp_local_addr(), &trailing).await.unwrap(),
        tcp_raw(gate.tcp_local_addr(), &trailing).await.unwrap(),
    ] {
        no_address(&response, ResponseCode::FormErr);
    }
    let mut reserved = base.to_vec().unwrap();
    reserved[3] |= 0x40;
    for response in [
        udp_raw(gate.udp_local_addr(), &reserved).await.unwrap(),
        tcp_raw(gate.tcp_local_addr(), &reserved).await.unwrap(),
    ] {
        no_address(&response, ResponseCode::FormErr);
    }
    gate.shutdown().await.unwrap();
}

#[tokio::test]
async fn raw_edns_option_framing_is_checked_on_udp_and_tcp_before_source_read() {
    let gate = spawn(Config {
        listen: "127.0.0.1:0".parse().unwrap(),
    })
    .await
    .unwrap();
    // Use the actual unavailable product source. FORMERR and REFUSED distinguish
    // grammar rejection from the SERVFAIL a source observation would produce.
    // Raw RDATA preserves malformed tails that a decoded/encoded OPT would lose.
    let cases: &[(&str, &[u8], ResponseCode)] = &[
        ("empty supported OPT", &[], ResponseCode::ServFail),
        (
            "well-formed unsupported option",
            &[0xfd, 0xe8, 0, 0],
            ResponseCode::Refused,
        ),
        (
            "well-formed unsupported option with data",
            &[0xfd, 0xe8, 0, 2, 0xaa, 0xbb],
            ResponseCode::Refused,
        ),
        ("dangling option code", &[0xfd, 0xe8], ResponseCode::FormErr),
        (
            "short option data",
            &[0xfd, 0xe8, 0, 2, 0xaa],
            ResponseCode::FormErr,
        ),
        (
            "well-formed option then dangling code",
            &[0xfd, 0xe8, 0, 0, 0xfd, 0xe9],
            ResponseCode::FormErr,
        ),
        (
            "well-formed option then short data",
            &[0xfd, 0xe8, 0, 0, 0xfd, 0xe9, 0, 2, 0xaa],
            ResponseCode::FormErr,
        ),
    ];
    for (case, options, code) in cases {
        let mut wire = query("github.com.", RecordType::A).to_vec().unwrap();
        wire[11] = 1;
        wire.extend_from_slice(&[0, 0, 41, 2, 0, 0, 0, 0, 0]);
        wire.extend_from_slice(&(options.len() as u16).to_be_bytes());
        wire.extend_from_slice(options);
        let (udp, tcp) = tokio::join!(
            udp_raw(gate.udp_local_addr(), &wire),
            tcp_raw(gate.tcp_local_addr(), &wire)
        );
        for (transport, response) in [("UDP", udp), ("TCP", tcp)] {
            let response =
                response.unwrap_or_else(|| panic!("missing {transport} response: {case}"));
            assert_eq!(
                u16::from(response.metadata.response_code),
                u16::from(*code),
                "{transport}: {case}"
            );
            no_address(&response, *code);
            assert!(response.edns.unwrap().options().as_ref().is_empty());
        }
    }
    gate.shutdown().await.unwrap();
}

#[tokio::test]
async fn malformed_dns_is_bounded_without_positive_answers_on_either_transport() {
    let gate = mechanism(fixture()).await;
    let wire = query("github.com.", RecordType::A).to_vec().unwrap();
    // A response packet must never receive another DNS response: two resolvers
    // would otherwise reflect errors indefinitely even with no current route.
    let mut response_packet = wire.clone();
    response_packet[2] |= 0x80;
    let (udp, tcp) = tokio::join!(
        udp_raw(gate.udp_local_addr(), &response_packet),
        tcp_raw(gate.tcp_local_addr(), &response_packet)
    );
    assert!(udp.is_none());
    assert!(tcp.is_none());
    let mut malformed = vec![wire[..5].to_vec(), wire[..wire.len() - 1].to_vec()];
    let mut pointer = wire[..12].to_vec();
    pointer.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1]);
    malformed.push(pointer);
    let mut pointer = wire[..12].to_vec();
    pointer.extend_from_slice(&[0xc0, 0xff, 0, 1, 0, 1]);
    malformed.push(pointer);
    let mut label = wire.clone();
    label[12] = 0x40;
    malformed.push(label);
    let mut count = wire.clone();
    count[5] = 2;
    malformed.push(count);
    let mut duplicate_opt = wire.clone();
    duplicate_opt[11] = 2;
    for _ in 0..2 {
        duplicate_opt.extend_from_slice(&[0, 0, 41, 2, 0, 0, 0, 0, 0, 0, 0]);
    }
    malformed.push(duplicate_opt);
    for raw in malformed {
        let (udp, tcp) = tokio::join!(
            udp_raw(gate.udp_local_addr(), &raw),
            tcp_raw(gate.tcp_local_addr(), &raw)
        );
        for response in [udp, tcp].into_iter().flatten() {
            assert!(response.answers.is_empty());
            assert_ne!(response.metadata.response_code, ResponseCode::NoError);
        }
    }
    gate.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ds_upstream_resolver_remains_independent_of_split_answer() {
    let gate = mechanism(fixture()).await;
    let upstream = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream.local_addr().unwrap();
    // The sole external double is a recursive DNS server. The actual DS
    // LiveReResolver performs the lookup; it never consumes split-DNS answers.
    let server = tokio::spawn(async move {
        let mut bytes = [0u8; 4096];
        let (count, peer) =
            tokio::time::timeout(Duration::from_secs(2), upstream.recv_from(&mut bytes))
                .await
                .unwrap()
                .unwrap();
        let request = Message::from_vec(&bytes[..count]).unwrap();
        let question = request.queries[0].clone();
        assert_eq!(
            question.name(),
            &Name::from_ascii("api.github.com.").unwrap()
        );
        let mut reply = Message::query();
        reply.metadata.id = request.metadata.id;
        reply.metadata.message_type = MessageType::Response;
        reply.metadata.recursion_available = true;
        reply.add_query(question.clone());
        reply.add_answer(Record::from_rdata(
            question.name().clone(),
            5,
            RData::A(A(Ipv4Addr::new(140, 82, 112, 6))),
        ));
        upstream
            .send_to(&reply.to_vec().unwrap(), peer)
            .await
            .unwrap();
    });
    let resolver = LiveReResolver::new(&ForwarderConfig {
        upstreams: vec![upstream_address],
        timeout: Duration::from_millis(300),
    });
    let actual = tokio::task::spawn_blocking(move || resolver.resolve("api.github.com."))
        .await
        .unwrap();
    let ReResolveResolved::Resolved { terminal_addrs, .. } = actual else {
        panic!("external resolver failed");
    };
    assert_eq!(
        terminal_addrs,
        vec![std::net::IpAddr::V4(Ipv4Addr::new(140, 82, 112, 6))]
    );
    for response in both(&gate, &query("api.github.com.", RecordType::A)).await {
        assert_eq!(
            response.answers[0].data.ip_addr(),
            Some(Ipv4Addr::new(10, 44, 0, 8).into())
        );
    }
    server.await.unwrap();
    gate.shutdown().await.unwrap();
}
