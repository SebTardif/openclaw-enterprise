use crate::{Origin, Refusal};
use std::{net::SocketAddrV4, sync::Arc};
use tokio::time::Instant;

pub(crate) struct Permit {
    pub endpoint: SocketAddrV4,
    pub trust: Arc<rustls::ClientConfig>,
    pub deadline: Instant,
}

pub(crate) enum Check {
    Connection,
    Request,
}

pub(crate) enum Source {
    Unavailable,
    #[cfg(test)]
    Fixture {
        endpoint: SocketAddrV4,
        trust: Arc<rustls::ClientConfig>,
        deadline: Instant,
        request_deadline: Option<Instant>,
    },
}
impl Source {
    pub(crate) fn current(&self, _origin: Origin, _check: Check) -> Result<Permit, Refusal> {
        // TODO: Original current native-delivery/presented-token authority and
        // qualified DNS/attachment producers must supply this join. A DTO,
        // callback, selector or credential fingerprint cannot create a permit.
        match self {
            Self::Unavailable => Err(Refusal::AuthorityUnavailable),
            #[cfg(test)]
            Self::Fixture {
                endpoint,
                trust,
                deadline,
                request_deadline,
            } => {
                let deadline = match _check {
                    Check::Connection => *deadline,
                    Check::Request => request_deadline.map_or(*deadline, |d| d.min(*deadline)),
                };
                if !endpoint.ip().is_loopback() || deadline <= Instant::now() {
                    return Err(Refusal::Deadline);
                }
                Ok(Permit {
                    endpoint: *endpoint,
                    trust: trust.clone(),
                    deadline,
                })
            }
        }
    }
}
