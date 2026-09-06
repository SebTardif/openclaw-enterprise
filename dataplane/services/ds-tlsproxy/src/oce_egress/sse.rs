// Modified for OpenClaw Enterprise.
//! Bounded observation of provider application events above Hyper's HTTP body.
use super::{json, Refusal};

const EVENT_LIMIT: usize = 1024 * 1024;

pub(super) struct Observer {
    line: Vec<u8>,
    data: Vec<u8>,
    event: Option<String>,
    response_id: Option<String>,
    event_bytes: usize,
    data_seen: bool,
    terminal: bool,
    done_marker: bool,
    failure: Option<Refusal>,
    finished: bool,
}

impl Observer {
    pub(super) fn new() -> Self {
        Self {
            line: Vec::new(),
            data: Vec::new(),
            event: None,
            response_id: None,
            event_bytes: 0,
            data_seen: false,
            terminal: false,
            done_marker: false,
            failure: None,
            finished: false,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<(), Refusal> {
        if let Some(error) = self.failure {
            return Err(error);
        }
        if self.finished {
            return Err(Refusal::Malformed);
        }
        let result = self.consume(bytes);
        if let Err(error) = result {
            self.failure = Some(error);
        }
        result
    }

    /// A complete, validated terminal event has been observed. Call finish at
    /// HTTP EOF as well: a later partial or invalid event cannot certify EOF.
    #[cfg(test)]
    pub(super) fn ended(&self) -> bool {
        self.terminal && self.failure.is_none()
    }

    pub(super) fn finish(&mut self) -> Result<bool, Refusal> {
        self.finished = true;
        if let Some(error) = self.failure {
            return Err(error);
        }
        // SSE dispatch requires a blank line. EOF never dispatches a partial
        // data event, even when its JSON happens to look like a terminal event.
        Ok(self.terminal && self.line.is_empty() && !self.data_seen && self.event.is_none())
    }

    fn consume(&mut self, bytes: &[u8]) -> Result<(), Refusal> {
        for byte in bytes {
            self.event_bytes += 1;
            if self.event_bytes > EVENT_LIMIT {
                return Err(Refusal::Bounds);
            }
            if *byte == b'\n' {
                let mut line = std::mem::take(&mut self.line);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                let result = self.consume_line(&line);
                line.clear();
                self.line = line;
                result?;
            } else {
                self.line.push(*byte);
            }
        }
        Ok(())
    }

    fn consume_line(&mut self, line: &[u8]) -> Result<(), Refusal> {
        // The selected provider uses LF or CRLF. Bare embedded CR is not a
        // second interpretation of event boundaries in this observer.
        if line.contains(&b'\r') {
            return Err(Refusal::Malformed);
        }
        let line = std::str::from_utf8(line).map_err(|_| Refusal::Malformed)?;
        if line.is_empty() {
            self.dispatch()?;
            self.event = None;
            self.data.clear();
            self.data_seen = false;
            self.event_bytes = 0;
            return Ok(());
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => {
                if self.event.is_some()
                    || value.is_empty()
                    || value.len() > 128
                    || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
                {
                    return Err(Refusal::Malformed);
                }
                self.event = Some(value.to_owned());
            }
            "data" => {
                if self.data_seen {
                    self.data.push(b'\n');
                }
                self.data.extend_from_slice(value.as_bytes());
                self.data_seen = true;
            }
            // Standard SSE id/retry and extension fields do not establish a
            // provider terminal. They still count toward this event's bound.
            _ => {}
        }
        Ok(())
    }

    fn dispatch(&mut self) -> Result<(), Refusal> {
        if !self.data_seen {
            if self.event.as_deref().is_some_and(|event| {
                self.terminal
                    || matches!(
                        event,
                        "response.completed" | "response.failed" | "response.incomplete"
                    )
            }) {
                return Err(Refusal::Malformed);
            }
            return Ok(());
        }
        if self.data == b"[DONE]" {
            if self.event.is_some() || self.done_marker {
                return Err(Refusal::Malformed);
            }
            // Some SSE clients accept this marker, but it is not an attributed
            // provider Response and cannot itself release operation ownership.
            self.done_marker = true;
            return Ok(());
        }
        if self.terminal || self.done_marker {
            return Err(Refusal::Malformed);
        }
        let payload = json::parse(&self.data)?;
        let kind = json::bounded_str(&payload, "type", 128)?;
        if self.event.as_deref().is_some_and(|event| event != kind) {
            return Err(Refusal::Malformed);
        }
        let status = match kind {
            "response.completed" => Some("completed"),
            "response.failed" => Some("failed"),
            "response.incomplete" => Some("incomplete"),
            _ => None,
        };
        if let Some(response) = payload.get("response") {
            let id = json::bounded_str(response, "id", 128)?;
            if self
                .response_id
                .as_deref()
                .is_some_and(|previous| previous != id)
            {
                return Err(Refusal::Malformed);
            }
            self.response_id = Some(id.to_owned());
        } else if matches!(
            kind,
            "response.created" | "response.in_progress" | "response.queued"
        ) {
            return Err(Refusal::Malformed);
        }
        if let Some(status) = status {
            let response = payload.get("response").ok_or(Refusal::Malformed)?;
            json::bounded_str(response, "id", 128)?;
            if response.get("status").and_then(serde_json::Value::as_str) != Some(status) {
                return Err(Refusal::Malformed);
            }
            self.terminal = true;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terminal(kind: &str, status: &str, newline: &str) -> String {
        format!(
            "event: {kind}{newline}data: {{\"type\":\"{kind}\",\"response\":{{\"id\":\"resp_test\",\"status\":\"{status}\"}}}}{newline}{newline}"
        )
    }

    #[test]
    fn all_terminal_kinds_survive_every_two_piece_boundary_and_single_bytes() {
        for (kind, status) in [
            ("response.completed", "completed"),
            ("response.failed", "failed"),
            ("response.incomplete", "incomplete"),
        ] {
            for newline in ["\n", "\r\n"] {
                let wire = terminal(kind, status, newline);
                for split in 0..=wire.len() {
                    let mut observer = Observer::new();
                    observer.push(&wire.as_bytes()[..split]).unwrap();
                    observer.push(&wire.as_bytes()[split..]).unwrap();
                    assert!(observer.ended());
                    assert!(observer.finish().unwrap());
                }
                let mut observer = Observer::new();
                for byte in wire.as_bytes() {
                    observer.push(std::slice::from_ref(byte)).unwrap();
                }
                assert!(observer.finish().unwrap());
            }
        }
    }

    #[test]
    fn comments_multiline_json_and_optional_event_are_observed() {
        let mut observer = Observer::new();
        observer.push(b": heartbeat\r\n\r\ndata: {\"type\":\"response.created\",\r\ndata: \"response\":{\"id\":\"resp_test\",\"status\":\"in_progress\"}}\r\n\r\n").unwrap();
        assert!(!observer.ended());
        observer.push(b"data: {\"type\":\"response.completed\",\ndata: \"response\":{\"id\":\"resp_test\",\"status\":\"completed\"}}\n\n: final heartbeat\n").unwrap();
        assert!(observer.finish().unwrap());
    }

    #[test]
    fn clean_http_eof_and_done_marker_without_terminal_do_not_end_provider_work() {
        for wire in [
            "",
            ": heartbeat\n\n",
            "data: [DONE]\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n",
        ] {
            let mut observer = Observer::new();
            observer.push(wire.as_bytes()).unwrap();
            assert!(!observer.ended());
            assert!(!observer.finish().unwrap());
        }
        let mut observer = Observer::new();
        observer
            .push(terminal("response.completed", "completed", "\n").as_bytes())
            .unwrap();
        observer.push(b"data: [DONE]\n\n").unwrap();
        assert!(observer.finish().unwrap());
    }

    #[test]
    fn wrong_event_status_id_and_duplicate_json_fail_closed() {
        for wire in [
            "event: response.failed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"status\":\"completed\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"status\":\"in_progress\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"\",\"status\":\"completed\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"type\":\"response.failed\",\"response\":{\"id\":\"resp_test\",\"status\":\"failed\"}}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"status\":\"completed\",\"\\u0073tatus\":\"failed\"}}\n\n",
            "event: response.completed\nevent: response.completed\ndata: {}\n\n",
            "event: response.completed\n\n",
            "data: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\"}}\n\n",
        ] {
            let mut observer = Observer::new();
            assert!(observer.push(wire.as_bytes()).is_err());
            assert!(!observer.ended());
            assert!(observer.finish().is_err());
        }
    }

    #[test]
    fn every_truncated_terminal_and_trailing_partial_event_remains_unknown() {
        let wire = terminal("response.completed", "completed", "\r\n");
        for end in 0..wire.len() {
            let mut observer = Observer::new();
            observer.push(&wire.as_bytes()[..end]).unwrap();
            assert!(!observer.finish().unwrap());
        }
        for tail in [b"data: {".as_slice(), b"event: response.completed\n", b"\r"] {
            let mut observer = Observer::new();
            observer.push(wire.as_bytes()).unwrap();
            observer.push(tail).unwrap();
            assert!(!observer.finish().unwrap());
        }
    }

    #[test]
    fn conflicting_response_identity_or_events_after_terminal_are_rejected() {
        let mut observer = Observer::new();
        observer
            .push(b"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_other\"}}\n\n")
            .unwrap();
        assert!(observer
            .push(terminal("response.completed", "completed", "\n").as_bytes())
            .is_err());
        let mut observer = Observer::new();
        let wire = terminal("response.completed", "completed", "\n");
        observer.push(wire.as_bytes()).unwrap();
        assert!(observer.push(wire.as_bytes()).is_err());
        assert!(!observer.ended());
    }

    #[test]
    fn single_event_limit_covers_unterminated_lines_comments_and_accumulated_data() {
        for prefix in [b"data: ".as_slice(), b": "] {
            let mut observer = Observer::new();
            observer.push(prefix).unwrap();
            assert!(matches!(
                observer.push(&vec![b'x'; EVENT_LIMIT]),
                Err(Refusal::Bounds)
            ));
        }
        let mut observer = Observer::new();
        let line = b"data:                                                                 \n";
        let mut result = Ok(());
        while result.is_ok() {
            result = observer.push(line);
        }
        assert!(matches!(result, Err(Refusal::Bounds)));
        assert!(observer.data.len() <= EVENT_LIMIT);
        assert!(observer.line.len() <= EVENT_LIMIT);
        let mut observer = Observer::new();
        // The limit is per event; many independent heartbeats do not retain
        // their combined bytes or consume the next valid event's allowance.
        for _ in 0..20_000 {
            observer.push(b": heartbeat\n\n").unwrap();
        }
        observer
            .push(terminal("response.completed", "completed", "\n").as_bytes())
            .unwrap();
        assert!(observer.finish().unwrap());
    }

    #[test]
    fn crd43_bytewise_unicode_lifecycle_preserves_terminal_boundary() {
        let mut observer = Observer::new();
        let initial = concat!(
            ": heartbeat\r\n\r\n",
            "event: response.created\r\n",
            "data: {\"type\":\"response.created\",\"sequence_number\":0,\r\n",
            "data: \"response\":{\"id\":\"resp_unicode\",\"status\":\"in_progress\"}}\r\n\r\n",
            "data: {\"type\":\"response.output_text.delta\",\"sequence_number\":1,",
            "\"item_id\":\"msg_unicode\",\"output_index\":0,\"content_index\":0,\"delta\":\"Hello, 世界 🌍\"}\n\n"
        );
        // One-byte delivery splits every multibyte UTF-8 character and CRLF.
        // The actual observer must retain partial bytes without ending work.
        for byte in initial.as_bytes() {
            observer.push(std::slice::from_ref(byte)).unwrap();
        }
        assert!(!observer.ended());
        let terminal = "data: {\"type\":\"response.completed\",\"sequence_number\":2,\"response\":{\"id\":\"resp_unicode\",\"status\":\"completed\"}}\n\n";
        for byte in terminal.as_bytes() {
            observer.push(std::slice::from_ref(byte)).unwrap();
        }
        assert!(observer.finish().unwrap());
    }
}
