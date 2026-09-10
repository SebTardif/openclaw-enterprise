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

/// One declared-length allocation, retained under zeroizing ownership on every
/// partial-body and validation error. The input cap is distinct from JSON's DOM.
pub(super) struct Capture {
    bytes: Zeroizing<Vec<u8>>,
    declared: usize,
}

impl Capture {
    pub fn new(declared: usize) -> Result<Self, Refusal> {
        if declared == 0 || declared > REQUEST_LIMIT {
            return Err(Refusal::Bounds);
        }
        let mut bytes = Zeroizing::new(Vec::new());
        bytes
            .try_reserve_exact(declared)
            .map_err(|_| Refusal::Bounds)?;
        Ok(Self { bytes, declared })
    }

    pub fn extend(&mut self, data: &[u8]) -> Result<(), Refusal> {
        let length = self
            .bytes
            .len()
            .checked_add(data.len())
            .filter(|length| *length <= self.declared && *length <= REQUEST_LIMIT)
            .ok_or(Refusal::Bounds)?;
        // Reservation already covers every accepted byte; extension cannot
        // trigger geometric growth or allocate beyond the declared body.
        if length > self.bytes.capacity() {
            return Err(Refusal::Bounds);
        }
        self.bytes.extend_from_slice(data);
        Ok(())
    }

    pub fn finish(self) -> Result<Zeroizing<Vec<u8>>, Refusal> {
        if self.bytes.len() != self.declared {
            return Err(Refusal::Malformed);
        }
        Ok(self.bytes)
    }
}

pub(super) fn validate_parts(parts: &Parts, authority: &str) -> Result<usize, Refusal> {
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
    let declared = content_length(parts)?;
    let auth = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|a| a.strip_prefix("Bearer "))
        .ok_or(Refusal::Denied)?;
    if auth.is_empty() || auth.len() > 8192 || !auth.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(Refusal::Denied);
    }
    Ok(declared)
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
    let v = json::parse_request(value.as_bytes())?;
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
    bytes: impl Into<Zeroizing<Vec<u8>>>,
    authority: &str,
) -> Result<Request, Refusal> {
    let mut bytes = bytes.into();
    let declared = validate_parts(parts, authority)?;
    if declared != bytes.len() {
        return Err(Refusal::Malformed);
    }
    let auth = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|a| a.strip_prefix("Bearer "))
        .ok_or(Refusal::Denied)?;
    let body = match String::from_utf8(std::mem::take(&mut *bytes)) {
        Ok(body) => Zeroizing::new(body),
        Err(error) => {
            // FromUtf8Error owns the original vector. Keep those bytes under
            // the same erasure policy instead of discarding the error's owner.
            let _invalid = Zeroizing::new(error.into_bytes());
            return Err(Refusal::Malformed);
        }
    };
    let parsed = json::parse_request(body.as_bytes())?;
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
    // The parsed tree is no longer needed. Do not retain it through hashing,
    // admission encoding or forwarding of the immutable original body.
    drop(parsed);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(length: usize) -> Parts {
        ::http::Request::builder()
            .method("POST")
            .uri("/v1/responses")
            .header("host", "localhost:8443")
            .header("content-type", "application/json")
            .header("content-length", length)
            .header("authorization", "Bearer controlled-workload")
            .body(())
            .unwrap()
            .into_parts()
            .0
    }

    #[test]
    fn capture_enforces_declared_length_without_growth() {
        let mut capture = Capture::new(3).unwrap();
        let pointer = capture.bytes.as_ptr();
        let capacity = capture.bytes.capacity();
        capture.extend(b"ab").unwrap();
        assert_eq!(capture.extend(b"cd"), Err(Refusal::Bounds));
        assert_eq!(capture.bytes.len(), 2);
        capture.extend(b"c").unwrap();
        let body = capture.finish().unwrap();
        assert_eq!(body.as_slice(), b"abc");
        assert_eq!(body.as_ptr(), pointer);
        assert_eq!(body.capacity(), capacity);
        assert!(matches!(Capture::new(0), Err(Refusal::Bounds)));
        assert!(matches!(
            Capture::new(REQUEST_LIMIT + 1),
            Err(Refusal::Bounds)
        ));
        assert!(matches!(
            Capture::new(2).unwrap().finish(),
            Err(Refusal::Malformed)
        ));
    }

    #[test]
    fn captured_owner_moves_through_validation_without_copy() {
        let original = serde_json::json!({
            "model":"gpt-5.1", "input":[], "store":false, "stream":true,
            "tool_choice":"none", "parallel_tool_calls":false,
            "client_metadata":{"x-codex-turn-metadata":
                "{\"openclaw_mediation_context\":\"controlled-context\"}"}
        })
        .to_string();
        let mut capture = Capture::new(original.len()).unwrap();
        capture.extend(original.as_bytes()).unwrap();
        let bytes = capture.finish().unwrap();
        let pointer = bytes.as_ptr();
        let request = parse_request(&parts(bytes.len()), bytes, "localhost:8443").unwrap();
        assert_eq!(request.body.as_ptr(), pointer);
        assert!(request.body.as_bytes() == original.as_bytes());
        assert_eq!(request.context, "controlled-context");
    }

    #[test]
    fn invalid_utf8_and_declared_mismatch_are_refused() {
        assert!(matches!(
            parse_request(&parts(1), vec![0xffu8], "localhost:8443"),
            Err(Refusal::Malformed)
        ));
        assert!(matches!(
            parse_request(&parts(2), vec![b'a'], "localhost:8443"),
            Err(Refusal::Malformed)
        ));
    }

    #[test]
    fn request_dom_budgets_apply_before_operation_profile_validation() {
        // These small wire bodies previously expanded before profile rejection.
        // Exercise the real HTTP parser rather than only its JSON helper.
        for body in [
            format!("[{}0]", "0,".repeat(20_000)),
            format!(
                "{{{}}}",
                (0..20_000)
                    .map(|index| format!("\"k{index}\":0"))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            format!("{}0{}", "[".repeat(65), "]".repeat(65)),
        ] {
            assert!(matches!(
                parse_request(&parts(body.len()), body.into_bytes(), "localhost:8443"),
                Err(Refusal::Bounds)
            ));
        }
    }

    #[test]
    fn request_budget_preserves_exact_16_mib_instruction_strings() {
        let prefix = concat!(
            "{\"model\":\"gpt-5.1\",\"input\":[],\"store\":false,\"stream\":true,",
            "\"tool_choice\":\"none\",\"parallel_tool_calls\":false,",
            "\"client_metadata\":{\"x-codex-turn-metadata\":",
            "\"{\\\"openclaw_mediation_context\\\":\\\"controlled-context\\\"}\"},",
            "\"instructions\":\""
        );
        let suffix = "\"}";
        // Escapes also exercise serde_json's scratch buffer for decoded strings.
        for fragment in ["a", "\\n"] {
            let mut body = String::with_capacity(REQUEST_LIMIT);
            body.push_str(prefix);
            let padding = REQUEST_LIMIT - prefix.len() - suffix.len();
            body.extend(std::iter::repeat_n(fragment, padding / fragment.len()));
            body.extend(std::iter::repeat_n('a', padding % fragment.len()));
            body.push_str(suffix);
            let pointer = body.as_ptr();
            let request =
                parse_request(&parts(body.len()), body.into_bytes(), "localhost:8443").unwrap();
            assert_eq!(request.body.len(), REQUEST_LIMIT);
            assert_eq!(request.body.as_ptr(), pointer);
            assert_eq!(request.context, "controlled-context");
        }
    }

    #[test]
    fn metadata_body_and_header_use_independent_depth_budgets() {
        let ordinary = r#"{"openclaw_mediation_context":"controlled-context"}"#;
        for depth in [64, 65] {
            let nested = format!(
                "{{\"openclaw_mediation_context\":\"controlled-context\",\"padding\":{}0{}}}",
                "[".repeat(depth - 1),
                "]".repeat(depth - 1)
            );
            for in_header in [false, true] {
                let body = serde_json::json!({
                    "model":"gpt-5.1", "input":[], "store":false, "stream":true,
                    "tool_choice":"none", "parallel_tool_calls":false,
                    "client_metadata":{"x-codex-turn-metadata":
                        if in_header { ordinary } else { &nested }}
                })
                .to_string();
                let mut head = parts(body.len());
                if in_header {
                    head.headers
                        .insert("x-codex-turn-metadata", nested.parse().unwrap());
                }
                // Metadata is JSON encoded inside a body string or header, so
                // each decoded document must start a fresh root-depth budget.
                let result = parse_request(&head, body.into_bytes(), "localhost:8443");
                if depth == 64 {
                    assert_eq!(result.unwrap().context, "controlled-context");
                } else {
                    assert!(matches!(result, Err(Refusal::Bounds)));
                }
            }
        }
    }
}
