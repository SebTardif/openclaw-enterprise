//! Closed CNI invocation boundary. The outer configuration is strict; the
//! previous plugin result is an opaque JSON object, not a validated CNI result. A successful closed ADD is not workload readiness,
//! original effect authorization, or proof of containerd's before-start ordering.
use crate::{Error, kernel::interface_name};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SOCKET_PATH: &str = "/run/oce-network-fence/control.sock";
pub const MAX_INPUT: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Configuration {
    pub cni_version: String,
    pub name: String,
    #[serde(rename = "type")]
    kind: String,
    /// Forwarded as a JSON object without interpreting interfaces, routes, IPs
    /// or DNS. The selected predecessor and receiving CNI runtime must validate
    /// that result; no field contributes to attachment identity or authority.
    pub prev_result: Value,
}
impl Configuration {
    pub fn parse(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.is_empty() || bytes.len() > MAX_INPUT {
            return Err(Error::Invalid("invalid CNI input size"));
        }
        let value: Self = serde_json::from_slice(bytes)
            .map_err(|_| Error::Invalid("invalid CNI configuration"))?;
        reference(&value.name)?;
        if !matches!(value.cni_version.as_str(), "1.0.0" | "1.1.0")
            || value.kind != "oce-network-fence"
            || !value.prev_result.is_object()
            || value.prev_result.get("cniVersion").and_then(Value::as_str)
                != Some(&value.cni_version)
        {
            return Err(Error::Invalid("unsupported CNI chain"));
        }
        Ok(value)
    }
    pub fn closed_result(&self) -> Result<Vec<u8>, Error> {
        serde_json::to_vec(&self.prev_result)
            .map_err(|_| Error::Invalid("invalid previous CNI result"))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Operation {
    Add,
    Check,
    Del,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub schema_version: u32,
    pub operation: Operation,
    /// Correlation only, supplied by the protected CNI invocation. This is not
    /// an authenticated Pod UID, original create effect or runtime assignment.
    pub container_id: String,
    pub network_name: String,
    pub interface_name: String,
}
impl Request {
    pub fn validate(&self) -> Result<(), Error> {
        if self.schema_version != 1 {
            return Err(Error::Invalid("unsupported fence request"));
        }
        reference(&self.container_id)?;
        reference(&self.network_name)?;
        interface_name(&self.interface_name)
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Reply {
    pub schema_version: u32,
    pub status: Status,
    pub operation_ref: Option<String>,
}
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Closed,
    /// Responsibility is retained; neither retirement nor absence was proved.
    CleanupUnknown,
    Unavailable,
}
fn reference(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return Err(Error::Invalid("invalid CNI correlation"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_chain_and_duplicate_fields() {
        let valid = br#"{"cniVersion":"1.0.0","name":"pods","type":"oce-network-fence","prevResult":{"cniVersion":"1.0.0","interfaces":[]}}"#;
        let config = Configuration::parse(valid).unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&config.closed_result().unwrap()).unwrap(),
            config.prev_result
        );
        for invalid in [
            br#"{"cniVersion":"0.4.0","name":"pods","type":"oce-network-fence","prevResult":{"cniVersion":"0.4.0"}}"#.as_slice(),
            br#"{"cniVersion":"1.0.0","name":"pods","type":"oce-network-fence","prevResult":null}"#,
            br#"{"cniVersion":"1.0.0","name":"pods","name":"other","type":"oce-network-fence","prevResult":{"cniVersion":"1.0.0"}}"#,
            br#"{"cniVersion":"1.0.0","name":"pods","type":"oce-network-fence","endpoints":["0.0.0.0/0"],"prevResult":{"cniVersion":"1.0.0"}}"#,
        ] { assert!(Configuration::parse(invalid).is_err()); }
    }
    #[test]
    fn no_path_or_command_in_correlation() {
        let request = Request {
            schema_version: 1,
            operation: Operation::Add,
            container_id: "sandbox".into(),
            network_name: "pods".into(),
            interface_name: "eth0".into(),
        };
        request.validate().unwrap();
        let mut value = request;
        value.container_id = "../../other".into();
        assert!(value.validate().is_err());
        assert!(serde_json::from_slice::<Request>(br#"{"schemaVersion":1,"operation":"OPEN","containerId":"s","networkName":"pods","interfaceName":"eth0"}"#).is_err());
    }
}
