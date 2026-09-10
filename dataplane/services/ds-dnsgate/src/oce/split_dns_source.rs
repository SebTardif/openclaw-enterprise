// Modified for OpenClaw Enterprise.
//! Private attachment-source boundary. No public positive routing factory.

use std::{io, net::Ipv4Addr, time::Instant};

pub(super) struct Source {
    #[cfg(test)]
    fixture: Option<Fixture>,
}

impl Source {
    pub(super) fn unavailable() -> Self {
        Self {
            #[cfg(test)]
            fixture: None,
        }
    }

    pub(super) async fn current(&self) -> io::Result<Route> {
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            tokio::time::sleep(fixture.delay).await;
            let current = fixture.state.lock().unwrap().clone();
            if current.binding != fixture.original || !current.active {
                return Err(unavailable());
            }
            return Ok(Route {
                endpoint: current.endpoint,
                deadline: current.deadline,
                fixture: fixture.clone(),
            });
        }
        // TODO(Agent attachment integration): replace this refusal only when the
        // original node/listener owner supplies retained ingress custody joined
        // to current canonical Work/context and the authenticated DS endpoint.
        // Root Unix peer credentials or serialized fence observations alone are
        // not that producer. There is intentionally no file/env/RPC allow path.
        Err(unavailable())
    }
}

fn unavailable() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "attachment source unavailable",
    )
}

pub(super) struct Route {
    endpoint: Ipv4Addr,
    deadline: Instant,
    #[cfg(test)]
    fixture: Fixture,
}

impl Route {
    pub(super) fn endpoint(&self) -> Ipv4Addr {
        self.endpoint
    }

    pub(super) fn current(&self) -> bool {
        #[cfg(test)]
        {
            let current = self.fixture.state.lock().unwrap();
            if !current.active
                || current.binding != self.fixture.original
                || current.endpoint != self.endpoint
                || current.deadline < self.deadline
            {
                return false;
            }
        }
        self.deadline > Instant::now()
            && !self.endpoint.is_unspecified()
            && !self.endpoint.is_multicast()
            && !self.endpoint.is_broadcast()
    }
}

// Diagnostic response-mechanism inputs only. This module cannot construct a
// positive Route in a product build; these values are not an internal authority
// substitute for an integrated passing flow.
#[cfg(test)]
#[derive(Clone)]
pub(super) struct Fixture {
    pub(super) original: [u64; 3], // attachment, work context, DS service incarnation
    pub(super) state: std::sync::Arc<std::sync::Mutex<FixtureState>>,
    pub(super) delay: std::time::Duration,
}

#[cfg(test)]
#[derive(Clone)]
pub(super) struct FixtureState {
    pub(super) binding: [u64; 3],
    pub(super) endpoint: Ipv4Addr,
    pub(super) deadline: Instant,
    pub(super) active: bool,
}

#[cfg(test)]
impl Source {
    pub(super) fn response_fixture(fixture: Fixture) -> Self {
        Self {
            fixture: Some(fixture),
        }
    }
}
