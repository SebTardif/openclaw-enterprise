//! Connection-owned observations of original closed attachments. These records
//! contain physical evidence only. They neither authenticate a runtime effect
//! nor authorize an endpoint. A copied record cannot recreate this session.
use crate::{cni, kernel::InstalledIdentity, linux::ObservedLink, Error};
use serde::{Deserialize, Serialize};
use std::{
    os::fd::OwnedFd,
    sync::Arc,
    time::{Duration, Instant},
};

pub const LIFETIME: Duration = Duration::from_secs(10);
pub const MAX_INSPECTIONS: u8 = 16;
pub const MAX_SESSIONS: usize = 32;

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "ACQUIRE")]
    Acquire(Observe),
    #[serde(rename = "OBSERVE")]
    Observe(Observe),
    #[serde(rename = "INSPECT")]
    Inspect(Inspect),
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Observe {
    pub schema_version: u32,
    pub request_ref: String,
    pub container_id: String,
    pub network_name: String,
    pub interface_name: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Inspect {
    pub schema_version: u32,
    pub request_ref: String,
    pub observation_ref: String,
    pub record_digest: String,
}
impl Observe {
    pub fn validate(&self) -> Result<(), Error> {
        request_ref(&self.request_ref)?;
        self.check().validate()
    }
    pub(crate) fn check(&self) -> cni::Request {
        cni::Request {
            schema_version: self.schema_version,
            operation: cni::Operation::Check,
            container_id: self.container_id.clone(),
            network_name: self.network_name.clone(),
            interface_name: self.interface_name.clone(),
        }
    }
}
impl Inspect {
    pub fn validate(&self) -> Result<(), Error> {
        request_ref(&self.request_ref)?;
        if self.schema_version != 1
            || !hex(&self.observation_ref, 32)
            || !self
                .record_digest
                .strip_prefix("sha256:")
                .is_some_and(|s| hex(s, 64))
        {
            return Err(Error::Invalid("invalid observation inspection"));
        }
        Ok(())
    }
}
impl Request {
    pub fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Acquire(r) | Self::Observe(r) => r.validate(),
            Self::Inspect(r) => r.validate(),
        }
    }
    pub fn descriptor_count(&self) -> usize {
        match self {
            Self::Observe(_) => 1,
            Self::Acquire(_) | Self::Inspect(_) => 0,
        }
    }
}
fn request_ref(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/-".contains(&b))
    {
        return Err(Error::Invalid("invalid observation request reference"));
    }
    Ok(())
}
fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn nonce() -> Result<String, Error> {
    let mut bytes = [0u8; 16];
    let mut offset = 0;
    while offset < bytes.len() {
        let count = unsafe {
            libc::getrandom(bytes[offset..].as_mut_ptr().cast(), bytes.len() - offset, 0)
        };
        if count < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        if count == 0 {
            return Err(Error::Unavailable("observation incarnation unavailable"));
        }
        offset += count as usize;
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    schema_version: u32,
    kind: &'static str,
    service_instance: String,
    observation_ref: String,
    request_ref: String,
    container_id: String,
    network_name: String,
    interface_name: String,
    operation_ref: String,
    topology: ObservedLink,
    kernel_identity: InstalledIdentity,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply<'a> {
    schema_version: u32,
    status: &'static str,
    request_ref: &'a str,
    record_digest: &'a str,
    record: Option<&'a Record>,
}

/// Only the original Owner can construct an observation. The retained socket
/// owner additionally binds it to one live exchange. Expiry ends this read,
/// not the attachment or work; a later authentic read needs fresh FD custody.
pub struct Observation {
    pub(crate) owner: Arc<()>,
    pub(crate) attempt: usize,
    pub(crate) namespace: OwnedFd,
    pub(crate) request: Observe,
    record: Record,
    digest: String,
    deadline: Instant,
    remaining: u8,
}
impl Observation {
    pub(crate) fn new(
        owner: Arc<()>,
        instance: &str,
        attempt: usize,
        namespace: OwnedFd,
        request: Observe,
        operation: &str,
        topology: ObservedLink,
        kernel: InstalledIdentity,
        started: Instant,
    ) -> Result<Self, Error> {
        let record = Record {
            schema_version: 1,
            kind: "closed-network-observation",
            service_instance: instance.into(),
            observation_ref: nonce()?,
            request_ref: request.request_ref.clone(),
            container_id: request.container_id.clone(),
            network_name: request.network_name.clone(),
            interface_name: request.interface_name.clone(),
            operation_ref: operation.into(),
            topology,
            kernel_identity: kernel,
        };
        // Hash the exact original JSON object bytes sent in the observation reply.
        let raw =
            serde_json::to_vec(&record).map_err(|_| Error::Invalid("cannot encode observation"))?;
        let digest = format!(
            "sha256:{}",
            ds_contracts::snapshot_verify::sha256(&raw)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        Ok(Self {
            owner,
            attempt,
            namespace,
            request,
            record,
            digest,
            deadline: started + LIFETIME,
            remaining: MAX_INSPECTIONS,
        })
    }
    pub fn current(&self) -> Result<(), Error> {
        if Instant::now() >= self.deadline {
            return Err(Error::Unavailable("observation session expired"));
        }
        Ok(())
    }
    pub fn matches(&mut self, request: &Inspect) -> Result<(), Error> {
        self.current()?;
        request.validate()?;
        if self.remaining == 0
            || request.request_ref != self.record.request_ref
            || request.observation_ref != self.record.observation_ref
            || request.record_digest != self.digest
        {
            return Err(Error::Unavailable(
                "inspection is not the original observation",
            ));
        }
        self.remaining -= 1;
        Ok(())
    }
    pub fn reply(&self, initial: bool) -> Result<Reply<'_>, Error> {
        self.current()?;
        Ok(Reply {
            schema_version: 1,
            status: if initial { "observed" } else { "current" },
            request_ref: &self.record.request_ref,
            record_digest: &self.digest,
            record: initial.then_some(&self.record),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_observation_protocol() {
        let valid = br#"{"schemaVersion":1,"operation":"OBSERVE","requestRef":"node:1","containerId":"sandbox","networkName":"pods","interfaceName":"eth0"}"#;
        let request: Request = serde_json::from_slice(valid).unwrap();
        request.validate().unwrap();
        assert_eq!(request.descriptor_count(), 1);
        let acquire: Request = serde_json::from_slice(
            br#"{"schemaVersion":1,"operation":"ACQUIRE","requestRef":"node:1","containerId":"sandbox","networkName":"pods","interfaceName":"eth0"}"#,
        ).unwrap();
        acquire.validate().unwrap();
        assert_eq!(acquire.descriptor_count(), 0);
        for raw in [
            br#"{"schemaVersion":1,"operation":"OBSERVE","requestRef":"a","requestRef":"b","containerId":"s","networkName":"p","interfaceName":"eth0"}"#.as_slice(),
            br#"{"schemaVersion":1,"operation":"OBSERVE","requestRef":"a","containerId":"s","networkName":"p","interfaceName":"eth0","allowed":true}"#,
            br#"{"schemaVersion":1,"operation":"OPEN","requestRef":"a","containerId":"s","networkName":"p","interfaceName":"eth0"}"#,
        ] { assert!(serde_json::from_slice::<Request>(raw).is_err()); }
        let inspect = Inspect {
            schema_version: 1,
            request_ref: "node:1".into(),
            observation_ref: "a".repeat(32),
            record_digest: format!("sha256:{}", "b".repeat(64)),
        };
        inspect.validate().unwrap();
        assert!(!hex(&"A".repeat(32), 32));
    }
    #[test]
    fn incarnations_are_unpredictable_locators_not_authority() {
        let a = nonce().unwrap();
        let b = nonce().unwrap();
        assert!(hex(&a, 32));
        assert_ne!(a, b);
    }
}
