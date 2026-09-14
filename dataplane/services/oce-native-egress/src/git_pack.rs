//! Bounded validation and reconstruction of self-contained SHA-1 Git packs.
//!
//! This parser implements the PACK and delta encodings documented by pinned
//! Git 2.55.0's gitformat-pack and patch-delta.c. It never executes Git or
//! repository contents. No object is released before every entry, dependency,
//! checksum and reconstructed-object credential check has succeeded.
use crate::Refusal;
use flate2::{Decompress, FlushDecompress, Status};
use ring::digest::{Context, SHA1_FOR_LEGACY_USE_ONLY};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
};
use zeroize::Zeroizing;

const OBJECTS: usize = 100_000;
const OBJECT_BYTES: usize = 16 * 1024 * 1024;
const TOTAL_BYTES: usize = 64 * 1024 * 1024;
const DEPTH: usize = 64;
const CHUNK: usize = 64 * 1024;

#[derive(Clone, Copy)]
enum Base {
    Full(u8),
    Offset(usize),
    Reference([u8; 20]),
}

struct Object {
    kind: u8,
    bytes: Zeroizing<Vec<u8>>,
    depth: usize,
}

struct Entry {
    base: Base,
    encoded: Option<Zeroizing<Vec<u8>>>,
    object: Option<Object>,
}

fn current(cancel: &AtomicBool) -> Result<(), Refusal> {
    if cancel.load(Ordering::Relaxed) {
        Err(Refusal::Deadline)
    } else {
        Ok(())
    }
}

fn bounded_total(total: &mut usize, increment: usize) -> Result<(), Refusal> {
    *total = total.checked_add(increment).ok_or(Refusal::Bounds)?;
    if *total > TOTAL_BYTES {
        return Err(Refusal::Bounds);
    }
    Ok(())
}

fn sha1(bytes: &[u8], cancel: &AtomicBool) -> Result<[u8; 20], Refusal> {
    let mut hash = Context::new(&SHA1_FOR_LEGACY_USE_ONLY);
    for chunk in bytes.chunks(CHUNK) {
        current(cancel)?;
        hash.update(chunk);
    }
    Ok(hash.finish().as_ref().try_into().expect("SHA-1 length"))
}

fn object_id(kind: u8, bytes: &[u8], cancel: &AtomicBool) -> Result<[u8; 20], Refusal> {
    let name = match kind {
        1 => b"commit".as_slice(),
        2 => b"tree",
        3 => b"blob",
        4 => b"tag",
        _ => return Err(Refusal::Protocol),
    };
    let mut hash = Context::new(&SHA1_FOR_LEGACY_USE_ONLY);
    hash.update(name);
    hash.update(b" ");
    hash.update(bytes.len().to_string().as_bytes());
    hash.update(b"\0");
    for chunk in bytes.chunks(CHUNK) {
        current(cancel)?;
        hash.update(chunk);
    }
    Ok(hash.finish().as_ref().try_into().expect("SHA-1 length"))
}

fn byte(input: &[u8], cursor: &mut usize) -> Result<u8, Refusal> {
    let result = *input.get(*cursor).ok_or(Refusal::Protocol)?;
    *cursor = cursor.checked_add(1).ok_or(Refusal::Bounds)?;
    Ok(result)
}

fn entry_header(input: &[u8], cursor: &mut usize) -> Result<(u8, usize), Refusal> {
    let first = byte(input, cursor)?;
    let kind = (first >> 4) & 7;
    let mut size = u64::from(first & 15);
    let mut more = first & 128 != 0;
    let mut shift = 4;
    while more {
        let next = byte(input, cursor)?;
        let value = u64::from(next & 127);
        if shift >= 64 || value > (u64::MAX >> shift) {
            return Err(Refusal::Bounds);
        }
        size = size.checked_add(value << shift).ok_or(Refusal::Bounds)?;
        shift += 7;
        more = next & 128 != 0;
    }
    let size = usize::try_from(size).map_err(|_| Refusal::Bounds)?;
    if size > OBJECT_BYTES {
        return Err(Refusal::Bounds);
    }
    Ok((kind, size))
}

fn ofs_distance(input: &[u8], cursor: &mut usize) -> Result<usize, Refusal> {
    let mut next = byte(input, cursor)?;
    let mut value = usize::from(next & 127);
    while next & 128 != 0 {
        next = byte(input, cursor)?;
        value = value
            .checked_add(1)
            .and_then(|v| v.checked_mul(128))
            .and_then(|v| v.checked_add(usize::from(next & 127)))
            .ok_or(Refusal::Bounds)?;
    }
    if value == 0 {
        return Err(Refusal::Protocol);
    }
    Ok(value)
}

fn inflate(
    input: &[u8],
    declared: usize,
    cancel: &AtomicBool,
) -> Result<(Zeroizing<Vec<u8>>, usize), Refusal> {
    // Fixed allocation includes one byte to detect an overlong zlib stream.
    // Truncation retains its already-zeroed spare byte; it never grows/reallocates.
    let mut output = Zeroizing::new(vec![0; declared + 1]);
    // The Read adapter can report EOF on a truncated stream without exposing
    // StreamEnd. Use the same maintained inflater's status API so the Adler
    // trailer must be consumed and validated before accepting the entry.
    let mut decoder = Decompress::new(true);
    let mut written = 0usize;
    let mut consumed = 0usize;
    loop {
        current(cancel)?;
        let end = output.len().min(written + CHUNK);
        // Empty deflate blocks can consume input without producing output.
        // Bound both sides of each call so they cannot defer cancellation over
        // the entire compressed pack in a single backend invocation.
        let input_end = consumed
            .checked_add(CHUNK)
            .ok_or(Refusal::Bounds)?
            .min(input.len());
        let status = decoder
            .decompress(
                input.get(consumed..input_end).ok_or(Refusal::Protocol)?,
                &mut output[written..end],
                FlushDecompress::None,
            )
            .map_err(|_| Refusal::Protocol)?;
        let next_written = usize::try_from(decoder.total_out()).map_err(|_| Refusal::Bounds)?;
        let next_consumed = usize::try_from(decoder.total_in()).map_err(|_| Refusal::Bounds)?;
        let progressed = next_written != written || next_consumed != consumed;
        written = next_written;
        consumed = next_consumed;
        if written > declared {
            return Err(Refusal::Bounds);
        }
        if status == Status::StreamEnd {
            break;
        }
        if !progressed {
            return Err(Refusal::Protocol);
        }
    }
    if written != declared {
        return Err(Refusal::Protocol);
    }
    if consumed == 0 || consumed > input.len() {
        return Err(Refusal::Protocol);
    }
    output.truncate(declared);
    Ok((output, consumed))
}

fn delta_size(input: &[u8], cursor: &mut usize) -> Result<usize, Refusal> {
    let mut value = 0u64;
    let mut shift = 0;
    loop {
        let next = byte(input, cursor)?;
        let part = u64::from(next & 127);
        if shift >= 64 || part > (u64::MAX >> shift) {
            return Err(Refusal::Bounds);
        }
        value = value.checked_add(part << shift).ok_or(Refusal::Bounds)?;
        if next & 128 == 0 {
            let result = usize::try_from(value).map_err(|_| Refusal::Bounds)?;
            return if result <= OBJECT_BYTES {
                Ok(result)
            } else {
                Err(Refusal::Bounds)
            };
        }
        shift += 7;
    }
}

fn delta_header(input: &[u8]) -> Result<(usize, usize, usize), Refusal> {
    // Git's patch_delta rejects encodings shorter than DELTA_SIZE_MIN.
    if input.len() < 4 {
        return Err(Refusal::Protocol);
    }
    let mut cursor = 0;
    let base = delta_size(input, &mut cursor)?;
    let result = delta_size(input, &mut cursor)?;
    Ok((base, result, cursor))
}

fn apply_delta(base: &Object, delta: &[u8], cancel: &AtomicBool) -> Result<Object, Refusal> {
    current(cancel)?;
    let depth = base.depth.checked_add(1).ok_or(Refusal::Bounds)?;
    if depth > DEPTH {
        return Err(Refusal::Bounds);
    }
    let (base_size, result_size, mut cursor) = delta_header(delta)?;
    if base_size != base.bytes.len() {
        return Err(Refusal::Protocol);
    }
    let mut output = Zeroizing::new(vec![0; result_size]);
    let mut written = 0usize;
    while cursor < delta.len() {
        current(cancel)?;
        let op = byte(delta, &mut cursor)?;
        let source = if op & 128 != 0 {
            let mut offset = 0u64;
            let mut size = 0u64;
            for index in 0..4 {
                if op & (1 << index) != 0 {
                    offset |= u64::from(byte(delta, &mut cursor)?) << (index * 8);
                }
            }
            for index in 0..3 {
                if op & (1 << (index + 4)) != 0 {
                    size |= u64::from(byte(delta, &mut cursor)?) << (index * 8);
                }
            }
            if size == 0 {
                size = 0x10000;
            }
            let offset = usize::try_from(offset).map_err(|_| Refusal::Bounds)?;
            let size = usize::try_from(size).map_err(|_| Refusal::Bounds)?;
            let end = offset.checked_add(size).ok_or(Refusal::Bounds)?;
            base.bytes.get(offset..end).ok_or(Refusal::Protocol)?
        } else if op != 0 {
            let end = cursor.checked_add(usize::from(op)).ok_or(Refusal::Bounds)?;
            let literal = delta.get(cursor..end).ok_or(Refusal::Protocol)?;
            cursor = end;
            literal
        } else {
            return Err(Refusal::Protocol);
        };
        let end = written.checked_add(source.len()).ok_or(Refusal::Bounds)?;
        let target = output.get_mut(written..end).ok_or(Refusal::Protocol)?;
        // Large copies check cancellation at fixed byte intervals too.
        for (from, to) in source.chunks(CHUNK).zip(target.chunks_mut(CHUNK)) {
            current(cancel)?;
            to.copy_from_slice(from);
            #[cfg(test)]
            test_control::after_delta_copy(cancel);
        }
        written = end;
    }
    if written != result_size {
        return Err(Refusal::Protocol);
    }
    Ok(Object {
        kind: base.kind,
        bytes: output,
        depth,
    })
}

/// Validate a complete self-contained SHA-1 pack and reject any supplied
/// credential spelling in a fully reconstructed object. Input bytes are owned
/// by the caller; all owned inflated, delta and reconstructed bytes zeroize.
pub(crate) fn validate(pack: &[u8], secrets: &[&[u8]], cancel: &AtomicBool) -> Result<(), Refusal> {
    current(cancel)?;
    if pack.len() < 32 {
        return Err(Refusal::Protocol);
    }
    if pack.len() > TOTAL_BYTES {
        return Err(Refusal::Bounds);
    }
    if &pack[..4] != b"PACK" || !matches!(&pack[4..8], b"\0\0\0\x02" | b"\0\0\0\x03") {
        return Err(Refusal::Protocol);
    }
    let count = u32::from_be_bytes(pack[8..12].try_into().expect("checked header")) as usize;
    if count > OBJECTS {
        return Err(Refusal::Bounds);
    }
    let entries_end = pack.len() - 20;
    if sha1(&pack[..entries_end], cancel)?.as_slice() != &pack[entries_end..] {
        return Err(Refusal::Protocol);
    }
    let bytes = &pack[..entries_end];
    let mut cursor = 12;
    let mut entries = Vec::with_capacity(count);
    let mut offsets = BTreeMap::new();
    let mut inflated = 0;
    let mut reconstructed = 0;
    for index in 0..count {
        current(cancel)?;
        let offset = cursor;
        let (kind, size) = entry_header(bytes, &mut cursor)?;
        bounded_total(&mut inflated, size)?;
        let base = match kind {
            1..=4 => Base::Full(kind),
            6 => {
                let distance = ofs_distance(bytes, &mut cursor)?;
                let base_offset = offset.checked_sub(distance).ok_or(Refusal::Protocol)?;
                let base_index = *offsets.get(&base_offset).ok_or(Refusal::Protocol)?;
                Base::Offset(base_index)
            }
            7 => {
                let end = cursor.checked_add(20).ok_or(Refusal::Bounds)?;
                let id = bytes.get(cursor..end).ok_or(Refusal::Protocol)?;
                cursor = end;
                Base::Reference(id.try_into().expect("checked ID length"))
            }
            _ => return Err(Refusal::Unsupported),
        };
        let (decoded, consumed) =
            inflate(bytes.get(cursor..).ok_or(Refusal::Protocol)?, size, cancel)?;
        cursor = cursor.checked_add(consumed).ok_or(Refusal::Bounds)?;
        let result_size = match base {
            Base::Full(_) => size,
            _ => delta_header(&decoded)?.1,
        };
        bounded_total(&mut reconstructed, result_size)?;
        offsets.insert(offset, index);
        entries.push(Entry {
            base,
            encoded: Some(decoded),
            object: None,
        });
    }
    if cursor != entries_end {
        return Err(Refusal::Protocol);
    }
    let patterns = secrets
        .iter()
        .map(|secret| Pattern::new(secret))
        .collect::<Result<Vec<_>, _>>()?;
    let mut ids: BTreeMap<[u8; 20], usize> = BTreeMap::new();
    let mut remaining = count;
    // Each successful pass resolves at least one level. A full object is level
    // zero; at most 64 more dependency levels are permitted, including forward
    // REF references. No progress means missing/external/cyclic dependencies.
    for _ in 0..=DEPTH {
        current(cancel)?;
        let before = remaining;
        for index in 0..entries.len() {
            current(cancel)?;
            if entries[index].object.is_some() {
                continue;
            }
            let base_index = match entries[index].base {
                Base::Full(_) => None,
                Base::Offset(base) => Some(base),
                Base::Reference(id) => match ids.get(&id) {
                    Some(base) => Some(*base),
                    None => continue,
                },
            };
            let object = if let Some(base_index) = base_index {
                let Some(base) = entries[base_index].object.as_ref() else {
                    continue;
                };
                apply_delta(
                    base,
                    entries[index].encoded.as_ref().ok_or(Refusal::Protocol)?,
                    cancel,
                )?
            } else {
                let Base::Full(kind) = entries[index].base else {
                    return Err(Refusal::Protocol);
                };
                Object {
                    kind,
                    bytes: entries[index].encoded.take().ok_or(Refusal::Protocol)?,
                    depth: 0,
                }
            };
            for pattern in &patterns {
                if pattern.matches(&object.bytes, cancel)? {
                    return Err(Refusal::Protocol);
                }
            }
            let id = object_id(object.kind, &object.bytes, cancel)?;
            if ids.insert(id, index).is_some() {
                return Err(Refusal::Protocol);
            }
            entries[index].encoded = None; // Zeroize resolved delta instructions.
            entries[index].object = Some(object);
            remaining -= 1;
        }
        if remaining == 0 {
            return Ok(());
        }
        if remaining == before {
            return Err(Refusal::Protocol);
        }
    }
    Err(Refusal::Bounds)
}

/// Finite test synchronization for the actual blocking reconstruction worker.
/// A per-worker scope prevents another concurrent request from entering the gate.
#[cfg(test)]
pub(crate) mod test_control {
    use super::*;
    use std::{
        cell::RefCell,
        sync::{Arc, Condvar, Mutex},
        time::{Duration, Instant},
    };
    use tokio::sync::Notify;

    thread_local! {
        static ACTIVE: RefCell<Option<Arc<Control>>> = const { RefCell::new(None) };
    }

    #[derive(Default)]
    pub(crate) struct Control {
        entered: AtomicBool,
        cancelled: AtomicBool,
        finished: AtomicBool,
        released: Mutex<bool>,
        wake: Condvar,
        entered_notice: Notify,
        cancelled_notice: Notify,
    }
    impl Control {
        pub(crate) fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }
        pub(crate) async fn wait_entered(&self) {
            self.entered_notice.notified().await;
        }
        pub(crate) async fn wait_cancelled(&self) {
            self.cancelled_notice.notified().await;
        }
        pub(crate) fn is_entered(&self) -> bool {
            self.entered.load(Ordering::Acquire)
        }
        pub(crate) fn is_cancelled(&self) -> bool {
            self.cancelled.load(Ordering::Acquire)
        }
        pub(crate) fn is_finished(&self) -> bool {
            self.finished.load(Ordering::Acquire)
        }
        pub(crate) fn is_released(&self) -> bool {
            *self.released.lock().unwrap()
        }
        pub(crate) fn release(&self) {
            *self.released.lock().unwrap() = true;
            self.wake.notify_one();
        }
    }

    pub(crate) struct Scope(Option<Arc<Control>>);
    impl Scope {
        pub(crate) fn install(control: Option<Arc<Control>>) -> Self {
            ACTIVE.with(|active| {
                assert!(active.borrow().is_none());
                *active.borrow_mut() = control.clone();
            });
            Self(control)
        }
    }
    impl Drop for Scope {
        fn drop(&mut self) {
            ACTIVE.with(|active| active.borrow_mut().take());
            if let Some(control) = &self.0 {
                control.finished.store(true, Ordering::Release);
            }
        }
    }

    pub(super) fn after_delta_copy(cancel: &AtomicBool) {
        let Some(control) = ACTIVE.with(|active| active.borrow().clone()) else {
            return;
        };
        if control.entered.swap(true, Ordering::AcqRel) {
            return;
        }
        // Entry is reported only after apply_delta has copied real object data.
        // Keep the worker alive after it observes cancellation so the fixture
        // can verify that the serve result and terminal receipt await drainage.
        control.entered_notice.notify_one();
        let end = Instant::now() + Duration::from_secs(10);
        let mut released = control.released.lock().unwrap();
        while !*released {
            if cancel.load(Ordering::Acquire) && !control.cancelled.swap(true, Ordering::AcqRel) {
                control.cancelled_notice.notify_one();
            }
            assert!(
                Instant::now() < end,
                "test reconstruction gate was not released"
            );
            released = control
                .wake
                .wait_timeout(released, Duration::from_millis(10))
                .unwrap()
                .0;
        }
    }
}

// One borrowed-pattern prefix table is built per validation, then reused for
// all objects. No copied credential buffer and no quadratic substring scans.
pub(crate) struct Pattern<'a> {
    bytes: &'a [u8],
    prefix: Vec<usize>,
}

impl<'a> Pattern<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Result<Self, Refusal> {
        if bytes.is_empty() {
            return Err(Refusal::Configuration);
        }
        let mut prefix = vec![0; bytes.len()];
        let mut matched = 0;
        for index in 1..bytes.len() {
            while matched > 0 && bytes[index] != bytes[matched] {
                matched = prefix[matched - 1];
            }
            if bytes[index] == bytes[matched] {
                matched += 1;
            }
            prefix[index] = matched;
        }
        Ok(Self { bytes, prefix })
    }

    pub(crate) fn matches(&self, bytes: &[u8], cancel: &AtomicBool) -> Result<bool, Refusal> {
        let mut matched = 0;
        for chunk in bytes.chunks(CHUNK) {
            current(cancel)?;
            for byte in chunk {
                while matched > 0 && *byte != self.bytes[matched] {
                    matched = self.prefix[matched - 1];
                }
                if *byte == self.bytes[matched] {
                    matched += 1;
                }
                if matched == self.bytes.len() {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write;

    fn header(kind: u8, mut size: usize) -> Vec<u8> {
        let mut first = (kind << 4) | (size as u8 & 15);
        size >>= 4;
        if size != 0 {
            first |= 128;
        }
        let mut result = vec![first];
        while size != 0 {
            let mut byte = size as u8 & 127;
            size >>= 7;
            if size != 0 {
                byte |= 128;
            }
            result.push(byte);
        }
        result
    }

    fn entry(kind: u8, base: &[u8], data: &[u8]) -> Vec<u8> {
        let mut result = header(kind, data.len());
        result.extend_from_slice(base);
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        result.extend(encoder.finish().unwrap());
        result
    }

    fn pack(entries: &[Vec<u8>]) -> Vec<u8> {
        let mut result = b"PACK\0\0\0\x02".to_vec();
        result.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        for entry in entries {
            result.extend(entry);
        }
        checksum(result)
    }

    fn checksum(mut data: Vec<u8>) -> Vec<u8> {
        let digest = ring::digest::digest(&SHA1_FOR_LEGACY_USE_ONLY, &data);
        data.extend_from_slice(digest.as_ref());
        data
    }

    fn ofs(mut distance: usize) -> Vec<u8> {
        let mut result = vec![distance as u8 & 127];
        distance >>= 7;
        while distance != 0 {
            distance -= 1;
            result.push(128 | (distance as u8 & 127));
            distance >>= 7;
        }
        result.reverse();
        result
    }

    fn delta_integer(mut value: usize) -> Vec<u8> {
        let mut result = Vec::new();
        loop {
            let mut next = value as u8 & 127;
            value >>= 7;
            if value != 0 {
                next |= 128;
            }
            result.push(next);
            if value == 0 {
                return result;
            }
        }
    }

    fn blob_id(data: &[u8]) -> [u8; 20] {
        let mut hash_input = format!("blob {}\0", data.len()).into_bytes();
        hash_input.extend_from_slice(data);
        ring::digest::digest(&SHA1_FOR_LEGACY_USE_ONLY, &hash_input)
            .as_ref()
            .try_into()
            .unwrap()
    }

    fn check(pack: &[u8], secrets: &[&[u8]]) -> Result<(), Refusal> {
        validate(pack, secrets, &AtomicBool::new(false))
    }

    #[test]
    fn full_objects_validate_and_compressed_credential_is_refused() {
        let ordinary = pack(&[entry(3, &[], b"hello\n")]);
        assert_eq!(check(&ordinary, &[b"ghs_demo_secret"]), Ok(()));
        assert_eq!(
            blob_id(b"hello\n"),
            [
                0xce, 0x01, 0x36, 0x25, 0x03, 0x0b, 0xa8, 0xdb, 0xa9, 0x06, 0xf7, 0x56, 0x96, 0x7f,
                0x9e, 0x9c, 0xa3, 0x94, 0x46, 0x4a
            ]
        );
        let canary = b"ghs_demo_secret";
        let encoded = pack(&[entry(3, &[], canary)]);
        assert!(!encoded.windows(canary.len()).any(|window| window == canary));
        assert_eq!(check(&encoded, &[canary]), Err(Refusal::Protocol));
        assert_eq!(check(&pack(&[]), &[]), Ok(()));
        let mut version3 = ordinary[..ordinary.len() - 20].to_vec();
        version3[7] = 3;
        assert_eq!(check(&checksum(version3), &[]), Ok(()));
    }

    #[test]
    fn copy_and_literal_reconstruct_credentials_for_ofs_and_forward_ref() {
        for (prefix, suffix) in [
            (b"ghs_demo_".as_slice(), b"secret".as_slice()),
            (b"Basic c3lu", b"dGhldGlj"),
        ] {
            let mut canary = prefix.to_vec();
            canary.extend_from_slice(suffix);
            let mut delta = vec![
                prefix.len() as u8,
                canary.len() as u8,
                0x90,
                prefix.len() as u8,
                suffix.len() as u8,
            ];
            delta.extend_from_slice(suffix);
            let base = entry(3, &[], prefix);
            let child = entry(6, &ofs(base.len()), &delta);
            let forward = entry(7, &blob_id(prefix), &delta);
            for encoded in [pack(&[base.clone(), child]), pack(&[forward, base])] {
                assert_eq!(check(&encoded, &[]), Ok(()));
                assert!(!encoded.windows(canary.len()).any(|window| window == canary));
                assert_eq!(check(&encoded, &[&canary]), Err(Refusal::Protocol));
            }
        }
    }

    #[test]
    fn rejects_missing_bases_duplicate_objects_and_wrong_offsets() {
        assert_eq!(
            check(&pack(&[entry(7, &[7; 20], &[1, 1, 1, b'x'])]), &[]),
            Err(Refusal::Protocol)
        );
        let root = entry(3, &[], b"a");
        assert_eq!(
            check(&pack(&[root.clone(), root.clone()]), &[]),
            Err(Refusal::Protocol)
        );
        let child = entry(6, &ofs(root.len() - 1), &[1, 2, 0x90, 1, 1, b'b']);
        assert_eq!(check(&pack(&[root, child]), &[]), Err(Refusal::Protocol));
        assert_eq!(
            check(&pack(&[entry(6, &[0], &[1, 1, 1, b'x'])]), &[]),
            Err(Refusal::Protocol)
        );
    }

    #[test]
    fn checks_checksum_zlib_completion_and_exact_entry_count() {
        let object = entry(3, &[], b"ordinary object bytes");
        let valid = pack(&[object.clone()]);
        for end in 0..valid.len() {
            assert!(check(&valid[..end], &[]).is_err());
        }
        let mut bad_checksum = valid.clone();
        *bad_checksum.last_mut().unwrap() ^= 1;
        assert_eq!(check(&bad_checksum, &[]), Err(Refusal::Protocol));
        for end in 1..object.len() {
            assert!(
                check(&pack(&[object[..end].to_vec()]), &[]).is_err(),
                "zlib truncation {end}"
            );
        }
        let mut extra = valid[..valid.len() - 20].to_vec();
        extra.extend_from_slice(b"tail");
        assert_eq!(check(&checksum(extra), &[]), Err(Refusal::Protocol));
        let mut wrong_size = object;
        wrong_size[0] ^= 1;
        assert!(check(&pack(&[wrong_size]), &[]).is_err());
    }

    #[test]
    fn rejects_malformed_delta_programs_before_any_object_release() {
        let root = entry(3, &[], b"abc");
        for delta in [
            vec![3, 1, 0],          // Reserved opcode.
            vec![3, 1, 2, b'x'],    // Truncated literal.
            vec![3, 1, 0x91],       // Truncated copy fields.
            vec![3, 1, 0x91, 3, 1], // Base-copy end out of range.
            vec![3, 1, 0x90, 2],    // Output-copy end out of range.
            vec![3, 2, 1, b'x'],    // Short output.
            vec![2, 1, 1, b'x'],    // Incorrect declared base length.
            vec![3, 1, 0x80],       // Implicit 64 KiB copy exceeds base.
            vec![0x80; 12],         // Unterminated/overflowing size.
        ] {
            let child = entry(6, &ofs(root.len()), &delta);
            assert!(check(&pack(&[root.clone(), child]), &[]).is_err());
        }
    }

    #[test]
    fn enforces_object_count_size_aggregate_and_cancellation_bounds() {
        let mut excessive_count = b"PACK\0\0\0\x02".to_vec();
        excessive_count.extend_from_slice(&((OBJECTS + 1) as u32).to_be_bytes());
        assert_eq!(check(&checksum(excessive_count), &[]), Err(Refusal::Bounds));
        assert_eq!(
            check(&pack(&[header(3, OBJECT_BYTES + 1)]), &[]),
            Err(Refusal::Bounds)
        );
        let overlong = vec![b'x'; OBJECT_BYTES + 1];
        let mut compressed = entry(3, &[], &overlong);
        let original_header = header(3, overlong.len());
        compressed.splice(..original_header.len(), header(3, OBJECT_BYTES));
        assert_eq!(check(&pack(&[compressed]), &[]), Err(Refusal::Bounds));
        let mut total = TOTAL_BYTES;
        assert_eq!(bounded_total(&mut total, 1), Err(Refusal::Bounds));
        assert_eq!(
            validate(&pack(&[]), &[], &AtomicBool::new(true)),
            Err(Refusal::Deadline)
        );
        assert_eq!(check(&pack(&[]), &[b""]), Err(Refusal::Configuration));
    }

    #[test]
    fn enforces_delta_depth_at_sixty_four() {
        let mut entries = vec![entry(3, &[], b"x")];
        for depth in 1..=DEPTH + 1 {
            let delta = [depth as u8, (depth + 1) as u8, 0x90, depth as u8, 1, b'a'];
            let child = entry(6, &ofs(entries.last().unwrap().len()), &delta);
            entries.push(child);
            if depth == DEPTH {
                assert_eq!(check(&pack(&entries), &[]), Ok(()));
            }
        }
        assert_eq!(check(&pack(&entries), &[]), Err(Refusal::Bounds));
    }

    #[test]
    fn resolves_reversed_ref_chain_and_rejects_unrooted_graph() {
        let mut entries = vec![entry(3, &[], b"x")];
        let mut base = b"x".to_vec();
        for depth in 1..=DEPTH {
            let delta = [depth as u8, (depth + 1) as u8, 0x90, depth as u8, 1, b'a'];
            entries.push(entry(7, &blob_id(&base), &delta));
            base.push(b'a');
        }
        entries.reverse();
        assert_eq!(check(&pack(&entries), &[]), Ok(()));
        assert_eq!(check(&pack(&entries), &[&base]), Err(Refusal::Protocol));
        let unresolved = pack(&[
            entry(7, &[1; 20], &[1, 2, 0x90, 1, 1, b'a']),
            entry(7, &[2; 20], &[2, 3, 0x90, 2, 1, b'b']),
        ]);
        assert_eq!(check(&unresolved, &[]), Err(Refusal::Protocol));
    }

    #[test]
    fn aggregate_budgets_are_enforced_before_reconstruction() {
        let root = entry(3, &[], &vec![b'x'; OBJECT_BYTES]);
        // Four 16 MiB entries exhaust the inflation budget before the fifth
        // entry is inflated (duplicate-ID checking occurs only afterward).
        assert_eq!(
            check(&pack(&vec![root.clone(); 5]), &[]),
            Err(Refusal::Bounds)
        );

        // Small, valid copy programs can each reconstruct 16 MiB while their
        // total instruction bytes remain tiny. Charge reconstructed sizes
        // during parsing, before applying any of these programs.
        let mut delta = delta_integer(OBJECT_BYTES);
        delta.extend(delta_integer(OBJECT_BYTES));
        delta.extend_from_slice(&[0x80; 256]); // 256 copies of 64 KiB.
        let mut entries = vec![root];
        for _ in 0..4 {
            let child = entry(6, &ofs(entries.last().unwrap().len()), &delta);
            entries.push(child);
        }
        assert_eq!(check(&pack(&entries), &[]), Err(Refusal::Bounds));
    }

    #[test]
    fn validates_zlib_across_multiple_compressed_input_chunks() {
        // Deterministic public fixture bytes that do not collapse into a tiny
        // compressed stream. This exercises input chunking as well as output
        // chunking, without any timing assertion or external randomness.
        let mut state = 0x1234_5678u32;
        let mut data: Vec<u8> = (0..CHUNK * 3)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as u8
            })
            .collect();
        data.extend_from_slice(b"chunk_end_canary");
        let encoded = pack(&[entry(3, &[], &data)]);
        assert!(encoded.len() > CHUNK * 2);
        assert_eq!(check(&encoded, &[]), Ok(()));
        assert_eq!(
            check(&encoded, &[b"chunk_end_canary"]),
            Err(Refusal::Protocol)
        );
    }
}
