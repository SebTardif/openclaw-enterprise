//! Fixed-name protected resolution data. This does not install a fence or issue
//! a current native admission permit. Existing model DNS semantics are separate.
use crate::{Origin, Refusal};
use hickory_proto::{
    access_control::AccessControlSet,
    op::{DnsRequestOptions, Query},
    rr::{DNSClass, Name, RData, Record, RecordType},
};
use hickory_resolver::{
    config::{ConnectionConfig, NameServerConfig, ResolverOpts},
    net::{
        runtime::TokioRuntimeProvider,
        xfer::{DnsHandle, FirstAnswer},
    },
    NameServerPool, PoolContext, TlsConfig,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    net::{Ipv4Addr, SocketAddrV4},
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Policy {
    pub max_hops: usize,
    pub max_records: usize,
    pub max_addresses: usize,
    pub max_ttl: Duration,
    pub timeout: Duration,
    /// Exact reviewed DNS aliases, not extra HTTPS origins or wildcard hosts.
    pub allowed_aliases: BTreeSet<String>,
    /// Actual additional node/cluster/control ranges supplied by deployment.
    pub denied_networks: Vec<(Ipv4Addr, u8)>,
}
#[derive(Debug)]
pub struct Resolution {
    pub origin: Origin,
    pub chain: Vec<(String, String)>,
    pub addresses: Vec<Ipv4Addr>,
    pub observed_at: Instant,
    pub valid_until: Instant,
}
pub struct ProtectedResolver {
    resolver: NameServerPool<TokioRuntimeProvider>,
    policy: Policy,
}
impl ProtectedResolver {
    pub fn new(endpoints: &[SocketAddrV4], policy: Policy) -> Result<Self, Refusal> {
        if endpoints.iter().any(|e| e.port() != 53) {
            return Err(Refusal::Configuration);
        }
        Self::build(endpoints, policy)
    }
    fn build(endpoints: &[SocketAddrV4], policy: Policy) -> Result<Self, Refusal> {
        if endpoints.is_empty()
            || endpoints.iter().any(|e| {
                e.port() == 0
                    || e.ip().is_unspecified()
                    || e.ip().is_multicast()
                    || e.ip().is_broadcast()
            })
            || policy.max_records == 0
            || policy.max_addresses == 0
            || policy.max_addresses > policy.max_records
            || policy.max_hops > policy.max_records
            || policy.max_ttl.is_zero()
            || policy.timeout.is_zero()
            || Instant::now().checked_add(policy.max_ttl).is_none()
            || Instant::now().checked_add(policy.timeout).is_none()
            || policy
                .denied_networks
                .iter()
                .any(|(_, prefix)| *prefix > 32)
            || policy
                .allowed_aliases
                .iter()
                .any(|name| canonical(name).as_ref() != Ok(name))
        {
            return Err(Refusal::Configuration);
        }
        let servers: Vec<_> = endpoints
            .iter()
            .map(|e| {
                let mut udp = ConnectionConfig::udp();
                udp.port = e.port();
                let mut tcp = ConnectionConfig::tcp();
                tcp.port = e.port();
                NameServerConfig::new((*e.ip()).into(), true, vec![udp, tcp])
            })
            .collect();
        // Use the maintained DNS transport directly. Resolver::lookup can merge
        // and filter records across CNAME follow-ups before callers see them.
        // The protected recursive endpoint must return a complete answer.
        let mut opts = ResolverOpts::default();
        opts.num_concurrent_reqs = 1;
        opts.attempts = 1;
        opts.timeout = policy.timeout;
        let context = PoolContext::new(opts, TlsConfig::new().map_err(|_| Refusal::Configuration)?)
            .with_answer_filter(AccessControlSet::empty("native_complete_answer"));
        let resolver = NameServerPool::from_config(
            servers,
            Arc::new(context),
            TokioRuntimeProvider::default(),
        );
        Ok(Self { resolver, policy })
    }
    pub async fn resolve(&self, origin: Origin) -> Result<Resolution, Refusal> {
        let started = Instant::now();
        // Fully qualified, fixed enum only. No hosts/search/system resolver input.
        let name = Name::from_ascii(format!("{}.", origin.hostname()))
            .map_err(|_| Refusal::Configuration)?;
        let answer = tokio::time::timeout(
            self.policy.timeout,
            self.resolver
                .lookup(
                    Query::query(name, RecordType::A),
                    DnsRequestOptions::default(),
                )
                .first_answer(),
        )
        .await
        .map_err(|_| Refusal::Deadline)?
        .map_err(|_| Refusal::Io)?;
        validate(
            origin,
            &answer.answers,
            started,
            started
                .checked_add(self.policy.max_ttl)
                .ok_or(Refusal::Bounds)?,
            &self.policy,
        )
    }
}
fn canonical(name: &str) -> Result<String, Refusal> {
    let name = name.strip_suffix('.').unwrap_or(name);
    if name.is_empty()
        || name.len() > 253
        || name.parse::<std::net::IpAddr>().is_ok()
        || name.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err(Refusal::Protocol);
    }
    Ok(name.to_ascii_lowercase())
}
fn in_network(ip: Ipv4Addr, base: Ipv4Addr, prefix: u8) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    u32::from(ip) & mask == u32::from(base) & mask
}
fn allowed_ip(ip: Ipv4Addr, policy: &Policy) -> bool {
    public_ipv4(ip)
        && !policy
            .denied_networks
            .iter()
            .any(|(base, prefix)| in_network(ip, *base, *prefix))
}

pub(crate) fn public_ipv4(ip: Ipv4Addr) -> bool {
    const SPECIAL: &[(u32, u8)] = &[
        (0x00000000, 8),
        (0x0a000000, 8),
        (0x64400000, 10),
        (0x7f000000, 8),
        (0xa9fe0000, 16),
        (0xac100000, 12),
        (0xc0000000, 24),
        (0xc0000200, 24),
        (0xc0586300, 24),
        (0xc0a80000, 16),
        (0xc6120000, 15),
        (0xc6336400, 24),
        (0xcb007100, 24),
        (0xe0000000, 4),
        (0xf0000000, 4),
    ];
    !SPECIAL
        .iter()
        .any(|(base, prefix)| in_network(ip, Ipv4Addr::from(*base), *prefix))
}
fn validate(
    origin: Origin,
    records: &[Record],
    observed: Instant,
    cached_until: Instant,
    policy: &Policy,
) -> Result<Resolution, Refusal> {
    if records.is_empty() || records.len() > policy.max_records {
        return Err(Refusal::Bounds);
    }
    let mut aliases = BTreeMap::new();
    let mut addresses = BTreeMap::<String, BTreeSet<Ipv4Addr>>::new();
    let mut ttl = policy.max_ttl;
    for record in records {
        if record.dns_class != DNSClass::IN || record.ttl == 0 {
            return Err(Refusal::Protocol);
        }
        ttl = ttl.min(Duration::from_secs(record.ttl.into()));
        let owner = canonical(&record.name.to_ascii())?;
        match &record.data {
            RData::CNAME(target) => {
                let target = canonical(&target.0.to_ascii())?;
                if !policy.allowed_aliases.contains(&target)
                    || aliases.insert(owner, target).is_some()
                {
                    return Err(Refusal::Unsupported);
                }
            }
            RData::A(address) => {
                if !allowed_ip(address.0, policy) {
                    return Err(Refusal::Unsupported);
                }
                if !addresses.entry(owner).or_default().insert(address.0) {
                    return Err(Refusal::Protocol);
                }
            }
            _ => return Err(Refusal::Unsupported),
        }
    }
    let mut cursor = origin.hostname().to_owned();
    let mut seen = BTreeSet::new();
    let mut chain = Vec::new();
    loop {
        if !seen.insert(cursor.clone()) {
            return Err(Refusal::Protocol);
        }
        if let Some(target) = aliases.remove(&cursor) {
            if addresses.contains_key(&cursor) || chain.len() >= policy.max_hops {
                return Err(Refusal::Unsupported);
            }
            chain.push((cursor, target.clone()));
            cursor = target;
        } else {
            break;
        }
    }
    let chosen = addresses.remove(&cursor).ok_or(Refusal::Protocol)?;
    if !aliases.is_empty()
        || !addresses.is_empty()
        || chosen.is_empty()
        || chosen.len() > policy.max_addresses
    {
        return Err(Refusal::Unsupported);
    }
    let valid_until = observed
        .checked_add(ttl)
        .ok_or(Refusal::Bounds)?
        .min(cached_until);
    if valid_until <= Instant::now() {
        return Err(Refusal::Deadline);
    }
    Ok(Resolution {
        origin,
        chain,
        addresses: chosen.into_iter().collect(),
        observed_at: observed,
        valid_until,
    })
}

#[cfg(test)]
mod tests;
