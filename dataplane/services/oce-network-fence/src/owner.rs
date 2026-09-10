//! Original node-local ownership of a negative attachment attempt. Durable
//! receipts retain uncertainty; they never reconstruct execution authority.
use crate::Error;
use crate::cni::{Operation, Reply, Request, Status};
use crate::kernel::Table;
use crate::linux::RetainedLink;
use crate::tool::NftTool;
use serde::Serialize;
use std::fs::File;
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

const CAPACITY: usize = 32;
const DIRECTORY: &str = "/var/lib/oce-network-fence/operations";

/// One dedicated node-service process owns this value for its entire serving
/// lifetime. Dropping it is service shutdown, not observed child settlement or
/// completed cleanup; unresolved receipts must remain with the original stop owner.
pub struct Owner {
    receipts: Receipts,
    nft: NftTool,
    attempts: Vec<Attempt>,
}
struct Attempt {
    request: Request,
    link: RetainedLink,
    table: Table,
    closed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt<'a> {
    schema_version: u32,
    kind: &'static str,
    operation_ref: &'a str,
    status: &'static str,
    correlation: &'a Request,
    topology: &'a crate::linux::ObservedLink,
    kernel_identity: Option<&'a crate::kernel::InstalledIdentity>,
}
impl Attempt {
    fn receipt(&self, status: &'static str) -> Receipt<'_> {
        Receipt {
            schema_version: 1,
            kind: "closed-network-attempt",
            operation_ref: self.table.name(),
            status,
            correlation: &self.request,
            topology: self.link.observed(),
            kernel_identity: self.table.observed(),
        }
    }
    fn same(&self, request: &Request) -> bool {
        self.request.container_id == request.container_id
            && self.request.network_name == request.network_name
            && self.request.interface_name == request.interface_name
    }
}
impl Owner {
    pub fn open(nft_path: &Path, nft_digest: &str) -> Result<Self, Error> {
        Ok(Self {
            receipts: Receipts::open(Path::new(DIRECTORY))?,
            nft: NftTool::open(nft_path, nft_digest)?,
            attempts: Vec::new(),
        })
    }
    pub fn poll_processes(&self) {
        self.nft.poll_pending();
    }
    /// A received request is owned to settlement independently of client socket
    /// lifetime. No receipt permits a later process to adopt the old handles.
    pub fn handle(&mut self, request: Request, namespace: Option<OwnedFd>) -> Reply {
        let reply = self.handle_owned(request, namespace);
        match reply {
            Ok(reply) => reply,
            Err(error) => {
                // Protected operator diagnostics carry only fixed reason strings
                // or an OS error number; never request fields or native output.
                match error {
                    Error::Invalid(reason)
                    | Error::Unavailable(reason)
                    | Error::Unknown(reason) => eprintln!("network fence refused: {reason}"),
                    Error::Io(error) => {
                        eprintln!("network fence I/O refusal: {:?}", error.raw_os_error())
                    }
                    Error::Linux(_) => eprintln!("network fence Linux refusal"),
                }
                Reply {
                    schema_version: 1,
                    status: Status::Unavailable,
                    operation_ref: None,
                }
            }
        }
    }
    fn handle_owned(
        &mut self,
        request: Request,
        namespace: Option<OwnedFd>,
    ) -> Result<Reply, Error> {
        request.validate()?;
        if let Some(index) = self
            .attempts
            .iter()
            .position(|attempt| attempt.same(&request))
        {
            let attempt = &mut self.attempts[index];
            if request.operation == Operation::Del {
                // CNI deletion intent is not proof that its interface is retired.
                // Retain the original closed table, handles and responsibility.
                attempt.closed = false;
                self.receipts.update(&attempt.receipt("cleanup-unknown"))?;
                return Ok(Reply {
                    schema_version: 1,
                    status: Status::CleanupUnknown,
                    operation_ref: Some(attempt.table.name().into()),
                });
            }
            let namespace = namespace.ok_or(Error::Invalid("network namespace is required"))?;
            if !attempt.closed {
                return Err(Error::Unavailable("attachment is nonterminal"));
            }
            let observed = attempt
                .link
                .matches_namespace(&namespace)
                .and_then(|_| self.nft.inspect(&attempt.table))
                .and_then(|_| attempt.link.current());
            if observed.is_err() {
                attempt.closed = false;
                self.receipts
                    .update(&attempt.receipt("observation-unknown"))?;
                return Err(Error::Unavailable("closed attachment is not current"));
            }
            self.receipts.current()?;
            return Ok(Reply {
                schema_version: 1,
                status: Status::Closed,
                operation_ref: Some(attempt.table.name().into()),
            });
        }
        if request.operation != Operation::Add || self.attempts.len() >= CAPACITY {
            return Err(Error::Unavailable("original attachment unavailable"));
        }
        let namespace = namespace.ok_or(Error::Invalid("network namespace is required"))?;
        let link = RetainedLink::capture(namespace, &request.interface_name)?;
        let table = Table::allocate(link.host_ifname())?;
        let attempt = Attempt {
            request,
            link,
            table,
            closed: false,
        };
        // This fsynced receipt precedes the first possible kernel mutation. A
        // lost receipt commit does not allow submission; an ambiguous nft result
        // leaves the same locator for the original runtime's cleanup owner.
        self.receipts.create(&attempt.receipt("preparing"))?;
        self.attempts.push(attempt);
        let attempt = self.attempts.last_mut().expect("attempt inserted");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let result = (|| {
            let mut activation = crate::activation::Activation::open(deadline)?;
            attempt.link.current()?;
            let before = activation.generation()?;
            // Name lookup creates harmless ACCEPT anchors only. A replacement
            // during this operation cannot receive a DROP policy.
            activation.current()?;
            self.nft.install(&attempt.table)?;
            let anchored = activation.generation()?;
            if anchored != crate::activation::next_generation(before) {
                return Err(Error::Unavailable("anchor creation generation changed"));
            }
            activation.current()?;
            self.nft.inspect_anchor(&attempt.table)?;
            attempt.link.current()?;
            if activation.generation()? != anchored {
                return Err(Error::Unavailable("anchor readback generation changed"));
            }
            // Both policies change in one kernel transaction against the same
            // original nonzero generation and retained handles. Never re-resolve
            // chain names, supply a hook, recreate a chain or retry a refusal.
            activation.drop_original(&attempt.table, anchored)?;
            attempt.link.current()?;
            activation.current()?;
            self.nft.inspect(&attempt.table)?;
            activation.current()?;
            attempt.link.current()
        })();
        if result.is_err() {
            self.receipts
                .update(&attempt.receipt("installation-unknown"))?;
            return Ok(Reply {
                schema_version: 1,
                status: Status::Unavailable,
                operation_ref: Some(attempt.table.name().into()),
            });
        }
        self.receipts.update(&attempt.receipt("closed"))?;
        // Recheck after the durability wait. The receipt is historical custody,
        // never the authority for this final current observation.
        if attempt
            .link
            .current()
            .and_then(|_| self.nft.inspect(&attempt.table))
            .and_then(|_| attempt.link.current())
            .is_err()
        {
            self.receipts
                .update(&attempt.receipt("observation-unknown"))?;
            return Ok(Reply {
                schema_version: 1,
                status: Status::Unavailable,
                operation_ref: Some(attempt.table.name().into()),
            });
        }
        self.receipts.current()?;
        if std::time::Instant::now() >= deadline {
            return Err(Error::Unavailable("original attachment deadline elapsed"));
        }
        attempt.closed = true;
        Ok(Reply {
            schema_version: 1,
            status: Status::Closed,
            operation_ref: Some(attempt.table.name().into()),
        })
    }
}

struct Receipts {
    directory: File,
    path: PathBuf,
    identity: (u64, u64),
    valid: std::cell::Cell<bool>,
}
impl Receipts {
    fn open(path: &Path) -> Result<Self, Error> {
        let directory = open_directory(path)?;
        let metadata = directory.metadata()?;
        let receipts = Self {
            directory,
            path: path.to_owned(),
            identity: (metadata.dev(), metadata.ino()),
            valid: std::cell::Cell::new(true),
        };
        receipts.current()?;
        let directory = &receipts.directory;
        if unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(Error::Unavailable("negative receipt owner already held"));
        }
        // Restart cannot reconstruct either subscribed socket or link generation.
        // Preserve every old receipt and refuse rather than adopt its metadata.
        if std::fs::read_dir(format!("/proc/self/fd/{}", directory.as_raw_fd()))?
            .next()
            .is_some()
        {
            return Err(Error::Unavailable(
                "unsettled attachments require original cleanup",
            ));
        }
        receipts.current()?;
        Ok(receipts)
    }
    fn current(&self) -> Result<(), Error> {
        if !self.valid.replace(false) {
            return Err(Error::Unavailable("negative receipt custody invalidated"));
        }
        let actual = open_directory(&self.path)?.metadata()?;
        let retained = self.directory.metadata()?;
        if (actual.dev(), actual.ino()) != self.identity
            || (retained.dev(), retained.ino()) != self.identity
            || retained.nlink() == 0
            || retained.uid() != 0
            || retained.mode() & 0o022 != 0
        {
            return Err(Error::Unavailable("negative receipt storage changed"));
        }
        self.valid.set(true);
        Ok(())
    }
    fn create(&self, receipt: &Receipt<'_>) -> Result<(), Error> {
        self.write(receipt, false)
    }
    fn update(&self, receipt: &Receipt<'_>) -> Result<(), Error> {
        self.write(receipt, true)
    }
    fn write(&self, receipt: &Receipt<'_>, replace: bool) -> Result<(), Error> {
        self.current()?;
        self.valid.set(false);
        let bytes =
            serde_json::to_vec(receipt).map_err(|_| Error::Invalid("invalid negative receipt"))?;
        if bytes.len() > 16 * 1024 {
            return Err(Error::Invalid("negative receipt exceeds bound"));
        }
        let final_name = std::ffi::CString::new(format!("{}.json", receipt.operation_ref))
            .map_err(|_| Error::Invalid("invalid operation locator"))?;
        let name = if replace {
            std::ffi::CString::new(format!("{}.pending", receipt.operation_ref)).unwrap()
        } else {
            final_name.clone()
        };
        let fd = unsafe {
            libc::openat(
                self.directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(&bytes)?;
        file.sync_all()?;
        if replace
            && unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    name.as_ptr(),
                    self.directory.as_raw_fd(),
                    final_name.as_ptr(),
                )
            } != 0
        {
            return Err(Error::Unknown("negative receipt replacement uncertain"));
        }
        self.directory.sync_all()?;
        self.valid.set(true);
        self.current()
    }
}

fn open_directory(path: &Path) -> Result<File, Error> {
    if !path.is_absolute() {
        return Err(Error::Invalid("receipt path is not absolute"));
    }
    let raw = unsafe {
        libc::open(
            c"/".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if raw < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut directory = unsafe { File::from_raw_fd(raw) };
    for component in path.components() {
        let metadata = directory.metadata()?;
        if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(Error::Unavailable("receipt ancestry is not protected"));
        }
        let name = match component {
            Component::RootDir => continue,
            Component::Normal(name) => name,
            _ => return Err(Error::Invalid("invalid receipt ancestry")),
        };
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(name.as_bytes())
            .map_err(|_| Error::Invalid("invalid receipt component"))?;
        let raw = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        directory = unsafe { File::from_raw_fd(raw) };
    }
    let metadata = directory.metadata()?;
    if !metadata.is_dir()
        || metadata.uid() != 0
        || metadata.mode() & 0o022 != 0
        || metadata.nlink() == 0
    {
        return Err(Error::Unavailable("receipt directory is not protected"));
    }
    Ok(directory)
}
