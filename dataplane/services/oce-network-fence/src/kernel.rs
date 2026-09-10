//! Dedicated netdev anchors followed by handle-bound closed activation. Successful command completion is never
//! installation evidence: the owner must inspect the exact kernel readback.
use crate::Error;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug)]
pub struct Table {
    name: String,
    device: String,
    installed: std::sync::OnceLock<InstalledIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledIdentity {
    table_handle: u64,
    pub(crate) from_handle: u64,
    pub(crate) toward_handle: u64,
}
impl Table {
    /// Allocate an unpredictable locator before the kernel operation. Callers
    /// retain this object even when submission or its acknowledgement is lost.
    pub fn allocate(device: &str) -> Result<Self, Error> {
        interface_name(device)?;
        let mut bytes = [0u8; 16];
        let mut offset = 0;
        while offset < bytes.len() {
            let n = unsafe {
                libc::getrandom(bytes[offset..].as_mut_ptr().cast(), bytes.len() - offset, 0)
            };
            if n < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error.into());
            }
            if n == 0 {
                return Err(Error::Unavailable("table locator unavailable"));
            }
            offset += n as usize;
        }
        let suffix: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self {
            name: format!("oce_closed_{suffix}"),
            device: device.to_owned(),
            installed: std::sync::OnceLock::new(),
        })
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn observed(&self) -> Option<&InstalledIdentity> {
        self.installed.get()
    }
    /// One transaction, no flush/replace, no existing-table adoption. A name
    /// collision fails rather than changing somebody else's table.
    pub fn installation(&self) -> String {
        format!(
            "create table netdev {}\ncreate chain netdev {} from_pod {{ type filter hook ingress device \"{}\" priority -500; policy accept; }}\ncreate chain netdev {} toward_pod {{ type filter hook egress device \"{}\" priority -500; policy accept; }}\n",
            self.name, self.name, self.device, self.name, self.device
        )
    }
    /// Accept only the two exact base chains at the required policy and table.
    /// Extra rules, sets, chains or flags are not a closed installation receipt.
    pub fn inspect(&self, bytes: &[u8]) -> Result<(), Error> {
        self.inspect_policy(bytes, "drop")
    }
    pub(crate) fn inspect_anchor(&self, bytes: &[u8]) -> Result<(), Error> {
        self.inspect_policy(bytes, "accept")
    }
    fn inspect_policy(&self, bytes: &[u8], policy: &str) -> Result<(), Error> {
        if bytes.is_empty() || bytes.len() > 32 * 1024 {
            return Err(Error::Invalid("invalid nft readback size"));
        }
        let result: Readback =
            serde_json::from_slice(bytes).map_err(|_| Error::Invalid("invalid nft readback"))?;
        if result.nftables.len() != 4 {
            return Err(Error::Invalid("unexpected nft objects"));
        }
        let mut meta = false;
        let mut table = false;
        let mut chains = BTreeSet::new();
        let mut table_handle = 0;
        let mut from_handle = 0;
        let mut toward_handle = 0;
        for object in result.nftables {
            match object {
                Object::Meta(value) => {
                    if meta
                        || value.json_schema_version != 1
                        || value.version.is_empty()
                        || value.release_name.is_empty()
                    {
                        return Err(Error::Invalid("invalid nft metadata"));
                    }
                    meta = true;
                }
                Object::Table(value) => {
                    if table
                        || value.family != "netdev"
                        || value.name != self.name
                        || value.handle == 0
                    {
                        return Err(Error::Invalid("wrong nft table"));
                    }
                    table = true;
                    table_handle = value.handle;
                }
                Object::Chain(value) => {
                    if value.name == "from_pod" {
                        from_handle = value.handle;
                    }
                    if value.name == "toward_pod" {
                        toward_handle = value.handle;
                    }
                    let hook = match value.name.as_str() {
                        "from_pod" => "ingress",
                        "toward_pod" => "egress",
                        _ => return Err(Error::Invalid("unexpected nft chain")),
                    };
                    if !chains.insert(value.name)
                        || value.family != "netdev"
                        || value.table != self.name
                        || value.handle == 0
                        || value.kind != "filter"
                        || value.hook != hook
                        || value.prio != -500
                        || value.dev != self.device
                        || value.policy != policy
                    {
                        return Err(Error::Invalid("wrong nft attachment"));
                    }
                }
            }
        }
        if !meta || !table || chains.len() != 2 {
            return Err(Error::Invalid("incomplete nft attachment"));
        }
        // Table handles and within-table object handles use different kernel
        // counters. The first table and first chain can both legitimately be 1.
        if from_handle == toward_handle {
            return Err(Error::Invalid("duplicate nft object handles"));
        }
        let observed = InstalledIdentity {
            table_handle,
            from_handle,
            toward_handle,
        };
        let original = self.installed.get_or_init(|| observed.clone());
        if original != &observed {
            return Err(Error::Unavailable("original nft attachment was replaced"));
        }
        Ok(())
    }
}

pub(crate) fn interface_name(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || value.len() >= libc::IFNAMSIZ
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
    {
        return Err(Error::Invalid("unsupported interface name"));
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Readback {
    nftables: Vec<Object>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Object {
    #[serde(rename = "metainfo")]
    Meta(Meta),
    Table(TableObject),
    Chain(Chain),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Meta {
    version: String,
    release_name: String,
    json_schema_version: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TableObject {
    family: String,
    name: String,
    handle: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Chain {
    family: String,
    table: String,
    name: String,
    handle: u64,
    #[serde(rename = "type")]
    kind: String,
    hook: String,
    prio: i32,
    dev: String,
    policy: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn readback(table: &Table) -> Value {
        json!({"nftables":[
            {"metainfo":{"version":"1.1.0","release_name":"fixture","json_schema_version":1}},
            {"table":{"family":"netdev","name":table.name(),"handle":1}},
            {"chain":{"family":"netdev","table":table.name(),"name":"from_pod","handle":1,"type":"filter","hook":"ingress","prio":-500,"dev":&table.device,"policy":"drop"}},
            {"chain":{"family":"netdev","table":table.name(),"name":"toward_pod","handle":2,"type":"filter","hook":"egress","prio":-500,"dev":&table.device,"policy":"drop"}}
        ]})
    }
    #[test]
    fn exact_closed_readback_and_all_security_fields() {
        let table = Table::allocate("veth0").unwrap();
        let original = readback(&table);
        table
            .inspect(&serde_json::to_vec(&original).unwrap())
            .unwrap();
        for (field, changed) in [
            ("family", json!("inet")),
            ("table", json!("other")),
            ("type", json!("nat")),
            ("hook", json!("egress")),
            ("prio", json!(0)),
            ("dev", json!("veth1")),
            ("policy", json!("accept")),
            ("handle", json!(0)),
        ] {
            let mut value = original.clone();
            value["nftables"][2]["chain"][field] = changed;
            assert!(
                table.inspect(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{field}"
            );
        }
        let mut replaced = original.clone();
        replaced["nftables"][1]["table"]["handle"] = json!(44);
        assert!(
            table
                .inspect(&serde_json::to_vec(&replaced).unwrap())
                .is_err()
        );
        let mut extra = original.clone();
        extra["nftables"]
            .as_array_mut()
            .unwrap()
            .push(json!({"rule":{"expr":[{"accept":null}]}}));
        assert!(table.inspect(&serde_json::to_vec(&extra).unwrap()).is_err());
        let mut flag = original;
        flag["nftables"][1]["table"]["flags"] = json!(["dormant"]);
        assert!(table.inspect(&serde_json::to_vec(&flag).unwrap()).is_err());
    }
    #[test]
    fn no_name_injection_or_table_reuse() {
        assert!(Table::allocate("x\";flush ruleset").is_err());
        let a = Table::allocate("veth0").unwrap();
        let b = Table::allocate("veth0").unwrap();
        assert_ne!(a.name(), b.name());
        assert!(
            b.inspect(&serde_json::to_vec(&readback(&a)).unwrap())
                .is_err()
        );
        assert!(
            a.installation()
                .starts_with("create table netdev oce_closed_")
        );
        assert!(!a.installation().contains("drop"));
        assert_eq!(a.installation().matches("policy accept").count(), 2);
    }
}
