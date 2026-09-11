//! Fixed publication HTTP bodies and bounded response projections.
//! These comparison values grant no Work, State, capture or native authority.
use crate::Refusal;
use serde_json::{json, Value};
use zeroize::{Zeroize, Zeroizing};

pub(crate) const PACK_LIMIT: usize = 80 * 1024 * 1024;
pub(crate) const RESPONSE_LIMIT: usize = 1024 * 1024;
pub(crate) const ZERO_OID: &str = "0000000000000000000000000000000000000000";

pub(crate) fn oid(value: &str) -> bool {
    value.len() == 40
        && value != ZERO_OID
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub(crate) fn branch(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
        && !value.contains("..")
        && value.split('/').all(|part| {
            !part.is_empty()
                && !part.starts_with('.')
                && !part.ends_with('.')
                && !part.ends_with(".lock")
        })
}

pub(crate) fn component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub(crate) fn decimal(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && value.as_bytes()[0] != b'0'
        && value.bytes().all(|b| b.is_ascii_digit())
}

pub(crate) fn text(title: &str, body: &str) -> bool {
    !title.is_empty()
        && title.len() <= 256
        && body.len() <= 32768
        && !title.bytes().any(|b| b < 32 || b == 127)
        && !body
            .bytes()
            .any(|b| b < 9 || (11..=12).contains(&b) || (14..=31).contains(&b) || b == 127)
}

/// No caller command or capabilities enter the request. Expected-old is the
/// server's compare-and-update precondition; the independent graph ancestry
/// check must already have succeeded before this body is prepared.
pub(crate) fn push_body(
    target: &str,
    old: &str,
    new: &str,
    pack: Zeroizing<Vec<u8>>,
) -> Result<Zeroizing<Vec<u8>>, Refusal> {
    if !branch(target)
        || (old != ZERO_OID && !oid(old))
        || !oid(new)
        || old == new
        || pack.len() < 32
        || pack.len() > PACK_LIMIT
    {
        return Err(Refusal::Protocol);
    }
    let command = format!("{old} {new} refs/heads/{target}\0report-status\n");
    let length = command.len().checked_add(4).ok_or(Refusal::Bounds)?;
    if length > 65520 {
        return Err(Refusal::Bounds);
    }
    let capacity = length
        .checked_add(4)
        .and_then(|n| n.checked_add(pack.len()))
        .ok_or(Refusal::Bounds)?;
    let mut result = Zeroizing::new(Vec::new());
    result
        .try_reserve_exact(capacity)
        .map_err(|_| Refusal::Bounds)?;
    result.extend_from_slice(format!("{length:04x}").as_bytes());
    result.extend_from_slice(command.as_bytes());
    result.extend_from_slice(b"0000");
    result.extend_from_slice(&pack);
    Ok(result)
}

struct Packets<'a> {
    bytes: &'a [u8],
    cursor: usize,
}
impl<'a> Packets<'a> {
    fn next(&mut self) -> Result<Option<&'a [u8]>, Refusal> {
        let prefix = self
            .bytes
            .get(self.cursor..self.cursor + 4)
            .ok_or(Refusal::Protocol)?;
        let mut length = 0usize;
        for byte in prefix {
            length = length * 16
                + match byte {
                    b'0'..=b'9' => usize::from(byte - b'0'),
                    b'a'..=b'f' => usize::from(byte - b'a' + 10),
                    _ => return Err(Refusal::Protocol),
                };
        }
        self.cursor += 4;
        if length == 0 {
            return if self.cursor == self.bytes.len() {
                Ok(None)
            } else {
                Err(Refusal::Protocol)
            };
        }
        if !(5..=65520).contains(&length) {
            return Err(Refusal::Protocol);
        }
        let end = self.cursor.checked_add(length - 4).ok_or(Refusal::Bounds)?;
        let data = self.bytes.get(self.cursor..end).ok_or(Refusal::Protocol)?;
        self.cursor = end;
        if !data.ends_with(b"\n") || data[..data.len() - 1].iter().any(|b| *b < 32 || *b == 127) {
            return Err(Refusal::Protocol);
        }
        Ok(Some(&data[..data.len() - 1]))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum PushStatus {
    Pushed,
    Rejected,
}

/// Only the requested report-status protocol is accepted. No sideband, extra
/// ref, ref-option, progress or server diagnostic is reflected to the caller.
pub(crate) fn push_status(bytes: &[u8], target: &str) -> Result<PushStatus, Refusal> {
    if bytes.len() > RESPONSE_LIMIT || !branch(target) {
        return Err(Refusal::Bounds);
    }
    let mut packets = Packets { bytes, cursor: 0 };
    let unpack = packets.next()?.ok_or(Refusal::Protocol)?;
    if !unpack.starts_with(b"unpack ") {
        return Err(Refusal::Protocol);
    }
    let status = packets.next()?.ok_or(Refusal::Protocol)?;
    let selected = format!("refs/heads/{target}");
    let accepted = status == format!("ok {selected}").as_bytes();
    let rejected = status.starts_with(format!("ng {selected} ").as_bytes())
        && status.len() > selected.len() + 4;
    if (!accepted && !rejected) || packets.next()?.is_some() {
        return Err(Refusal::Protocol);
    }
    if accepted && unpack != b"unpack ok" {
        return Err(Refusal::Protocol);
    }
    Ok(if accepted {
        PushStatus::Pushed
    } else {
        PushStatus::Rejected
    })
}

pub(crate) fn draft_body(
    base: &str,
    target: &str,
    title: &str,
    body: &str,
) -> Result<Zeroizing<Vec<u8>>, Refusal> {
    if !branch(base) || !branch(target) || base == target || !text(title, body) {
        return Err(Refusal::Protocol);
    }
    let value = crate::json::OwnedJson(json!({
        "base": base, "body": body, "draft": true, "head": target, "title": title
    }));
    serde_json::to_vec(&value.0)
        .map(Zeroizing::new)
        .map_err(|_| Refusal::Protocol)
}

/// The actual attributed response projection, not an atomic SHA precondition.
/// A mismatch remains an observed PR even when it cannot confirm completion.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct PullRequest {
    pub(crate) number: String,
    pub(crate) url: String,
    pub(crate) repository_id: String,
    pub(crate) base_branch: String,
    pub(crate) base_oid: String,
    pub(crate) head_branch: String,
    pub(crate) head_oid: String,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) draft: bool,
}
impl Drop for PullRequest {
    fn drop(&mut self) {
        self.number.zeroize();
        self.url.zeroize();
        self.repository_id.zeroize();
        self.base_branch.zeroize();
        self.base_oid.zeroize();
        self.head_branch.zeroize();
        self.head_oid.zeroize();
        self.title.zeroize();
        self.body.zeroize();
    }
}
impl PullRequest {
    pub(crate) fn value(&self) -> Value {
        json!({"number": self.number, "url": self.url, "repositoryId": self.repository_id,
            "baseBranch": self.base_branch, "baseOid": self.base_oid,
            "headBranch": self.head_branch, "headOid": self.head_oid,
            "title": self.title, "body": self.body, "draft": self.draft})
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, Refusal> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Refusal::Protocol)
}
fn id(value: &Value) -> Result<String, Refusal> {
    let number = value.as_u64().ok_or(Refusal::Protocol)?;
    if number == 0 || number > 9_007_199_254_740_991 {
        return Err(Refusal::Protocol);
    }
    Ok(number.to_string())
}

pub(crate) fn pull_request(value: &Value) -> Result<(PullRequest, bool), Refusal> {
    let base = value.get("base").ok_or(Refusal::Protocol)?;
    let head = value.get("head").ok_or(Refusal::Protocol)?;
    let number = id(&value["number"])?;
    let repository_id = id(&base["repo"]["id"])?;
    let head_repository = id(&head["repo"]["id"])?;
    let url = string(value, "html_url")?;
    let owner = string(&base["repo"]["owner"], "login")?;
    let repository = string(&base["repo"], "name")?;
    let base_branch = string(base, "ref")?;
    let head_branch = string(head, "ref")?;
    let base_oid = string(base, "sha")?;
    let head_oid = string(head, "sha")?;
    let title = string(value, "title")?;
    // GitHub represents an absent description as JSON null. The selected
    // string projection gives that explicitly observed empty description "";
    // missing fields and every other non-string value still refuse.
    let body = match value.get("body") {
        Some(Value::Null) => "",
        Some(Value::String(body)) => body,
        _ => return Err(Refusal::Protocol),
    };
    if !component(owner)
        || !component(repository)
        || url != format!("https://github.com/{owner}/{repository}/pull/{number}")
        || !branch(base_branch)
        || !branch(head_branch)
        || !oid(base_oid)
        || !oid(head_oid)
        || title.len() > 256
        || body.len() > 32768
    {
        return Err(Refusal::Protocol);
    }
    let same_repository = repository_id == head_repository;
    let draft = value["draft"].as_bool().ok_or(Refusal::Protocol)?;
    Ok((
        PullRequest {
            number,
            url: url.to_owned(),
            repository_id,
            base_branch: base_branch.to_owned(),
            base_oid: base_oid.to_owned(),
            head_branch: head_branch.to_owned(),
            head_oid: head_oid.to_owned(),
            title: title.to_owned(),
            body: body.to_owned(),
            draft,
        },
        same_repository,
    ))
}
