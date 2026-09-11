//! Bounded confidential broker frames on one authenticated, non-resumable stream.
use crate::{json, Refusal};
use ring::{
    digest,
    rand::{SecureRandom, SystemRandom},
};
use serde_json::Value;
use std::{
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    time::{timeout_at, Instant},
};
use tokio_rustls::{client::TlsStream, TlsConnector};
use zeroize::Zeroize;

pub(crate) const FRAME_LIMIT: usize = 16 * 1024;
pub(crate) const TOKEN_LIMIT: usize = 16 * 1024;
pub(crate) const ALPN: &[u8] = b"oce-github-mediation-v2";
pub(crate) const GIT_ALPN: &[u8] = b"oce-github-git-read-v3";

/// Protected service configuration. This authenticates the broker connection;
/// the broker must independently resolve and authorize the original attachment.
/// There is no token, authority callback or local positive admission in this API.
pub struct BrokerConfig {
    pub socket_path: PathBuf,
    pub peer_uid: u32,
    /// Trusted owners of non-writable ancestors (normally root). Explicitly
    /// accounts for UID mapping; the immediate directory/socket remain peer-owned.
    pub trusted_ancestor_uids: Vec<u32>,
    pub server_name: rustls_pki_types::ServerName<'static>,
    /// Selected service trust and client identity, supplied by the identity owner.
    pub tls: Arc<rustls::ClientConfig>,
    pub call_timeout: Duration,
    pub check_interval: Duration,
    pub max_clock_skew: Duration,
}
impl BrokerConfig {
    pub(crate) fn validate(&self) -> Result<(), Refusal> {
        self.validate_for(ALPN)
    }
    pub(crate) fn validate_for(&self, alpn: &[u8]) -> Result<(), Refusal> {
        if !self.socket_path.is_absolute()
            || self.trusted_ancestor_uids.is_empty()
            || self.trusted_ancestor_uids.len() > 8
            || self
                .socket_path
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
            || self.tls.alpn_protocols != [alpn.to_vec()]
            || self.tls.enable_early_data
            || !self.tls.client_auth_cert_resolver.has_certs()
            || self.call_timeout.is_zero()
            || self.check_interval.is_zero()
            || self.call_timeout > Duration::from_secs(30)
            || self.check_interval > Duration::from_secs(30)
            || self.max_clock_skew > Duration::from_secs(30)
        {
            return Err(Refusal::Configuration);
        }
        Ok(())
    }
}

/// Raw credential allocation. It never enters a JSON value or diagnostic.
pub(crate) struct Secret {
    bytes: Vec<u8>,
    #[cfg(test)]
    erased: Option<Arc<std::sync::Mutex<Vec<u8>>>>,
}
impl Secret {
    fn new(len: usize) -> Self {
        Self {
            bytes: vec![0; len],
            #[cfg(test)]
            erased: None,
        }
    }
    pub(crate) fn expose(&self) -> &[u8] {
        &self.bytes
    }
    pub(crate) fn take(mut self) -> Vec<u8> {
        std::mem::take(&mut self.bytes)
    }
}
impl Drop for Secret {
    fn drop(&mut self) {
        self.bytes.as_mut_slice().zeroize();
        self.bytes.spare_capacity_mut().zeroize();
        #[cfg(test)]
        if let Some(observer) = &self.erased {
            *observer.lock().unwrap() = self.bytes.clone();
        }
    }
}

pub(crate) struct Channel {
    stream: TlsStream<UnixStream>,
    pub(crate) live: bool,
    timeout: Duration,
}
impl Channel {
    pub(crate) fn into_stream(self) -> TlsStream<UnixStream> {
        self.stream
    }

    pub(crate) async fn connect_for(
        config: &BrokerConfig,
        deadline: Instant,
        alpn: &[u8],
    ) -> Result<Self, Refusal> {
        let deadline = deadline.min(Instant::now() + config.call_timeout);
        timeout_at(deadline, async {
            protected_path(
                &config.socket_path,
                config.peer_uid,
                &config.trusted_ancestor_uids,
            )?;
            let socket = UnixStream::connect(&config.socket_path)
                .await
                .map_err(|_| Refusal::AuthorityUnavailable)?;
            if socket
                .peer_cred()
                .map_err(|_| Refusal::AuthorityUnavailable)?
                .uid()
                != config.peer_uid
            {
                return Err(Refusal::AuthorityUnavailable);
            }
            // Every request authenticates a fresh session against the selected
            // verifier. A cached TLS ticket is not a current identity readback.
            let mut tls_config = (*config.tls).clone();
            tls_config.resumption = rustls::client::Resumption::disabled();
            let stream = TlsConnector::from(Arc::new(tls_config))
                .connect(config.server_name.clone(), socket)
                .await
                .map_err(|_| Refusal::Tls)?;
            if stream.get_ref().1.alpn_protocol() != Some(alpn)
                || stream
                    .get_ref()
                    .1
                    .peer_certificates()
                    .is_none_or(|c| c.is_empty())
            {
                return Err(Refusal::Tls);
            }
            Ok(Self {
                stream,
                live: true,
                timeout: config.call_timeout,
            })
        })
        .await
        .unwrap_or(Err(Refusal::Deadline))
    }

    pub(crate) async fn call(
        &mut self,
        request: &Value,
        token_allowed: bool,
        deadline: Instant,
    ) -> Result<(Value, Secret), Refusal> {
        if !self.live {
            return Err(Refusal::AuthorityUnavailable);
        }
        // A dropped, timed-out or malformed exchange permanently poisons this
        // connection. No operation can reconnect, resume or reuse its sequence.
        self.live = false;
        let deadline = deadline.min(Instant::now() + self.timeout);
        let result = timeout_at(deadline, async {
            let encoded = serde_json::to_vec(request).map_err(|_| Refusal::Protocol)?;
            if encoded.is_empty() || encoded.len() > FRAME_LIMIT {
                return Err(Refusal::Bounds);
            }
            self.stream
                .write_all(&(encoded.len() as u32).to_be_bytes())
                .await
                .map_err(|_| Refusal::Io)?;
            self.stream
                .write_all(&0_u32.to_be_bytes())
                .await
                .map_err(|_| Refusal::Io)?;
            self.stream
                .write_all(&encoded)
                .await
                .map_err(|_| Refusal::Io)?;
            self.stream.flush().await.map_err(|_| Refusal::Io)?;
            let mut sizes = [0_u8; 8];
            self.stream
                .read_exact(&mut sizes)
                .await
                .map_err(|_| Refusal::Io)?;
            let metadata_len = u32::from_be_bytes(sizes[..4].try_into().unwrap()) as usize;
            let secret_len = u32::from_be_bytes(sizes[4..].try_into().unwrap()) as usize;
            if metadata_len == 0
                || metadata_len > FRAME_LIMIT
                || secret_len > TOKEN_LIMIT
                || (!token_allowed && secret_len != 0)
            {
                return Err(Refusal::Bounds);
            }
            let mut metadata = vec![0; metadata_len];
            self.stream
                .read_exact(&mut metadata)
                .await
                .map_err(|_| Refusal::Io)?;
            let value = json::parse(&metadata)?;
            if (secret_len != 0 && (value["ok"] != true || value["phase"] != "dispatch-once"))
                || (value["phase"] == "dispatch-once" && secret_len == 0)
            {
                return Err(Refusal::Protocol);
            }
            let mut secret = Secret::new(secret_len);
            self.stream
                .read_exact(&mut secret.bytes)
                .await
                .map_err(|_| Refusal::Io)?;
            if secret.expose().iter().any(|b| !(b'!'..=b'~').contains(b)) {
                return Err(Refusal::Protocol);
            }
            Ok((value, secret))
        })
        .await
        .unwrap_or(Err(Refusal::Deadline));
        if result.is_ok() {
            self.live = true;
        }
        result
    }
}

fn protected_path(path: &Path, uid: u32, trusted_ancestors: &[u32]) -> Result<(), Refusal> {
    let endpoint = std::fs::symlink_metadata(path).map_err(|_| Refusal::AuthorityUnavailable)?;
    if !endpoint.file_type().is_socket() || endpoint.uid() != uid || endpoint.mode() & 0o077 != 0 {
        return Err(Refusal::AuthorityUnavailable);
    }
    let mut current = path.parent().ok_or(Refusal::Configuration)?;
    let mut immediate = true;
    loop {
        let metadata =
            std::fs::symlink_metadata(current).map_err(|_| Refusal::AuthorityUnavailable)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || (metadata.uid() != uid && !trusted_ancestors.contains(&metadata.uid()))
            || metadata.mode() & 0o022 != 0
            || (immediate && (metadata.uid() != uid || metadata.mode() & 0o077 != 0))
        {
            return Err(Refusal::AuthorityUnavailable);
        }
        immediate = false;
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
    }
    Ok(())
}

pub(crate) fn sha256(bytes: &[u8]) -> String {
    let hex: String = digest::digest(&digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("sha256:{hex}")
}
pub(crate) fn random_ref() -> Result<String, Refusal> {
    let mut bytes = [0; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| Refusal::Io)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub(crate) fn unix_ms() -> Result<u64, Refusal> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Refusal::Deadline)?
        .as_millis()
        .try_into()
        .map_err(|_| Refusal::Deadline)
}

const COMMON: &[&str] = &["version", "sequence", "request_ref"];
const BINDING: &[&str] = &[
    "session_ref",
    "effect_ref",
    "work_binding_sha256",
    "request_sha256",
];
const TIMES: &[&str] = &["server_time_ms", "valid_until_ms", "operation_until_ms"];
const MAX_TIME: u64 = 253_402_300_799_999;

pub(crate) struct Session {
    channel: Channel,
    version: u8,
    request_ref: String,
    binding: serde_json::Map<String, Value>,
    sequence: u32,
    pub(crate) dns_binding_ref: String,
    pub(crate) address: std::net::Ipv4Addr,
    pub(crate) deadline: Instant,
    operation_deadline: Instant,
    operation_until_ms: u64,
    clock_origin: (Instant, u64),
    clock_skew: Duration,
    pub(crate) release_ref: Option<String>,
    dispatch_attempted: bool,
}
impl Session {
    pub(crate) async fn open(
        config: &BrokerConfig,
        attachment: &str,
        owner: &str,
        name: &str,
        digest: &str,
        outer: Instant,
    ) -> Result<Self, Refusal> {
        Self::open_for(config, attachment, owner, name, digest, outer, None).await
    }

    pub(crate) async fn open_git_read(
        config: &BrokerConfig,
        attachment: &str,
        owner: &str,
        name: &str,
        digest: &str,
        outer: Instant,
        operation: &str,
        body_bytes: u64,
        body_sha256: &str,
    ) -> Result<Self, Refusal> {
        hash(body_sha256)?;
        if !matches!(operation, "discovery" | "upload-pack")
            || body_bytes > 4_194_304
            || (operation == "discovery" && (body_bytes != 0 || body_sha256 != sha256(b"")))
            || (operation == "upload-pack" && body_bytes == 0)
        {
            return Err(Refusal::Protocol);
        }
        Self::open_for(
            config,
            attachment,
            owner,
            name,
            digest,
            outer,
            Some((operation, body_bytes, body_sha256)),
        )
        .await
    }

    async fn open_for(
        config: &BrokerConfig,
        attachment: &str,
        owner: &str,
        name: &str,
        digest: &str,
        outer: Instant,
        git: Option<(&str, u64, &str)>,
    ) -> Result<Self, Refusal> {
        reference(attachment)?;
        let version: u8 = if git.is_some() { 3 } else { 2 };
        let alpn = if git.is_some() { GIT_ALPN } else { ALPN };
        let mut channel = Channel::connect_for(config, outer, alpn).await?;
        let request_ref = random_ref()?;
        let clock_origin = (Instant::now(), unix_ms()?);
        let mut request = serde_json::json!({"version":version,"sequence":1,"request_ref":request_ref,
            "method":"open-read","attachment_ref":attachment,"repository_owner":owner,
            "repository_name":name,"request_sha256":digest});
        if let Some((operation, body_bytes, body_hash)) = git {
            request["git_operation"] = operation.into();
            request["git_protocol"] = "version=2".into();
            request["body_bytes"] = body_bytes.into();
            request["body_sha256"] = body_hash.into();
        }
        let start = Instant::now();
        let (reply, _) = channel.call(&request, false, outer).await?;
        response_common(&reply, version, &request_ref, 1)?;
        fields(
            &reply,
            &[
                COMMON,
                BINDING,
                TIMES,
                &["ok", "phase", "dns_binding_ref", "upstream_ipv4"],
            ],
        )?;
        if reply["phase"] != "opened" || reply["request_sha256"] != digest {
            return Err(Refusal::Protocol);
        }
        nonce(string(&reply, "session_ref")?)?;
        reference(string(&reply, "effect_ref")?)?;
        hash(string(&reply, "work_binding_sha256")?)?;
        let dns_binding_ref = string(&reply, "dns_binding_ref")?.to_owned();
        reference(&dns_binding_ref)?;
        let ip = string(&reply, "upstream_ipv4")?;
        let address: std::net::Ipv4Addr = ip.parse().map_err(|_| Refusal::Protocol)?;
        if address.to_string() != ip {
            return Err(Refusal::Protocol);
        }
        let binding = BINDING
            .iter()
            .map(|&key| (key.to_owned(), reply[key].clone()))
            .collect();
        let mut session = Self {
            channel,
            version,
            request_ref,
            binding,
            sequence: 1,
            dns_binding_ref,
            address,
            deadline: outer,
            operation_deadline: outer,
            operation_until_ms: integer(&reply, "operation_until_ms")?,
            clock_origin,
            clock_skew: config.max_clock_skew,
            release_ref: None,
            dispatch_attempted: false,
        };
        let server = integer(&reply, "server_time_ms")?;
        let duration = session
            .operation_until_ms
            .checked_sub(server)
            .ok_or(Refusal::Deadline)?;
        let duration = Duration::from_millis(duration)
            .checked_sub(config.max_clock_skew)
            .ok_or(Refusal::Deadline)?;
        session.operation_deadline = start
            .checked_add(duration)
            .ok_or(Refusal::Deadline)?
            .min(outer);
        session.lease(&reply, start)?;
        Ok(session)
    }

    pub(crate) fn current(&self) -> Result<(), Refusal> {
        if !self.channel.live || Instant::now() >= self.deadline {
            return Err(Refusal::Deadline);
        }
        let wall = unix_ms()?;
        let elapsed: u64 = self
            .clock_origin
            .0
            .elapsed()
            .as_millis()
            .try_into()
            .map_err(|_| Refusal::Deadline)?;
        let expected = self
            .clock_origin
            .1
            .checked_add(elapsed)
            .ok_or(Refusal::Deadline)?;
        if wall.abs_diff(expected) > self.clock_skew.as_millis() as u64 {
            return Err(Refusal::Deadline);
        }
        Ok(())
    }

    pub(crate) async fn dispatch(&mut self, peer_hash: &str) -> Result<Secret, Refusal> {
        self.current()?;
        if self.dispatch_attempted {
            return Err(Refusal::Protocol);
        }
        hash(peer_hash)?;
        // Set before the possible committed release, including a lost reply.
        self.dispatch_attempted = true;
        let mut request = self.request("dispatch-read")?;
        request["dns_binding_ref"] = self.dns_binding_ref.clone().into();
        request["upstream_ipv4"] = self.address.to_string().into();
        request["peer_certificate_sha256"] = peer_hash.into();
        let start = Instant::now();
        let (reply, secret) = self.channel.call(&request, true, self.deadline).await?;
        let result = (|| {
            self.correspondence(&reply)?;
            fields(
                &reply,
                &[
                    COMMON,
                    BINDING,
                    TIMES,
                    &[
                        "ok",
                        "phase",
                        "dns_binding_ref",
                        "upstream_ipv4",
                        "peer_certificate_sha256",
                        "release_ref",
                    ],
                ],
            )?;
            if reply["phase"] != "dispatch-once"
                || reply["dns_binding_ref"] != self.dns_binding_ref
                || reply["upstream_ipv4"] != self.address.to_string()
                || reply["peer_certificate_sha256"] != peer_hash
                || secret.expose().is_empty()
            {
                return Err(Refusal::Protocol);
            }
            let release = string(&reply, "release_ref")?;
            reference(release)?;
            self.lease(&reply, start)?;
            self.release_ref = Some(release.to_owned());
            self.current()
        })();
        if let Err(error) = result {
            self.channel.live = false;
            return Err(error);
        }
        Ok(secret)
    }

    pub(crate) async fn check(&mut self) -> Result<Instant, Refusal> {
        self.current()?;
        let release = self.release_ref.clone().ok_or(Refusal::Protocol)?;
        let mut request = self.request("check-read")?;
        request["release_ref"] = release.clone().into();
        let start = Instant::now();
        let (reply, _) = self.channel.call(&request, false, self.deadline).await?;
        let result = (|| {
            self.correspondence(&reply)?;
            fields(
                &reply,
                &[COMMON, BINDING, TIMES, &["ok", "phase", "release_ref"]],
            )?;
            if reply["phase"] != "current" || reply["release_ref"] != release {
                return Err(Refusal::Protocol);
            }
            self.lease(&reply, start)?;
            Ok(self.deadline)
        })();
        if result.is_err() {
            self.channel.live = false;
        }
        result
    }

    pub(crate) async fn complete(
        &mut self,
        outcome: &str,
        deadline: Instant,
    ) -> Result<(), Refusal> {
        let mut request = self.request("complete-read")?;
        request["release_ref"] = self.release_ref.clone().map_or(Value::Null, Value::String);
        request["outcome"] = outcome.into();
        let result = self.channel.call(&request, false, deadline).await;
        // A terminal receipt grants no new request or check, even on success.
        self.channel.live = false;
        let (reply, _) = result?;
        self.correspondence(&reply)?;
        fields(&reply, &[COMMON, BINDING, &["ok", "phase", "release_ref"]])?;
        if reply["phase"] != "recorded" || reply["release_ref"] != request["release_ref"] {
            return Err(Refusal::Protocol);
        }
        Ok(())
    }

    fn request(&mut self, method: &str) -> Result<Value, Refusal> {
        self.sequence = self.sequence.checked_add(1).ok_or(Refusal::Protocol)?;
        let mut fields = self.binding.clone();
        fields.insert("version".into(), self.version.into());
        fields.insert("sequence".into(), self.sequence.into());
        fields.insert("request_ref".into(), self.request_ref.clone().into());
        fields.insert("method".into(), method.into());
        Ok(fields.into())
    }
    fn correspondence(&self, reply: &Value) -> Result<(), Refusal> {
        response_common(reply, self.version, &self.request_ref, self.sequence)?;
        if self
            .binding
            .iter()
            .any(|(key, value)| reply.get(key) != Some(value))
        {
            return Err(Refusal::Protocol);
        }
        Ok(())
    }
    fn lease(&mut self, reply: &Value, start: Instant) -> Result<(), Refusal> {
        // Validate clock continuity and the PREVIOUS deadline before considering
        // a newer short lease. A late successful reply cannot resurrect authority.
        self.current()?;
        let server = integer(reply, "server_time_ms")?;
        let until = integer(reply, "valid_until_ms")?;
        let operation = integer(reply, "operation_until_ms")?;
        if server >= until
            || until > operation
            || operation != self.operation_until_ms
            || operation > MAX_TIME
        {
            return Err(Refusal::Deadline);
        }
        let wall_at_start =
            self.clock_origin.1 + start.duration_since(self.clock_origin.0).as_millis() as u64;
        if server.abs_diff(wall_at_start)
            > self.clock_skew.as_millis() as u64 + start.elapsed().as_millis() as u64
        {
            return Err(Refusal::Deadline);
        }
        let interval = Duration::from_millis(until - server)
            .checked_sub(self.clock_skew)
            .ok_or(Refusal::Deadline)?;
        self.deadline = start
            .checked_add(interval)
            .ok_or(Refusal::Deadline)?
            .min(self.operation_deadline);
        self.current()
    }
}

fn response_common(
    reply: &Value,
    version: u8,
    request: &str,
    sequence: u32,
) -> Result<(), Refusal> {
    if reply["version"].as_u64() != Some(u64::from(version))
        || reply["sequence"].as_u64() != Some(u64::from(sequence))
        || reply["request_ref"] != request
    {
        return Err(Refusal::Protocol);
    }
    if reply["ok"] == false {
        fields(reply, &[COMMON, &["ok", "code"]])?;
        if !matches!(
            string(reply, "code")?,
            "denied" | "unavailable" | "expired" | "invalid"
        ) {
            return Err(Refusal::Protocol);
        }
        return Err(Refusal::AuthorityUnavailable);
    }
    if reply["ok"] != true {
        return Err(Refusal::Protocol);
    }
    Ok(())
}
fn fields(value: &Value, groups: &[&[&str]]) -> Result<(), Refusal> {
    let object = value.as_object().ok_or(Refusal::Protocol)?;
    if object.len() != groups.iter().map(|v| v.len()).sum::<usize>()
        || groups
            .iter()
            .flat_map(|g| g.iter())
            .any(|&key| !object.contains_key(key))
    {
        return Err(Refusal::Protocol);
    }
    Ok(())
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, Refusal> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Refusal::Protocol)
}
fn integer(value: &Value, key: &str) -> Result<u64, Refusal> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|v| *v <= MAX_TIME)
        .ok_or(Refusal::Protocol)
}
pub(crate) fn reference(value: &str) -> Result<(), Refusal> {
    if value.is_empty()
        || value.len() > 200
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
    {
        return Err(Refusal::Protocol);
    }
    Ok(())
}
fn nonce(value: &str) -> Result<(), Refusal> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Refusal::Protocol);
    }
    Ok(())
}
fn hash(value: &str) -> Result<(), Refusal> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value[7..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Refusal::Protocol);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owned_secret_is_erased_before_allocation_release() {
        let erased = Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut secret = Secret::new(64);
        secret.bytes.fill(b'x');
        secret.erased = Some(erased.clone());
        drop(secret);
        assert_eq!(*erased.lock().unwrap(), vec![0; 64]);
    }
    #[test]
    fn reply_fields_and_integer_correspondence_are_closed() {
        let good = serde_json::json!({"version":2,"sequence":1,"request_ref":"a","ok":false,"code":"denied"});
        assert_eq!(
            response_common(&good, 2, "a", 1),
            Err(Refusal::AuthorityUnavailable)
        );
        let mut extra = good.clone();
        extra["token"] = "forbidden".into();
        assert_eq!(response_common(&extra, 2, "a", 1), Err(Refusal::Protocol));
        let mut floating = good.clone();
        floating["sequence"] = serde_json::json!(1.0);
        assert_eq!(
            response_common(&floating, 2, "a", 1),
            Err(Refusal::Protocol)
        );
        assert_eq!(response_common(&good, 2, "b", 1), Err(Refusal::Protocol));
        assert_eq!(response_common(&good, 2, "a", 2), Err(Refusal::Protocol));
    }
}
