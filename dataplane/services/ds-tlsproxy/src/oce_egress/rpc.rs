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
use zeroize::Zeroize;

const RPC_LIMIT: usize = 2 * 1024 * 1024;
// Validated JSON text expands by at most 2x in this closed envelope. The
// remaining fields need at most 17,028 bytes, including escaped credentials.
const ADMISSION_LIMIT: usize = 32 * 1024 * 1024 + 64 * 1024;
const RESPONSE_LIMIT: usize = 64 * 1024;
pub(super) const RPC_TIMEOUT: Duration = Duration::from_secs(1);

pub(super) struct AdmissionRequest<'a> {
    pub reservation_ref: &'a str,
    pub provider_binding_ref: &'a str,
    pub workload_credential: &'a str,
    pub mediation_context: &'a str,
    pub request_body: &'a str,
    pub request_sha256: &'a str,
}

#[derive(Serialize)]
struct AdmissionEnvelope<'a> {
    version: u8,
    method: &'static str,
    reservation_ref: &'a str,
    provider_binding_ref: &'a str,
    workload_credential: &'a str,
    mediation_context: &'a str,
    request_body: &'a str,
    request_sha256: &'a str,
    recipient: AdmissionRecipient,
    operation: &'static str,
}

#[derive(Serialize)]
struct AdmissionRecipient {
    scheme: &'static str,
    host: &'static str,
    port: u16,
}

impl AdmissionRequest<'_> {
    fn envelope(&self) -> AdmissionEnvelope<'_> {
        AdmissionEnvelope {
            version: 1,
            method: "admit",
            reservation_ref: self.reservation_ref,
            provider_binding_ref: self.provider_binding_ref,
            workload_credential: self.workload_credential,
            mediation_context: self.mediation_context,
            request_body: self.request_body,
            request_sha256: self.request_sha256,
            recipient: AdmissionRecipient {
                scheme: "https",
                host: super::FIXED_HOST,
                port: 443,
            },
            operation: "responses.create",
        }
    }
}

// One owned allocation for an encoded RPC. No Vec, Clone, or growth interface
// escapes the encoder; mutable access exposes only already initialized bytes.
struct RpcFrame {
    bytes: Vec<u8>,
    #[cfg(test)]
    erasure_observer: Option<std::sync::Arc<std::sync::Mutex<tests::FrameErasureObservation>>>,
}

impl std::ops::Deref for RpcFrame {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        self.bytes.as_slice()
    }
}

impl std::ops::DerefMut for RpcFrame {
    fn deref_mut(&mut self) -> &mut [u8] {
        self.bytes.as_mut_slice()
    }
}

impl Drop for RpcFrame {
    fn drop(&mut self) {
        // These disjoint slices cover the entire allocation exactly once.
        // Keep len intact: clearing first would overlap the initialized region
        // with spare capacity. Both pinned Zeroize slice APIs use volatile wipes.
        self.bytes.as_mut_slice().zeroize();
        self.bytes.spare_capacity_mut().zeroize();
        #[cfg(test)]
        if let Some(observer) = &self.erasure_observer {
            tests::observe_frame_erasure(observer, &self.bytes);
        }
    }
}

#[cfg(test)]
impl RpcFrame {
    fn capacity(&self) -> usize {
        self.bytes.capacity()
    }
}

#[derive(Clone)]
pub(super) struct Rpc {
    pub path: PathBuf,
    pub peer_uid: u32,
    pub authority: bool,
}
impl Rpc {
    pub fn admit(&self, request: &AdmissionRequest<'_>) -> Result<(Value, Instant), Refusal> {
        let start = Instant::now();
        if !self.authority {
            return Err(Refusal::Denied);
        }
        let deadline = start + RPC_TIMEOUT;
        let framed = encode_admission(request, ADMISSION_LIMIT, deadline)?;
        self.exchange(framed, start, deadline, false)
    }
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
        let framed = encode_frame(request, RPC_LIMIT, deadline)?;
        let complete =
            self.authority && request.get("method").and_then(Value::as_str) == Some("complete");
        self.exchange(framed, start, deadline, complete)
    }
    fn exchange(
        &self,
        framed: RpcFrame,
        start: Instant,
        deadline: Instant,
        complete: bool,
    ) -> Result<(Value, Instant), Refusal> {
        remaining(deadline)?;
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
        drop(framed);
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
        if complete {
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

// Ordinary RPCs retain canonical counting of the complete request. Admission
// counts its large body directly, but both paths emit the original request with
// serde_json into the same measured, fallibly allocated frame. Deadline gates
// do not preempt synchronous work; a late result cannot reach the socket.
fn encode_frame<T: Serialize>(
    request: &T,
    limit: usize,
    deadline: Instant,
) -> Result<RpcFrame, Refusal> {
    remaining(deadline)?;
    let mut counter = FrameCounter {
        len: 0,
        limit,
        exceeded: false,
    };
    serde_json::to_writer(&mut counter, request).map_err(|_| {
        if counter.exceeded {
            Refusal::Bounds
        } else {
            Refusal::Malformed
        }
    })?;
    encode_counted_frame(request, limit, counter.len, deadline)
}

fn encode_admission(
    request: &AdmissionRequest<'_>,
    limit: usize,
    deadline: Instant,
) -> Result<RpcFrame, Refusal> {
    #[cfg(test)]
    tests::record_encoder_phase(tests::EncoderPhase::AdmissionEntered);
    remaining(deadline)?;
    let limit = limit.min(ADMISSION_LIMIT);
    let mut envelope = request.envelope();
    // The canonical small-envelope count already includes the body's quotes.
    // Every metadata field remains borrowed from this same original request.
    envelope.request_body = "";
    let mut counter = FrameCounter {
        len: 0,
        limit,
        exceeded: false,
    };
    serde_json::to_writer(&mut counter, &envelope).map_err(|_| {
        if counter.exceeded {
            Refusal::Bounds
        } else {
            Refusal::Malformed
        }
    })?;
    #[cfg(test)]
    tests::record_encoder_phase(tests::EncoderPhase::MetadataCounted);
    let available = limit.checked_sub(counter.len).ok_or(Refusal::Bounds)?;
    let content_len = escaped_content_len(request.request_body, available)?;
    #[cfg(test)]
    tests::record_encoder_phase(tests::EncoderPhase::ContentCounted);
    let payload_len = counter
        .len
        .checked_add(content_len)
        .ok_or(Refusal::Bounds)?;
    envelope.request_body = request.request_body;
    encode_counted_frame(&envelope, limit, payload_len, deadline)
}

fn escaped_content_len(value: &str, limit: usize) -> Result<usize, Refusal> {
    let mut len = value.len();
    if len > limit {
        return Err(Refusal::Bounds);
    }
    for chunk in value.as_bytes().chunks(4096) {
        // At most 4096 * 5 extra bytes fit in this local sum. The complete
        // content length is still checked before allocation or socket I/O.
        let mut extra = 0usize;
        for &byte in chunk {
            // serde_json copies all other UTF-8 bytes unchanged. Enclosing
            // quotes belong to the separately counted canonical envelope.
            extra += match byte {
                b'"' | b'\\' | b'\x08' | b'\t' | b'\n' | b'\x0c' | b'\r' => 1,
                0x00..=0x1f => 5,
                _ => 0,
            };
        }
        len = len
            .checked_add(extra)
            .filter(|len| *len <= limit)
            .ok_or(Refusal::Bounds)?;
    }
    Ok(len)
}

fn zeroed_frame(frame_len: usize) -> Result<RpcFrame, Refusal> {
    static ZERO_BLOCK: [u8; 4096] = [0; 4096];
    let mut frame = RpcFrame {
        bytes: Vec::new(),
        #[cfg(test)]
        erasure_observer: None,
    };
    frame
        .bytes
        .try_reserve_exact(frame_len)
        .map_err(|_| Refusal::Bounds)?;
    // Initialize the complete reserved frame before exposing it to the writer.
    // Every append fits the reserved capacity and copies only public zeros.
    while frame.len() < frame_len {
        let count = (frame_len - frame.len()).min(ZERO_BLOCK.len());
        frame.bytes.extend_from_slice(&ZERO_BLOCK[..count]);
    }
    Ok(frame)
}

fn encode_counted_frame<T: Serialize>(
    request: &T,
    limit: usize,
    measured_len: usize,
    deadline: Instant,
) -> Result<RpcFrame, Refusal> {
    #[cfg(test)]
    tests::record_encoder_phase(tests::EncoderPhase::AllocationGate);
    remaining(deadline)?;
    if measured_len > limit {
        return Err(Refusal::Bounds);
    }
    let payload_len = u32::try_from(measured_len).map_err(|_| Refusal::Bounds)?;
    let frame_len = measured_len.checked_add(4).ok_or(Refusal::Bounds)?;
    let mut frame = zeroed_frame(frame_len)?;
    frame[..4].copy_from_slice(&payload_len.to_be_bytes());
    #[cfg(test)]
    tests::record_encoder_phase(tests::EncoderPhase::FrameInitialized);
    let mut writer = FrameWriter {
        payload: &mut frame[4..],
        offset: 0,
        exceeded: false,
    };
    serde_json::to_writer(&mut writer, request).map_err(|_| {
        if writer.exceeded {
            Refusal::Bounds
        } else {
            Refusal::Malformed
        }
    })?;
    #[cfg(test)]
    tests::record_encoder_phase(tests::EncoderPhase::CanonicalEmissionFinished);
    if writer.offset != measured_len || writer.offset > limit {
        return Err(Refusal::Bounds);
    }
    #[cfg(test)]
    tests::record_encoder_phase(tests::EncoderPhase::FinalDeadlineGate);
    remaining(deadline)?;
    #[cfg(test)]
    tests::record_encoder_phase(tests::EncoderPhase::FrameReturned);
    Ok(frame)
}

struct FrameCounter {
    len: usize,
    limit: usize,
    exceeded: bool,
}
impl Write for FrameCounter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.write_all(buf)?;
        Ok(buf.len())
    }
    // Every fragment is accepted in full or refused; no partial-write loop is needed.
    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        match self
            .len
            .checked_add(buf.len())
            .filter(|len| *len <= self.limit)
        {
            Some(len) => {
                self.len = len;
                Ok(())
            }
            None => {
                self.exceeded = true;
                Err(std::io::ErrorKind::InvalidData.into())
            }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct FrameWriter<'a> {
    payload: &'a mut [u8],
    offset: usize,
    exceeded: bool,
}
impl Write for FrameWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.write_all(buf)?;
        Ok(buf.len())
    }
    #[inline(always)]
    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        if self.offset > self.payload.len() || buf.len() > self.payload.len() - self.offset {
            self.exceeded = true;
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        // The guard proves subtraction and addition cannot overflow, and the
        // entire fragment fits. No bytes or offset change on a refused write.
        let end = self.offset + buf.len();
        self.payload[self.offset..end].copy_from_slice(buf);
        self.offset = end;
        Ok(())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};

    #[derive(Clone, Copy)]
    pub(super) enum EncoderPhase {
        AdmissionEntered,
        MetadataCounted,
        ContentCounted,
        AllocationGate,
        FrameInitialized,
        CanonicalEmissionFinished,
        FinalDeadlineGate,
        FrameReturned,
        CallReturned,
    }
    const ENCODER_PHASES: [(EncoderPhase, &str); 9] = [
        (EncoderPhase::AdmissionEntered, "admission_entered"),
        (EncoderPhase::MetadataCounted, "metadata_counted"),
        (EncoderPhase::ContentCounted, "content_counted"),
        (EncoderPhase::AllocationGate, "allocation_gate"),
        (EncoderPhase::FrameInitialized, "frame_initialized"),
        (
            EncoderPhase::CanonicalEmissionFinished,
            "canonical_emission_finished",
        ),
        (EncoderPhase::FinalDeadlineGate, "final_deadline_gate"),
        (EncoderPhase::FrameReturned, "frame_returned"),
        (EncoderPhase::CallReturned, "call_returned"),
    ];
    struct EncoderTrace {
        started: Instant,
        elapsed: [Option<Duration>; 9],
        invalid: bool,
    }
    impl EncoderTrace {
        fn record(&mut self, phase: EncoderPhase) {
            let slot = &mut self.elapsed[phase as usize];
            if slot.is_some() {
                self.invalid = true;
                return;
            }
            *slot = Instant::now().checked_duration_since(self.started);
            self.invalid |= slot.is_none();
        }
        fn report(&self) {
            // Exactly nine fixed metadata rows, after the original call returns.
            // Missing phases remain unobserved, including on an error return.
            for (phase, label) in ENCODER_PHASES {
                let elapsed_us = self.elapsed[phase as usize].map(|time| time.as_micros());
                eprintln!(
                    "proxy_encoder_phase phase={label} elapsed_us={elapsed_us:?} trace_invalid={}",
                    self.invalid
                );
            }
        }
    }
    std::thread_local! {
        static ENCODER_TRACE: std::cell::RefCell<Option<EncoderTrace>> = const {
            std::cell::RefCell::new(None)
        };
    }
    pub(super) fn record_encoder_phase(phase: EncoderPhase) {
        ENCODER_TRACE.with(|slot| {
            if let Some(trace) = slot.borrow_mut().as_mut() {
                trace.record(phase);
            }
        });
    }
    struct EncoderTraceGuard;
    impl EncoderTraceGuard {
        fn start(started: Instant) -> Self {
            ENCODER_TRACE.with(|slot| {
                let mut slot = slot.borrow_mut();
                assert!(
                    slot.is_none(),
                    "encoder trace already active on this thread"
                );
                *slot = Some(EncoderTrace {
                    started,
                    elapsed: [None; 9],
                    invalid: false,
                });
            });
            Self
        }
        fn finish(self) -> EncoderTrace {
            let mut trace =
                ENCODER_TRACE.with(|slot| slot.borrow_mut().take().expect("encoder trace missing"));
            trace.record(EncoderPhase::CallReturned);
            trace
        }
    }
    impl Drop for EncoderTraceGuard {
        fn drop(&mut self) {
            // Clear activation during assertion unwinding as well as success.
            ENCODER_TRACE.with(|slot| {
                slot.borrow_mut().take();
            });
        }
    }

    #[derive(Default)]
    pub(super) struct FrameErasureObservation {
        drops: usize,
        initialized: usize,
        spare: usize,
        capacity: usize,
        initialized_zero: bool,
    }

    pub(super) fn observe_frame_erasure(
        observer: &std::sync::Arc<std::sync::Mutex<FrameErasureObservation>>,
        bytes: &Vec<u8>,
    ) {
        // Observe while the allocation is still owned, after both actual wipes.
        // Never read spare/uninitialized storage or retain plaintext bytes.
        if let Ok(mut observed) = observer.lock() {
            observed.drops = observed.drops.saturating_add(1);
            observed.initialized = bytes.len();
            observed.capacity = bytes.capacity();
            observed.spare = bytes.capacity() - bytes.len();
            observed.initialized_zero = bytes.iter().all(|byte| *byte == 0);
        }
    }

    fn frame_with_erasure_observer(
        length: usize,
        extra_capacity: usize,
    ) -> (
        RpcFrame,
        std::sync::Arc<std::sync::Mutex<FrameErasureObservation>>,
    ) {
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(length.checked_add(extra_capacity).unwrap())
            .unwrap();
        let capacity = bytes.capacity();
        // Seed the complete allocation while it is initialized; truncation
        // leaves a formerly initialized nonzero canary in logical spare space.
        bytes.resize(capacity, b'x');
        bytes.truncate(length);
        let observed =
            std::sync::Arc::new(std::sync::Mutex::new(FrameErasureObservation::default()));
        (
            RpcFrame {
                bytes,
                erasure_observer: Some(observed.clone()),
            },
            observed,
        )
    }

    fn assert_frame_erased(
        observed: &std::sync::Arc<std::sync::Mutex<FrameErasureObservation>>,
        length: usize,
        capacity: usize,
    ) {
        let observed = observed.lock().unwrap();
        assert_eq!(observed.drops, 1);
        assert_eq!(observed.initialized, length);
        assert_eq!(observed.capacity, capacity);
        assert_eq!(observed.spare, capacity - length);
        assert_eq!(observed.initialized + observed.spare, capacity);
        assert!(observed.initialized_zero);
        // Spare contents are covered by the pinned safe MaybeUninit slice API;
        // this observation intentionally makes no uninitialized-memory read.
    }

    #[test]
    fn frame_owner_erases_initialized_and_spare_capacity_on_drop() {
        for (length, extra) in [(0, 0), (0, 31), (1, 31), (17, 0), (4097, 31)] {
            let (mut frame, observed) = frame_with_erasure_observer(length, extra);
            let pointer = frame.as_ptr();
            let capacity = frame.capacity();
            frame.fill(b's');
            assert_eq!(frame.as_ptr(), pointer);
            assert_eq!(frame.capacity(), capacity);
            // Moving a successful owned result neither exposes nor reallocates it.
            let returned: Result<RpcFrame, Refusal> = Ok(frame);
            let returned = returned.unwrap();
            assert_eq!(returned.as_ptr(), pointer);
            assert_eq!(observed.lock().unwrap().drops, 0);
            drop(returned);
            assert_frame_erased(&observed, length, capacity);
        }
        // Exercise the actual encoder allocation helper, retaining its capacity.
        let mut frame = zeroed_frame(31).unwrap();
        let observed =
            std::sync::Arc::new(std::sync::Mutex::new(FrameErasureObservation::default()));
        frame.erasure_observer = Some(observed.clone());
        frame.fill(b'q');
        let capacity = frame.capacity();
        drop(frame);
        assert_frame_erased(&observed, 31, capacity);
    }

    #[test]
    fn frame_owner_erases_on_error_and_unwind() {
        fn return_error(frame: RpcFrame) -> Result<(), Refusal> {
            let _owned = frame;
            Err(Refusal::Malformed)
        }
        for (length, extra) in [(0, 23), (13, 31), (4097, 0)] {
            let (frame, observed) = frame_with_erasure_observer(length, extra);
            let capacity = frame.capacity();
            assert!(matches!(return_error(frame), Err(Refusal::Malformed)));
            assert_frame_erased(&observed, length, capacity);

            let (frame, observed) = frame_with_erasure_observer(length, extra);
            let capacity = frame.capacity();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let _owned = frame;
                panic!("controlled frame-owner unwind");
            }));
            assert!(result.is_err());
            assert_frame_erased(&observed, length, capacity);
        }
    }

    fn admission_count_inputs() -> Vec<String> {
        vec![
            String::new(),
            (0u8..=127).map(char::from).collect(),
            "\"\\\x08\t\n\x0c\r".repeat(4),
            "a".repeat(4096),
            "é中🙂\u{2028}\u{2029}/\x7f".to_owned(),
            format!("{}\"\t\\{}", "a".repeat(127), "é".repeat(65)),
            format!("{}\t\0\\é", "a".repeat(4095)),
            "\0".repeat(4097),
            format!("{}é🙂", "a".repeat(4095)),
            format!("{}\n{}", "é".repeat(2047), "\"\\".repeat(2049)),
        ]
    }

    #[test]
    fn admission_content_count_matches_serde_for_controls_and_utf8() {
        for value in admission_count_inputs() {
            // These small primitive inputs do not duplicate a maximum-size body.
            let canonical = serde_json::to_vec(&value).unwrap();
            let expected = canonical.len().checked_sub(2).unwrap();
            assert_eq!(escaped_content_len(&value, expected).unwrap(), expected);
            assert_eq!(escaped_content_len(&value, usize::MAX).unwrap(), expected);
            if expected != 0 {
                assert!(matches!(
                    escaped_content_len(&value, expected - 1),
                    Err(Refusal::Bounds)
                ));
            }
        }
        for (left, right) in [
            ("\"", "\\"),
            ("\n", "é"),
            ("中", "\u{2028}"),
            ("plain", "\0"),
        ] {
            let combined = format!("{left}{right}");
            let expected = escaped_content_len(left, usize::MAX)
                .unwrap()
                .checked_add(escaped_content_len(right, usize::MAX).unwrap())
                .unwrap();
            assert_eq!(escaped_content_len(&combined, expected).unwrap(), expected);
            assert_eq!(serde_json::to_vec(&combined).unwrap().len(), expected + 2);
        }
    }

    struct CanonicalComparison<'a> {
        expected: &'a [u8],
        offset: usize,
    }
    impl Write for CanonicalComparison<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let end = self
                .offset
                .checked_add(bytes.len())
                .ok_or(std::io::ErrorKind::InvalidData)?;
            if self.expected.get(self.offset..end) != Some(bytes) {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            self.offset = end;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn admission_encoder_matches_canonical_envelope_at_exact_limit() {
        for (index, body) in admission_count_inputs().iter().enumerate() {
            let reservation = format!("{index:064x}");
            let provider = format!("provider-{index}");
            let credential = format!("workload-{index}-\"\\");
            let context = format!("context-{index}");
            let digest = format!("{:064x}", index + 16);
            let admission = AdmissionRequest {
                reservation_ref: &reservation,
                provider_binding_ref: &provider,
                workload_credential: &credential,
                mediation_context: &context,
                request_body: body,
                request_sha256: &digest,
            };
            let mut canonical_count = FrameCounter {
                len: 0,
                limit: ADMISSION_LIMIT,
                exceeded: false,
            };
            serde_json::to_writer(&mut canonical_count, &admission.envelope()).unwrap();
            let expected = canonical_count.len;
            let frame =
                encode_admission(&admission, expected, Instant::now() + RPC_TIMEOUT).unwrap();
            assert_eq!(frame.len(), expected + 4);
            assert_eq!(
                u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize,
                expected
            );
            // Compare canonical emission directly to the one existing frame.
            let mut comparison = CanonicalComparison {
                expected: &frame[4..],
                offset: 0,
            };
            serde_json::to_writer(&mut comparison, &admission.envelope()).unwrap();
            assert_eq!(comparison.offset, expected);
            assert!(matches!(
                encode_admission(&admission, expected - 1, Instant::now() + RPC_TIMEOUT),
                Err(Refusal::Bounds)
            ));
            assert!(matches!(
                encode_admission(&admission, expected, Instant::now()),
                Err(Refusal::Timeout)
            ));
        }
    }

    #[test]
    fn measured_frame_rejects_mismatched_and_overflowing_lengths() {
        for length in [0, 1, 4095, 4096, 4097, 8193] {
            let frame = zeroed_frame(length).unwrap();
            assert_eq!(frame.len(), length);
            assert!(frame.capacity() >= length);
            assert!(frame.iter().all(|byte| *byte == 0));
        }
        assert!(matches!(zeroed_frame(usize::MAX), Err(Refusal::Bounds)));
        let request = json!({"value": "quoted\"\\text"});
        let expected = serde_json::to_vec(&request).unwrap().len();
        for measured in [0, expected - 1, expected + 1, usize::MAX] {
            assert!(matches!(
                encode_counted_frame(&request, usize::MAX, measured, Instant::now() + RPC_TIMEOUT),
                Err(Refusal::Bounds)
            ));
        }
        assert!(matches!(
            encode_counted_frame(
                &request,
                expected - 1,
                expected,
                Instant::now() + RPC_TIMEOUT
            ),
            Err(Refusal::Bounds)
        ));
    }

    fn write_fragment(
        writer: &mut impl Write,
        use_write_all: bool,
        fragment: &[u8],
    ) -> std::io::Result<()> {
        if use_write_all {
            writer.write_all(fragment)
        } else {
            assert_eq!(writer.write(fragment)?, fragment.len());
            Ok(())
        }
    }

    #[test]
    fn frame_counter_write_entrypoints_preserve_bounds_and_sticky_state() {
        for use_write_all in [false, true] {
            let mut counter = FrameCounter {
                len: 0,
                limit: 4,
                exceeded: false,
            };
            write_fragment(&mut counter, use_write_all, b"").unwrap();
            assert_eq!(counter.len, 0);
            assert!(!counter.exceeded);
            write_fragment(&mut counter, use_write_all, b"ab").unwrap();
            assert_eq!(counter.len, 2);
            let error = write_fragment(&mut counter, use_write_all, b"xyz").unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
            assert_eq!(counter.len, 2);
            assert!(counter.exceeded);
            write_fragment(&mut counter, use_write_all, b"cd").unwrap();
            write_fragment(&mut counter, use_write_all, b"").unwrap();
            counter.flush().unwrap();
            assert_eq!(counter.len, 4);
            assert!(counter.exceeded);
            assert!(write_fragment(&mut counter, use_write_all, b"x").is_err());
            assert_eq!(counter.len, 4);
            assert!(counter.exceeded);

            for bound in [0, usize::MAX] {
                let mut full = FrameCounter {
                    len: bound,
                    limit: bound,
                    exceeded: false,
                };
                write_fragment(&mut full, use_write_all, b"").unwrap();
                assert_eq!(full.len, bound);
                assert!(!full.exceeded);
                let error = write_fragment(&mut full, use_write_all, b"x").unwrap_err();
                assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
                assert_eq!(full.len, bound);
                assert!(full.exceeded);
                write_fragment(&mut full, use_write_all, b"").unwrap();
                assert_eq!(full.len, bound);
                assert!(full.exceeded);
            }
        }
    }

    #[test]
    fn frame_writer_write_entrypoints_preserve_bounds_and_sticky_state() {
        for use_write_all in [false, true] {
            for offset in [5, usize::MAX] {
                let mut unchanged = [b'.'; 4];
                let mut invalid = FrameWriter {
                    payload: &mut unchanged,
                    offset,
                    exceeded: false,
                };
                for fragment in [b"".as_slice(), b"x".as_slice()] {
                    let error = write_fragment(&mut invalid, use_write_all, fragment).unwrap_err();
                    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
                    assert_eq!(invalid.offset, offset);
                    assert!(&*invalid.payload == b"....");
                    assert!(invalid.exceeded);
                }
            }
            let mut payload = [b'.'; 4];
            let mut writer = FrameWriter {
                payload: &mut payload,
                offset: 0,
                exceeded: false,
            };
            write_fragment(&mut writer, use_write_all, b"").unwrap();
            assert_eq!(writer.offset, 0);
            assert_eq!(&*writer.payload, b"....");
            assert!(!writer.exceeded);
            write_fragment(&mut writer, use_write_all, b"ab").unwrap();
            assert_eq!(writer.offset, 2);
            assert_eq!(&*writer.payload, b"ab..");
            let error = write_fragment(&mut writer, use_write_all, b"xyz").unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
            assert_eq!(writer.offset, 2);
            assert_eq!(&*writer.payload, b"ab..");
            assert!(writer.exceeded);
            write_fragment(&mut writer, use_write_all, b"cd").unwrap();
            write_fragment(&mut writer, use_write_all, b"").unwrap();
            writer.flush().unwrap();
            assert_eq!(writer.offset, 4);
            assert_eq!(&*writer.payload, b"abcd");
            assert!(writer.exceeded);
            assert!(write_fragment(&mut writer, use_write_all, b"x").is_err());
            assert_eq!(writer.offset, 4);
            assert_eq!(&*writer.payload, b"abcd");
            assert!(writer.exceeded);

            let mut empty = [];
            let mut full = FrameWriter {
                payload: &mut empty,
                offset: 0,
                exceeded: false,
            };
            write_fragment(&mut full, use_write_all, b"").unwrap();
            assert_eq!(full.offset, 0);
            assert!(!full.exceeded);
            let error = write_fragment(&mut full, use_write_all, b"x").unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
            assert_eq!(full.offset, 0);
            assert!(full.payload.is_empty());
            assert!(full.exceeded);
            write_fragment(&mut full, use_write_all, b"").unwrap();
            assert_eq!(full.offset, 0);
            assert!(full.exceeded);
        }
    }

    #[test]
    fn bounded_frame_accepts_exact_encoded_limit() {
        let request = json!({"value": "\"\\\t\n\r\u{0}é"});
        let expected = serde_json::to_vec(&request).unwrap();
        let frame = encode_frame(&request, expected.len(), Instant::now() + RPC_TIMEOUT).unwrap();
        assert_eq!(
            u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize,
            expected.len()
        );
        assert!(&frame[4..] == expected.as_slice());
        assert!(matches!(
            encode_frame(&request, expected.len() - 1, Instant::now() + RPC_TIMEOUT),
            Err(Refusal::Bounds)
        ));
    }

    #[test]
    fn encoded_admission_preserves_escaped_16_mib_body_and_metadata() {
        use super::super::{http, REQUEST_LIMIT};

        let context = "c".repeat(128);
        let empty_metadata =
            json!({"openclaw_mediation_context": context, "padding": ""}).to_string();
        let metadata = json!({
            "openclaw_mediation_context": context,
            "padding": "m".repeat(8192 - empty_metadata.len())
        })
        .to_string();
        assert_eq!(metadata.len(), 8192);
        let mut body = json!({
            "model": "model-test", "store": false, "stream": true,
            "input": [], "tool_choice": "auto", "parallel_tool_calls": false,
            "client_metadata": {"x-codex-turn-metadata": metadata}
        })
        .to_string();
        // Raw JSON whitespace is valid input and doubles in the outer string.
        // Use real HTTP/profile validation before testing the admission encoder.
        body.push_str(&"\t".repeat(REQUEST_LIMIT - body.len()));
        let credential = "\"\\".repeat(4096);
        let (parts, ()) = ::http::Request::builder()
            .method("POST")
            .uri("/v1/responses")
            .version(::http::Version::HTTP_11)
            .header("host", "localhost")
            .header("content-type", "application/json")
            .header("content-length", body.len())
            .header("authorization", format!("Bearer {credential}"))
            .body(())
            .unwrap()
            .into_parts();
        let request = http::parse_request(&parts, body.into_bytes(), "localhost").unwrap();
        let reservation = "a".repeat(64);
        let provider = "p".repeat(128);
        let admission = AdmissionRequest {
            reservation_ref: &reservation,
            provider_binding_ref: &provider,
            workload_credential: request.workload_credential.as_str(),
            mediation_context: &request.context,
            request_body: request.body.as_str(),
            request_sha256: &request.digest,
        };
        let encode_started = Instant::now();
        let trace = EncoderTraceGuard::start(encode_started);
        let encoded = encode_admission(&admission, ADMISSION_LIMIT, encode_started + RPC_TIMEOUT);
        let trace = trace.finish();
        // Total return time includes error cleanup. The separate test-only
        // checkpoints show reached phases without preempting or restarting work.
        let refusal = encoded.as_ref().err().copied();
        let frame_bytes = encoded.as_ref().map_or(0, |frame| frame.len());
        eprintln!(
            "proxy_encoder_result body_bytes={} payload_limit={} elapsed_ms={} success={} refusal={refusal:?} frame_bytes={frame_bytes}",
            request.body.len(), ADMISSION_LIMIT, encode_started.elapsed().as_millis(), encoded.is_ok()
        );
        trace.report();
        let frame = encoded.unwrap();
        assert!(!trace.invalid && trace.elapsed.iter().all(Option::is_some));
        let payload_len = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        assert_eq!(request.body.len(), 16_777_216);
        assert_eq!(payload_len, frame.len() - 4);
        assert!(payload_len > RPC_LIMIT && payload_len <= 2 * REQUEST_LIMIT + 17_028);
        assert!(payload_len <= ADMISSION_LIMIT);
        let decoded = json::parse(&frame[4..]).unwrap();
        assert_eq!(decoded.as_object().unwrap().len(), 10);
        // Boolean comparisons keep original bodies and credentials out of failures.
        assert!(decoded["request_body"].as_str() == Some(request.body.as_str()));
        assert!(decoded["workload_credential"].as_str() == Some(credential.as_str()));
        assert!(decoded["mediation_context"].as_str() == Some(context.as_str()));
        assert!(decoded["provider_binding_ref"].as_str() == Some(provider.as_str()));
        assert!(decoded["reservation_ref"].as_str() == Some(reservation.as_str()));
        assert!(decoded["request_sha256"].as_str() == Some(request.digest.as_str()));
        assert!(decoded["recipient"] == super::super::recipient());
        assert!(
            decoded["version"] == 1
                && decoded["method"] == "admit"
                && decoded["operation"] == "responses.create"
        );
    }

    struct TestDirectory(PathBuf);
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn oversized_or_expired_rpc_never_connects() {
        static NEXT_DIRECTORY: std::sync::atomic::AtomicUsize =
            std::sync::atomic::AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "r-{:x}-{:x}",
            std::process::id(),
            NEXT_DIRECTORY.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let path = directory.join("a");
        // Stay under the selected TMPDIR; validate the platform address bound
        // before creating any state, without falling back to another root.
        assert!(
            SockAddr::unix(&path).is_ok(),
            "fixture socket address too long"
        );
        std::fs::create_dir(&directory).unwrap();
        let dir = TestDirectory(directory);
        std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o700)).unwrap();
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let rpc = Rpc {
            path,
            peer_uid: nix::unistd::getuid().as_raw(),
            authority: true,
        };
        // Deliberately invalid raw controls exercise the encoder's actual cap;
        // this is not a claim that an admitted HTTP body can reach this size.
        let body = "\0".repeat(ADMISSION_LIMIT / 6 + 1);
        let admission = AdmissionRequest {
            reservation_ref: "a",
            provider_binding_ref: "provider-test",
            workload_credential: "workload-test",
            mediation_context: "context-test",
            request_body: &body,
            request_sha256: "b",
        };
        assert!(matches!(rpc.admit(&admission), Err(Refusal::Bounds)));
        let ordinary = json!({"version":1,"method":"ready","padding":"x".repeat(RPC_LIMIT)});
        assert!(matches!(rpc.call(&ordinary), Err(Refusal::Bounds)));
        assert!(matches!(
            rpc.call_until(&json!({"version":1,"method":"ready"}), Instant::now()),
            Err(Refusal::Timeout)
        ));
        let mut nonauthority = rpc.clone();
        nonauthority.authority = false;
        assert!(matches!(
            nonauthority.admit(&admission),
            Err(Refusal::Denied)
        ));
        assert!(
            matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    }
}
