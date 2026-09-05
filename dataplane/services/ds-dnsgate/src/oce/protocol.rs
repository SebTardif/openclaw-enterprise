// Modified for OpenClaw Enterprise.
// Modified for OpenClaw Enterprise: authenticated, bounded admission RPC.
use serde::{Deserialize, Serialize};
use std::{io, path::Path, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};

pub const RPC_TIMEOUT: Duration = Duration::from_millis(900);
pub const MAX_FRAME: usize = 65_536;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Recipient {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}
impl Recipient {
    pub fn fixed(&self) -> bool {
        self.scheme == "https" && self.host == "api.openai.com" && self.port == 443
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
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
    pub fn valid(&self) -> bool {
        [
            &self.provider_binding_ref,
            &self.service_account_id,
            &self.credential_profile_ref,
            &self.provider_profile_ref,
            &self.audience_ref,
            &self.transport_profile_ref,
        ]
        .iter()
        .all(|value| reference(value))
    }
}
pub fn reference(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.is_ascii()
        && !value.bytes().any(|b| b.is_ascii_control())
}
pub fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub operation_id: String,
    pub reservation_ref: String,
    pub authority_instance_ref: String,
    pub provider_binding_ref: String,
    pub credential_binding: CredentialBinding,
    pub request_sha256: String,
    pub assignment_id: String,
    pub generation: u64,
    pub policy_version: u64,
    pub recipient: Recipient,
    pub protocol: String,
}
impl Operation {
    pub fn valid(&self) -> bool {
        [self.operation_id.as_str(), self.assignment_id.as_str()]
            .iter()
            .all(|s| {
                !s.is_empty()
                    && s.len() <= 256
                    && s.is_ascii()
                    && !s.bytes().any(|b| b.is_ascii_control())
            })
            && uuid(&self.assignment_id)
            && uuid(&self.authority_instance_ref)
            && reference(&self.provider_binding_ref)
            && self.credential_binding.valid()
            && self.credential_binding.provider_binding_ref == self.provider_binding_ref
            && self.reservation_ref.len() == 64
            && self
                .reservation_ref
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && self.request_sha256.len() == 64
            && self
                .request_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && self.generation > 0
            && self.generation <= MAX_SAFE_INTEGER
            && self.policy_version > 0
            && self.policy_version <= MAX_SAFE_INTEGER
            && self.recipient.fixed()
            && self.protocol == "tcp"
    }
}
// Explicit variants retain serde's duplicate/unknown-field rejection. Flatten is
// deliberately avoided because it weakens deny_unknown_fields guarantees.
#[derive(Debug, Deserialize)]
#[serde(tag = "method", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "ready")]
    Ready { version: u8 },
    #[serde(rename = "resolve")]
    Resolve {
        version: u8,
        operation_id: String,
        reservation_ref: String,
        authority_instance_ref: String,
        provider_binding_ref: String,
        credential_binding: CredentialBinding,
        request_sha256: String,
        assignment_id: String,
        generation: u64,
        policy_version: u64,
        recipient: Recipient,
        protocol: String,
    },
    #[serde(rename = "bind")]
    Bind {
        version: u8,
        operation_id: String,
        reservation_ref: String,
        authority_instance_ref: String,
        provider_binding_ref: String,
        credential_binding: CredentialBinding,
        request_sha256: String,
        assignment_id: String,
        generation: u64,
        policy_version: u64,
        recipient: Recipient,
        protocol: String,
        ip: String,
        admission_id: String,
        connection_ref: String,
    },
    #[serde(rename = "check")]
    Check {
        version: u8,
        operation_id: String,
        reservation_ref: String,
        authority_instance_ref: String,
        provider_binding_ref: String,
        credential_binding: CredentialBinding,
        request_sha256: String,
        assignment_id: String,
        generation: u64,
        policy_version: u64,
        recipient: Recipient,
        protocol: String,
        ip: String,
        admission_id: String,
        connection_ref: String,
        flow_ref: String,
    },
    #[serde(rename = "release")]
    Release {
        version: u8,
        operation_id: String,
        reservation_ref: String,
        authority_instance_ref: String,
        provider_binding_ref: String,
        credential_binding: CredentialBinding,
        request_sha256: String,
        assignment_id: String,
        generation: u64,
        policy_version: u64,
        recipient: Recipient,
        protocol: String,
        ip: String,
        admission_id: String,
        connection_ref: String,
        flow_ref: String,
    },
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DnsReadyResponse {
    pub version: u8,
    pub ok: bool,
    pub server_time_ms: Option<u64>,
    pub valid_until_ms: Option<u64>,
    pub reason: Option<String>,
}
impl DnsReadyResponse {
    pub fn valid(&self) -> bool {
        self.version == 1
            && self.ok
            && self.reason.is_none()
            && self
                .valid_until_ms
                .zip(self.server_time_ms)
                .is_some_and(|(until, now)| {
                    until <= MAX_SAFE_INTEGER
                        && until
                            .checked_sub(now)
                            .is_some_and(|duration| (1..=5000).contains(&duration))
                })
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityResponse {
    pub version: u8,
    pub ok: bool,
    pub operation_id: Option<String>,
    pub reservation_ref: Option<String>,
    pub assignment_id: Option<String>,
    pub generation: Option<u64>,
    pub policy_version: Option<u64>,
    pub server_time_ms: Option<u64>,
    pub valid_until_ms: Option<u64>,
    pub operation_expires_at_ms: Option<u64>,
    pub dispatch_before_ms: Option<u64>,
    pub authority_profile: Option<String>,
    pub authority_instance_ref: Option<String>,
    pub authority_evidence_ref: Option<String>,
    pub request_sha256: Option<String>,
    pub provider_binding_ref: Option<String>,
    pub credential_binding: Option<CredentialBinding>,
    pub operation_state: Option<String>,
    pub reason: Option<String>,
}
impl AuthorityResponse {
    pub fn duration(&self) -> io::Result<Duration> {
        let duration = self
            .valid_until_ms
            .zip(self.server_time_ms)
            .and_then(|(until, now)| until.checked_sub(now));
        if self.version != 1
            || !self.ok
            || self.reason.is_some()
            || self.authority_profile.as_deref() != Some("oce-delegated-model-v1")
            || !self.authority_instance_ref.as_deref().is_some_and(uuid)
            || !self
                .server_time_ms
                .is_some_and(|time| time <= MAX_SAFE_INTEGER)
            || !self
                .valid_until_ms
                .is_some_and(|time| time <= MAX_SAFE_INTEGER)
        {
            return Err(denied());
        }
        match duration {
            Some(ms @ 1..=5000) => Ok(Duration::from_millis(ms)),
            _ => Err(denied()),
        }
    }
    pub fn ready(&self) -> bool {
        self.operation_id.is_none()
            && self.reservation_ref.is_none()
            && self.assignment_id.is_none()
            && self.generation.is_none()
            && self.policy_version.is_none()
            && self.operation_expires_at_ms.is_none()
            && self.dispatch_before_ms.is_none()
            && self.authority_evidence_ref.is_none()
            && self.request_sha256.is_none()
            && self.provider_binding_ref.is_none()
            && self.credential_binding.is_none()
            && self.operation_state.is_none()
    }
    pub fn matches(&self, op: &Operation) -> bool {
        self.operation_id.as_ref() == Some(&op.operation_id)
            && self.reservation_ref.as_ref() == Some(&op.reservation_ref)
            && self.request_sha256.as_ref() == Some(&op.request_sha256)
            && self.authority_instance_ref.as_ref() == Some(&op.authority_instance_ref)
            && self.authority_evidence_ref.as_deref().is_some_and(uuid)
            && self.provider_binding_ref.as_ref() == Some(&op.provider_binding_ref)
            && self.credential_binding.as_ref() == Some(&op.credential_binding)
            && match self.operation_state.as_deref() {
                Some("accepted") => self
                    .dispatch_before_ms
                    .zip(self.valid_until_ms)
                    .is_some_and(|(dispatch, until)| dispatch >= until),
                Some("dispatched") => true,
                _ => false,
            }
            && self.assignment_id.as_ref() == Some(&op.assignment_id)
            && self.generation == Some(op.generation)
            && self.policy_version == Some(op.policy_version)
            && self
                .operation_expires_at_ms
                .zip(self.valid_until_ms)
                .is_some_and(|(expiry, until)| expiry >= until && expiry <= MAX_SAFE_INTEGER)
            && self
                .dispatch_before_ms
                .zip(self.operation_expires_at_ms)
                .is_some_and(|(dispatch, expiry)| dispatch > 0 && dispatch <= expiry)
    }
}
pub fn denied() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "admission unavailable")
}
pub async fn read_frame<T: serde::de::DeserializeOwned>(stream: &mut UnixStream) -> io::Result<T> {
    let length = stream.read_u32().await? as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(denied());
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(|_| denied())
}
pub async fn write_frame<T: Serialize>(stream: &mut UnixStream, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| denied())?;
    if bytes.len() > MAX_FRAME {
        return Err(denied());
    }
    stream.write_u32(bytes.len() as u32).await?;
    stream.write_all(&bytes).await?;
    stream.flush().await
}
pub struct AuthorityObservation {
    pub response: AuthorityResponse,
    pub started: std::time::Instant,
    pub deadline: std::time::Instant,
}
pub async fn authority(
    path: &Path,
    operation: Option<&Operation>,
) -> io::Result<AuthorityObservation> {
    authority_from(path, operation, 10003).await
}
// The expected producer role is fixed by the production wrapper. Component tests
// use the same framed consumer with an explicitly identified local fixture UID;
// that fixture is not a canonical authority implementation.
pub(super) async fn authority_from(
    path: &Path,
    operation: Option<&Operation>,
    expected_uid: u32,
) -> io::Result<AuthorityObservation> {
    let started = std::time::Instant::now();
    tokio::time::timeout(RPC_TIMEOUT, async {
        let mut stream = UnixStream::connect(path).await?;
        if stream.peer_cred()?.uid() != expected_uid { return Err(denied()); }
        let request = match operation {
            Some(op) => serde_json::json!({"version":1,"method":"inspect","operation_id":op.operation_id,"request_sha256":op.request_sha256}),
            None => serde_json::json!({"version":1,"method":"ready"}),
        };
        write_frame(&mut stream, &request).await?;
        let response: AuthorityResponse = read_frame(&mut stream).await?;
        let deadline = started.checked_add(response.duration()?).ok_or_else(denied)?;
        if deadline <= std::time::Instant::now() || operation.is_some_and(|op| !response.matches(op)) || (operation.is_none() && !response.ready()) { return Err(denied()); }
        Ok(AuthorityObservation { response, started, deadline })
    }).await.map_err(|_| denied())?
}
pub async fn probe(path: &Path) -> io::Result<()> {
    probe_from(path, 0).await
}
pub(super) async fn probe_from(path: &Path, expected_uid: u32) -> io::Result<()> {
    let started = std::time::Instant::now();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        let mut stream = UnixStream::connect(path).await?;
        if stream.peer_cred()?.uid() != expected_uid {
            return Err(denied());
        }
        write_frame(
            &mut stream,
            &serde_json::json!({"version":1,"method":"ready"}),
        )
        .await?;
        let response: DnsReadyResponse = read_frame(&mut stream).await?;
        if !response.valid() {
            return Err(denied());
        }
        let duration = response
            .valid_until_ms
            .and_then(|until| until.checked_sub(response.server_time_ms?))
            .ok_or_else(denied)?;
        let deadline = started
            .checked_add(Duration::from_millis(duration))
            .ok_or_else(denied)?;
        if std::time::Instant::now() >= deadline {
            return Err(denied());
        }
        Ok(())
    })
    .await
    .map_err(|_| denied())?
}
