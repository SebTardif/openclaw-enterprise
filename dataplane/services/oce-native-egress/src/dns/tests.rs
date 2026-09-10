use super::*;
use hickory_proto::{
    op::{Message, MessageType, OpCode},
    rr::rdata::{A, CNAME},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UdpSocket},
};
fn policy() -> Policy {
    Policy {
        max_hops: 4,
        max_records: 16,
        max_addresses: 4,
        max_ttl: Duration::from_secs(60),
        timeout: Duration::from_secs(2),
        allowed_aliases: ["edge.fixture.test".into()].into(),
        denied_networks: vec![(Ipv4Addr::new(9, 9, 0, 0), 16)],
    }
}
fn a(name: &str, ip: [u8; 4], ttl: u32) -> Record {
    Record::from_rdata(
        Name::from_ascii(name).unwrap(),
        ttl,
        RData::A(A(Ipv4Addr::from(ip))),
    )
}
fn cname(owner: &str, target: &str, ttl: u32) -> Record {
    Record::from_rdata(
        Name::from_ascii(owner).unwrap(),
        ttl,
        RData::CNAME(CNAME(Name::from_ascii(target).unwrap())),
    )
}
fn check(records: &[Record]) -> Result<Resolution, Refusal> {
    let now = Instant::now();
    validate(
        Origin::Git,
        records,
        now,
        now + Duration::from_secs(120),
        &policy(),
    )
}
#[test]
fn whole_chain_address_set_and_minimum_ttl() {
    let records = [
        cname("github.com.", "edge.fixture.test.", 3),
        a("edge.fixture.test.", [8, 8, 8, 8], 40),
        a("edge.fixture.test.", [1, 1, 1, 1], 20),
    ];
    let result = check(&records).unwrap();
    assert_eq!(
        result.chain,
        vec![("github.com".into(), "edge.fixture.test".into())]
    );
    assert_eq!(result.addresses.len(), 2);
    assert_eq!(
        result.valid_until - result.observed_at,
        Duration::from_secs(3)
    );
    let now = Instant::now();
    let result = validate(
        Origin::Git,
        &records,
        now,
        now + Duration::from_secs(1),
        &policy(),
    )
    .unwrap();
    assert_eq!(result.valid_until - now, Duration::from_secs(1));
}
#[test]
fn malformed_mixed_unrelated_stale_and_unapproved_answers_are_denied() {
    for records in [
        vec![],
        vec![a("github.com.", [127, 0, 0, 1], 5)],
        vec![
            a("github.com.", [8, 8, 8, 8], 5),
            a("github.com.", [10, 0, 0, 1], 5),
        ],
        vec![a("github.com.", [9, 9, 1, 1], 5)],
        vec![a("github.com.", [8, 8, 8, 8], 0)],
        vec![a("other.test.", [8, 8, 8, 8], 5)],
        vec![
            a("github.com.", [8, 8, 8, 8], 5),
            a("other.test.", [1, 1, 1, 1], 5),
        ],
        vec![
            a("github.com.", [8, 8, 8, 8], 5),
            a("github.com.", [8, 8, 8, 8], 5),
        ],
        vec![
            cname("github.com.", "unapproved.test.", 5),
            a("unapproved.test.", [8, 8, 8, 8], 5),
        ],
        vec![
            cname("github.com.", "edge.fixture.test.", 5),
            a("github.com.", [8, 8, 8, 8], 5),
            a("edge.fixture.test.", [8, 8, 8, 8], 5),
        ],
        vec![
            cname("github.com.", "edge.fixture.test.", 5),
            cname("edge.fixture.test.", "edge.fixture.test.", 5),
        ],
    ] {
        assert!(
            check(&records).is_err(),
            "unexpected acceptance: {records:?}"
        );
    }
    let now = Instant::now();
    assert!(validate(
        Origin::Git,
        &[a("github.com.", [8, 8, 8, 8], 5)],
        now - Duration::from_secs(10),
        now + Duration::from_secs(30),
        &policy()
    )
    .is_err());
    let mut limited = policy();
    limited.max_hops = 0;
    assert!(validate(
        Origin::Git,
        &[
            cname("github.com.", "edge.fixture.test.", 5),
            a("edge.fixture.test.", [8, 8, 8, 8], 5)
        ],
        now,
        now + Duration::from_secs(30),
        &limited
    )
    .is_err());
}
fn reply(bytes: &[u8], truncated: bool) -> Vec<u8> {
    let query = Message::from_vec(bytes).unwrap();
    assert_eq!(query.queries.len(), 1);
    assert_eq!(query.queries[0].name().to_ascii(), "github.com.");
    assert_eq!(query.queries[0].query_type(), RecordType::A);
    let mut response = Message::new(query.metadata.id, MessageType::Response, OpCode::Query);
    response.metadata.recursion_desired = true;
    response.metadata.recursion_available = true;
    response.metadata.truncation = truncated;
    response.queries = query.queries;
    if !truncated {
        response.add_answers([
            cname("github.com.", "edge.fixture.test.", 5),
            a("edge.fixture.test.", [8, 8, 8, 8], 20),
        ]);
    }
    response.to_vec().unwrap()
}
#[tokio::test]
async fn actual_protected_udp_and_truncation_tcp_resolution() {
    // The public-looking answer is data only: no origin socket is created.
    for truncated in [false, true] {
        let tcp = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let endpoint = match tcp.local_addr().unwrap() {
            std::net::SocketAddr::V4(v) => v,
            _ => unreachable!(),
        };
        let udp = UdpSocket::bind(endpoint).await.unwrap();
        let server = tokio::spawn(async move {
            let mut bytes = [0u8; 4096];
            let (len, peer) = udp.recv_from(&mut bytes).await.unwrap();
            udp.send_to(&reply(&bytes[..len], truncated), peer)
                .await
                .unwrap();
            if truncated {
                let (mut socket, _) = tcp.accept().await.unwrap();
                let len = socket.read_u16().await.unwrap();
                let mut bytes = vec![0; usize::from(len)];
                socket.read_exact(&mut bytes).await.unwrap();
                let answer = reply(&bytes, false);
                socket
                    .write_u16(answer.len().try_into().unwrap())
                    .await
                    .unwrap();
                socket.write_all(&answer).await.unwrap();
            }
        });
        let result = ProtectedResolver::build(&[endpoint], policy())
            .unwrap()
            .resolve(Origin::Git)
            .await;
        if result.is_err() {
            server.abort();
        }
        let _ = server.await;
        let result = result.unwrap();
        assert_eq!(result.chain.len(), 1);
        assert_eq!(result.addresses, vec![Ipv4Addr::new(8, 8, 8, 8)]);
        assert!(result.valid_until - result.observed_at <= Duration::from_secs(5));
    }
}

#[tokio::test]
async fn actual_mixed_or_incomplete_resolver_answers_are_not_sanitized_into_permission() {
    for incomplete in [false, true] {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let endpoint = match socket.local_addr().unwrap() {
            std::net::SocketAddr::V4(v) => v,
            _ => unreachable!(),
        };
        let server = tokio::spawn(async move {
            let mut bytes = [0u8; 4096];
            let (len, peer) = socket.recv_from(&mut bytes).await.unwrap();
            let mut answer = Message::from_vec(&reply(&bytes[..len], false)).unwrap();
            if incomplete {
                answer
                    .answers
                    .retain(|r| r.record_type() == RecordType::CNAME);
            } else {
                answer.add_answer(a("edge.fixture.test.", [10, 0, 0, 1], 20));
            }
            socket
                .send_to(&answer.to_vec().unwrap(), peer)
                .await
                .unwrap();
        });
        let result = ProtectedResolver::build(&[endpoint], policy())
            .unwrap()
            .resolve(Origin::Git)
            .await;
        server.await.unwrap();
        assert!(result.is_err());
    }
}
