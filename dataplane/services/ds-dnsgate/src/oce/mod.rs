// Modified for OpenClaw Enterprise.
// Modified for OpenClaw Enterprise. This executable consumes live OCE authority;
// it does not manufacture assignments, grants, provider secrets, or DS host marks.
pub mod kernel;
pub mod protocol;

use ds_contracts::dns_admission::{
    AddressFamily, AdmissionEntry, AdmissionKey, AdmissionMap, AdmissionType, AdmittedAddr,
    Instant as AdmissionInstant, Provenance,
};
use ds_dnsgate::{
    handler::{ForwarderConfig, LiveReResolver},
    policy::{DnsQueryCtx, PolicyCorePolicy, PolicyHook, Verdict},
    reresolve::{ReResolveResolved, ReResolver},
    txn::{is_plumbable, InMemoryAdmissionMap},
};
use futures_util::{stream, StreamExt};
use kernel::{Enforcement, Kernel};
use protocol::{authority, denied, Operation, Request};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4},
    os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::UnixListener,
    sync::{Mutex, Semaphore},
};

const MAX_OPERATIONS: usize = 64;
const MAX_CLIENTS: usize = 32;
const MAX_RETIRED: usize = 4096;
const MAX_LEASE: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct Admission {
    operation: Operation,
    admission_id: String,
    ip: Ipv4Addr,
    deadline: Instant,
    dns_deadline: Instant,
    flow: Option<(String, String)>,
    operation_expiry_ms: u64,
    dispatch_before_ms: u64,
    retirement_deadline: Instant,
    dispatch_deadline: Instant,
    release_requested: bool,
}
impl Admission {
    fn key(&self) -> AdmissionKey {
        AdmissionKey {
            session_uuid: self.operation.operation_id.clone(),
            original_query_fqdn: "api.openai.com".into(),
        }
    }
}
#[derive(Clone)]
struct Retired {
    admission: Admission,
    release_complete: bool,
}

struct State {
    // Reserve before authority I/O to serialize a first attempt. Once a valid
    // observation exists, no failure may erase its original time boundary and
    // permit a later attempt to establish new ceilings under a rolled-back clock.
    attempts: BTreeSet<String>,
    admissions: BTreeMap<String, Admission>,
    map: InMemoryAdmissionMap,
    cleanup: BTreeSet<Ipv4Addr>,
    uncertain: bool,
    retired: BTreeMap<String, Retired>,
    next_id: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            attempts: BTreeSet::new(),
            admissions: BTreeMap::new(),
            map: InMemoryAdmissionMap::default(),
            cleanup: BTreeSet::new(),
            uncertain: false,
            retired: BTreeMap::new(),
            next_id: 0,
        }
    }
}
struct AuthorityLease {
    accepted: bool,
    dispatch_deadline: Instant,
    deadline: Instant,
    operation_expiry_ms: u64,
    dispatch_before_ms: u64,
    retirement_deadline: Instant,
}

pub struct Service {
    authority_socket: PathBuf,
    resolver: Arc<LiveReResolver>,
    policy: PolicyCorePolicy,
    kernel: Arc<dyn Enforcement>,
    #[cfg(test)]
    authority_fixture_uid: Option<u32>,
    state: Mutex<State>,
    startup_id: String,
    capacity_limit: usize,
}
impl Service {
    fn new(config: &Config, kernel: Arc<Kernel>) -> io::Result<Self> {
        let policy_file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&config.policy_file)?;
        let metadata = policy_file.metadata()?;
        if !metadata.is_file() || metadata.mode() & 0o022 != 0 || metadata.len() > 262_144 {
            return Err(denied());
        }
        let mut policy_bytes = Vec::new();
        std::io::Read::read_to_end(
            &mut std::io::Read::take(policy_file, 262_145),
            &mut policy_bytes,
        )?;
        if policy_bytes.len() > 262_144 {
            return Err(denied());
        }
        let policy = ds_contracts::pol1::parse_layer(
            std::str::from_utf8(&policy_bytes).map_err(|_| denied())?,
        )
        .map_err(|_| denied())?;
        let composed = policy_core::pol1_eval::compose(&[policy], &[]);
        // Random process identity prevents a prior instance's handle identifying a
        // new admission after a restart. No persistent authority is reconstructed.
        let mut bytes = [0u8; 16];
        std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut bytes)?;
        let startup_id = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        Ok(Self {
            authority_socket: config.authority_socket.clone(),
            resolver: Arc::new(LiveReResolver::new(&ForwarderConfig {
                upstreams: config
                    .upstreams
                    .iter()
                    .copied()
                    .map(SocketAddr::V4)
                    .collect(),
                timeout: Duration::from_millis(300),
            })),
            policy: PolicyCorePolicy::new(composed),
            kernel,
            #[cfg(test)]
            authority_fixture_uid: None,
            state: Mutex::new(State::default()),
            startup_id,
            capacity_limit: MAX_RETIRED,
        })
    }
    fn allowed(&self, operation: &Operation) -> bool {
        operation.valid()
            && matches!(
                self.policy.evaluate(&DnsQueryCtx {
                    session: operation.assignment_id.clone(),
                    qname: "api.openai.com.".into(),
                    qtype: 1,
                    source: "127.0.0.1:0".parse().expect("constant address")
                }),
                Verdict::Allow { .. }
            )
    }
    async fn observe(
        &self,
        operation: Option<&Operation>,
    ) -> io::Result<protocol::AuthorityObservation> {
        #[cfg(test)]
        if let Some(uid) = self.authority_fixture_uid {
            return protocol::authority_from(&self.authority_socket, operation, uid).await;
        }
        authority(&self.authority_socket, operation).await
    }
    async fn live(&self, operation: &Operation) -> io::Result<AuthorityLease> {
        if !self.allowed(operation) {
            return Err(denied());
        }
        let observed = self.observe(Some(operation)).await?;
        let response = observed.response;
        let expiry = response.operation_expires_at_ms.ok_or_else(denied)?;
        let dispatch = response.dispatch_before_ms.ok_or_else(denied)?;
        let server_time = response.server_time_ms.ok_or_else(denied)?;
        let retirement_deadline = observed
            .started
            .checked_add(Duration::from_millis(
                expiry.checked_sub(server_time).ok_or_else(denied)?,
            ))
            .ok_or_else(denied)?;
        // A dispatched operation may report a past dispatch-before. Its original
        // accepted admission still owns the separately pinned dispatch ceiling.
        let dispatch_deadline = observed
            .started
            .checked_add(Duration::from_millis(dispatch.saturating_sub(server_time)))
            .ok_or_else(denied)?;
        if retirement_deadline <= Instant::now() {
            return Err(denied());
        }
        Ok(AuthorityLease {
            deadline: observed.deadline.min(retirement_deadline),
            accepted: response.operation_state.as_deref() == Some("accepted"),
            operation_expiry_ms: expiry,
            dispatch_before_ms: dispatch,
            retirement_deadline,
            dispatch_deadline,
        })
    }
    async fn live_admission(
        &self,
        admission: &Admission,
        require_accepted: bool,
    ) -> io::Result<Instant> {
        let lease = self.live(&admission.operation).await?;
        if lease.operation_expiry_ms != admission.operation_expiry_ms
            || lease.dispatch_before_ms != admission.dispatch_before_ms
            || (require_accepted && !lease.accepted)
        {
            return Err(denied());
        }
        let mut deadline = lease.deadline.min(admission.retirement_deadline);
        if lease.accepted {
            deadline = deadline
                .min(admission.dispatch_deadline)
                .min(lease.dispatch_deadline);
        }
        if require_accepted {
            deadline = deadline.min(admission.dns_deadline);
        }
        if deadline <= Instant::now() {
            return Err(denied());
        }
        Ok(deadline)
    }
    async fn final_current(&self, admission: &Admission, require_accepted: bool) -> bool {
        // A shorter positive decision is not permission to keep the previous
        // kernel lease. Deny and withdraw instead of acknowledging stale state.
        self.live_admission(admission, require_accepted)
            .await
            .is_ok_and(|deadline| {
                deadline >= admission.deadline && admission.deadline > Instant::now()
            })
    }
    fn retire(state: &mut State, admission: Admission) {
        state
            .retired
            .entry(admission.operation.operation_id.clone())
            .or_insert(Retired {
                admission,
                release_complete: false,
            });
    }
    async fn enforce(&self, desired: BTreeMap<Ipv4Addr, Instant>) -> io::Result<()> {
        let kernel = self.kernel.clone();
        tokio::task::spawn_blocking(move || kernel.replace(&desired))
            .await
            .map_err(|_| denied())?
    }
    fn union(admissions: &BTreeMap<String, Admission>) -> BTreeMap<Ipv4Addr, Instant> {
        let mut result = BTreeMap::new();
        let now = Instant::now();
        for admission in admissions.values().filter(|a| a.deadline > now) {
            result
                .entry(admission.ip)
                .and_modify(|deadline: &mut Instant| {
                    *deadline = (*deadline).max(admission.deadline)
                })
                .or_insert(admission.deadline);
        }
        result
    }
    // A failed atomic nft replacement has unknown enforcement state. Keep all
    // possible destination ownership until an empty replacement and cleanup succeed.
    fn poison(state: &mut State, extra: Option<Ipv4Addr>) {
        state.uncertain = true;
        state
            .cleanup
            .extend(state.admissions.values().map(|a| a.ip));
        state.cleanup.extend(extra);
    }
    async fn retry_cleanup(&self, state: &mut State) -> io::Result<()> {
        if state.uncertain {
            self.enforce(BTreeMap::new()).await?;
            for admission in state.admissions.values().cloned().collect::<Vec<_>>() {
                Self::retire(state, admission);
            }
            state.admissions.clear();
            state.map = InMemoryAdmissionMap::default();
            state.uncertain = false;
        }
        let active = Self::union(&state.admissions);
        for ip in state.cleanup.clone() {
            // A surviving operation owns the endpoint. Per-operation socket
            // cancellation is TLS's job; flushing this IP would break its sibling.
            if active.contains_key(&ip) {
                continue;
            }
            self.kernel.destroy(ip).await?;
            state.cleanup.remove(&ip);
        }
        if state.cleanup.is_empty() {
            Ok(())
        } else {
            Err(denied())
        }
    }
    async fn remove(&self, state: &mut State, id: &str) -> io::Result<()> {
        let Some(admission) = state.admissions.get(id).cloned() else {
            return Ok(());
        };
        let mut next = state.admissions.clone();
        next.remove(id);
        let desired = Self::union(&next);
        if self.enforce(desired.clone()).await.is_err() {
            Self::poison(state, Some(admission.ip));
            return Err(denied());
        }
        if state.map.revoke(&admission.key()).is_err() {
            Self::poison(state, Some(admission.ip));
            return Err(denied());
        }
        Self::retire(state, admission.clone());
        state.admissions = next;
        if !desired.contains_key(&admission.ip) {
            state.cleanup.insert(admission.ip);
        }
        self.retry_cleanup(state).await
    }
    async fn resolve(&self, operation: Operation) -> io::Result<Value> {
        if !operation.valid() {
            return Err(denied());
        }
        {
            let mut state = self.state.lock().await;
            if let Some(existing) = state.admissions.get(&operation.operation_id) {
                if state.uncertain
                    || !state.cleanup.is_empty()
                    || existing.operation != operation
                    || existing.flow.is_some()
                    || existing.dispatch_deadline <= Instant::now()
                {
                    return Err(denied());
                }
                return Self::response(existing);
            }
            if state.uncertain
                || !state.cleanup.is_empty()
                || state.admissions.len() >= MAX_OPERATIONS
                || state.attempts.len() >= self.capacity_limit
                || state.attempts.contains(&operation.operation_id)
                || state.retired.contains_key(&operation.operation_id)
                || state.admissions.contains_key(&operation.operation_id)
            {
                return Err(denied());
            }
            state.attempts.insert(operation.operation_id.clone());
        }
        let issued = match self.live(&operation).await {
            Ok(issued) => issued,
            Err(error) => {
                // No authenticated, valid observation established a ceiling.
                self.state
                    .lock()
                    .await
                    .attempts
                    .remove(&operation.operation_id);
                return Err(error);
            }
        };
        if !issued.accepted || issued.dispatch_deadline <= Instant::now() {
            return Err(denied());
        }
        let resolver = self.resolver.clone();
        // Reuse the actual DS CNAME-following resolver; never ask libc/system DNS.
        let resolved = tokio::task::spawn_blocking(move || resolver.resolve("api.openai.com."))
            .await
            .map_err(|_| denied())?;
        let (ip, ttl) = select_answer(resolved)?;
        let dns_deadline = Instant::now() + Duration::from_secs(u64::from(ttl));
        let mut state = self.state.lock().await;
        if let Some(existing) = state.admissions.get(&operation.operation_id) {
            if state.uncertain
                || !state.cleanup.is_empty()
                || existing.operation != operation
                || existing.flow.is_some()
                || existing.dispatch_deadline <= Instant::now()
            {
                return Err(denied());
            }
            return Self::response(existing);
        }
        if state.uncertain
            || !state.cleanup.is_empty()
            || state.admissions.len() >= MAX_OPERATIONS
            || state.retired.contains_key(&operation.operation_id)
            || state.admissions.contains_key(&operation.operation_id)
        {
            return Err(denied());
        }
        // Fence the asynchronous answer against the real authority, inside the
        // same local serialization used for withdrawal and publication.
        let current = self.live(&operation).await?;
        if !current.accepted
            || issued.dispatch_deadline <= Instant::now()
            || issued.operation_expiry_ms != current.operation_expiry_ms
            || issued.dispatch_before_ms != current.dispatch_before_ms
        {
            return Err(denied());
        }
        let deadline = current
            .deadline
            .min(dns_deadline)
            .min(issued.retirement_deadline)
            .min(issued.dispatch_deadline)
            .min(current.dispatch_deadline)
            .min(Instant::now() + MAX_LEASE);
        state.next_id = state.next_id.checked_add(1).ok_or_else(denied)?;
        let admission = Admission {
            operation: operation.clone(),
            admission_id: format!("{}-{}", self.startup_id, state.next_id),
            ip,
            deadline,
            dns_deadline,
            flow: None,
            operation_expiry_ms: issued.operation_expiry_ms,
            dispatch_before_ms: issued.dispatch_before_ms,
            retirement_deadline: issued.retirement_deadline,
            dispatch_deadline: issued.dispatch_deadline,
            release_requested: false,
        };
        let mut next = state.admissions.clone();
        next.insert(operation.operation_id.clone(), admission.clone());
        // An unavailable local wall clock must fail before any kernel effect.
        // All post-effect failures retain owned cleanup or committed admission.
        let now_ms = unix_ms()?;
        if self.enforce(Self::union(&next)).await.is_err() {
            Self::retire(&mut state, admission.clone());
            Self::poison(&mut state, Some(ip));
            return Err(denied());
        }
        // Network effects are bounded leases, not a cross-process atomic lock.
        // A changed authority during the kernel write is withdrawn before reply.
        if !self.final_current(&admission, true).await {
            Self::retire(&mut state, admission.clone());
            if self.enforce(Self::union(&state.admissions)).await.is_err() {
                Self::poison(&mut state, Some(ip));
            } else if !Self::union(&state.admissions).contains_key(&ip) {
                state.cleanup.insert(ip);
                let _ = self.retry_cleanup(&mut state).await;
            }
            return Err(denied());
        }
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        let entry = AdmissionEntry {
            admitted_ips: vec![AdmittedAddr {
                family: AddressFamily::V4,
                octets: ip.octets().to_vec(),
            }],
            admission_type: AdmissionType::Normal,
            real_targets: vec![],
            expires_at: AdmissionInstant::from_unix_nanos(
                (now_ms + remaining).saturating_mul(1_000_000),
            ),
            admitted_at: AdmissionInstant::from_unix_nanos(now_ms.saturating_mul(1_000_000)),
            provenance: Provenance {
                rule_id: "oce-authority-operation".into(),
                policy_layer: "oce".into(),
                policy_version: operation.policy_version.to_string(),
            },
        };
        if state.map.admit(admission.key(), entry).is_err() {
            Self::retire(&mut state, admission.clone());
            Self::poison(&mut state, Some(ip));
            return Err(denied());
        }
        state.admissions = next;
        Self::response(&admission)
    }
    fn response(admission: &Admission) -> io::Result<Value> {
        let now = unix_ms()?;
        let remaining = admission
            .deadline
            .saturating_duration_since(Instant::now())
            .as_millis() as u64;
        if remaining <= 500 || remaining > 5000 {
            return Err(denied());
        }
        let op = &admission.operation;
        let mut response = json!({"version":1,"ok":true,"operation_id":op.operation_id,"reservation_ref":op.reservation_ref,"authority_instance_ref":op.authority_instance_ref,"provider_binding_ref":op.provider_binding_ref,"credential_binding":op.credential_binding,"request_sha256":op.request_sha256,"assignment_id":op.assignment_id,"generation":op.generation,"policy_version":op.policy_version,"recipient":op.recipient,"protocol":op.protocol,"ip":admission.ip.to_string(),"admission_id":admission.admission_id,"server_time_ms":now,"valid_until_ms":now + remaining});
        if let Some((connection_ref, flow_ref)) = &admission.flow {
            response["connection_ref"] = json!(connection_ref);
            response["flow_ref"] = json!(flow_ref);
        }
        Ok(response)
    }
    async fn bind(
        &self,
        operation: Operation,
        ip: String,
        id: String,
        connection_ref: String,
    ) -> io::Result<Value> {
        if !operation.valid()
            || connection_ref.len() != 64
            || !connection_ref
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(denied());
        }
        let mut state = self.state.lock().await;
        let admission = state
            .admissions
            .get(&operation.operation_id)
            .cloned()
            .ok_or_else(denied)?;
        if state.uncertain
            || !state.cleanup.is_empty()
            || admission.operation != operation
            || admission.ip.to_string() != ip
            || admission.admission_id != id
            || admission.deadline <= Instant::now()
        {
            return Err(denied());
        }
        if let Some((existing, _)) = &admission.flow {
            if *existing != connection_ref {
                return Err(denied());
            }
            if !self.final_current(&admission, false).await {
                self.remove(&mut state, &operation.operation_id).await?;
                return Err(denied());
            }
            return Self::response(&admission);
        }
        if admission.dns_deadline <= Instant::now() {
            return Err(denied());
        }
        let deadline = self.live_admission(&admission, false).await?;
        let mut bytes = [0u8; 32];
        std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut bytes)?;
        let flow_ref = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let mut bound = admission;
        bound.deadline = deadline;
        bound.flow = Some((connection_ref, flow_ref));
        let mut next = state.admissions.clone();
        next.insert(operation.operation_id, bound.clone());
        if self.enforce(Self::union(&next)).await.is_err() {
            Self::poison(&mut state, None);
            return Err(denied());
        }
        if !self.final_current(&bound, false).await {
            self.remove(&mut state, &bound.operation.operation_id)
                .await?;
            return Err(denied());
        }
        state.admissions = next;
        Self::response(&bound)
    }
    async fn check(
        &self,
        operation: Operation,
        ip: String,
        id: String,
        connection_ref: String,
        flow_ref: String,
        release: bool,
    ) -> io::Result<Value> {
        if !operation.valid() {
            return Err(denied());
        }
        let mut state = self.state.lock().await;
        if release {
            if let Some(retired) = state.retired.get(&operation.operation_id) {
                let old = &retired.admission;
                if !old.release_requested
                    || old.operation != operation
                    || old.ip.to_string() != ip
                    || old.admission_id != id
                    || old.flow.as_ref() != Some(&(connection_ref.clone(), flow_ref.clone()))
                {
                    return Err(denied());
                }
                if !retired.release_complete {
                    self.retry_cleanup(&mut state).await?;
                    state
                        .retired
                        .get_mut(&operation.operation_id)
                        .ok_or_else(denied)?
                        .release_complete = true;
                }
                return Ok(json!({"version":1,"ok":true}));
            }
        }
        let admission = state
            .admissions
            .get(&operation.operation_id)
            .cloned()
            .ok_or_else(denied)?;
        if admission.operation != operation
            || admission.ip.to_string() != ip
            || admission.admission_id != id
            || admission.flow.as_ref() != Some(&(connection_ref, flow_ref))
        {
            return Err(denied());
        }
        if release {
            state
                .admissions
                .get_mut(&operation.operation_id)
                .ok_or_else(denied)?
                .release_requested = true;
            self.remove(&mut state, &operation.operation_id).await?;
            state
                .retired
                .get_mut(&operation.operation_id)
                .ok_or_else(denied)?
                .release_complete = true;
            return Ok(json!({"version":1,"ok":true}));
        }
        if state.uncertain || !state.cleanup.is_empty() || admission.deadline <= Instant::now() {
            return Err(denied());
        }
        let deadline = match self.live_admission(&admission, false).await {
            Ok(deadline) => deadline,
            Err(_) => {
                self.remove(&mut state, &operation.operation_id).await?;
                return Err(denied());
            }
        };
        let mut renewed = admission;
        renewed.deadline = deadline;
        let mut next = state.admissions.clone();
        next.insert(operation.operation_id.clone(), renewed.clone());
        if self.enforce(Self::union(&next)).await.is_err() {
            Self::poison(&mut state, None);
            return Err(denied());
        }
        if !self.final_current(&renewed, false).await {
            self.remove(&mut state, &operation.operation_id).await?;
            return Err(denied());
        }
        let entry = state.map.lookup(&renewed.key()).ok_or_else(denied)?;
        if entry.admitted_ips.len() != 1 || entry.admitted_ips[0].octets != renewed.ip.octets() {
            Self::poison(&mut state, None);
            return Err(denied());
        }
        state.admissions = next;
        Self::response(&renewed)
    }
    async fn maintain(&self) {
        // Snapshot only bounded current ownership; currentness probes run in
        // parallel, so an unavailable authority cannot serialize unbounded waits.
        let admissions = {
            self.state
                .lock()
                .await
                .admissions
                .values()
                .cloned()
                .collect::<Vec<_>>()
        };
        let invalid: Vec<(String, String, Instant)> = stream::iter(admissions)
            .map(|admission| async move {
                let expired = admission.deadline <= Instant::now()
                    || (admission.flow.is_none() && admission.dns_deadline <= Instant::now());
                if expired
                    || !self
                        .final_current(&admission, admission.flow.is_none())
                        .await
                {
                    Some((
                        admission.operation.operation_id,
                        admission.admission_id,
                        admission.deadline,
                    ))
                } else {
                    None
                }
            })
            .buffer_unordered(MAX_OPERATIONS)
            .filter_map(|value| async { value })
            .collect()
            .await;
        let mut state = self.state.lock().await;
        for (id, admission_id, observed_deadline) in invalid {
            // A concurrent successful renewal can supersede this snapshot. Its
            // own online check owns that newer lease; do not revoke it from old I/O.
            if state.admissions.get(&id).is_some_and(|entry| {
                entry.admission_id == admission_id && entry.deadline == observed_deadline
            }) && self.remove(&mut state, &id).await.is_err()
            {
                break;
            }
        }
        let _ = self.retry_cleanup(&mut state).await;
        // TODO(authority terminality): until the canonical producer supplies a
        // reviewed irreversible terminal/incarnation boundary, keep consumed IDs
        // for this process lifetime and refuse capacity instead of evicting them.
    }
    async fn handle(&self, request: Request) -> io::Result<Value> {
        match request {
            Request::Ready { version: 1 } => {
                let deadline = self.observe(None).await?.deadline;
                let mut state = self.state.lock().await;
                if state.uncertain || !state.cleanup.is_empty() {
                    return Err(denied());
                }
                // Probe the actual writer on each readiness request. A live
                // authority with missing enforcement never reports readiness.
                if self.enforce(Self::union(&state.admissions)).await.is_err() {
                    Self::poison(&mut state, None);
                    return Err(denied());
                }
                let now = unix_ms()?;
                let remaining = deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis() as u64;
                if remaining == 0 {
                    return Err(denied());
                }
                Ok(
                    json!({"version":1,"ok":true,"server_time_ms":now,"valid_until_ms":now+remaining}),
                )
            }
            Request::Resolve {
                version: 1,
                operation_id,
                reservation_ref,
                authority_instance_ref,
                provider_binding_ref,
                credential_binding,
                request_sha256,
                assignment_id,
                generation,
                policy_version,
                recipient,
                protocol,
            } => {
                self.resolve(Operation {
                    operation_id,
                    reservation_ref,
                    authority_instance_ref,
                    provider_binding_ref,
                    credential_binding,
                    request_sha256,
                    assignment_id,
                    generation,
                    policy_version,
                    recipient,
                    protocol,
                })
                .await
            }
            Request::Bind {
                version: 1,
                operation_id,
                reservation_ref,
                authority_instance_ref,
                provider_binding_ref,
                credential_binding,
                request_sha256,
                assignment_id,
                generation,
                policy_version,
                recipient,
                protocol,
                ip,
                admission_id,
                connection_ref,
            } => {
                self.bind(
                    Operation {
                        operation_id,
                        reservation_ref,
                        authority_instance_ref,
                        provider_binding_ref,
                        credential_binding,
                        request_sha256,
                        assignment_id,
                        generation,
                        policy_version,
                        recipient,
                        protocol,
                    },
                    ip,
                    admission_id,
                    connection_ref,
                )
                .await
            }
            Request::Check {
                version: 1,
                operation_id,
                reservation_ref,
                authority_instance_ref,
                provider_binding_ref,
                credential_binding,
                request_sha256,
                assignment_id,
                generation,
                policy_version,
                recipient,
                protocol,
                ip,
                admission_id,
                connection_ref,
                flow_ref,
            } => {
                self.check(
                    Operation {
                        operation_id,
                        reservation_ref,
                        authority_instance_ref,
                        provider_binding_ref,
                        credential_binding,
                        request_sha256,
                        assignment_id,
                        generation,
                        policy_version,
                        recipient,
                        protocol,
                    },
                    ip,
                    admission_id,
                    connection_ref,
                    flow_ref,
                    false,
                )
                .await
            }
            Request::Release {
                version: 1,
                operation_id,
                reservation_ref,
                authority_instance_ref,
                provider_binding_ref,
                credential_binding,
                request_sha256,
                assignment_id,
                generation,
                policy_version,
                recipient,
                protocol,
                ip,
                admission_id,
                connection_ref,
                flow_ref,
            } => {
                self.check(
                    Operation {
                        operation_id,
                        reservation_ref,
                        authority_instance_ref,
                        provider_binding_ref,
                        credential_binding,
                        request_sha256,
                        assignment_id,
                        generation,
                        policy_version,
                        recipient,
                        protocol,
                    },
                    ip,
                    admission_id,
                    connection_ref,
                    flow_ref,
                    true,
                )
                .await
            }
            _ => Err(denied()),
        }
    }
}
pub fn select_answer(resolved: ReResolveResolved) -> io::Result<(Ipv4Addr, u32)> {
    let (addresses, ttl) = match resolved {
        ReResolveResolved::Resolved {
            terminal_addrs,
            chain_min_ttl,
        } => (terminal_addrs, chain_min_ttl),
        ReResolveResolved::Unresolved => return Err(denied()),
    };
    // Treat mixed public/private answers as poisoned, including CNAME terminals.
    if addresses.is_empty()
        || addresses.len() > 32
        || ttl == 0
        || addresses
            .iter()
            .any(|ip| !is_plumbable(*ip) || !ip.is_ipv4())
    {
        return Err(denied());
    }
    match addresses[0] {
        IpAddr::V4(ip) => Ok((ip, ttl)),
        _ => Err(denied()),
    }
}

fn unix_ms() -> io::Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|_| denied())
}

pub struct Config {
    pub socket: PathBuf,
    pub authority_socket: PathBuf,
    pub upstreams: Vec<SocketAddrV4>,
    pub authority_upstreams: Vec<SocketAddrV4>,
    pub policy_file: PathBuf,
    pub ingress_port: u16,
}
fn safe_socket_parent(path: &Path) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(denied());
    }
    let parent = path.parent().ok_or_else(denied)?;
    let meta = std::fs::symlink_metadata(parent)?;
    if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
        return Err(denied());
    }
    // Ancestors must not be symlinks: production uses immutable scoped mounts.
    for ancestor in parent.ancestors() {
        let ancestor_meta = std::fs::symlink_metadata(ancestor)?;
        if ancestor_meta.file_type().is_symlink()
            || ancestor_meta.mode() & 0o022 != 0
            || ancestor_meta.uid() != 0
        {
            return Err(denied());
        }
    }
    if std::fs::symlink_metadata(path).is_ok() {
        return Err(denied());
    }
    Ok(())
}
fn capabilities() -> io::Result<()> {
    let status = std::fs::read_to_string("/proc/self/status")?;
    let number = |name: &str, radix| -> io::Result<u64> {
        let value = status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .ok_or_else(denied)?
            .trim();
        u64::from_str_radix(value, radix).map_err(|_| denied())
    };
    let net_admin = 1u64 << 12;
    // Enforce the selected custody profile rather than accepting a privileged
    // root process or a deployment that quietly disables no-new-privileges.
    if number("CapEff:", 16)? != net_admin
        || number("CapPrm:", 16)? != net_admin
        || number("CapBnd:", 16)? != net_admin
        || number("CapInh:", 16)? != 0
        || number("CapAmb:", 16)? != 0
        || number("NoNewPrivs:", 10)? != 1
    {
        return Err(denied());
    }
    Ok(())
}

pub async fn run(config: Config) -> io::Result<()> {
    if unsafe { libc::geteuid() } != 0 {
        return Err(denied());
    }
    capabilities()?;
    safe_socket_parent(&config.socket)?;
    // Register all fallible signal sources before any owned task can mutate state.
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let kernel = Arc::new(Kernel::new()?);
    kernel.install(
        &config.upstreams,
        &config.authority_upstreams,
        config.ingress_port,
    )?;
    let service = Arc::new(Service::new(&config, kernel)?);
    let listener = UnixListener::bind(&config.socket)?;
    let identity = std::fs::symlink_metadata(&config.socket)?;
    std::fs::set_permissions(&config.socket, std::fs::Permissions::from_mode(0o666))?;
    let result = serve(
        service,
        listener,
        async {
            tokio::select! { _ = term.recv() => {}, _ = interrupt.recv() => {} }
        },
        10002,
    )
    .await;
    // Every service exit already drained mutation owners and attempted the empty
    // floor. Retain the floor and remove only this producer's exact socket inode.
    let removed = match std::fs::symlink_metadata(&config.socket) {
        Ok(meta)
            if meta.file_type().is_socket()
                && meta.dev() == identity.dev()
                && meta.ino() == identity.ino() =>
        {
            std::fs::remove_file(&config.socket)
        }
        Ok(_) => Err(denied()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    };
    result.and(removed)
}

#[async_trait::async_trait]
trait Acceptor: Send + Sync {
    async fn accept_connection(&self) -> io::Result<tokio::net::UnixStream>;
}
#[async_trait::async_trait]
impl Acceptor for UnixListener {
    async fn accept_connection(&self) -> io::Result<tokio::net::UnixStream> {
        self.accept().await.map(|(connection, _)| connection)
    }
}

async fn serve<F: std::future::Future<Output = ()>>(
    service: Arc<Service>,
    listener: impl Acceptor,
    shutdown: F,
    expected_tls_uid: u32,
) -> io::Result<()> {
    let permits = Arc::new(Semaphore::new(MAX_CLIENTS));
    let maintenance_service = service.clone();
    let stopping = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop = stopping.clone();
    let maintenance = tokio::spawn(async move {
        while !stop.load(std::sync::atomic::Ordering::Acquire) {
            maintenance_service.maintain().await;
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });
    let mut clients = tokio::task::JoinSet::new();
    tokio::pin!(shutdown);
    let outcome = 'accepting: loop {
        let accepted = tokio::select! { value = listener.accept_connection() => value, _ = &mut shutdown => break Ok(()) };
        let mut connection = match accepted {
            Ok(value) => value,
            Err(error) => break Err(error),
        };
        // A bad/unavailable peer credential rejects only this connection. It must
        // never escape the common drain path while another mutation is in flight.
        if !connection
            .peer_cred()
            .is_ok_and(|peer| peer.uid() == expected_tls_uid)
        {
            continue;
        }
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            continue;
        };
        let service = service.clone();
        clients.spawn(async move {
            let _permit = permit;
            // Read/write cancellation cannot cancel a begun kernel mutation.
            let request = tokio::time::timeout(
                Duration::from_millis(200),
                protocol::read_frame::<Request>(&mut connection),
            )
            .await;
            let response = match request {
                Ok(Ok(request)) => service
                    .handle(request)
                    .await
                    .unwrap_or_else(|_| json!({"version":1,"ok":false,"reason":"unavailable"})),
                _ => json!({"version":1,"ok":false,"reason":"unavailable"}),
            };
            let _ = tokio::time::timeout(
                Duration::from_millis(100),
                protocol::write_frame(&mut connection, &response),
            )
            .await;
        });
        while let Some(joined) = clients.try_join_next() {
            if joined.is_err() {
                break 'accepting Err(denied());
            }
        }
    };
    stopping.store(true, std::sync::atomic::Ordering::Release);
    let maintenance_result = maintenance.await.map_err(|_| denied());
    let mut clients_result = Ok(());
    while let Some(joined) = clients.join_next().await {
        if joined.is_err() {
            clients_result = Err(denied());
        }
    }
    let mut state = service.state.lock().await;
    Service::poison(&mut state, None);
    let cleanup = service.retry_cleanup(&mut state).await;
    outcome
        .and(maintenance_result)
        .and(clients_result)
        .and(cleanup)
}

#[cfg(test)]
#[path = "../../tests/oce/state_cases.rs"]
mod state_cases;
