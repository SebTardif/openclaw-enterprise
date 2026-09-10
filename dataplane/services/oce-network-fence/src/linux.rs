//! Retained, fail-closed observation of a cross-namespace veth pair.
//!
//! This is topology custody, not Pod, original-effect, or current-use authority.
//! Every socket is subscribed before discovery; uncertainty consumes the object.

use crate::Error;
use serde::Serialize;
use std::fs::File;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const NSFS_MAGIC: libc::c_long = 0x6e736673;
const NS_GET_NSTYPE: libc::c_ulong = 0xb703;
const RTM_NEWLINK: u16 = 16;
const RTM_GETLINK: u16 = 18;
const RTM_NEWNSID: u16 = 88;
const RTM_GETNSID: u16 = 90;
const NLMSG_DONE: u16 = 3;
const NLM_F_REQUEST: u16 = 1;
const NLM_F_MULTI: u16 = 2;
const NLM_F_DUMP: u16 = 0x300;
const NLM_F_DUMP_INTR: u16 = 0x10;
const NLM_F_DUMP_FILTERED: u16 = 0x20;
const IFLA_IFNAME: u16 = 3;
const IFLA_LINK: u16 = 5;
const IFLA_LINKINFO: u16 = 18;
const IFLA_LINK_NETNSID: u16 = 37;
const IFLA_INFO_KIND: u16 = 1;
const NETNSA_NSID: u16 = 1;
const NETNSA_FD: u16 = 3;
const MAX_DATAGRAM: usize = 65536;
const MAX_DUMP_BYTES: usize = 4 * 1024 * 1024;
const MAX_LINKS: usize = 4096;
const MAX_DATAGRAMS: usize = 1024;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct NamespaceIdentity {
    pub device: u64,
    pub inode: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LinkIdentity {
    pub ifindex: u32,
    pub iflink: u32,
    pub name: String,
    pub kind: String,
    /// Kernel namespace ID interpreted only within this endpoint's namespace.
    pub peer_netnsid: i32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ObservedLink {
    pub host_namespace: NamespaceIdentity,
    pub pod_namespace: NamespaceIdentity,
    pub host: LinkIdentity,
    pub pod: LinkIdentity,
}

pub struct RetainedLink {
    observed: ObservedLink,
    state: Mutex<Continuity>,
}

struct Continuity {
    host_namespace: OwnedFd,
    pod_namespace: OwnedFd,
    host: RouteSocket,
    pod: RouteSocket,
    valid: bool,
}

impl RetainedLink {
    pub fn capture(pod_netns: OwnedFd, pod_ifname: &str) -> Result<Self, Error> {
        validate_name(pod_ifname)?;
        let host_namespace: OwnedFd = File::open("/proc/thread-self/ns/net")?.into();
        let host_identity = namespace_identity(host_namespace.as_raw_fd())?;
        let pod_identity = namespace_identity(pod_netns.as_raw_fd())?;
        if host_identity == pod_identity {
            return Err(Error::Invalid(
                "pod and host network namespaces must differ",
            ));
        }
        // Both subscriptions precede either full dump. The joining thread exits;
        // no caller thread or pooled worker ever enters the Pod namespace.
        let host = RouteSocket::open()?;
        let thread_namespace = duplicate(pod_netns.as_raw_fd())?;
        let expected = pod_identity.clone();
        let pod = std::thread::Builder::new()
            .name("fence-netns-observer".to_owned())
            .spawn(move || -> Result<RouteSocket, Error> {
                // SAFETY: a dedicated OS thread changes only its network namespace.
                if unsafe { libc::setns(thread_namespace.as_raw_fd(), libc::CLONE_NEWNET) } != 0 {
                    return Err(io::Error::last_os_error().into());
                }
                let actual = File::open("/proc/thread-self/ns/net")?;
                if namespace_identity(actual.as_raw_fd())? != expected {
                    return Err(Error::Invalid("network namespace entry mismatch"));
                }
                RouteSocket::open()
            })?
            .join()
            .map_err(|_| Error::Unknown("network namespace observer thread failed"))??;
        let mut state = Continuity {
            host_namespace,
            pod_namespace: pod_netns,
            host,
            pod,
            valid: false,
        };
        let (host, pod) = state.capture_pair(pod_ifname)?;
        state.valid = true;
        Ok(Self {
            observed: ObservedLink {
                host_namespace: host_identity,
                pod_namespace: pod_identity,
                host,
                pod,
            },
            state: Mutex::new(state),
        })
    }

    pub fn host_ifname(&self) -> &str {
        &self.observed.host.name
    }

    pub fn observed(&self) -> &ObservedLink {
        &self.observed
    }

    /// CHECK and repeated ADD must present the original namespace, then prove
    /// continuity through this original observer. This never captures a new
    /// interface or adopts a replacement observer.
    pub fn matches_namespace(&self, namespace: &OwnedFd) -> Result<(), Error> {
        if namespace_identity(namespace.as_raw_fd())? != self.observed.pod_namespace {
            return Err(Error::Invalid(
                "request network namespace does not match original",
            ));
        }
        self.current()
    }

    /// A successful read is an observation at this boundary, not a lifetime
    /// guarantee. Call before and after kernel operations and their readbacks.
    /// Any failed check is permanent, including a timeout or interrupted dump.
    pub fn current(&self) -> Result<(), Error> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| Error::Unknown("network observation lock poisoned"))?;
        if !state.valid {
            return Err(Error::Unavailable(
                "network identity permanently invalidated",
            ));
        }
        state.valid = false;
        // The caller which performs the fence operation must itself remain in
        // the retained host namespace. A live FD alone cannot establish that.
        let caller_namespace = File::open("/proc/thread-self/ns/net")?;
        if namespace_identity(caller_namespace.as_raw_fd())? != self.observed.host_namespace
            || namespace_identity(state.host_namespace.as_raw_fd())? != self.observed.host_namespace
            || namespace_identity(state.pod_namespace.as_raw_fd())? != self.observed.pod_namespace
        {
            return Err(Error::Unavailable("retained network namespace changed"));
        }
        let (host, pod) = state.capture_pair(&self.observed.pod.name)?;
        if host != self.observed.host || pod != self.observed.pod {
            return Err(Error::Unavailable("retained veth identity changed"));
        }
        state.valid = true;
        Ok(())
    }
}

impl Continuity {
    fn capture_pair(&mut self, pod_name: &str) -> Result<(LinkIdentity, LinkIdentity), Error> {
        self.host.quiet()?;
        self.pod.quiet()?;
        let host_links = self.host.links()?;
        let pod_links = self.pod.links()?;
        let pod = unique_link(&pod_links, |link| link.name == pod_name)?;
        let host = unique_link(&host_links, |link| link.index == pod.peer.unwrap_or(0))?;
        let host_peer_nsid = self.host.namespace_id(self.pod_namespace.as_raw_fd())?;
        let pod_peer_nsid = self.pod.namespace_id(self.host_namespace.as_raw_fd())?;
        let pair = validate_pair(host, pod, host_peer_nsid, pod_peer_nsid)?;
        // Events queued while either namespace was captured are never folded
        // into a new identity. Reuse of a name/ifindex cannot revive this object.
        self.host.quiet()?;
        self.pod.quiet()?;
        Ok(pair)
    }
}

fn namespace_identity(fd: RawFd) -> Result<NamespaceIdentity, Error> {
    // SAFETY: libc writes exactly the initialized native structures.
    let mut stat: libc::stat = unsafe { zeroed() };
    let mut fs: libc::statfs = unsafe { zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } != 0 || unsafe { libc::fstatfs(fd, &mut fs) } != 0 {
        return Err(io::Error::last_os_error().into());
    }
    if fs.f_type != NSFS_MAGIC || unsafe { libc::ioctl(fd, NS_GET_NSTYPE) } != libc::CLONE_NEWNET {
        return Err(Error::Invalid(
            "descriptor is not an nsfs network namespace",
        ));
    }
    Ok(NamespaceIdentity {
        device: stat.st_dev,
        inode: stat.st_ino,
    })
}

fn duplicate(fd: RawFd) -> Result<OwnedFd, Error> {
    let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if copy < 0 {
        return Err(io::Error::last_os_error().into());
    }
    // SAFETY: fcntl returned a fresh descriptor, transferred to sole Rust owner.
    Ok(unsafe { OwnedFd::from_raw_fd(copy) })
}

struct RouteSocket {
    fd: OwnedFd,
    port: u32,
    sequence: u32,
}

impl RouteSocket {
    fn open() -> Result<Self, Error> {
        let raw = unsafe {
            libc::socket(
                libc::AF_NETLINK,
                libc::SOCK_RAW | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                libc::NETLINK_ROUTE,
            )
        };
        if raw < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let mut address: libc::sockaddr_nl = unsafe { zeroed() };
        address.nl_family = libc::AF_NETLINK as u16;
        address.nl_groups = 1; // RTMGRP_LINK. Never enable NETLINK_NO_ENOBUFS.
        if unsafe {
            libc::bind(
                fd.as_raw_fd(),
                (&address as *const libc::sockaddr_nl).cast(),
                size_of::<libc::sockaddr_nl>() as libc::socklen_t,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        let mut length = size_of::<libc::sockaddr_nl>() as libc::socklen_t;
        if unsafe {
            libc::getsockname(
                fd.as_raw_fd(),
                (&mut address as *mut libc::sockaddr_nl).cast(),
                &mut length,
            )
        } != 0
        {
            return Err(io::Error::last_os_error().into());
        }
        if length as usize != size_of::<libc::sockaddr_nl>()
            || address.nl_family != libc::AF_NETLINK as u16
            || address.nl_pid == 0
            || address.nl_groups != 1
        {
            return Err(Error::Invalid("unexpected subscribed route socket address"));
        }
        Ok(Self {
            fd,
            port: address.nl_pid,
            sequence: 0,
        })
    }

    fn quiet(&self) -> Result<(), Error> {
        match self.receive()? {
            None => Ok(()),
            Some(_) => Err(Error::Unavailable(
                "network event invalidated retained identity",
            )),
        }
    }

    fn request(&mut self, kind: u16, flags: u16, payload: &[u8]) -> Result<u32, Error> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or(Error::Unavailable("route sequence exhausted"))?;
        let mut bytes = Vec::with_capacity(16 + payload.len());
        bytes.extend_from_slice(&((16 + payload.len()) as u32).to_ne_bytes());
        bytes.extend_from_slice(&kind.to_ne_bytes());
        bytes.extend_from_slice(&(NLM_F_REQUEST | flags).to_ne_bytes());
        bytes.extend_from_slice(&self.sequence.to_ne_bytes());
        bytes.extend_from_slice(&self.port.to_ne_bytes());
        bytes.extend_from_slice(payload);
        let mut kernel: libc::sockaddr_nl = unsafe { zeroed() };
        kernel.nl_family = libc::AF_NETLINK as u16;
        let sent = unsafe {
            libc::sendto(
                self.fd.as_raw_fd(),
                bytes.as_ptr().cast(),
                bytes.len(),
                libc::MSG_DONTWAIT,
                (&kernel as *const libc::sockaddr_nl).cast(),
                size_of::<libc::sockaddr_nl>() as libc::socklen_t,
            )
        };
        if sent < 0 {
            return Err(io::Error::last_os_error().into());
        }
        if sent as usize != bytes.len() {
            return Err(Error::Unknown("partial route request"));
        }
        Ok(self.sequence)
    }

    fn receive(&self) -> Result<Option<Vec<u8>>, Error> {
        let mut bytes = vec![0u8; MAX_DATAGRAM];
        let mut address: libc::sockaddr_nl = unsafe { zeroed() };
        let mut iov = libc::iovec {
            iov_base: bytes.as_mut_ptr().cast(),
            iov_len: bytes.len(),
        };
        let mut message: libc::msghdr = unsafe { zeroed() };
        message.msg_name = (&mut address as *mut libc::sockaddr_nl).cast();
        message.msg_namelen = size_of::<libc::sockaddr_nl>() as libc::socklen_t;
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        let received =
            unsafe { libc::recvmsg(self.fd.as_raw_fd(), &mut message, libc::MSG_DONTWAIT) };
        if received < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::WouldBlock {
                return Ok(None);
            }
            // Includes ENOBUFS, EINTR and descriptor failure: no resync.
            return Err(error.into());
        }
        validate_datagram_origin(
            received as usize,
            message.msg_flags,
            message.msg_namelen as usize,
            address.nl_family,
            address.nl_pid,
        )?;
        bytes.truncate(received as usize);
        Ok(Some(bytes))
    }

    fn response(&self, deadline: Instant) -> Result<Vec<u8>, Error> {
        loop {
            if Instant::now() >= deadline {
                return Err(Error::Unavailable("route response deadline exceeded"));
            }
            if let Some(bytes) = self.receive()? {
                return Ok(bytes);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let mut poll = libc::pollfd {
                fd: self.fd.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let count =
                unsafe { libc::poll(&mut poll, 1, remaining.as_millis().clamp(1, 2000) as i32) };
            if count < 0 {
                return Err(io::Error::last_os_error().into());
            }
            if poll.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                return Err(Error::Unavailable("route event socket lost continuity"));
            }
        }
    }

    fn links(&mut self) -> Result<Vec<Link>, Error> {
        let sequence = self.request(RTM_GETLINK, NLM_F_DUMP, &[0; 16])?;
        let deadline = Instant::now() + RESPONSE_TIMEOUT;
        let mut result = Vec::new();
        let mut total = 0;
        for _ in 0..MAX_DATAGRAMS {
            let bytes = self.response(deadline)?;
            total += bytes.len();
            if total > MAX_DUMP_BYTES {
                return Err(Error::Invalid("route dump exceeds byte bound"));
            }
            let mut done = false;
            for message in messages(&bytes, sequence, self.port)? {
                if done {
                    return Err(Error::Invalid("message after route dump completion"));
                }
                if message.flags & NLM_F_MULTI == 0 {
                    return Err(Error::Invalid("route dump is not multipart"));
                }
                match message.kind {
                    RTM_NEWLINK => {
                        let link = parse_link(message.payload)?;
                        if result.iter().any(|prior: &Link| prior.index == link.index) {
                            return Err(Error::Invalid("duplicate interface in route dump"));
                        }
                        result.push(link);
                        if result.len() > MAX_LINKS {
                            return Err(Error::Invalid("route dump exceeds link bound"));
                        }
                    }
                    NLMSG_DONE => {
                        validate_done(message.payload)?;
                        done = true;
                    }
                    _ => return Err(Error::Unavailable("unexpected route dump message")),
                }
            }
            if done {
                return Ok(result);
            }
        }
        Err(Error::Invalid("route dump exceeds datagram bound"))
    }

    fn namespace_id(&mut self, opposite: RawFd) -> Result<i32, Error> {
        // rtgenmsg followed by aligned NETNSA_FD; the kernel resolves the FD in
        // this process while looking up its ID relative to the socket's netns.
        let mut payload = vec![0; 4];
        payload.extend_from_slice(&8u16.to_ne_bytes());
        payload.extend_from_slice(&NETNSA_FD.to_ne_bytes());
        payload.extend_from_slice(&opposite.to_ne_bytes());
        let sequence = self.request(RTM_GETNSID, 0, &payload)?;
        let bytes = self.response(Instant::now() + RESPONSE_TIMEOUT)?;
        let replies = messages(&bytes, sequence, self.port)?;
        if replies.len() != 1 || replies[0].kind != RTM_NEWNSID || replies[0].flags != 0 {
            return Err(Error::Unavailable(
                "unsupported route namespace ID response",
            ));
        }
        let body = replies[0].payload;
        if body.len() < 4 {
            return Err(Error::Invalid("short route namespace ID response"));
        }
        let mut id = None;
        for (kind, value) in attributes(&body[4..])? {
            if kind == NETNSA_NSID {
                once(&mut id, read_i32(value)?)?;
            }
        }
        id.filter(|id| *id >= 0).ok_or(Error::Unavailable(
            "opposite namespace has no observed kernel ID",
        ))
    }
}

fn validate_datagram_origin(
    length: usize,
    flags: i32,
    address_length: usize,
    family: u16,
    pid: u32,
) -> Result<(), Error> {
    if length == 0
        || length > MAX_DATAGRAM
        || flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0
        || address_length != size_of::<libc::sockaddr_nl>()
        || family != libc::AF_NETLINK as u16
        || pid != 0
    {
        return Err(Error::Unavailable(
            "untrusted, empty or truncated route datagram",
        ));
    }
    Ok(())
}

struct Message<'a> {
    kind: u16,
    flags: u16,
    payload: &'a [u8],
}

fn messages(bytes: &[u8], sequence: u32, port: u32) -> Result<Vec<Message<'_>>, Error> {
    let mut rest = bytes;
    let mut result = Vec::new();
    while !rest.is_empty() {
        if rest.len() < 16 {
            return Err(Error::Invalid("short netlink header"));
        }
        let length = u32::from_ne_bytes(rest[0..4].try_into().unwrap()) as usize;
        let kind = u16::from_ne_bytes(rest[4..6].try_into().unwrap());
        let flags = u16::from_ne_bytes(rest[6..8].try_into().unwrap());
        let seq = u32::from_ne_bytes(rest[8..12].try_into().unwrap());
        let pid = u32::from_ne_bytes(rest[12..16].try_into().unwrap());
        if length < 16 || length > rest.len() || align(length)? > rest.len() {
            return Err(Error::Invalid("invalid netlink message extent"));
        }
        if seq != sequence || pid != port || sequence == 0 {
            return Err(Error::Unavailable(
                "route event or unexpected response invalidates capture",
            ));
        }
        if flags & (NLM_F_DUMP_INTR | NLM_F_DUMP_FILTERED) != 0 || kind == 2 || kind == 4 {
            return Err(Error::Unavailable(
                "route error, overrun or incomplete dump",
            ));
        }
        result.push(Message {
            kind,
            flags,
            payload: &rest[16..length],
        });
        rest = &rest[align(length)?..];
    }
    if result.is_empty() {
        return Err(Error::Invalid("empty netlink message list"));
    }
    Ok(result)
}

fn validate_done(payload: &[u8]) -> Result<(), Error> {
    if payload.is_empty() || (payload.len() == 4 && read_i32(payload)? == 0) {
        Ok(())
    } else {
        Err(Error::Unavailable(
            "nonzero or unsupported route dump completion",
        ))
    }
}

#[derive(Debug)]
struct Link {
    index: u32,
    peer: Option<u32>,
    name: String,
    kind: Option<String>,
    peer_netnsid: Option<i32>,
}

fn parse_link(payload: &[u8]) -> Result<Link, Error> {
    if payload.len() < 16 {
        return Err(Error::Invalid("short link message"));
    }
    let index = read_i32(&payload[4..8])?;
    if index <= 0 {
        return Err(Error::Invalid("invalid kernel interface index"));
    }
    let mut name = None;
    let mut peer = None;
    let mut kind = None;
    let mut peer_netnsid = None;
    let mut linkinfo_seen = false;
    for (attribute, value) in attributes(&payload[16..])? {
        match attribute {
            IFLA_IFNAME => once(&mut name, cstring(value)?)?,
            IFLA_LINK => once(&mut peer, read_u32(value)?)?,
            IFLA_LINK_NETNSID => once(&mut peer_netnsid, read_i32(value)?)?,
            IFLA_LINKINFO => {
                if linkinfo_seen {
                    return Err(Error::Invalid("duplicate link information"));
                }
                linkinfo_seen = true;
                for (attribute, value) in attributes(value)? {
                    if attribute == IFLA_INFO_KIND {
                        once(&mut kind, cstring(value)?)?;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(Link {
        index: index as u32,
        peer,
        name: name.ok_or(Error::Invalid("kernel link has no name"))?,
        kind,
        peer_netnsid,
    })
}

fn unique_link(links: &[Link], predicate: impl Fn(&Link) -> bool) -> Result<&Link, Error> {
    let mut found = links.iter().filter(|link| predicate(link));
    let result = found
        .next()
        .ok_or(Error::Unavailable("veth endpoint absent"))?;
    if found.next().is_some() {
        return Err(Error::Invalid("ambiguous veth endpoint"));
    }
    Ok(result)
}

fn validate_pair(
    host: &Link,
    pod: &Link,
    host_peer_nsid: i32,
    pod_peer_nsid: i32,
) -> Result<(LinkIdentity, LinkIdentity), Error> {
    if host.kind.as_deref() != Some("veth")
        || pod.kind.as_deref() != Some("veth")
        || host.peer != Some(pod.index)
        || pod.peer != Some(host.index)
        || host_peer_nsid < 0
        || pod_peer_nsid < 0
        || host.peer_netnsid != Some(host_peer_nsid)
        || pod.peer_netnsid != Some(pod_peer_nsid)
    {
        return Err(Error::Unavailable(
            "kernel links are not the retained cross-namespace veth pair",
        ));
    }
    validate_name(&host.name)?;
    validate_name(&pod.name)?;
    let identity = |link: &Link| LinkIdentity {
        ifindex: link.index,
        iflink: link.peer.unwrap(),
        name: link.name.clone(),
        kind: "veth".to_string(),
        peer_netnsid: link.peer_netnsid.unwrap(),
    };
    Ok((identity(host), identity(pod)))
}

fn validate_name(name: &str) -> Result<(), Error> {
    if name.is_empty()
        || name.len() >= libc::IFNAMSIZ
        || name == "."
        || name == ".."
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
    {
        return Err(Error::Invalid("unsupported kernel interface name"));
    }
    Ok(())
}

fn attributes(mut bytes: &[u8]) -> Result<Vec<(u16, &[u8])>, Error> {
    let mut result = Vec::new();
    while !bytes.is_empty() {
        if bytes.len() < 4 {
            return Err(Error::Invalid("short route attribute header"));
        }
        let length = u16::from_ne_bytes(bytes[..2].try_into().unwrap()) as usize;
        let raw_kind = u16::from_ne_bytes(bytes[2..4].try_into().unwrap());
        if length < 4
            || length > bytes.len()
            || align(length)? > bytes.len()
            || raw_kind & 0x4000 != 0
        {
            return Err(Error::Invalid(
                "invalid route attribute extent or byte order",
            ));
        }
        result.push((raw_kind & 0x3fff, &bytes[4..length]));
        bytes = &bytes[align(length)?..];
    }
    Ok(result)
}

fn align(length: usize) -> Result<usize, Error> {
    length
        .checked_add(3)
        .map(|value| value & !3)
        .ok_or(Error::Invalid("route length overflow"))
}

fn cstring(bytes: &[u8]) -> Result<String, Error> {
    if bytes.is_empty()
        || bytes.len() > 256
        || bytes.last() != Some(&0)
        || bytes[..bytes.len() - 1].contains(&0)
    {
        return Err(Error::Invalid("invalid route string"));
    }
    std::str::from_utf8(&bytes[..bytes.len() - 1])
        .map(str::to_owned)
        .map_err(|_| Error::Invalid("route string is not UTF-8"))
}

fn read_u32(bytes: &[u8]) -> Result<u32, Error> {
    Ok(u32::from_ne_bytes(
        bytes
            .try_into()
            .map_err(|_| Error::Invalid("invalid route u32"))?,
    ))
}

fn read_i32(bytes: &[u8]) -> Result<i32, Error> {
    Ok(i32::from_ne_bytes(
        bytes
            .try_into()
            .map_err(|_| Error::Invalid("invalid route i32"))?,
    ))
}

fn once<T>(destination: &mut Option<T>, value: T) -> Result<(), Error> {
    if destination.replace(value).is_some() {
        return Err(Error::Invalid("duplicate identity attribute"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attr(kind: u16, value: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&((value.len() + 4) as u16).to_ne_bytes());
        bytes.extend_from_slice(&kind.to_ne_bytes());
        bytes.extend_from_slice(value);
        bytes.resize(align(bytes.len()).unwrap(), 0);
        bytes
    }

    fn link_bytes(index: i32, peer: u32, nsid: i32, name: &[u8]) -> Vec<u8> {
        let mut bytes = vec![0; 16];
        bytes[4..8].copy_from_slice(&index.to_ne_bytes());
        bytes.extend(attr(IFLA_IFNAME, name));
        bytes.extend(attr(IFLA_LINK, &peer.to_ne_bytes()));
        bytes.extend(attr(IFLA_LINK_NETNSID, &nsid.to_ne_bytes()));
        bytes.extend(attr(
            IFLA_LINKINFO | 0x8000,
            &attr(IFLA_INFO_KIND, b"veth\0"),
        ));
        bytes
    }

    fn message(kind: u16, flags: u16, sequence: u32, port: u32, body: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&((16 + body.len()) as u32).to_ne_bytes());
        bytes.extend_from_slice(&kind.to_ne_bytes());
        bytes.extend_from_slice(&flags.to_ne_bytes());
        bytes.extend_from_slice(&sequence.to_ne_bytes());
        bytes.extend_from_slice(&port.to_ne_bytes());
        bytes.extend_from_slice(body);
        bytes.resize(align(bytes.len()).unwrap(), 0);
        bytes
    }

    #[test]
    fn veth_requires_reciprocal_namespace_mapping_not_only_matching_indices() {
        let host = parse_link(&link_bytes(71, 2, 9, b"veth1\0")).unwrap();
        let pod = parse_link(&link_bytes(2, 71, 4, b"eth0\0")).unwrap();
        assert!(validate_pair(&host, &pod, 9, 4).is_ok());
        assert!(validate_pair(&host, &pod, 8, 4).is_err());
        assert!(validate_pair(&host, &pod, 9, -1).is_err());
        let wrong_peer = parse_link(&link_bytes(2, 70, 4, b"eth0\0")).unwrap();
        assert!(validate_pair(&host, &wrong_peer, 9, 4).is_err());
    }

    #[test]
    fn malformed_and_duplicate_identity_attributes_are_refused() {
        let mut bytes = link_bytes(1, 2, 3, b"eth0\0");
        bytes.extend(attr(IFLA_IFNAME, b"other\0"));
        assert!(parse_link(&bytes).is_err());
        for truncated in 0..16 {
            assert!(parse_link(&bytes[..truncated]).is_err());
        }
        assert!(attributes(&[3, 0, 1, 0]).is_err());
        assert!(attributes(&[8, 0, 1, 0, 0]).is_err());
        assert!(cstring(b"eth0\0suffix\0").is_err());
        assert!(cstring(b"eth0").is_err());
        assert!(validate_name("eth0;drop").is_err());
        assert!(validate_name("abcdefghijklmnop").is_err());
    }

    #[test]
    fn events_loss_foreign_sequence_and_interrupted_dump_are_refused() {
        let body = link_bytes(1, 2, 3, b"eth0\0");
        assert!(messages(&message(RTM_NEWLINK, NLM_F_MULTI, 5, 7, &body), 5, 7).is_ok());
        for (kind, flags, seq, port) in [
            (RTM_NEWLINK, 0, 0, 0),
            (RTM_NEWLINK, NLM_F_MULTI | NLM_F_DUMP_INTR, 5, 7),
            (RTM_NEWLINK, NLM_F_MULTI | NLM_F_DUMP_FILTERED, 5, 7),
            (RTM_NEWLINK, NLM_F_MULTI, 4, 7),
            (RTM_NEWLINK, NLM_F_MULTI, 5, 8),
            (4, 0, 5, 7),
            (2, 0, 5, 7),
        ] {
            assert!(messages(&message(kind, flags, seq, port, &body), 5, 7).is_err());
        }
        assert!(validate_done(&(-libc::ENOBUFS).to_ne_bytes()).is_err());
    }

    #[test]
    fn kernel_sender_and_complete_datagrams_are_mandatory() {
        let length = size_of::<libc::sockaddr_nl>();
        assert!(validate_datagram_origin(16, 0, length, libc::AF_NETLINK as u16, 0).is_ok());
        for flags in [libc::MSG_TRUNC, libc::MSG_CTRUNC] {
            assert!(
                validate_datagram_origin(16, flags, length, libc::AF_NETLINK as u16, 0).is_err()
            );
        }
        assert!(validate_datagram_origin(16, 0, length, libc::AF_NETLINK as u16, 1).is_err());
        assert!(validate_datagram_origin(16, 0, length - 1, libc::AF_NETLINK as u16, 0).is_err());
        assert!(validate_datagram_origin(0, 0, length, libc::AF_NETLINK as u16, 0).is_err());
    }

    #[test]
    fn namespace_validation_rejects_regular_file_and_pid_namespace() {
        let regular = File::open("/dev/null").unwrap();
        assert!(namespace_identity(regular.as_raw_fd()).is_err());
        let pid_namespace = File::open("/proc/thread-self/ns/pid").unwrap();
        assert!(namespace_identity(pid_namespace.as_raw_fd()).is_err());
        let network_namespace = File::open("/proc/thread-self/ns/net").unwrap();
        let original = namespace_identity(network_namespace.as_raw_fd()).unwrap();
        let retained = duplicate(network_namespace.as_raw_fd()).unwrap();
        drop(network_namespace);
        assert_eq!(namespace_identity(retained.as_raw_fd()).unwrap(), original);
        assert_ne!(
            unsafe { libc::fcntl(retained.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
    }
}
