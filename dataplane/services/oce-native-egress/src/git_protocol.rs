//! Closed Git protocol-v2 envelope for ordinary, full SHA-1 clone/fetch.
//!
//! Framing and emitted lines follow pinned Git 2.55.0's connect.c,
//! fetch-pack.c, remote-curl.c and Documentation/gitprotocol-v2.adoc.
//! The HTTP owner bounds/decodes the body before calling these functions.
//! Response checks are structural: maintained Git still verifies pack integrity,
//! negotiation semantics and correspondence to its requested refs/objects.
use crate::Refusal;
use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicBool, Ordering},
};
use zeroize::Zeroizing;

const REQUEST_LIMIT: usize = 4 * 1024 * 1024;
const PACKET_LIMIT: usize = 65520;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Operation {
    Discovery,
    UploadPack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Command {
    LsRefs,
    Fetch,
}

#[derive(Debug, PartialEq, Eq)]
enum Packet<'a> {
    Data(&'a [u8]),
    Delimiter,
    Flush,
}

struct Packets<'a> {
    remaining: &'a [u8],
    cancel: Option<&'a AtomicBool>,
}

impl<'a> Packets<'a> {
    fn new(body: &'a [u8]) -> Self {
        Self {
            remaining: body,
            cancel: None,
        }
    }

    fn next(&mut self) -> Result<Packet<'a>, Refusal> {
        if self.cancel.is_some_and(|v| v.load(Ordering::Acquire)) {
            return Err(Refusal::Deadline);
        }
        let header = self.remaining.get(..4).ok_or(Refusal::Protocol)?;
        let mut len = 0usize;
        for byte in header {
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => return Err(Refusal::Protocol),
            };
            len = len * 16 + usize::from(digit);
        }
        match len {
            0 | 1 => {
                self.remaining = &self.remaining[4..];
                Ok(if len == 0 {
                    Packet::Flush
                } else {
                    Packet::Delimiter
                })
            }
            5..=PACKET_LIMIT => {
                let payload = self.remaining.get(4..len).ok_or(Refusal::Protocol)?;
                self.remaining = &self.remaining[len..];
                Ok(Packet::Data(payload))
            }
            _ => Err(Refusal::Protocol),
        }
    }

    fn end(&self) -> Result<(), Refusal> {
        if self.remaining.is_empty() {
            Ok(())
        } else {
            Err(Refusal::Protocol)
        }
    }
}

// Git's own writers mix LF-terminated and unterminated text packets. Strip
// exactly one final LF, never trim whitespace or silently discard extra lines.
fn text(payload: &[u8]) -> Result<&[u8], Refusal> {
    let line = payload.strip_suffix(b"\n").unwrap_or(payload);
    if line.is_empty() || line.iter().any(|b| *b < 32 || *b == 127) {
        return Err(Refusal::Protocol);
    }
    Ok(line)
}

fn word(value: &[u8]) -> bool {
    !value.is_empty() && value.iter().all(|b| (33..=126).contains(b))
}

fn oid(value: &[u8]) -> bool {
    value.len() == 40
        && value
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
}

// Prefixes may end in '/' and may be abbreviated ref names. Full refs may
// only be HEAD or refs/... . Ref names are octet strings, not necessarily UTF-8.
fn reference(value: &[u8], prefix: bool) -> bool {
    if value.is_empty()
        || value
            .iter()
            .any(|b| *b <= 32 || *b == 127 || b"~^:?*[\\".contains(b))
        || value.windows(2).any(|w| matches!(w, b".." | b"@{" | b"//"))
        || value.starts_with(b"/")
        || (!prefix && (value.ends_with(b"/") || value.ends_with(b".")))
        || (!prefix && value != b"HEAD" && !value.starts_with(b"refs/"))
    {
        return false;
    }
    value.split(|b| *b == b'/').all(|part| {
        (prefix || !part.is_empty()) && !part.starts_with(b".") && !part.ends_with(b".lock")
    })
}

fn singleton(seen: &mut u16, bit: u16) -> Result<(), Refusal> {
    if *seen & bit != 0 {
        return Err(Refusal::Protocol);
    }
    *seen |= bit;
    Ok(())
}

/// Validate one complete, already decompressed upload-pack HTTP request.
pub(crate) fn request(body: &[u8]) -> Result<Command, Refusal> {
    if body.len() > REQUEST_LIMIT {
        return Err(Refusal::Bounds);
    }
    let mut packets = Packets::new(body);
    let command = match packets.next()? {
        Packet::Data(data) => match text(data)? {
            b"command=ls-refs" => Command::LsRefs,
            b"command=fetch" => Command::Fetch,
            _ => return Err(Refusal::Unsupported),
        },
        _ => return Err(Refusal::Protocol),
    };
    let mut caps = 0;
    loop {
        match packets.next()? {
            Packet::Delimiter => break,
            Packet::Data(data) => {
                let line = text(data)?;
                if line == b"object-format=sha1" {
                    singleton(&mut caps, 1)?;
                } else if let Some(agent) = line.strip_prefix(b"agent=") {
                    if !word(agent) {
                        return Err(Refusal::Protocol);
                    }
                    singleton(&mut caps, 2)?;
                } else {
                    return Err(Refusal::Unsupported);
                }
            }
            Packet::Flush => return Err(Refusal::Protocol),
        }
    }
    let mut flags = 0;
    let mut wants = false;
    let mut done = false;
    let mut wanted_refs = BTreeSet::new();
    loop {
        match packets.next()? {
            Packet::Flush => {
                packets.end()?;
                if command == Command::Fetch && !wants {
                    return Err(Refusal::Protocol);
                }
                return Ok(command);
            }
            Packet::Delimiter => return Err(Refusal::Protocol),
            Packet::Data(data) => {
                if done {
                    return Err(Refusal::Protocol);
                }
                let line = text(data)?;
                match command {
                    Command::LsRefs => match line {
                        b"peel" => singleton(&mut flags, 1)?,
                        b"symrefs" => singleton(&mut flags, 2)?,
                        b"unborn" => singleton(&mut flags, 4)?,
                        _ => {
                            let prefix = line
                                .strip_prefix(b"ref-prefix ")
                                .ok_or(Refusal::Unsupported)?;
                            if !reference(prefix, true) {
                                return Err(Refusal::Protocol);
                            }
                        }
                    },
                    Command::Fetch => match line {
                        b"thin-pack" => singleton(&mut flags, 1)?,
                        b"no-progress" => singleton(&mut flags, 2)?,
                        b"include-tag" => singleton(&mut flags, 4)?,
                        b"ofs-delta" => singleton(&mut flags, 8)?,
                        b"sideband-all" => singleton(&mut flags, 16)?,
                        b"done" => done = true,
                        _ => {
                            if let Some(value) = line.strip_prefix(b"want ") {
                                if !oid(value) {
                                    return Err(Refusal::Protocol);
                                }
                                wants = true;
                            } else if let Some(value) = line.strip_prefix(b"have ") {
                                if !oid(value) {
                                    return Err(Refusal::Protocol);
                                }
                            } else if let Some(value) = line.strip_prefix(b"want-ref ") {
                                if !reference(value, false) || !wanted_refs.insert(value) {
                                    return Err(Refusal::Protocol);
                                }
                                wants = true;
                            } else {
                                return Err(Refusal::Unsupported);
                            }
                        }
                    },
                }
            }
        }
    }
}

/// Validate a complete bounded HTTP response without rewriting its bytes.
/// HTTP response-end is EOF: remote-curl adds 0002 only to its local Git pipe.
#[cfg(test)]
pub(crate) fn response(
    operation: Operation,
    command: Option<Command>,
    body: &[u8],
) -> Result<(), Refusal> {
    response_with_cancel(operation, command, body, None)
}
fn response_with_cancel(
    operation: Operation,
    command: Option<Command>,
    body: &[u8],
    cancel: Option<&AtomicBool>,
) -> Result<(), Refusal> {
    let mut packets = Packets {
        remaining: body,
        cancel,
    };
    match (operation, command) {
        (Operation::Discovery, None) => discovery(&mut packets),
        (Operation::UploadPack, Some(Command::LsRefs)) => refs(&mut packets),
        (Operation::UploadPack, Some(Command::Fetch)) => fetch(&mut packets),
        _ => Err(Refusal::Protocol),
    }
}

/// Check credential spellings both in the raw body and after packet framing
/// and sideband bytes have been removed. This validates the entire structure
/// before matching, including bytes after a potential match.
/// Patterns are borrowed; no decoded payload or secret byte buffer is created.
#[cfg(test)]
pub(crate) fn contains_credential(
    operation: Operation,
    command: Option<Command>,
    body: &[u8],
    secrets: &[&[u8]],
) -> Result<bool, Refusal> {
    contains_credential_with_cancel(operation, command, body, secrets, None)
}
pub(crate) fn contains_credential_with_cancel(
    operation: Operation,
    command: Option<Command>,
    body: &[u8],
    secrets: &[&[u8]],
    cancel: Option<&AtomicBool>,
) -> Result<bool, Refusal> {
    response_with_cancel(operation, command, body, cancel)?;
    let mut matchers = secrets
        .iter()
        .map(|secret| Matcher::new(secret))
        .collect::<Result<Vec<_>, _>>()?;
    for (index, byte) in body.iter().enumerate() {
        if index % 8192 == 0 && cancel.is_some_and(|v| v.load(Ordering::Acquire)) {
            return Err(Refusal::Deadline);
        }
        for matcher in &mut matchers {
            if matcher.feed(4, *byte) {
                return Ok(true);
            }
        }
    }
    let is_fetch = operation == Operation::UploadPack && command == Some(Command::Fetch);
    let mut packets = Packets {
        remaining: body,
        cancel,
    };
    loop {
        match packets.next()? {
            Packet::Flush => return Ok(false),
            Packet::Delimiter => (),
            Packet::Data(data) => {
                let (channel, payload) = if is_fetch {
                    match data.split_first() {
                        Some((band @ (1 | 2), payload)) => (usize::from(*band), payload),
                        _ => (0, data),
                    }
                } else {
                    (0, data)
                };
                for byte in payload {
                    for matcher in &mut matchers {
                        // Keep each channel's state across intervening packets
                        // from other channels. Also check the concatenation of
                        // all payloads, conservatively catching mixed channels.
                        if matcher.feed(channel, *byte) || matcher.feed(3, *byte) {
                            return Ok(true);
                        }
                    }
                }
            }
        }
    }
}

// Knuth-Morris-Pratt matching is linear in input length per borrowed pattern,
// including repeated-prefix adversarial inputs. Only prefix lengths and current
// positions are allocated; secret-bearing bytes remain in their original owner.
struct Matcher<'a> {
    pattern: &'a [u8],
    prefix: Vec<usize>,
    positions: [usize; 5],
}

impl<'a> Matcher<'a> {
    fn new(pattern: &'a [u8]) -> Result<Self, Refusal> {
        if pattern.is_empty() {
            return Err(Refusal::Configuration);
        }
        let mut prefix = vec![0; pattern.len()];
        let mut matched = 0;
        for index in 1..pattern.len() {
            while matched > 0 && pattern[index] != pattern[matched] {
                matched = prefix[matched - 1];
            }
            if pattern[index] == pattern[matched] {
                matched += 1;
            }
            prefix[index] = matched;
        }
        Ok(Self {
            pattern,
            prefix,
            positions: [0; 5],
        })
    }

    fn feed(&mut self, channel: usize, byte: u8) -> bool {
        let position = &mut self.positions[channel];
        while *position > 0 && byte != self.pattern[*position] {
            *position = self.prefix[*position - 1];
        }
        if byte == self.pattern[*position] {
            *position += 1;
        }
        if *position == self.pattern.len() {
            *position = self.prefix[*position - 1];
            true
        } else {
            false
        }
    }
}

fn discovery(packets: &mut Packets<'_>) -> Result<(), Refusal> {
    match packets.next()? {
        Packet::Data(data) if text(data)? == b"version 2" => (),
        _ => return Err(Refusal::Protocol),
    }
    let mut seen = 0;
    loop {
        match packets.next()? {
            Packet::Flush => {
                packets.end()?;
                // Both commands must exist; absent object-format means SHA-1.
                return if seen & 6 == 6 {
                    Ok(())
                } else {
                    Err(Refusal::Unsupported)
                };
            }
            Packet::Delimiter => return Err(Refusal::Protocol),
            Packet::Data(data) => {
                let line = text(data)?;
                let bit = if let Some(agent) = line.strip_prefix(b"agent=") {
                    if !word(agent) {
                        return Err(Refusal::Protocol);
                    }
                    1
                } else if line == b"ls-refs" || line == b"ls-refs=unborn" {
                    2
                } else if line == b"fetch" {
                    4
                } else if let Some(features) = line.strip_prefix(b"fetch=") {
                    let mut unique = BTreeSet::new();
                    for feature in features.split(|b| *b == b' ') {
                        if !matches!(
                            feature,
                            b"shallow"
                                | b"wait-for-done"
                                | b"filter"
                                | b"ref-in-want"
                                | b"sideband-all"
                        ) {
                            return Err(Refusal::Unsupported);
                        }
                        if !unique.insert(feature) {
                            return Err(Refusal::Protocol);
                        }
                    }
                    4
                } else if line == b"object-format=sha1" {
                    8
                } else if line == b"server-option" {
                    16
                } else if let Some(sid) = line.strip_prefix(b"session-id=") {
                    if !word(sid) {
                        return Err(Refusal::Protocol);
                    }
                    32
                } else if line == b"object-info" {
                    64
                } else {
                    // This also closes bundle-uri, packfile-uris and promisor
                    // remote advertisements that can introduce other locations.
                    return Err(Refusal::Unsupported);
                };
                singleton(&mut seen, bit)?;
            }
        }
    }
}

fn ref_line(line: &[u8], attributes: bool) -> Result<(), Refusal> {
    let mut fields = line.split(|b| *b == b' ');
    let object = fields.next().ok_or(Refusal::Protocol)?;
    let name = fields.next().ok_or(Refusal::Protocol)?;
    let unborn = object == b"unborn";
    if (!oid(object) && !(attributes && unborn))
        || !reference(name, false)
        || (unborn && name != b"HEAD")
    {
        return Err(Refusal::Protocol);
    }
    let mut seen = 0;
    for field in fields {
        if !attributes {
            return Err(Refusal::Protocol);
        }
        if let Some(target) = field.strip_prefix(b"symref-target:") {
            if !reference(target, false) {
                return Err(Refusal::Protocol);
            }
            singleton(&mut seen, 1)?;
        } else if let Some(peeled) = field.strip_prefix(b"peeled:") {
            if unborn || !oid(peeled) {
                return Err(Refusal::Protocol);
            }
            singleton(&mut seen, 2)?;
        } else {
            return Err(Refusal::Unsupported);
        }
    }
    if unborn && seen & 1 == 0 {
        return Err(Refusal::Protocol);
    }
    Ok(())
}

fn refs(packets: &mut Packets<'_>) -> Result<(), Refusal> {
    loop {
        match packets.next()? {
            Packet::Data(data) => ref_line(text(data)?, true)?,
            Packet::Flush => return packets.end(),
            Packet::Delimiter => return Err(Refusal::Protocol),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    Start,
    Acknowledgments,
    AfterAck,
    WantedRefs,
    AfterRefs,
    Pack,
}

fn fetch(packets: &mut Packets<'_>) -> Result<(), Refusal> {
    let mut section = Section::Start;
    let mut sideband_all = None;
    let mut ack = false;
    let mut nak = false;
    let mut ready = false;
    let mut wanted = false;
    let mut pack_data = false;
    loop {
        let data = match packets.next()? {
            Packet::Flush => {
                packets.end()?;
                return if (section == Section::Acknowledgments && (ack || nak) && !ready)
                    || (section == Section::Pack && pack_data)
                {
                    Ok(())
                } else {
                    Err(Refusal::Protocol)
                };
            }
            Packet::Delimiter => {
                section = match section {
                    Section::Acknowledgments if ready => Section::AfterAck,
                    Section::WantedRefs if wanted => Section::AfterRefs,
                    _ => return Err(Refusal::Protocol),
                };
                continue;
            }
            Packet::Data(data) => data,
        };
        let all = *sideband_all.get_or_insert(matches!(data.first(), Some(1..=3)));
        let payload = if all || section == Section::Pack {
            match data.split_first() {
                Some((1, payload)) => payload,
                Some((2, _)) => continue, // Includes protocol keepalive packets.
                _ => return Err(Refusal::Protocol), // Fatal band 3 is never success.
            }
        } else {
            data
        };
        if section == Section::Pack {
            if !payload.is_empty() {
                pack_data = true;
            }
            continue;
        }
        let line = text(payload)?;
        match section {
            Section::Start | Section::AfterAck | Section::AfterRefs => {
                section = match line {
                    b"acknowledgments" if section == Section::Start => Section::Acknowledgments,
                    b"wanted-refs" if section != Section::AfterRefs => Section::WantedRefs,
                    b"packfile" => Section::Pack,
                    _ => return Err(Refusal::Unsupported),
                };
            }
            Section::Acknowledgments => {
                if ready {
                    return Err(Refusal::Protocol);
                }
                if line == b"NAK" && !ack && !nak {
                    nak = true;
                } else if line == b"ready" {
                    ready = true;
                } else if let Some(object) = line.strip_prefix(b"ACK ") {
                    if nak || !oid(object) {
                        return Err(Refusal::Protocol);
                    }
                    ack = true;
                } else {
                    return Err(Refusal::Protocol);
                }
            }
            Section::WantedRefs => {
                ref_line(line, false)?;
                wanted = true;
            }
            Section::Pack => unreachable!(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OID: &str = "0123456789abcdef0123456789abcdef01234567";

    fn packet(data: &[u8]) -> Vec<u8> {
        let mut out = format!("{:04x}", data.len() + 4).into_bytes();
        out.extend_from_slice(data);
        out
    }

    fn message(lines: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for line in lines {
            if matches!(*line, b"0000" | b"0001" | b"0002") {
                out.extend_from_slice(line);
            } else {
                out.extend(packet(line));
            }
        }
        out
    }

    fn fetch_request(args: &[&[u8]]) -> Vec<u8> {
        let mut body = message(&[
            b"command=fetch",
            b"agent=git/2.55.0",
            b"object-format=sha1",
            b"0001",
        ]);
        for arg in args {
            body.extend(packet(arg));
        }
        body.extend_from_slice(b"0000");
        body
    }

    #[test]
    fn accepts_git_mixed_newlines_and_negotiation_rounds() {
        let refs = message(&[
            b"command=ls-refs\n",
            b"agent=git/2.55.0",
            b"object-format=sha1",
            b"0001",
            b"peel\n",
            b"symrefs\n",
            b"unborn\n",
            b"ref-prefix refs/heads/\n",
            b"ref-prefix HEAD\n",
            b"ref-prefix refs/tags/\n",
            b"0000",
        ]);
        assert_eq!(request(&refs), Ok(Command::LsRefs));
        let want = format!("want {OID}\n");
        let have = format!("have {OID}\n");
        assert_eq!(
            request(&fetch_request(&[
                b"thin-pack",
                b"no-progress",
                b"include-tag",
                b"ofs-delta",
                want.as_bytes(),
                b"done\n"
            ])),
            Ok(Command::Fetch)
        );
        assert_eq!(
            request(&fetch_request(&[want.as_bytes(), have.as_bytes()])),
            Ok(Command::Fetch)
        );
        assert_eq!(
            request(&fetch_request(&[
                b"want-ref refs/heads/main\n",
                b"want-ref HEAD\n",
                b"done"
            ])),
            Ok(Command::Fetch)
        );
    }

    #[test]
    fn rejects_command_and_capability_escape_routes() {
        for command in [
            b"command=receive-pack".as_slice(),
            b"command=bundle-uri",
            b"command=object-info",
            b"command=fetch\ncommand=ls-refs",
            b"command=fetch\0",
        ] {
            assert!(request(&message(&[command, b"0001", b"0000"])).is_err());
        }
        for cap in [
            b"object-format=sha256".as_slice(),
            b"server-option=uploadpack.allowAnySHA1InWant=true",
            b"promisor-remote=x",
            b"agent=two words",
            b"command=ls-refs",
        ] {
            assert!(request(&message(&[b"command=ls-refs", cap, b"0001", b"0000"])).is_err());
        }
        assert!(request(&message(&[
            b"command=ls-refs",
            b"agent=a",
            b"agent=b",
            b"0001",
            b"0000"
        ]))
        .is_err());
    }

    #[test]
    fn rejects_unsupported_fetch_extensions_and_unsafe_refs() {
        for arg in [
            b"filter blob:none".as_slice(),
            b"deepen 1",
            b"shallow 0123456789abcdef0123456789abcdef01234567",
            b"packfile-uris https",
            b"wait-for-done",
            b"want-ref refs/../secret",
            b"want-ref refs/heads/x.lock",
            b"want-ref https://other.invalid/a",
            b"want-ref refs/heads/a\nb",
            b"want 0123456789abcdef0123456789abcdef012345678901234567890123456789abcd",
        ] {
            assert!(request(&fetch_request(&[b"want-ref HEAD", arg])).is_err());
        }
        assert!(request(&fetch_request(&[b"want-ref HEAD", b"want-ref HEAD"])).is_err());
        assert!(request(&fetch_request(&[
            b"want-ref HEAD",
            b"done",
            b"have 0123456789abcdef0123456789abcdef01234567"
        ]))
        .is_err());
        assert!(request(&fetch_request(&[b"done"])).is_err());
    }

    #[test]
    fn rejects_all_truncations_and_trailing_packets() {
        let valid = fetch_request(&[b"want-ref HEAD", b"done"]);
        for len in 0..valid.len() {
            assert!(request(&valid[..len]).is_err(), "prefix length {len}");
        }
        for suffix in [b"x".as_slice(), b"0000", b"0001", b"0002", valid.as_slice()] {
            let mut body = valid.clone();
            body.extend_from_slice(suffix);
            assert!(request(&body).is_err());
        }
        for malformed in [
            b"0000".as_slice(),
            b"0001",
            b"0002",
            b"0003",
            b"0004",
            b"ffffx",
            b"zzzzx",
        ] {
            assert!(request(malformed).is_err());
        }
        assert_eq!(
            request(&vec![b'x'; REQUEST_LIMIT + 1]),
            Err(Refusal::Bounds)
        );
    }

    #[test]
    fn accepts_default_discovery_and_ref_attributes() {
        let discovery = message(&[
            b"version 2\n",
            b"agent=git/2.55.0",
            b"ls-refs=unborn",
            b"fetch=shallow wait-for-done",
            b"server-option",
            b"object-format=sha1",
            b"0000",
        ]);
        assert_eq!(response(Operation::Discovery, None, &discovery), Ok(()));
        let head = format!("{OID} HEAD symref-target:refs/heads/main\n");
        let tag = format!("{OID} refs/tags/v1 peeled:{OID}\n");
        for refs in [
            message(&[head.as_bytes(), tag.as_bytes(), b"0000"]),
            message(&[b"unborn HEAD symref-target:refs/heads/main\n", b"0000"]),
            b"0000".to_vec(),
        ] {
            assert_eq!(
                response(Operation::UploadPack, Some(Command::LsRefs), &refs),
                Ok(())
            );
        }
    }

    #[test]
    fn accepts_ack_only_and_binary_pack_responses() {
        let ack = format!("ACK {OID}\n");
        let wanted = format!("{OID} refs/heads/main\n");
        for body in [
            message(&[b"acknowledgments\n", b"NAK\n", b"0000"]),
            message(&[b"acknowledgments\n", ack.as_bytes(), b"0000"]),
            message(&[
                b"packfile\n",
                b"\x02progress\r",
                b"\x01PACK\0\0\0\x02",
                b"0000",
            ]),
            message(&[
                b"acknowledgments\n",
                ack.as_bytes(),
                b"ready\n",
                b"0001",
                b"wanted-refs\n",
                wanted.as_bytes(),
                b"0001",
                b"packfile\n",
                b"\x01PACK\0",
                b"0000",
            ]),
            message(&[
                b"\x02",
                b"\x01acknowledgments\n",
                b"\x01ready\n",
                b"0001",
                b"\x01packfile\n",
                b"\x01PACK\0",
                b"\x02progress",
                b"0000",
            ]),
        ] {
            assert_eq!(
                response(Operation::UploadPack, Some(Command::Fetch), &body),
                Ok(())
            );
        }
    }

    #[test]
    fn rejects_response_errors_alternate_locations_and_bad_sections() {
        for body in [
            message(&[b"packfile-uris\n", b"https://other.invalid/pack", b"0000"]),
            message(&[b"shallow-info\n", b"0000"]),
            message(&[b"ERR forbidden\n", b"0000"]),
            message(&[b"packfile\n", b"\x03fatal error", b"0000"]),
            message(&[b"packfile\n", b"\x01PACK", b"0001", b"0000"]),
            message(&[b"packfile\n", b"\x02only progress", b"0000"]),
            message(&[b"acknowledgments", b"ready", b"0000"]),
            message(&[
                b"acknowledgments",
                b"NAK",
                b"ACK 0123456789abcdef0123456789abcdef01234567",
                b"0000",
            ]),
            message(&[
                b"acknowledgments",
                b"NAK",
                b"0001",
                b"packfile",
                b"\x01PACK",
                b"0000",
            ]),
            message(&[b"\x01packfile", b"PACK", b"0000"]),
        ] {
            assert!(response(Operation::UploadPack, Some(Command::Fetch), &body).is_err());
        }
        for capability in [
            b"bundle-uri".as_slice(),
            b"promisor-remote=x",
            b"fetch=packfile-uris",
            b"object-format=sha256",
        ] {
            assert!(response(
                Operation::Discovery,
                None,
                &message(&[b"version 2", b"ls-refs", b"fetch", capability, b"0000"])
            )
            .is_err());
        }
    }

    #[test]
    fn rejects_truncated_or_trailing_response_frames() {
        let valid = message(&[b"packfile\n", b"\x01PACK\0", b"0000"]);
        for len in 0..valid.len() {
            assert!(response(Operation::UploadPack, Some(Command::Fetch), &valid[..len]).is_err());
        }
        for suffix in [b"0002".as_slice(), b"0000", b"garbage"] {
            let mut body = valid.clone();
            body.extend_from_slice(suffix);
            assert!(response(Operation::UploadPack, Some(Command::Fetch), &body).is_err());
        }
        assert!(response(Operation::Discovery, Some(Command::Fetch), &valid).is_err());
        assert!(response(Operation::UploadPack, None, &valid).is_err());
    }

    #[test]
    fn detects_credentials_split_across_progress_or_pack_packets() {
        let raw = b"ghs_fixture_secret";
        let basic = b"Basic eC1hY2Nlc3MtdG9rZW46Zml4dHVyZQ==";
        for body in [
            message(&[
                b"packfile",
                b"\x02ghs_fixture_",
                b"\x01PACK",
                b"\x02secret",
                b"0000",
            ]),
            message(&[
                b"packfile",
                b"\x01PACKghs_fixture_",
                b"\x02interleaved progress",
                b"\x01secret",
                b"0000",
            ]),
            message(&[
                b"\x01packfile",
                b"\x02Basic eC1hY2Nlc3MtdG9r",
                b"\x01PACK",
                b"\x02ZW46Zml4dHVyZQ==",
                b"0000",
            ]),
            message(&[b"packfile", b"\x01ghs_fixture_", b"\x02secret", b"0000"]),
        ] {
            // A raw substring scan alone misses every one of these responses.
            for secret in [raw.as_slice(), basic.as_slice()] {
                assert!(!body.windows(secret.len()).any(|window| window == secret));
            }
            assert_eq!(
                contains_credential(
                    Operation::UploadPack,
                    Some(Command::Fetch),
                    &body,
                    &[raw, basic]
                ),
                Ok(true)
            );
        }
    }

    #[test]
    fn credential_matching_handles_overlap_absence_and_invalid_tail() {
        let body = message(&[
            b"packfile",
            b"\x01PACKaaaa",
            b"\x02progress",
            b"\x01aaab",
            b"0000",
        ]);
        assert_eq!(
            contains_credential(
                Operation::UploadPack,
                Some(Command::Fetch),
                &body,
                &[b"aaaab"]
            ),
            Ok(true)
        );
        assert_eq!(
            contains_credential(
                Operation::UploadPack,
                Some(Command::Fetch),
                &body,
                &[b"aaaac", b"ghs_fixture_secret"]
            ),
            Ok(false)
        );
        assert_eq!(
            contains_credential(Operation::UploadPack, Some(Command::Fetch), &body, &[]),
            Ok(false)
        );
        assert_eq!(
            contains_credential(Operation::UploadPack, Some(Command::Fetch), &body, &[b""]),
            Err(Refusal::Configuration)
        );
        let mut invalid = body;
        invalid.extend_from_slice(b"0002");
        assert_eq!(
            contains_credential(
                Operation::UploadPack,
                Some(Command::Fetch),
                &invalid,
                &[b"PACK"]
            ),
            Err(Refusal::Protocol)
        );
    }

    #[test]
    fn detects_packet_boundary_credentials_in_discovery() {
        let body = message(&[
            b"version 2",
            b"agent=prefixsecret",
            b"ls-refs",
            b"fetch",
            b"0000",
        ]);
        assert!(!body
            .windows(b"secretls-refs".len())
            .any(|window| window == b"secretls-refs"));
        assert_eq!(
            contains_credential(Operation::Discovery, None, &body, &[b"secretls-refs"]),
            Ok(true)
        );
    }

    #[test]
    fn scans_raw_framing_and_large_repeated_prefixes() {
        let framed = message(&[b"packfile", b"\x01PACK", b"0000"]);
        // This spelling crosses a payload/framing boundary and exists only in
        // the raw stream, so decoded-only matching would miss it.
        assert_eq!(
            contains_credential(
                Operation::UploadPack,
                Some(Command::Fetch),
                &framed,
                &[b"PACK0000"]
            ),
            Ok(true)
        );

        let mut secret = vec![b'a'; 16 * 1024];
        secret.push(b'b');
        let mut data = vec![b'a'; 32 * 1024];
        data[0] = 1;
        let mut body = packet(b"packfile");
        for _ in 0..32 {
            body.extend(packet(&data));
        }
        body.extend_from_slice(b"0000");
        // A window-by-window matcher repeatedly compares this 16 KiB prefix.
        // KMP retains prefix lengths instead, with no timing-based assertion.
        assert_eq!(
            contains_credential(
                Operation::UploadPack,
                Some(Command::Fetch),
                &body,
                &[&secret]
            ),
            Ok(false)
        );
        body.truncate(body.len() - 4);
        body.extend(packet(b"\x01b"));
        body.extend_from_slice(b"0000");
        assert_eq!(
            contains_credential(
                Operation::UploadPack,
                Some(Command::Fetch),
                &body,
                &[&secret]
            ),
            Ok(true)
        );
    }
}

/// Extract the already validated fetch pack stream without progress channels.
/// The original packet body remains unchanged for eventual downstream output.
pub(crate) fn pack_stream(
    body: &[u8],
    cancel: &AtomicBool,
) -> Result<Option<Zeroizing<Vec<u8>>>, Refusal> {
    let mut packets = Packets {
        remaining: body,
        cancel: Some(cancel),
    };
    let mut pack: Option<Zeroizing<Vec<u8>>> = None;
    loop {
        match packets.next()? {
            Packet::Flush => return Ok(pack),
            Packet::Delimiter => (),
            Packet::Data(data) => {
                let payload = match data.split_first() {
                    Some((2, _)) => continue,
                    Some((1, payload)) => payload,
                    _ => data,
                };
                if let Some(bytes) = &mut pack {
                    if !matches!(data.first(), Some(1)) {
                        return Err(Refusal::Protocol);
                    }
                    bytes.extend_from_slice(payload);
                } else if payload.strip_suffix(b"\n").unwrap_or(payload) == b"packfile" {
                    let mut bytes = Zeroizing::new(Vec::new());
                    bytes
                        .try_reserve_exact(body.len())
                        .map_err(|_| Refusal::Bounds)?;
                    pack = Some(bytes);
                }
            }
        }
    }
}

/// Remove only the validated thin-pack option. Every resulting outgoing byte
/// is retained and hashed before admission; no external base can be requested.
pub(crate) fn without_thin_pack(body: Zeroizing<Vec<u8>>) -> Result<Zeroizing<Vec<u8>>, Refusal> {
    if request(&body)? != Command::Fetch {
        return Ok(body);
    }
    let mut packets = Packets::new(&body);
    let mut removed = None;
    loop {
        let start = body.len() - packets.remaining.len();
        match packets.next()? {
            Packet::Data(data) if text(data)? == b"thin-pack" => {
                removed = Some((start, body.len() - packets.remaining.len()));
            }
            Packet::Flush => break,
            _ => (),
        }
    }
    let Some((start, end)) = removed else {
        return Ok(body);
    };
    let mut normalized = Zeroizing::new(Vec::new());
    normalized
        .try_reserve_exact(body.len() - (end - start))
        .map_err(|_| Refusal::Bounds)?;
    normalized.extend_from_slice(&body[..start]);
    normalized.extend_from_slice(&body[end..]);
    Ok(normalized)
}
