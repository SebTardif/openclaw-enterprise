// Modified for OpenClaw Enterprise.
//! Application policy after Hyper's maintained HTTP/1 message framing.
use super::{json, Refusal, REQUEST_LIMIT};
use ::http::{request::Parts, Method, Version};
use ring::digest::{digest, SHA256};
use zeroize::Zeroizing;

pub(super) struct Request {
    pub body: Zeroizing<String>,
    pub workload_credential: Zeroizing<String>,
    pub context: String,
    pub digest: String,
}

pub(super) fn validate_parts(parts: &Parts, authority: &str) -> Result<(), Refusal> {
    if parts.method != Method::POST
        || parts.version != Version::HTTP_11
        || parts.uri.scheme().is_some()
        || parts.uri.authority().is_some()
        || parts.uri.path() != "/v1/responses"
        || parts.uri.query().is_some()
    {
        return Err(Refusal::Unsupported);
    }
    // Hyper normalizes identical Content-Length repetitions. Other repeated
    // fields remain visible and are rejected, especially authority/credentials.
    for name in parts.headers.keys() {
        if parts.headers.get_all(name).iter().count() != 1 {
            return Err(Refusal::Malformed);
        }
    }
    if parts.headers.get("host").and_then(|v| v.to_str().ok()) != Some(authority) {
        return Err(Refusal::Unsupported);
    }
    for name in [
        "transfer-encoding",
        "expect",
        "upgrade",
        "content-encoding",
        "proxy-authorization",
        "proxy-connection",
        "trailer",
        "te",
    ] {
        if parts.headers.contains_key(name) {
            return Err(Refusal::Unsupported);
        }
    }
    if parts
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        != Some("application/json")
    {
        return Err(Refusal::Unsupported);
    }
    if let Some(c) = parts.headers.get("connection") {
        if !matches!(c.to_str().ok(), Some("close" | "keep-alive")) {
            return Err(Refusal::Unsupported);
        }
    }
    content_length(parts)?;
    let auth = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|a| a.strip_prefix("Bearer "))
        .ok_or(Refusal::Denied)?;
    if auth.is_empty() || auth.len() > 8192 || !auth.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(Refusal::Denied);
    }
    Ok(())
}
fn content_length(parts: &Parts) -> Result<usize, Refusal> {
    let value = parts
        .headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .ok_or(Refusal::Malformed)?;
    if value.is_empty()
        || value.len() > 10
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(Refusal::Malformed);
    }
    let n = value.parse().map_err(|_| Refusal::Malformed)?;
    if n == 0 || n > REQUEST_LIMIT {
        return Err(Refusal::Bounds);
    }
    Ok(n)
}
fn metadata_context(value: &str) -> Result<String, Refusal> {
    if value.len() > 8192 {
        return Err(Refusal::Bounds);
    }
    let v = json::parse(value.as_bytes())?;
    let s = json::bounded_str(&v, "openclaw_mediation_context", 128)?;
    if !s
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err(Refusal::Malformed);
    }
    Ok(s.to_owned())
}

pub(super) fn parse_request(
    parts: &Parts,
    bytes: Vec<u8>,
    authority: &str,
) -> Result<Request, Refusal> {
    validate_parts(parts, authority)?;
    if content_length(parts)? != bytes.len() {
        return Err(Refusal::Malformed);
    }
    let auth = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|a| a.strip_prefix("Bearer "))
        .ok_or(Refusal::Denied)?;
    let body = Zeroizing::new(String::from_utf8(bytes).map_err(|_| Refusal::Malformed)?);
    let parsed = json::parse(body.as_bytes())?;
    json::bounded_str(&parsed, "model", 128)?;
    operation_profile(&parsed)?;
    if parsed.get("stream").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(Refusal::Unsupported);
    }
    let metadata = parsed
        .get("client_metadata")
        .and_then(|v| v.get("x-codex-turn-metadata"))
        .and_then(serde_json::Value::as_str)
        .ok_or(Refusal::Denied)?;
    let context = metadata_context(metadata)?;
    if let Some(header) = parts.headers.get("x-codex-turn-metadata") {
        if metadata_context(header.to_str().map_err(|_| Refusal::Malformed)?)? != context {
            return Err(Refusal::Denied);
        }
    }
    let digest = digest(&SHA256, body.as_bytes())
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok(Request {
        body,
        workload_credential: Zeroizing::new(auth.to_owned()),
        context,
        digest,
    })
}
// The selected Codex profile permits client-executed function/custom tools,
// namespaces and explicitly client-executed tool search.
// Detached provider jobs and provider-owned conversation state lack this stream's
// authority/cancellation binding, so they are unsupported rather than inferred.
fn operation_profile(body: &serde_json::Value) -> Result<(), Refusal> {
    let fields = body.as_object().ok_or(Refusal::Malformed)?;
    for key in fields.keys() {
        if !matches!(
            key.as_str(),
            "model"
                | "instructions"
                | "input"
                | "tools"
                | "tool_choice"
                | "parallel_tool_calls"
                | "reasoning"
                | "store"
                | "stream"
                | "stream_options"
                | "include"
                | "service_tier"
                | "prompt_cache_key"
                | "text"
                | "client_metadata"
        ) {
            return Err(Refusal::Unsupported);
        }
    }
    if body.get("store").and_then(serde_json::Value::as_bool) != Some(false) {
        return Err(Refusal::Unsupported);
    }
    if !matches!(
        body.get("tool_choice").and_then(serde_json::Value::as_str),
        Some("auto" | "none")
    ) || body
        .get("parallel_tool_calls")
        .and_then(serde_json::Value::as_bool)
        .is_none()
    {
        return Err(Refusal::Unsupported);
    }
    if body
        .get("client_metadata")
        .and_then(serde_json::Value::as_object)
        .is_none_or(|m| m.values().any(|v| !v.is_string()))
    {
        return Err(Refusal::Malformed);
    }
    let input = body
        .get("input")
        .and_then(serde_json::Value::as_array)
        .ok_or(Refusal::Unsupported)?;
    if input.len() > 4096 {
        return Err(Refusal::Bounds);
    }
    for item in input {
        if matches!(
            item.get("type").and_then(serde_json::Value::as_str),
            Some("tool_search_call" | "tool_search_output")
        ) {
            if item.get("execution").and_then(serde_json::Value::as_str) != Some("client") {
                return Err(Refusal::Unsupported);
            }
            if let Some(tools) = item.get("tools") {
                local_tools(tools, 0)?;
            }
        }
        if !matches!(
            item.get("type").and_then(serde_json::Value::as_str),
            Some(
                "message"
                    | "reasoning"
                    | "function_call"
                    | "function_call_output"
                    | "custom_tool_call"
                    | "custom_tool_call_output"
                    | "tool_search_call"
                    | "tool_search_output"
            )
        ) {
            return Err(Refusal::Unsupported);
        }
    }

    for key in ["previous_response_id", "conversation", "prompt"] {
        if body.get(key).is_some() {
            return Err(Refusal::Unsupported);
        }
    }
    if body
        .get("background")
        .is_some_and(|v| v.as_bool() != Some(false))
        || body
            .get("store")
            .is_some_and(|v| v.as_bool() != Some(false))
    {
        return Err(Refusal::Unsupported);
    }
    if let Some(tools) = body.get("tools") {
        local_tools(tools, 0)?;
    }

    Ok(())
}

// Custody-relevant local execution checks; the authority applies its complete
// typed Codex schema to the original bytes. Namespace/client search forms are
// part of that same selected ordinary Codex profile, not provider tools.
fn local_tools(value: &serde_json::Value, depth: usize) -> Result<(), Refusal> {
    let tools = value
        .as_array()
        .filter(|v| v.len() <= 128)
        .ok_or(Refusal::Unsupported)?;
    for tool in tools {
        match tool.get("type").and_then(serde_json::Value::as_str) {
            Some("function" | "custom") => {
                json::bounded_str(tool, "name", 128)?;
            }
            Some("namespace") if depth == 0 => {
                json::bounded_str(tool, "name", 128)?;
                local_tools(tool.get("tools").ok_or(Refusal::Unsupported)?, 1)?;
            }
            Some("tool_search")
                if depth == 0
                    && tool.get("execution").and_then(serde_json::Value::as_str)
                        == Some("client") => {}
            _ => return Err(Refusal::Unsupported),
        }
    }
    Ok(())
}
