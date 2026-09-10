// Modified for OpenClaw Enterprise.
//! Bounded Agent-facing split DNS, separate from DS's upstream resolver.
//!
//! DNS steering is not request authority. The selected executable currently
//! refuses positive answers because the original attachment/context/DS-endpoint
//! producer is not yet connected. No address map or configuration flag supplies
//! that missing authority. The private response-mechanism tests do not qualify it.

use std::{io, net::SocketAddrV4, time::Duration};

use async_trait::async_trait;
use hickory_server::{
    net::runtime::Time,
    proto::{
        op::{
            Edns, Header, HeaderCounts, Message, MessageType, Metadata, OpCode, Query, ResponseCode,
        },
        rr::{rdata::A, DNSClass, Name, RData, Record, RecordType},
        serialize::binary::{BinDecodable, BinDecoder},
    },
    server::{Request, RequestHandler, ResponseHandler, ResponseInfo},
    zone_handler::MessageResponseBuilder,
};

#[path = "split_dns_source.rs"]
mod source;
use source::Source;

pub use crate::server::selected_transport::Running;

/// The listener has no endpoint, assignment, credential or upstream option.
/// Positive selection must come from the original protected attachment owner.
#[derive(Clone, Debug)]
pub struct Config {
    /// UDP and TCP use this same IPv4 address and port. Port zero is supported
    /// for finite local verification; production selection uses an exact bind.
    pub listen: SocketAddrV4,
}

/// Start both real DNS transports with the current fail-closed source.
pub async fn spawn(config: Config) -> io::Result<Running> {
    if config.listen.ip().is_unspecified()
        || config.listen.ip().is_multicast()
        || config.listen.ip().is_broadcast()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid DNS bind",
        ));
    }
    crate::server::selected_transport::spawn(
        config.listen.into(),
        config.listen.into(),
        Handler {
            source: Source::unavailable(),
        },
    )
    .await
}

struct Handler {
    source: Source,
}

/// Validate the whole datagram, including bytes Hickory's Request decoder can
/// otherwise leave unread. Hickory owns name compression and RR parsing.
fn grammar(request: &Request) -> Result<(), ResponseCode> {
    let mut decoder = BinDecoder::new(request.as_slice());
    Message::read(&mut decoder).map_err(|_| ResponseCode::FormErr)?;
    let metadata = &request.metadata;
    if decoder.index() != request.as_slice().len()
        || request.as_slice().len() > 4096
        || request.as_slice()[3] & 0x40 != 0
        || metadata.message_type != MessageType::Query
        || metadata.authoritative
        || metadata.truncation
        || metadata.recursion_available
        || metadata.response_code != ResponseCode::NoError
        || !request.answers.is_empty()
        || !request.authorities.is_empty()
        || !request.additionals.is_empty()
        || request.signature.is_some()
    {
        return Err(ResponseCode::FormErr);
    }
    if metadata.op_code != OpCode::Query {
        return Err(ResponseCode::NotImp);
    }
    let query = request
        .request_info()
        .map_err(|_| ResponseCode::FormErr)?
        .query;
    if query.query_class() != DNSClass::IN {
        return Err(ResponseCode::Refused);
    }
    if let Some(edns) = &request.edns {
        let has_options = raw_edns_has_options(request.as_slice())?;
        if edns.version() != 0 {
            return Err(ResponseCode::BADVERS);
        }
        // Client subnet, cookies, padding and other extensions do not convey
        // attachment authority. Unsupported extensions are refused explicitly.
        if has_options {
            return Err(ResponseCode::Refused);
        }
    }
    Ok(())
}

/// Inspect the sole OPT's raw option framing after the query grammar has ruled
/// out every other record section. Hickory still parses the header, question,
/// compressed name and record type. Its OPT decoder can erase all decoded
/// options on an incomplete final option, so an empty decoded list is not proof
/// of empty wire RDATA. Only the option header/length framing is checked here.
fn raw_edns_has_options(wire: &[u8]) -> Result<bool, ResponseCode> {
    let malformed = |_| ResponseCode::FormErr;
    let mut decoder = BinDecoder::new(wire);
    let header = Header::read(&mut decoder).map_err(malformed)?;
    if header.counts.queries != 1
        || header.counts.answers != 0
        || header.counts.authorities != 0
        || header.counts.additionals != 1
    {
        return Err(ResponseCode::FormErr);
    }
    Query::read(&mut decoder).map_err(malformed)?;
    let owner = Name::read(&mut decoder).map_err(malformed)?;
    let kind = RecordType::read(&mut decoder).map_err(malformed)?;
    if !owner.is_root() || kind != RecordType::OPT {
        return Err(ResponseCode::FormErr);
    }
    // The existing EDNS decoder owns the payload size and version/flags. Skip
    // those six fixed bytes to read the original RDLENGTH without reserialization.
    decoder.read_slice(6).map_err(malformed)?;
    let length = usize::from(decoder.read_u16().map_err(malformed)?.unverified());
    let options = decoder.read_slice(length).map_err(malformed)?.unverified();
    if decoder.index() != wire.len() {
        return Err(ResponseCode::FormErr);
    }
    let mut remaining = options;
    while !remaining.is_empty() {
        let header = remaining.get(..4).ok_or(ResponseCode::FormErr)?;
        let length = usize::from(u16::from_be_bytes([header[2], header[3]]));
        remaining = remaining.get(4 + length..).ok_or(ResponseCode::FormErr)?;
    }
    Ok(!options.is_empty())
}

fn selected(name: &str) -> bool {
    matches!(name, "github.com." | "api.github.com." | "api.openai.com.")
}

impl Handler {
    async fn answer(&self, request: &Request) -> (ResponseCode, Option<Record>) {
        if let Err(code) = grammar(request) {
            return (code, None);
        }
        let info = request
            .request_info()
            .expect("grammar checked one question");
        if !selected(&info.query.name().to_string()) {
            return (ResponseCode::Refused, None);
        }
        if !matches!(
            info.query.query_type(),
            RecordType::A | RecordType::AAAA | RecordType::HTTPS | RecordType::SVCB
        ) {
            return (ResponseCode::Refused, None);
        }
        // The source has no source-IP, qname or client-provided token input.
        // Its future supplier must retain the actual listener attachment, and
        // revalidate the original context and assigned endpoint for this query.
        let route =
            match tokio::time::timeout(Duration::from_millis(200), self.source.current()).await {
                Ok(Ok(route)) => route,
                _ => return (ResponseCode::ServFail, None),
            };
        if !route.current() {
            return (ResponseCode::ServFail, None);
        }
        if info.query.query_type() != RecordType::A {
            // The selected route is IPv4. Suppress IPv6/ECH/QUIC steering without
            // a recursive query or a cacheable negative record.
            return (ResponseCode::NoError, None);
        }
        let answer = Record::from_rdata(
            info.query.original().name().clone(),
            0,
            RData::A(A(route.endpoint())),
        );
        // No DNS cache survives a withdrawal or fresh context. TTL zero cannot
        // terminate a connection: the attachment fence and online OCC still own
        // revocation of traffic using an address already received by a client.
        if !route.current() {
            return (ResponseCode::ServFail, None);
        }
        (ResponseCode::NoError, Some(answer))
    }
}

#[async_trait]
impl RequestHandler for Handler {
    async fn handle_request<R: ResponseHandler, T: Time>(
        &self,
        request: &Request,
        mut response_handle: R,
    ) -> ResponseInfo {
        let (code, answer) = self.answer(request).await;
        let mut metadata = Metadata::response_from_request(&request.metadata);
        metadata.response_code = code;
        metadata.authoritative = false;
        metadata.recursion_available = false;
        metadata.authentic_data = false;
        metadata.checking_disabled = false;
        let mut builder = MessageResponseBuilder::from_message_request(request);
        // Author a fresh OPT instead of echoing untrusted options. Answers fit
        // inside 512 bytes; advertising more never increases the service budget.
        let mut edns = Edns::new();
        edns.set_max_payload(512).set_version(0);
        if request.edns.is_some() {
            builder.edns(&edns);
        }
        let response = builder.build(
            metadata,
            answer.iter(),
            std::iter::empty(),
            std::iter::empty(),
            std::iter::empty(),
        );
        response_handle
            .send_response(response)
            .await
            .unwrap_or_else(|_| {
                let mut metadata = Metadata::response_from_request(&request.metadata);
                metadata.response_code = ResponseCode::ServFail;
                Header {
                    metadata,
                    counts: HeaderCounts::default(),
                }
                .into()
            })
    }
}

#[cfg(test)]
#[path = "../../tests/oce/split_dns_cases.rs"]
mod tests;
