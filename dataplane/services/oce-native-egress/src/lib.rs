//! Native and broker-mediated HTTPS mechanics. Deployment suppliers are external.
#![forbid(unsafe_code)]

mod admission;
mod broker_rpc;
pub mod dns;
mod git_pack;
mod git_protocol;
pub mod git_read_listener;
mod http;
mod ingress;
mod json;
pub mod mediated;
pub mod publication;
mod publication_protocol;
mod route;
mod transport;

pub use route::{Origin, Repository};
use std::{sync::Arc, time::Duration};

/// Diagnostics never contain request headers, bodies, credentials or peer input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Configuration,
    AuthorityUnavailable,
    Unsupported,
    Bounds,
    Deadline,
    Tls,
    Io,
    Protocol,
}
impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Native HTTPS exchange refused: {self:?}")
    }
}
impl std::error::Error for Refusal {}

/// Explicit deployment budgets. These are not universal Git/provider limits.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub header_bytes: usize,
    pub header_count: usize,
    pub request_bytes: u64,
    pub response_bytes: u64,
    pub exchange_timeout: Duration,
}
impl Limits {
    fn validate(self) -> Result<Self, Refusal> {
        // Hyper requires its HTTP/1 buffer to be at least 8192 bytes.
        if self.header_bytes < 8192
            || self.header_count == 0
            || self.request_bytes == 0
            || self.response_bytes == 0
            || self.exchange_timeout.is_zero()
            || tokio::time::Instant::now()
                .checked_add(self.exchange_timeout)
                .is_none()
        {
            return Err(Refusal::Configuration);
        }
        Ok(self)
    }
}

/// Server-owned transport configuration; it grants no current workload authority.
pub struct Firewall {
    repository: Repository,
    incoming: Arc<rustls::ServerConfig>,
    limits: Limits,
    admission: admission::Source,
}
impl Firewall {
    pub fn new(
        repository: Repository,
        incoming: Arc<rustls::ServerConfig>,
        limits: Limits,
    ) -> Result<Self, Refusal> {
        let limits = limits.validate()?;
        if incoming.alpn_protocols != [b"http/1.1".to_vec()] || incoming.max_early_data_size != 0 {
            return Err(Refusal::Configuration);
        }
        Ok(Self {
            repository,
            incoming,
            limits,
            admission: admission::Source::Unavailable,
        })
    }

    /// Own one accepted socket. Current production admission always refuses;
    /// there is no listener, route registration, positive default or test feature.
    pub async fn serve(&self, socket: tokio::net::TcpStream) -> Result<(), Refusal> {
        transport::serve(self, socket).await
    }
}

#[cfg(test)]
mod tests;
