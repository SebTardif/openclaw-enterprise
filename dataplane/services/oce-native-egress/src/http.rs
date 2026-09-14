use crate::Refusal;
use ::http::{header, HeaderMap};
use hyper::body::{Body, Bytes, Frame, Incoming, SizeHint};
use std::{
    pin::Pin,
    task::{Context, Poll},
};

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
