//! Root-owned, one-request Unix packet transport. Transport identity establishes
//! node-local custody only; it is not original Runtime or current-use authority.
//!
//! Once receive returns, the daemon owns the request and descriptor independently
//! of this connection. A disconnect or failed reply must not discard that owner.

use crate::{Error, cni};
use std::ffi::CString;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

const PACKET_LIMIT: usize = 64 * 1024;
const IO_TIMEOUT_SECONDS: libc::time_t = 60;
// Linux limits a SCM_RIGHTS message to 253 descriptors. Enough aligned space to
// take custody of that whole maximum even when the protocol expects zero or one.
const MAX_RIGHTS: usize = 253;
const CONTROL_WORDS: usize = 256;
const SOCKET_BASENAME: &std::ffi::CStr = c"control.sock";

pub struct Server {
    socket: OwnedFd,
    path: ProtectedPath,
}

pub struct Connection {
    socket: OwnedFd,
    phase: Phase,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Fresh,
    Received,
    Finished,
}

impl Server {
    /// The protected parent is provisioned by the node owner. Never create it,
    /// unlink an existing path, or adopt an old listener after restart.
    pub fn bind() -> Result<Self, Error> {
        require_root()?;
        let directory = protected_directory()?;
        match path_stat(directory.as_raw_fd()) {
            Ok(_) => return Err(Error::Unavailable("fence socket path already exists")),
            Err(Error::Io(error)) if error.raw_os_error() == Some(libc::ENOENT) => {}
            Err(error) => return Err(error),
        }
        let socket = packet_socket()?;
        let address = socket_address()?;
        if unsafe {
            libc::bind(
                socket.as_raw_fd(),
                (&address as *const libc::sockaddr_un).cast(),
                size_of::<libc::sockaddr_un>() as libc::socklen_t,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        // No global umask mutation in a threaded daemon. Before listen, narrow
        // the newly bound inode and verify its identity and protected ancestry.
        let before = path_stat(directory.as_raw_fd())?;
        validate_socket_inode(&before, false)?;
        if unsafe { libc::fchmodat(directory.as_raw_fd(), SOCKET_BASENAME.as_ptr(), 0o600, 0) } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let after = path_stat(directory.as_raw_fd())?;
        validate_socket_inode(&after, true)?;
        if inode(&before) != inode(&after) {
            return Err(Error::Unknown("fence socket changed during bind"));
        }
        let path = ProtectedPath {
            directory,
            socket_inode: inode(&after),
        };
        path.current()?;
        if unsafe { libc::listen(socket.as_raw_fd(), 16) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(Self { socket, path })
    }

    pub fn accept(&self) -> Result<Option<Connection>, Error> {
        self.path.current()?;
        let mut waiting = libc::pollfd {
            fd: self.socket.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut waiting, 1, 250) };
        if ready == 0 {
            return Ok(None);
        }
        if ready < 0 {
            return Err(io::Error::last_os_error().into());
        }
        if waiting.revents != libc::POLLIN {
            return Err(Error::Unavailable("fence listener lost"));
        }
        let raw = unsafe {
            libc::accept4(
                self.socket.as_raw_fd(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                libc::SOCK_CLOEXEC,
            )
        };
        if raw < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let socket = unsafe { OwnedFd::from_raw_fd(raw) };
        configure_deadlines(socket.as_raw_fd())?;
        root_peer(socket.as_raw_fd())?;
        self.path.current()?;
        Ok(Some(Connection {
            socket,
            phase: Phase::Fresh,
        }))
    }
}

impl Connection {
    pub fn receive(&mut self) -> Result<(cni::Request, Option<OwnedFd>), Error> {
        if self.phase != Phase::Fresh {
            return Err(Error::Invalid("connection request already consumed"));
        }
        self.phase = Phase::Finished;
        root_peer(self.socket.as_raw_fd())?;
        let (bytes, descriptors) = receive_packet(self.socket.as_raw_fd())?;
        let (request, namespace) = decode_request(&bytes, descriptors)?;
        self.phase = Phase::Received;
        Ok((request, namespace))
    }

    /// A failed send is delivery uncertainty. It does not relinquish the daemon's
    /// independently retained attempt or prove that no kernel write happened.
    pub fn reply(&mut self, reply: &cni::Reply) -> Result<(), Error> {
        if self.phase != Phase::Received {
            return Err(Error::Invalid("connection cannot send another reply"));
        }
        self.phase = Phase::Finished;
        validate_reply(reply)?;
        let bytes =
            serde_json::to_vec(reply).map_err(|_| Error::Invalid("cannot encode fence reply"))?;
        send_packet(self.socket.as_raw_fd(), &bytes, &[])
    }
}

fn decode_request(
    bytes: &[u8],
    mut descriptors: Vec<OwnedFd>,
) -> Result<(cni::Request, Option<OwnedFd>), Error> {
    let request: cni::Request = serde_json::from_slice(bytes)
        .map_err(|_| Error::Invalid("invalid fence request packet"))?;
    request.validate()?;
    expected_descriptor_count(&request, descriptors.len())?;
    Ok((request, descriptors.pop()))
}

pub fn client(request: &cni::Request, namespace: Option<&OwnedFd>) -> Result<cni::Reply, Error> {
    require_root()?;
    request.validate()?;
    expected_descriptor_count(request, usize::from(namespace.is_some()))?;
    let directory = protected_directory()?;
    let metadata = path_stat(directory.as_raw_fd())?;
    validate_socket_inode(&metadata, true)?;
    let path = ProtectedPath {
        directory,
        socket_inode: inode(&metadata),
    };
    let socket = packet_socket()?;
    let address = socket_address()?;
    if unsafe {
        libc::connect(
            socket.as_raw_fd(),
            (&address as *const libc::sockaddr_un).cast(),
            size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    } != 0
    {
        // SO_SNDTIMEO also bounds blocking connect. EINPROGRESS or EAGAIN is
        // uncertainty/failure; never treat a timed-out connect as authenticated.
        return Err(io::Error::last_os_error().into());
    }
    root_peer(socket.as_raw_fd())?;
    path.current()?;
    let bytes =
        serde_json::to_vec(request).map_err(|_| Error::Invalid("cannot encode fence request"))?;
    let descriptors: Vec<RawFd> = namespace.into_iter().map(AsRawFd::as_raw_fd).collect();
    send_packet(socket.as_raw_fd(), &bytes, &descriptors)?;
    let (bytes, descriptors) = receive_packet(socket.as_raw_fd())?;
    if !descriptors.is_empty() {
        return Err(Error::Invalid(
            "fence reply unexpectedly transferred descriptors",
        ));
    }
    let reply: cni::Reply =
        serde_json::from_slice(&bytes).map_err(|_| Error::Invalid("invalid fence reply packet"))?;
    validate_reply(&reply)?;
    Ok(reply)
}

fn expected_descriptor_count(request: &cni::Request, count: usize) -> Result<(), Error> {
    let expected = match request.operation {
        cni::Operation::Add | cni::Operation::Check => 1,
        cni::Operation::Del => 0,
    };
    if count != expected {
        return Err(Error::Invalid(
            "wrong namespace descriptor count for operation",
        ));
    }
    Ok(())
}

fn validate_reply(reply: &cni::Reply) -> Result<(), Error> {
    if reply.schema_version != 1
        || reply.operation_ref.as_ref().is_some_and(|value| {
            value.is_empty()
                || value.len() > 256
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        })
    {
        return Err(Error::Invalid("invalid fence reply schema or locator"));
    }
    Ok(())
}

fn require_root() -> Result<(), Error> {
    if unsafe { libc::geteuid() } != 0 {
        return Err(Error::Unavailable("fence transport requires node root"));
    }
    Ok(())
}

fn root_peer(fd: RawFd) -> Result<(), Error> {
    let mut credentials: libc::ucred = unsafe { zeroed() };
    let mut length = size_of::<libc::ucred>() as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    } != 0
    {
        return Err(io::Error::last_os_error().into());
    }
    if length as usize != size_of::<libc::ucred>() || credentials.uid != 0 || credentials.pid <= 0 {
        return Err(Error::Unavailable(
            "fence peer is not authenticated node root",
        ));
    }
    Ok(())
}

fn packet_socket() -> Result<OwnedFd, Error> {
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let socket = unsafe { OwnedFd::from_raw_fd(raw) };
    configure_deadlines(socket.as_raw_fd())?;
    Ok(socket)
}

fn configure_deadlines(fd: RawFd) -> Result<(), Error> {
    let timeout = libc::timeval {
        tv_sec: IO_TIMEOUT_SECONDS,
        tv_usec: 0,
    };
    for option in [libc::SO_RCVTIMEO, libc::SO_SNDTIMEO] {
        if unsafe {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                option,
                (&timeout as *const libc::timeval).cast(),
                size_of::<libc::timeval>() as libc::socklen_t,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
    }
    Ok(())
}

fn socket_address() -> Result<libc::sockaddr_un, Error> {
    let mut address: libc::sockaddr_un = unsafe { zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let path = cni::SOCKET_PATH.as_bytes();
    if path.is_empty() || path.len() >= address.sun_path.len() || path.contains(&0) {
        return Err(Error::Invalid("invalid compiled fence socket path"));
    }
    for (destination, source) in address.sun_path.iter_mut().zip(path) {
        *destination = *source as libc::c_char;
    }
    Ok(address)
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct Inode {
    device: u64,
    number: u64,
}

fn inode(metadata: &libc::stat) -> Inode {
    Inode {
        device: metadata.st_dev,
        number: metadata.st_ino,
    }
}

struct ProtectedPath {
    directory: OwnedFd,
    socket_inode: Inode,
}

impl ProtectedPath {
    fn current(&self) -> Result<(), Error> {
        let current = protected_directory()?;
        if inode(&fd_stat(current.as_raw_fd())?) != inode(&fd_stat(self.directory.as_raw_fd())?) {
            return Err(Error::Unavailable(
                "fence socket directory identity changed",
            ));
        }
        let metadata = path_stat(current.as_raw_fd())?;
        validate_socket_inode(&metadata, true)?;
        if inode(&metadata) != self.socket_inode {
            return Err(Error::Unavailable("fence socket inode changed"));
        }
        Ok(())
    }
}

fn protected_directory() -> Result<OwnedFd, Error> {
    let flags = libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let raw = unsafe { libc::open(c"/".as_ptr(), flags) };
    if raw < 0 {
        return Err(io::Error::last_os_error().into());
    }
    let mut directory = unsafe { OwnedFd::from_raw_fd(raw) };
    validate_directory(&fd_stat(directory.as_raw_fd())?)?;
    let (parent, basename) = cni::SOCKET_PATH
        .rsplit_once('/')
        .ok_or(Error::Invalid("compiled fence socket lacks parent"))?;
    if basename.as_bytes() != SOCKET_BASENAME.to_bytes() || !parent.starts_with('/') {
        return Err(Error::Invalid("unsupported compiled fence socket path"));
    }
    for component in parent[1..].split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(Error::Invalid("invalid compiled fence socket ancestry"));
        }
        let component = CString::new(component)
            .map_err(|_| Error::Invalid("invalid compiled fence path component"))?;
        let raw = unsafe { libc::openat(directory.as_raw_fd(), component.as_ptr(), flags) };
        if raw < 0 {
            return Err(io::Error::last_os_error().into());
        }
        directory = unsafe { OwnedFd::from_raw_fd(raw) };
        validate_directory(&fd_stat(directory.as_raw_fd())?)?;
    }
    Ok(directory)
}

fn validate_directory(metadata: &libc::stat) -> Result<(), Error> {
    if metadata.st_mode & libc::S_IFMT != libc::S_IFDIR
        || metadata.st_uid != 0
        || metadata.st_mode & 0o022 != 0
    {
        return Err(Error::Unavailable(
            "fence path directory is not protected node-root storage",
        ));
    }
    Ok(())
}

fn validate_socket_inode(metadata: &libc::stat, exact_mode: bool) -> Result<(), Error> {
    if metadata.st_mode & libc::S_IFMT != libc::S_IFSOCK
        || metadata.st_uid != 0
        || (exact_mode && metadata.st_mode & 0o7777 != 0o600)
    {
        return Err(Error::Unavailable(
            "fence socket inode is not protected node-root socket",
        ));
    }
    Ok(())
}

fn fd_stat(fd: RawFd) -> Result<libc::stat, Error> {
    let mut metadata: libc::stat = unsafe { zeroed() };
    if unsafe { libc::fstat(fd, &mut metadata) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(metadata)
}

fn path_stat(directory: RawFd) -> Result<libc::stat, Error> {
    let mut metadata: libc::stat = unsafe { zeroed() };
    if unsafe {
        libc::fstatat(
            directory,
            SOCKET_BASENAME.as_ptr(),
            &mut metadata,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error().into());
    }
    Ok(metadata)
}

fn send_packet(fd: RawFd, bytes: &[u8], descriptors: &[RawFd]) -> Result<(), Error> {
    if bytes.is_empty() || bytes.len() > PACKET_LIMIT || descriptors.len() > MAX_RIGHTS {
        return Err(Error::Invalid("invalid fence packet extent"));
    }
    let mut control = [0usize; CONTROL_WORDS];
    let mut iov = libc::iovec {
        iov_base: bytes.as_ptr().cast_mut().cast(),
        iov_len: bytes.len(),
    };
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    if !descriptors.is_empty() {
        let data_length = std::mem::size_of_val(descriptors);
        let space = unsafe { libc::CMSG_SPACE(data_length as u32) } as usize;
        if space > size_of::<[usize; CONTROL_WORDS]>() {
            return Err(Error::Invalid("descriptor transfer exceeds control bound"));
        }
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = space;
        let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        if header.is_null() {
            return Err(Error::Invalid("cannot construct descriptor transfer"));
        }
        unsafe {
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(data_length as u32) as usize;
            std::ptr::copy_nonoverlapping(
                descriptors.as_ptr().cast::<u8>(),
                libc::CMSG_DATA(header),
                data_length,
            );
        }
    }
    let sent = unsafe { libc::sendmsg(fd, &message, libc::MSG_NOSIGNAL) };
    if sent < 0 {
        return Err(io::Error::last_os_error().into());
    }
    if sent as usize != bytes.len() {
        return Err(Error::Unknown("partial fence packet delivery"));
    }
    Ok(())
}

fn receive_packet(fd: RawFd) -> Result<(Vec<u8>, Vec<OwnedFd>), Error> {
    let mut bytes = vec![0u8; PACKET_LIMIT];
    let mut control = [0usize; CONTROL_WORDS];
    let mut iov = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = size_of::<[usize; CONTROL_WORDS]>();
    let received = unsafe { libc::recvmsg(fd, &mut message, libc::MSG_CMSG_CLOEXEC) };
    if received < 0 {
        return Err(io::Error::last_os_error().into());
    }
    // Take ownership of every delivered descriptor BEFORE checking truncation,
    // JSON, descriptor count, or unexpected ancillary data. Early returns then
    // close all received FDs. The kernel closes rights beyond a truncated buffer.
    let descriptors = received_rights(&message)?;
    if received == 0
        || received as usize > PACKET_LIMIT
        || message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0
    {
        return Err(Error::Invalid(
            "empty, disconnected or truncated fence packet",
        ));
    }
    bytes.truncate(received as usize);
    Ok((bytes, descriptors))
}

fn received_rights(message: &libc::msghdr) -> Result<Vec<OwnedFd>, Error> {
    let mut descriptors = Vec::new();
    let mut invalid = false;
    let mut rights_messages = 0usize;
    // The headers and extents below are kernel-produced recvmsg output, not
    // caller-provided memory. CMSG_NXTHDR enforces the returned buffer bounds.
    let mut header = unsafe { libc::CMSG_FIRSTHDR(message) };
    while !header.is_null() {
        let minimum = unsafe { libc::CMSG_LEN(0) } as usize;
        let length = unsafe { (*header).cmsg_len };
        let offset = header as usize - message.msg_control as usize;
        if length < minimum
            || offset
                .checked_add(length)
                .is_none_or(|end| end > message.msg_controllen)
        {
            // Such a malformed header cannot be produced by SCM_RIGHTS, whose
            // kernel encoder constructs headers after installing descriptors.
            invalid = true;
            break;
        }
        if unsafe {
            (*header).cmsg_level == libc::SOL_SOCKET && (*header).cmsg_type == libc::SCM_RIGHTS
        } {
            rights_messages += 1;
            let data_length = length - minimum;
            if data_length % size_of::<RawFd>() != 0 {
                invalid = true;
            }
            for index in 0..(data_length / size_of::<RawFd>()) {
                let raw = unsafe {
                    std::ptr::read_unaligned(libc::CMSG_DATA(header).cast::<RawFd>().add(index))
                };
                if raw < 0 {
                    invalid = true;
                    continue;
                }
                let owned = unsafe { OwnedFd::from_raw_fd(raw) };
                let flags = unsafe { libc::fcntl(owned.as_raw_fd(), libc::F_GETFD) };
                if flags < 0 || flags & libc::FD_CLOEXEC == 0 {
                    invalid = true;
                }
                descriptors.push(owned);
            }
        } else {
            invalid = true;
        }
        header = unsafe { libc::CMSG_NXTHDR(message, header) };
    }
    if invalid || rights_messages > 1 || descriptors.len() > MAX_RIGHTS {
        return Err(Error::Invalid(
            "unexpected or malformed fence ancillary data",
        ));
    }
    Ok(descriptors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    fn pair() -> (OwnedFd, OwnedFd) {
        let mut fds = [-1; 2];
        assert_eq!(
            unsafe {
                libc::socketpair(
                    libc::AF_UNIX,
                    libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
                    0,
                    fds.as_mut_ptr(),
                )
            },
            0
        );
        let pair = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        configure_deadlines(pair.0.as_raw_fd()).unwrap();
        configure_deadlines(pair.1.as_raw_fd()).unwrap();
        pair
    }

    #[test]
    fn actual_packet_transfer_retains_descriptor_with_cloexec() {
        let (sender, receiver) = pair();
        let namespace = File::open("/proc/thread-self/ns/net").unwrap();
        let identity = inode(&fd_stat(namespace.as_raw_fd()).unwrap());
        send_packet(sender.as_raw_fd(), b"packet", &[namespace.as_raw_fd()]).unwrap();
        drop(namespace);
        let (bytes, descriptors) = receive_packet(receiver.as_raw_fd()).unwrap();
        assert_eq!(bytes, b"packet");
        assert_eq!(descriptors.len(), 1);
        assert!(inode(&fd_stat(descriptors[0].as_raw_fd()).unwrap()) == identity);
        assert_ne!(
            unsafe { libc::fcntl(descriptors[0].as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
    }

    #[test]
    fn actual_packet_boundaries_and_disconnect_are_preserved() {
        let (sender, receiver) = pair();
        send_packet(sender.as_raw_fd(), b"first", &[]).unwrap();
        send_packet(sender.as_raw_fd(), b"second", &[]).unwrap();
        drop(sender);
        assert_eq!(receive_packet(receiver.as_raw_fd()).unwrap().0, b"first");
        assert_eq!(receive_packet(receiver.as_raw_fd()).unwrap().0, b"second");
        assert!(receive_packet(receiver.as_raw_fd()).is_err());
    }

    #[test]
    fn actual_oversize_packet_is_rejected() {
        let (sender, receiver) = pair();
        let bytes = vec![0u8; PACKET_LIMIT + 1];
        assert_eq!(
            unsafe {
                libc::send(
                    sender.as_raw_fd(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    libc::MSG_NOSIGNAL,
                )
            },
            bytes.len() as isize
        );
        assert!(receive_packet(receiver.as_raw_fd()).is_err());
    }

    #[test]
    fn decoding_errors_close_every_transferred_descriptor() {
        let raw =
            unsafe { libc::memfd_create(c"fence-ipc-custody-test".as_ptr(), libc::MFD_CLOEXEC) };
        assert!(raw >= 0);
        let source = unsafe { OwnedFd::from_raw_fd(raw) };
        let identity = inode(&fd_stat(source.as_raw_fd()).unwrap());
        let add = br#"{"schemaVersion":1,"operation":"ADD","containerId":"sandbox","networkName":"pods","interfaceName":"eth0"}"#;
        for payload in [b"invalid-json".as_slice(), add.as_slice()] {
            let (sender, receiver) = pair();
            send_packet(
                sender.as_raw_fd(),
                payload,
                &[source.as_raw_fd(), source.as_raw_fd()],
            )
            .unwrap();
            let (bytes, descriptors) = receive_packet(receiver.as_raw_fd()).unwrap();
            let received: Vec<RawFd> = descriptors.iter().map(AsRawFd::as_raw_fd).collect();
            assert_eq!(received.len(), 2);
            assert!(decode_request(&bytes, descriptors).is_err());
            for raw in received {
                // A concurrent test may reuse the numerical FD, but cannot own
                // this test's unique memfd. Neither original reference survives.
                assert!(fd_stat(raw).map_or(true, |stat| inode(&stat) != identity));
            }
        }
    }

    #[test]
    fn operation_descriptor_contract_is_closed() {
        let mut request = cni::Request {
            schema_version: 1,
            operation: cni::Operation::Add,
            container_id: "sandbox".into(),
            network_name: "pods".into(),
            interface_name: "eth0".into(),
        };
        assert!(expected_descriptor_count(&request, 1).is_ok());
        assert!(expected_descriptor_count(&request, 0).is_err());
        assert!(expected_descriptor_count(&request, 2).is_err());
        request.operation = cni::Operation::Check;
        assert!(expected_descriptor_count(&request, 1).is_ok());
        assert!(expected_descriptor_count(&request, 0).is_err());
        request.operation = cni::Operation::Del;
        assert!(expected_descriptor_count(&request, 0).is_ok());
        assert!(expected_descriptor_count(&request, 1).is_err());
    }
}
