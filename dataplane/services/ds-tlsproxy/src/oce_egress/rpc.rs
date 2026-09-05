// Modified for OpenClaw Enterprise.
//! Required authenticated-owner RPC client. This module grants no local authority.
use super::{json, Refusal};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use socket2::{Domain, SockAddr, Socket, Type};
use std::{
    io::{Read, Write},
    net::IpAddr,
    os::unix::{fs::MetadataExt, io::AsRawFd, net::UnixStream},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const RPC_LIMIT: usize = 2 * 1024 * 1024;
const RESPONSE_LIMIT: usize = 64 * 1024;
pub(super) const RPC_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub(super) struct Rpc {
    pub path: PathBuf,
    pub peer_uid: u32,
    pub authority: bool,
}
impl Rpc {
    pub fn call(&self, request: &Value) -> Result<(Value, Instant), Refusal> {
        self.call_until(request, Instant::now() + RPC_TIMEOUT)
    }
    pub fn call_until(
        &self,
        request: &Value,
        outer_deadline: Instant,
    ) -> Result<(Value, Instant), Refusal> {
        let start = Instant::now();
        let deadline = outer_deadline.min(start + RPC_TIMEOUT);
        let parent = std::fs::symlink_metadata(self.path.parent().ok_or(Refusal::Configuration)?)
            .map_err(|_| Refusal::Dependency)?;
        let endpoint = std::fs::symlink_metadata(&self.path).map_err(|_| Refusal::Dependency)?;
        if !parent.is_dir()
            || parent.uid() != self.peer_uid
            || parent.mode() & 0o022 != 0
            || endpoint.file_type().is_symlink()
            || endpoint.uid() != self.peer_uid
        {
            return Err(Refusal::Denied);
        }
        let socket =
            Socket::new(Domain::UNIX, Type::STREAM, None).map_err(|_| Refusal::Dependency)?;
        let addr = SockAddr::unix(Path::new(&self.path)).map_err(|_| Refusal::Dependency)?;
        socket
            .connect_timeout(&addr, remaining(deadline)?)
            .map_err(|_| Refusal::Dependency)?;
        let mut stream: UnixStream = socket.into();
        let peer = nix::sys::socket::getsockopt(
            stream.as_raw_fd(),
            nix::sys::socket::sockopt::PeerCredentials,
        )
        .map_err(|_| Refusal::Denied)?;
        if peer.uid() != self.peer_uid {
            return Err(Refusal::Denied);
        }
        let data = Zeroizing::new(serde_json::to_vec(request).map_err(|_| Refusal::Malformed)?);
        if data.len() > RPC_LIMIT {
            return Err(Refusal::Bounds);
        }
        let mut framed = Zeroizing::new(Vec::with_capacity(data.len() + 4));
        framed.extend_from_slice(&(data.len() as u32).to_be_bytes());
        framed.extend_from_slice(&data);
        let mut offset = 0;
        while offset < framed.len() {
            stream
                .set_write_timeout(Some(remaining(deadline)?))
                .map_err(|_| Refusal::Dependency)?;
            let n = stream
                .write(&framed[offset..])
                .map_err(|_| Refusal::Dependency)?;
            if n == 0 {
                return Err(Refusal::Dependency);
            }
            offset += n;
        }
        let mut size = [0; 4];
        read_exact(&mut stream, &mut size, deadline)?;
        let len = u32::from_be_bytes(size) as usize;
        if len == 0 || len > RESPONSE_LIMIT {
            return Err(Refusal::Bounds);
        }
        let mut data = vec![0; len];
        read_exact(&mut stream, &mut data, deadline)?;
        remaining(deadline)?;
        let response = json::parse(&data)?;
        if response.get("version").and_then(Value::as_u64) != Some(1)
            || response.get("ok").and_then(Value::as_bool) != Some(true)
        {
            return Err(Refusal::Denied);
        }
        if self.authority && request.get("method").and_then(Value::as_str) == Some("complete") {
            exact_keys(&response, &["version", "ok"])?;
        }
        Ok((response, start))
    }
    pub fn ready(&self) -> Result<Lease, Refusal> {
        let (v, start) = self.call(&json!({"version":1,"method":"ready"}))?;
        if self.authority {
            exact_keys(
                &v,
                &[
                    "version",
                    "ok",
                    "authority_profile",
                    "authority_instance_ref",
                    "server_time_ms",
                    "valid_until_ms",
                ],
            )?;
            authority_profile(&v)?;
        }
        lease(&v, start)
    }
}
fn read_exact(
    stream: &mut UnixStream,
    mut buf: &mut [u8],
    deadline: Instant,
) -> Result<(), Refusal> {
    while !buf.is_empty() {
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|_| Refusal::Dependency)?;
        let n = stream.read(buf).map_err(|_| Refusal::Dependency)?;
        if n == 0 {
            return Err(Refusal::Dependency);
        }
        buf = &mut buf[n..];
    }
    Ok(())
}
fn remaining(deadline: Instant) -> Result<Duration, Refusal> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or(Refusal::Timeout)
}

#[derive(Clone, Copy)]
pub(super) struct Lease {
    pub deadline: Instant,
}
impl Lease {
    pub fn current(&self) -> Result<(), Refusal> {
        remaining(self.deadline).map(|_| ())
    }
}
pub(super) fn lease(v: &Value, start: Instant) -> Result<Lease, Refusal> {
    let now = safe_number(v, "server_time_ms")?;
    let until = safe_number(v, "valid_until_ms")?;
    let ttl = until
        .checked_sub(now)
        .filter(|n| *n > 0 && *n <= 5000)
        .ok_or(Refusal::Denied)?;
    let result = Lease {
        deadline: start + Duration::from_millis(ttl),
    };
    result.current()?;
    Ok(result)
}
pub(super) fn safe_number(v: &Value, key: &str) -> Result<u64, Refusal> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
        .ok_or(Refusal::Malformed)
}

#[derive(Clone, PartialEq, Eq, Serialize)]
pub(super) struct Binding {
    pub authority_instance_ref: String,
    pub request_sha256: String,
    pub credential_binding: CredentialBinding,
    pub operation_id: String,
    pub reservation_ref: String,
    pub provider_binding_ref: String,
    pub dispatch_before_ms: u64,
    pub operation_expires_at_ms: u64,
    pub assignment_id: String,
    pub generation: u64,
    pub policy_version: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialBinding {
    pub provider_binding_ref: String,
    pub service_account_id: String,
    pub credential_profile_ref: String,
    pub provider_profile_ref: String,
    pub audience_ref: String,
    pub transport_profile_ref: String,
}
impl CredentialBinding {
    pub fn validate(&self) -> Result<(), Refusal> {
        for v in [
            &self.provider_binding_ref,
            &self.service_account_id,
            &self.credential_profile_ref,
            &self.provider_profile_ref,
            &self.audience_ref,
            &self.transport_profile_ref,
        ] {
            if v.is_empty() || v.len() > 128 || !v.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
                return Err(Refusal::Malformed);
            }
        }
        Ok(())
    }
}
fn exact_keys(v: &Value, keys: &[&str]) -> Result<(), Refusal> {
    let map = v.as_object().ok_or(Refusal::Malformed)?;
    if map.len() != keys.len() || keys.iter().any(|k| !map.contains_key(*k)) {
        return Err(Refusal::Malformed);
    }
    Ok(())
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn authority_profile(v: &Value) -> Result<String, Refusal> {
    if v.get("authority_profile").and_then(Value::as_str) != Some("oce-delegated-model-v1") {
        return Err(Refusal::Denied);
    }
    let instance = json::bounded_str(v, "authority_instance_ref", 36)?;
    if !uuid(instance) {
        return Err(Refusal::Malformed);
    }
    Ok(instance.to_owned())
}
impl Binding {
    pub fn parse(v: &Value) -> Result<Self, Refusal> {
        exact_keys(
            v,
            &[
                "version",
                "ok",
                "authority_profile",
                "authority_instance_ref",
                "authority_evidence_ref",
                "operation_id",
                "reservation_ref",
                "request_sha256",
                "assignment_id",
                "generation",
                "policy_version",
                "provider_binding_ref",
                "credential_binding",
                "operation_state",
                "dispatch_before_ms",
                "operation_expires_at_ms",
                "server_time_ms",
                "valid_until_ms",
            ],
        )?;
        let instance = authority_profile(v)?;
        if !uuid(json::bounded_str(v, "authority_evidence_ref", 36)?) {
            return Err(Refusal::Malformed);
        }
        let reservation = json::bounded_str(v, "reservation_ref", 64)?;
        let digest = json::bounded_str(v, "request_sha256", 64)?;
        let assignment = json::bounded_str(v, "assignment_id", 36)?;
        if !hex64(reservation) || !hex64(digest) || !uuid(assignment) {
            return Err(Refusal::Malformed);
        }
        let credential: CredentialBinding = serde_json::from_value(
            v.get("credential_binding")
                .ok_or(Refusal::Malformed)?
                .clone(),
        )
        .map_err(|_| Refusal::Malformed)?;
        credential.validate()?;
        let provider = json::bounded_str(v, "provider_binding_ref", 128)?;
        if credential.provider_binding_ref != provider {
            return Err(Refusal::Denied);
        }
        let before = safe_number(v, "dispatch_before_ms")?;
        let expires = safe_number(v, "operation_expires_at_ms")?;
        let until = safe_number(v, "valid_until_ms")?;
        let state = v
            .get("operation_state")
            .and_then(Value::as_str)
            .ok_or(Refusal::Malformed)?;
        if !matches!(state, "accepted" | "dispatched")
            || expires < before
            || until > expires
            || (state == "accepted" && until > before)
        {
            return Err(Refusal::Denied);
        }
        Ok(Self {
            authority_instance_ref: instance,
            request_sha256: digest.into(),
            credential_binding: credential,
            operation_id: json::bounded_str(v, "operation_id", 128)?.into(),
            reservation_ref: reservation.into(),
            provider_binding_ref: provider.into(),
            dispatch_before_ms: before,
            operation_expires_at_ms: expires,
            assignment_id: assignment.into(),
            generation: safe_number(v, "generation")?,
            policy_version: safe_number(v, "policy_version")?,
        })
    }
}

pub(super) struct Admission {
    pub ip: IpAddr,
    pub id: String,
    pub lease: Lease,
    pub connection_ref: Option<String>,
    pub flow_ref: Option<String>,
}
impl Admission {
    pub fn parse(v: &Value, start: Instant, binding: &Binding) -> Result<Self, Refusal> {
        if json::bounded_str(v, "assignment_id", 256)? != binding.assignment_id
            || safe_number(v, "generation")? != binding.generation
            || safe_number(v, "policy_version")? != binding.policy_version
        {
            return Err(Refusal::Denied);
        }
        let ip = json::bounded_str(v, "ip", 64)?
            .parse()
            .map_err(|_| Refusal::Malformed)?;
        if !matches!(ip, IpAddr::V4(_)) {
            return Err(Refusal::Unsupported);
        }
        Ok(Self {
            connection_ref: None,
            flow_ref: None,
            ip,
            id: json::bounded_str(v, "admission_id", 128)?.to_owned(),
            lease: lease(v, start)?,
        })
    }
}
