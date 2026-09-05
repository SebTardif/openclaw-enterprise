// Modified for OpenClaw Enterprise.
//! POSIX shared-memory backing. One owned descriptor supplies metadata and the
//! complete mapping; attachment never reopens a name after validating it.
//!
//! Named writers hold an advisory `flock` for their handle lifetime and every
//! Segment has an additional in-process writer claim. Only cooperating writers
//! are supported: the operator must protect the name/mount and exclude processes
//! that can bypass locking, mutate immutable headers, truncate, or replace backing.
//! Named readers map an O_RDONLY descriptor with PROT_READ. This mapping does not
//! prevent a process with separate filesystem write permission from reopening it.

use std::ffi::CString;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use memmap2::{MmapOptions, MmapRaw};

/// Bounded address-space/storage footprint for one admission segment.
pub const MAX_SEGMENT_BYTES: usize = 1 << 30;

/// Base of a live mapping. All concurrent mutable accesses use atomic lanes.
#[derive(Clone, Copy)]
pub struct SharedBase {
    ptr: *mut u8,
}
// SAFETY: shared payload/header mutation uses atomic accesses. Reverse-index
// mutation is restricted to the uniquely claimed writer; its shared reads do
// not manufacture mutable references.
unsafe impl Send for SharedBase {}
unsafe impl Sync for SharedBase {}
impl SharedBase {
    pub fn as_ptr(self) -> *mut u8 {
        self.ptr
    }
    /// # Safety
    /// `off` must be within the owning Segment's validated extent.
    pub unsafe fn at(self, off: usize) -> *mut u8 {
        self.ptr.add(off)
    }
}

/// Owned mapping and descriptor. Named backing persists until explicitly unlinked.
pub struct Segment {
    base: SharedBase,
    len: usize,
    writable: bool,
    writer_claimed: AtomicBool,
    _mapping: MmapRaw,
    file: Option<File>,
}

/// Uniquely claims the writer even when anonymous readers retain the Segment.
/// The OS lock is released when the writer drops, not when its last reader drops.
pub(crate) struct WriterClaim {
    segment: Arc<Segment>,
}
impl Drop for WriterClaim {
    fn drop(&mut self) {
        if let Some(file) = &self.segment.file {
            // SAFETY: owned descriptor stays live through this call. Closing the
            // descriptor also releases flock if unlock is interrupted/fails.
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
        }
        self.segment.writer_claimed.store(false, Ordering::Release);
    }
}

impl Segment {
    pub fn base(&self) -> SharedBase {
        self.base
    }
    pub fn len(&self) -> usize {
        self.len
    }
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub(crate) fn claim_writer(self: &Arc<Self>) -> io::Result<WriterClaim> {
        if !self.writable {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "read-only segment",
            ));
        }
        self.writer_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                io::Error::new(io::ErrorKind::WouldBlock, "segment already has a writer")
            })?;
        if let Some(file) = &self.file {
            // flock locks the opened inode, not a subsequently replaced shm name.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                self.writer_claimed.store(false, Ordering::Release);
                return Err(io::Error::last_os_error());
            }
        }
        Ok(WriterClaim {
            segment: Arc::clone(self),
        })
    }

    /// Exclusively create new backing. Existing objects are never resized or
    /// reinitialized, including after incompatible-layout or failed attachment.
    pub fn create_named(name: &str, len: usize) -> io::Result<Arc<Segment>> {
        validate_len(len)?;
        let cname = shm_cname(name)?;
        let fd = unsafe {
            libc::shm_open(
                cname.as_ptr(),
                libc::O_CREAT | libc::O_EXCL | libc::O_RDWR | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // Failed initialization intentionally leaves unpublished backing in place;
        // automatic unlink could remove a replacement name owned by another actor.
        let file = unsafe { File::from_raw_fd(fd) };
        file.set_len(len as u64)?;
        // Reserve actual storage before publishing a writable map. A successful
        // ftruncate alone leaves sparse tmpfs pages that can SIGBUS on first use.
        let error = unsafe { libc::posix_fallocate(fd, 0, len as libc::off_t) };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
        Self::from_named_file(file, len, true)
    }

    /// Map an existing object's complete extent using one descriptor. `min_len`
    /// is the minimum safe extent before the caller reads its header.
    pub fn attach_named_writer(name: &str, min_len: usize) -> io::Result<Arc<Segment>> {
        Self::open_named(name, min_len, true)
    }
    /// O_RDONLY descriptor + PROT_READ mapping; identical same-descriptor checks.
    pub fn attach_named_reader(name: &str, min_len: usize) -> io::Result<Arc<Segment>> {
        Self::open_named(name, min_len, false)
    }
    fn open_named(name: &str, min_len: usize, write: bool) -> io::Result<Arc<Segment>> {
        let cname = shm_cname(name)?;
        let oflag = if write { libc::O_RDWR } else { libc::O_RDONLY };
        let fd = unsafe { libc::shm_open(cname.as_ptr(), oflag | libc::O_CLOEXEC, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        Self::from_named_file(file, min_len, write)
    }

    fn from_named_file(file: File, min_len: usize, write: bool) -> io::Result<Arc<Segment>> {
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.nlink() > 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "unsupported shm backing",
            ));
        }
        // Match the private ownership contract of create_named. Separate reader
        // identities require an explicitly designed authenticated handoff, not an
        // implicit permission widening of this shared object.
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "shm backing must be private to the effective user",
            ));
        }
        let len = usize::try_from(metadata.len()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "shm extent overflows usize")
        })?;
        validate_len(len)?;
        // Named segments are fully allocated by create_named. Sparse or partially
        // allocated foreign backing can SIGBUS when the shared-memory filesystem
        // runs out of pages, even if fstat reports the requested logical length.
        if metadata
            .blocks()
            .checked_mul(512)
            .is_none_or(|bytes| bytes < metadata.len())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "shm backing is not fully allocated",
            ));
        }
        if len < min_len {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "shm backing is shorter than header",
            ));
        }
        // Raw mappings never manufacture &[u8] or &mut [u8] over memory that
        // another reader/writer can access. Typed references are constructed only
        // for the atomic lanes or exclusively claimed reverse-index region.
        let mapping = if write {
            MmapOptions::new().len(len).map_raw(&file)?
        } else {
            MmapOptions::new().len(len).map_raw_read_only(&file)?
        };
        let ptr = mapping.as_mut_ptr();
        Ok(Arc::new(Segment {
            base: SharedBase { ptr },
            len,
            writable: write,
            writer_claimed: AtomicBool::new(false),
            _mapping: mapping,
            file: Some(file),
        }))
    }

    /// Anonymous MAP_PRIVATE storage shared by Arc between threads. It is a
    /// process-local verification facility; it is not cross-process restart proof.
    pub fn create_anonymous(len: usize) -> io::Result<Arc<Segment>> {
        validate_len(len)?;
        let mmap: MmapRaw = MmapOptions::new().len(len).map_anon()?.into();
        let ptr = mmap.as_mut_ptr();
        Ok(Arc::new(Segment {
            base: SharedBase { ptr },
            len,
            writable: true,
            writer_claimed: AtomicBool::new(false),
            _mapping: mmap,
            file: None,
        }))
    }

    /// Explicit operator teardown. Existing descriptors/mappings retain their inode.
    pub fn unlink_name(name: &str) -> io::Result<()> {
        let cname = shm_cname(name)?;
        if unsafe { libc::shm_unlink(cname.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

fn validate_len(len: usize) -> io::Result<()> {
    if len == 0 || len > MAX_SEGMENT_BYTES || len > isize::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsupported shm extent (maximum 1 GiB)",
        ));
    }
    Ok(())
}
fn shm_cname(name: &str) -> io::Result<CString> {
    if !name.starts_with('/') || name.len() < 2 || name[1..].contains('/') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "POSIX shm name must be /name with no embedded slash",
        ));
    }
    CString::new(name).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "shm name has NUL"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ShmAdmissionMap, ShmAdmissionReader};
    use std::io::{Read, Seek, SeekFrom, Write};

    struct NamedObject(String);
    impl NamedObject {
        fn new(label: &str) -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            Self(format!(
                "/ds-segment-{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ))
        }
        fn create_file(&self, len: u64) -> File {
            let name = shm_cname(&self.0).unwrap();
            let fd = unsafe {
                libc::shm_open(
                    name.as_ptr(),
                    libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
                    0o600,
                )
            };
            assert!(fd >= 0);
            let file = unsafe { File::from_raw_fd(fd) };
            file.set_len(len).unwrap();
            file
        }
    }
    impl Drop for NamedObject {
        fn drop(&mut self) {
            let _ = Segment::unlink_name(&self.0);
        }
    }

    #[test]
    fn opened_descriptor_retains_validated_inode_across_name_replacement() {
        let name = NamedObject::new("replacement");
        let writer = ShmAdmissionMap::create_named(&name.0, 8, 8).unwrap();
        let reader = Segment::attach_named_reader(&name.0, 64).unwrap();
        let opened = reader.file.as_ref().unwrap().try_clone().unwrap();
        let expected_inode = opened.metadata().unwrap().ino();
        let expected_len = opened.metadata().unwrap().len();
        drop(reader);
        drop(writer);
        Segment::unlink_name(&name.0).unwrap();
        let replacement = name.create_file(1);
        assert_ne!(replacement.metadata().unwrap().ino(), expected_inode);
        // This is the actual same-descriptor map constructor after replacement.
        // It must map the opened inode, never reopen the current name to map it.
        let original = Segment::from_named_file(opened, 64, false).unwrap();
        assert_eq!(
            original.file.as_ref().unwrap().metadata().unwrap().ino(),
            expected_inode
        );
        assert_eq!(original.len() as u64, expected_len);
        assert!(ShmAdmissionReader::attach_anonymous(original).is_ok());
        assert!(ShmAdmissionReader::attach_named(&name.0).is_err());
    }

    #[test]
    fn short_and_unpublished_named_objects_fail_without_recreation() {
        for len in [0, 1, 63, 64, 4096] {
            let name = NamedObject::new("short");
            let mut file = name.create_file(len);
            if len > 0 {
                file.write_all(&[0x5a]).unwrap();
            }
            let before = file.metadata().unwrap();
            assert!(ShmAdmissionReader::attach_named(&name.0).is_err());
            assert!(ShmAdmissionMap::attach_named_writer(&name.0).is_err());
            assert!(ShmAdmissionMap::open_or_create_named(&name.0, 8, 8).is_err());
            assert_eq!(file.metadata().unwrap().len(), before.len());
            assert_eq!(file.metadata().unwrap().ino(), before.ino());
            if len > 0 {
                file.seek(SeekFrom::Start(0)).unwrap();
                let mut byte = [0];
                file.read_exact(&mut byte).unwrap();
                assert_eq!(byte, [0x5a]);
            }
        }
    }

    #[test]
    fn existing_backing_extent_permissions_and_sparse_size_are_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let name = NamedObject::new("bounds");
        let writer = ShmAdmissionMap::create_named(&name.0, 8, 8).unwrap();
        let file = Segment::attach_named_writer(&name.0, 64)
            .unwrap()
            .file
            .as_ref()
            .unwrap()
            .try_clone()
            .unwrap();
        let len = file.metadata().unwrap().len();
        drop(writer);
        // No mappings are alive during truncation; next attachment must refuse
        // before touching a table that the file no longer contains.
        file.set_len(64).unwrap();
        assert!(ShmAdmissionReader::attach_named(&name.0).is_err());
        assert!(ShmAdmissionMap::attach_named_writer(&name.0).is_err());
        file.set_len(len).unwrap();
        assert!(
            ShmAdmissionReader::attach_named(&name.0).is_err(),
            "sparse backing"
        );
        let error = unsafe { libc::posix_fallocate(file.as_raw_fd(), 0, len as libc::off_t) };
        assert_eq!(error, 0);
        file.set_permissions(std::fs::Permissions::from_mode(0o666))
            .unwrap();
        assert!(ShmAdmissionReader::attach_named(&name.0).is_err());
        assert!(ShmAdmissionMap::attach_named_writer(&name.0).is_err());
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .unwrap();
        file.set_len(MAX_SEGMENT_BYTES as u64 + 1).unwrap();
        assert!(ShmAdmissionReader::attach_named(&name.0).is_err());
    }
}
