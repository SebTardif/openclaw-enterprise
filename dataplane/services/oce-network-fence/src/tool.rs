//! Retained root-owned native nft executable and bounded child responsibility.
use crate::Error;
use std::fs::{File, Metadata};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const OUTPUT_LIMIT: usize = 32 * 1024;
const DEADLINE: Duration = Duration::from_secs(3);

pub struct NftTool {
    file: File,
    metadata: Metadata,
    digest: String,
    pending: std::cell::RefCell<Vec<NativeAttempt>>,
}
impl NftTool {
    pub fn open(path: &Path, expected_digest: &str) -> Result<Self, Error> {
        if expected_digest.len() != 64
            || !expected_digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Invalid("invalid selected nft digest"));
        }
        protected_path(path, false)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != 0
            || metadata.mode() & 0o022 != 0
            || metadata.mode() & 0o111 == 0
            || metadata.len() > 64 * 1024 * 1024
        {
            return Err(Error::Invalid("unprotected nft executable"));
        }
        let mut magic = [0u8; 4];
        use std::os::unix::fs::FileExt;
        if file.read_at(&mut magic, 0)? != 4 || magic != *b"\x7fELF" {
            return Err(Error::Invalid("nft must be a native ELF executable"));
        }
        let tool = Self {
            file,
            metadata,
            digest: expected_digest.into(),
            pending: std::cell::RefCell::new(Vec::new()),
        };
        tool.current()?;
        Ok(tool)
    }
    fn current(&self) -> Result<(), Error> {
        let now = self.file.metadata()?;
        if now.dev() != self.metadata.dev()
            || now.ino() != self.metadata.ino()
            || now.uid() != 0
            || now.mode() != self.metadata.mode()
            || now.len() != self.metadata.len()
            || now.ctime() != self.metadata.ctime()
            || now.ctime_nsec() != self.metadata.ctime_nsec()
        {
            return Err(Error::Unavailable("retained nft executable changed"));
        }
        use std::os::unix::fs::FileExt;
        let mut bytes = vec![0u8; now.len() as usize];
        self.file.read_exact_at(&mut bytes, 0)?;
        let digest: String = ds_contracts::snapshot_verify::sha256(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let after = self.file.metadata()?;
        if digest != self.digest
            || after.ctime() != now.ctime()
            || after.ctime_nsec() != now.ctime_nsec()
            || after.len() != now.len()
        {
            return Err(Error::Unavailable("selected nft artifact changed"));
        }
        Ok(())
    }
    pub(crate) fn install(&self, table: &crate::kernel::Table) -> Result<(), Error> {
        self.run(&["-f", "-"], table.installation().as_bytes())
            .map(|_| ())
    }
    pub(crate) fn inspect_anchor(&self, table: &crate::kernel::Table) -> Result<(), Error> {
        table.inspect_anchor(&self.run(&["-j", "list", "table", "netdev", table.name()], &[])?)
    }
    pub(crate) fn inspect(&self, table: &crate::kernel::Table) -> Result<(), Error> {
        table.inspect(&self.run(&["-j", "list", "table", "netdev", table.name()], &[])?)
    }
    pub(crate) fn poll_pending(&self) {
        let mut pending = self.pending.borrow_mut();
        pending.retain_mut(|attempt| attempt.step().is_none());
    }
    fn run(&self, arguments: &[&str], input: &[u8]) -> Result<Vec<u8>, Error> {
        self.current()?;
        self.poll_pending();
        if self.pending.borrow().len() >= 32 {
            return Err(Error::Unavailable("native completion capacity exhausted"));
        }
        // Native completion has one original reaper. Inherited auto-reaping
        // cannot provide ownership of the process-group lifetime.
        let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
        if unsafe { libc::sigaction(libc::SIGCHLD, std::ptr::null(), &mut action) } != 0
            || action.sa_sigaction != libc::SIG_DFL
            || action.sa_flags & libc::SA_NOCLDWAIT != 0
        {
            return Err(Error::Unavailable(
                "native child wait ownership unavailable",
            ));
        }
        let mut command = Command::new(format!("/proc/self/fd/{}", self.file.as_raw_fd()));
        command
            .args(arguments)
            .env_clear()
            .env("LANG", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut attempt = NativeAttempt::start(&mut command, input)?;
        loop {
            if let Some(outcome) = attempt.step() {
                self.current()?;
                return outcome;
            }
            if Instant::now() >= attempt.deadline {
                // No wait() or JoinHandle::join() follows the deadline. Retain
                // process + pipe custody for the original owner's later polls.
                attempt.failed = true;
                self.pending.borrow_mut().push(attempt);
                return Err(Error::Unknown("native completion remains pending"));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
fn nonblocking(fd: i32) -> Result<(), Error> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
struct NativeAttempt {
    child: std::process::Child,
    stdout: Option<std::process::ChildStdout>,
    stderr: Option<std::process::ChildStderr>,
    output: Vec<u8>,
    output_eof: bool,
    error_eof: bool,
    output_nonblocking: bool,
    error_nonblocking: bool,
    failed: bool,
    settled: bool,
    deadline: Instant,
}
impl NativeAttempt {
    fn start(command: &mut Command, input: &[u8]) -> Result<Self, Error> {
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let mut attempt = NativeAttempt {
            stdout: child.stdout.take(),
            stderr: child.stderr.take(),
            child,
            output: Vec::new(),
            output_eof: false,
            error_eof: false,
            output_nonblocking: false,
            error_nonblocking: false,
            failed: false,
            settled: false,
            deadline: Instant::now() + DEADLINE,
        };
        let setup = (|| -> Result<(), Error> {
            let mut stdin = attempt
                .child
                .stdin
                .take()
                .ok_or(Error::Unknown("native input unavailable"))?;
            nonblocking(stdin.as_raw_fd())?;
            nonblocking(
                attempt
                    .stdout
                    .as_ref()
                    .ok_or(Error::Unknown("native output unavailable"))?
                    .as_raw_fd(),
            )?;
            attempt.output_nonblocking = true;
            nonblocking(
                attempt
                    .stderr
                    .as_ref()
                    .ok_or(Error::Unknown("native error unavailable"))?
                    .as_raw_fd(),
            )?;
            attempt.error_nonblocking = true;
            // The generated closed transaction is smaller than PIPE_BUF. A full
            // pipe is an uncertain submission, never a blocking write.
            stdin.write_all(input)?;
            Ok(())
        })();
        if setup.is_err() {
            attempt.failed = true;
        }
        Ok(attempt)
    }
    fn step(&mut self) -> Option<Result<Vec<u8>, Error>> {
        let drain =
            |reader: &mut dyn Read, output: &mut Vec<u8>, keep: bool| -> Result<bool, Error> {
                let mut bytes = [0u8; 4096];
                for _ in 0..16 {
                    match reader.read(&mut bytes) {
                        Ok(0) => return Ok(true),
                        Ok(n) if keep && output.len() + n <= OUTPUT_LIMIT => {
                            output.extend_from_slice(&bytes[..n])
                        }
                        Ok(_) if !keep => {}
                        Ok(_) => return Err(Error::Unknown("native output exceeds bound")),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            return Ok(false);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) => return Err(error.into()),
                    }
                }
                Ok(false)
            };
        if self.output_nonblocking && !self.output_eof {
            match self
                .stdout
                .as_mut()
                .map(|reader| drain(reader, &mut self.output, true))
            {
                Some(Ok(eof)) => self.output_eof = eof,
                _ => self.failed = true,
            }
        }
        if self.error_nonblocking && !self.error_eof {
            match self
                .stderr
                .as_mut()
                .map(|reader| drain(reader, &mut Vec::new(), false))
            {
                Some(Ok(eof)) => self.error_eof = eof,
                _ => self.failed = true,
            }
        }
        let pid = self.child.id() as i32;
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as u32,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            // Loss of wait ownership cannot justify a numeric PID signal. Keep
            // this unresolved attempt, including its pipes, for original cleanup.
            self.failed = true;
            return None;
        }
        let exited = unsafe { info.si_pid() } == pid;
        if Instant::now() >= self.deadline {
            self.failed = true;
        }
        if exited || self.failed {
            // waitid leaves the original leader unreaped, reserving its group
            // identifier until all pipes are drained and the final WNOHANG reap.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        if exited && self.output_eof && self.error_eof {
            match self.child.try_wait() {
                Ok(Some(status)) => {
                    self.settled = true;
                    if self.failed || !status.success() {
                        return Some(Err(Error::Unknown("native operation failed")));
                    }
                    return Some(Ok(std::mem::take(&mut self.output)));
                }
                _ => self.failed = true,
            }
        }
        None
    }
}
impl Drop for NativeAttempt {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let pid = self.child.id() as i32;
        if unsafe {
            libc::waitid(
                libc::P_PID,
                pid as u32,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } == 0
        {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        // No blocking destructor and no claim of observed settlement. The
        // precommitted negative receipt survives owner/process termination.
    }
}

pub(crate) fn protected_path(path: &Path, directory: bool) -> Result<(), Error> {
    if !path.is_absolute() {
        return Err(Error::Invalid("protected path must be absolute"));
    }
    let mut current = std::path::PathBuf::from("/");
    for component in path.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(value) => current.push(value),
            _ => return Err(Error::Invalid("invalid protected path")),
        }
        let metadata = std::fs::symlink_metadata(&current)?;
        let last = current == path;
        if metadata.uid() != 0
            || metadata.mode() & 0o022 != 0
            || metadata.file_type().is_symlink()
            || ((!last || directory) && !metadata.is_dir())
        {
            return Err(Error::Invalid("unprotected path component"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_native_process_timeout_retains_then_reaps_without_blocking() {
        let mut command = Command::new("/usr/bin/sleep");
        command
            .arg("30")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut attempt = NativeAttempt::start(&mut command, b"").unwrap();
        let started = Instant::now();
        let mut result = None;
        while started.elapsed() < Duration::from_secs(5) {
            let before = Instant::now();
            result = attempt.step();
            assert!(
                before.elapsed() < Duration::from_secs(1),
                "a native poll blocked"
            );
            if result.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(started.elapsed() >= DEADLINE);
        assert!(result.unwrap().is_err());
        assert!(attempt.settled);
    }
    #[test]
    fn real_output_overflow_is_bounded_and_original_process_is_reaped() {
        let mut command = Command::new("/usr/bin/yes");
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut attempt = NativeAttempt::start(&mut command, b"").unwrap();
        let started = Instant::now();
        let mut result = None;
        while started.elapsed() < Duration::from_secs(5) {
            result = attempt.step();
            assert!(attempt.output.len() <= OUTPUT_LIMIT);
            if result.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(result.unwrap().is_err());
        assert!(attempt.settled);
    }
}
