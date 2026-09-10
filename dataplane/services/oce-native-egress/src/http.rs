use crate::{Firewall, Origin, Refusal};
use ::http::{header, request::Parts, HeaderMap, Method, Version};
use http_body_util::BodyExt;
use hyper::body::{Body, Bytes, Frame, Incoming, SizeHint};
use std::{
    pin::Pin,
    task::{Context, Poll},
};

pub(crate) fn request(firewall: &Firewall, parts: &Parts, sni: Origin) -> Result<(), Refusal> {
    if parts.version != Version::HTTP_11 {
        return Err(Refusal::Unsupported);
    }
    headers(
        &parts.headers,
        firewall.limits.header_bytes,
        firewall.limits.header_count,
    )?;
    let host = parts
        .headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .ok_or(Refusal::Unsupported)?;
    if Origin::from_host(host)? != sni {
        return Err(Refusal::Unsupported);
    }
    firewall.repository.allows(sni, &parts.method, &parts.uri)?;
    if parts.uri.path() == "/graphql"
        && (!matches!(
            parts
                .headers
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
            Some("application/json" | "application/json; charset=utf-8")
        ) || parts.headers.contains_key(header::CONTENT_ENCODING))
    {
        return Err(Refusal::Unsupported);
    }
    if parts.method == Method::GET
        && (parts.headers.contains_key(header::TRANSFER_ENCODING)
            || content_length(&parts.headers)?.is_some_and(|n| n != 0))
    {
        return Err(Refusal::Unsupported);
    }
    if content_length(&parts.headers)?.is_some_and(|n| n > firewall.limits.request_bytes) {
        return Err(Refusal::Bounds);
    }
    Ok(())
}

pub(crate) fn headers(
    headers: &HeaderMap,
    byte_limit: usize,
    count_limit: usize,
) -> Result<(), Refusal> {
    let mut bytes = 0usize;
    if headers.len() > count_limit {
        return Err(Refusal::Bounds);
    }
    for (name, value) in headers {
        bytes = bytes
            .checked_add(name.as_str().len())
            .and_then(|n| n.checked_add(value.len()))
            .ok_or(Refusal::Bounds)?;
        if bytes > byte_limit || headers.get_all(name).iter().count() != 1 {
            return Err(Refusal::Bounds);
        }
    }
    for name in [
        "upgrade",
        "proxy-authorization",
        "proxy-connection",
        "trailer",
        "te",
        "expect",
    ] {
        if headers.contains_key(name) {
            return Err(Refusal::Unsupported);
        }
    }
    if headers
        .get(header::CONNECTION)
        .is_some_and(|v| v != "close" && v != "keep-alive")
    {
        return Err(Refusal::Unsupported);
    }
    if let Some(value) = headers.get(header::TRANSFER_ENCODING) {
        if value != "chunked" || headers.contains_key(header::CONTENT_LENGTH) {
            return Err(Refusal::Unsupported);
        }
    }
    Ok(())
}
fn content_length(headers: &HeaderMap) -> Result<Option<u64>, Refusal> {
    headers
        .get(header::CONTENT_LENGTH)
        .map(|v| {
            v.to_str()
                .ok()
                .and_then(|s| s.parse().ok())
                .ok_or(Refusal::Protocol)
        })
        .transpose()
}

pub(crate) async fn graphql(body: Incoming, limit: u64) -> Result<Bytes, Refusal> {
    let mut body = Bounded::new(body, limit);
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame?;
        let data = frame.data_ref().ok_or(Refusal::Unsupported)?;
        bytes.try_reserve(data.len()).map_err(|_| Refusal::Bounds)?;
        bytes.extend_from_slice(data);
    }
    let envelope = crate::json::parse(&bytes)?;
    let object = envelope.as_object().ok_or(Refusal::Protocol)?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "query" | "variables" | "operationName"))
        || object
            .get("query")
            .and_then(|v| v.as_str())
            .is_none_or(|v| v.is_empty())
        || object
            .get("variables")
            .is_some_and(|v| !v.is_null() && !v.is_object())
        || object
            .get("operationName")
            .is_some_and(|v| !v.is_null() && !v.is_string())
    {
        return Err(Refusal::Protocol);
    }
    // Validate the transport envelope, not GraphQL fields, branches or caller
    // intent. Forward the original bytes once under the delivered token scope.
    Ok(Bytes::from(bytes))
}

/// Streams each parsed frame once. Byte budgets bound traffic, not allocation
/// of a whole Git pack; Hyper owns framing. Trailers are unsupported.
pub(crate) struct Bounded {
    incoming: Incoming,
    remaining: u64,
    failed: bool,
}
impl Bounded {
    pub fn new(incoming: Incoming, remaining: u64) -> Self {
        Self {
            incoming,
            remaining,
            failed: false,
        }
    }
    pub fn boxed(self) -> http_body_util::combinators::UnsyncBoxBody<Bytes, Refusal> {
        self.boxed_unsync()
    }
}
impl Body for Bounded {
    type Data = Bytes;
    type Error = Refusal;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Refusal>>> {
        if self.failed {
            return Poll::Ready(None);
        }
        match Pin::new(&mut self.incoming).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    if data.len() as u64 <= self.remaining {
                        self.remaining -= data.len() as u64;
                        return Poll::Ready(Some(Ok(frame)));
                    }
                }
                self.failed = true;
                Poll::Ready(Some(Err(Refusal::Bounds)))
            }
            Poll::Ready(Some(Err(_))) => {
                self.failed = true;
                Poll::Ready(Some(Err(Refusal::Protocol)))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
    fn is_end_stream(&self) -> bool {
        self.failed || self.incoming.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        let mut hint = SizeHint::new();
        if let Some(exact) = self.incoming.size_hint().exact() {
            if exact <= self.remaining {
                hint.set_exact(exact);
            }
        }
        hint
    }
}
