//! Inspect the bounded original header block before Hyper normalizes framing.
//! The same bytes then enter Hyper on the same retained TLS connection.
use crate::{Limits, Refusal};
use std::{
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use zeroize::{Zeroize, Zeroizing};

pub(crate) struct Checked<S> {
    stream: S,
    prefix: Zeroizing<Vec<u8>>,
    position: usize,
}

pub(crate) async fn checked<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    limits: Limits,
) -> Result<Checked<S>, Refusal> {
    let mut prefix = Zeroizing::new(Vec::new());
    prefix
        .try_reserve_exact(limits.header_bytes)
        .map_err(|_| Refusal::Bounds)?;
    let mut scratch = Zeroizing::new([0; 8192]);
    let end = loop {
        let remaining = limits
            .header_bytes
            .checked_sub(prefix.len())
            .ok_or(Refusal::Bounds)?;
        if remaining == 0 {
            return Err(Refusal::Bounds);
        }
        let count = stream
            .read(&mut scratch[..remaining.min(8192)])
            .await
            .map_err(|_| Refusal::Io)?;
        if count == 0 {
            return Err(Refusal::Protocol);
        }
        let from = prefix.len().saturating_sub(3);
        prefix.extend_from_slice(&scratch[..count]);
        if let Some(at) = prefix[from..].windows(4).position(|v| v == b"\r\n\r\n") {
            break from + at + 4;
        }
    };
    raw_headers(&prefix[..end], limits.header_count)?;
    Ok(Checked {
        stream,
        prefix,
        position: 0,
    })
}

fn raw_headers(bytes: &[u8], count_limit: usize) -> Result<(), Refusal> {
    let mut headers = vec![httparse::EMPTY_HEADER; count_limit];
    let mut request = httparse::Request::new(&mut headers);
    if request.parse(bytes).map_err(|_| Refusal::Protocol)?
        != httparse::Status::Complete(bytes.len())
    {
        return Err(Refusal::Protocol);
    }
    request.headers.sort_unstable_by(|a, b| {
        a.name
            .bytes()
            .map(|v| v.to_ascii_lowercase())
            .cmp(b.name.bytes().map(|v| v.to_ascii_lowercase()))
    });
    if request
        .headers
        .windows(2)
        .any(|pair| pair[0].name.eq_ignore_ascii_case(pair[1].name))
    {
        return Err(Refusal::Unsupported);
    }
    let length = request
        .headers
        .iter()
        .any(|h| h.name.eq_ignore_ascii_case("content-length"));
    let transfer = request
        .headers
        .iter()
        .any(|h| h.name.eq_ignore_ascii_case("transfer-encoding"));
    if length && transfer {
        return Err(Refusal::Unsupported);
    }
    Ok(())
}

impl<S: AsyncRead + Unpin> AsyncRead for Checked<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if self.position < self.prefix.len() {
            let count = buf.remaining().min(self.prefix.len() - self.position);
            buf.put_slice(&self.prefix[self.position..self.position + count]);
            self.position += count;
            if self.position == self.prefix.len() {
                self.prefix.as_mut_slice().zeroize();
                self.prefix.clear();
                self.position = 0;
            }
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for Checked<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
