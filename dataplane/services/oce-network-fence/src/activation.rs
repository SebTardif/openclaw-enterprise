//! Policy-only activation against retained chain handles and an original nonzero
//! ruleset generation. There is no name-based chain creation or retry here.
use crate::{Error, kernel::Table};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::time::{Duration, Instant};

const NFT: u16 = 10 << 8;
const NEWCHAIN: u16 = NFT | 3;
const GETGEN: u16 = NFT | 16;
const NEWGEN: u16 = NFT | 15;
const REQUEST: u16 = 1;
const ACK: u16 = 4;

pub(crate) struct Activation {
    socket: OwnedFd,
    port: u32,
    sequence: u32,
    deadline: Instant,
}
impl Activation {
    pub(crate) fn open(deadline: Instant) -> Result<Self, Error> {
        let fd = unsafe {
            libc::socket(
                libc::AF_NETLINK,
                libc::SOCK_RAW | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK,
                libc::NETLINK_NETFILTER,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let socket = unsafe { OwnedFd::from_raw_fd(fd) };
        let mut address: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
        address.nl_family = libc::AF_NETLINK as u16;
        let mut length = std::mem::size_of_val(&address) as libc::socklen_t;
        if unsafe { libc::bind(fd, (&address as *const libc::sockaddr_nl).cast(), length) } != 0
            || unsafe {
                libc::getsockname(
                    fd,
                    (&mut address as *mut libc::sockaddr_nl).cast(),
                    &mut length,
                )
            } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        if length as usize != std::mem::size_of_val(&address)
            || address.nl_family != libc::AF_NETLINK as u16
            || address.nl_pid == 0
            || address.nl_groups != 0
        {
            return Err(Error::Unavailable("invalid netfilter socket identity"));
        }
        Ok(Self {
            socket,
            port: address.nl_pid,
            sequence: 0,
            deadline,
        })
    }
    fn next(&mut self) -> Result<u32, Error> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or(Error::Unavailable("netfilter sequence exhausted"))?;
        Ok(self.sequence)
    }
    pub(crate) fn generation(&mut self) -> Result<u32, Error> {
        let seq = self.next()?;
        self.send(&message(GETGEN, REQUEST, seq, self.port, &[0, 0, 0, 0]))?;
        let replies = self.receive(Instant::now() + Duration::from_secs(1))?;
        let messages = decode(&replies, self.port)?;
        if messages.len() != 1 || messages[0].sequence != seq || messages[0].kind != NEWGEN {
            return Err(Error::Unavailable("unexpected generation response"));
        }
        let body = messages[0].body;
        if body.len() < 4 || body[1] != 0 {
            return Err(Error::Invalid("invalid generation envelope"));
        }
        let mut generation = None;
        for (kind, bytes) in attributes(&body[4..])? {
            match kind & 0x3fff {
                1 if generation.is_none() && bytes.len() == 4 => {
                    generation = Some(u32::from_be_bytes(bytes.try_into().unwrap()))
                }
                2 | 3 => (), // Kernel's reporting process metadata, never authority.
                _ => return Err(Error::Invalid("invalid generation attributes")),
            }
        }
        generation
            .filter(|value| *value != 0)
            .ok_or(Error::Unavailable("zero or absent ruleset generation"))
    }
    pub(crate) fn drop_original(&mut self, table: &Table, generation: u32) -> Result<(), Error> {
        let identity = table
            .observed()
            .ok_or(Error::Unavailable("original anchor identity absent"))?;
        if generation == 0 {
            return Err(Error::Invalid(
                "generation zero disables the kernel comparison",
            ));
        }
        let begin = self.next()?;
        let first = self.next()?;
        let second = self.next()?;
        let end = self.next()?;
        let mut header = vec![0, 0, 0, 10];
        header.extend(attribute(1 | 0x4000, &generation.to_be_bytes()));
        let mut batch = message(16, REQUEST, begin, self.port, &header);
        for (sequence, handle) in [
            (first, identity.from_handle),
            (second, identity.toward_handle),
        ] {
            batch.extend(policy_message(table.name(), handle, sequence, self.port));
        }
        batch.extend(message(17, REQUEST, end, self.port, &[0, 0, 0, 10]));
        self.send(&batch)?;
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut seen = std::collections::BTreeSet::new();
        while seen.len() < 2 {
            for reply in decode(&self.receive(deadline)?, self.port)? {
                if reply.kind != 2
                    || !(begin..=end).contains(&reply.sequence)
                    || reply.body.len() < 20
                {
                    return Err(Error::Unknown("unexpected activation acknowledgement"));
                }
                let error = i32::from_ne_bytes(reply.body[..4].try_into().unwrap());
                if error != 0 {
                    return Err(Error::Unavailable("original activation refused by kernel"));
                }
                if ![first, second].contains(&reply.sequence) || !seen.insert(reply.sequence) {
                    return Err(Error::Unknown("invalid activation acknowledgement set"));
                }
            }
        }
        Ok(())
    }
    fn send(&self, bytes: &[u8]) -> Result<(), Error> {
        self.current()?;
        let mut kernel: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
        kernel.nl_family = libc::AF_NETLINK as u16;
        let n = unsafe {
            libc::sendto(
                self.socket.as_raw_fd(),
                bytes.as_ptr().cast(),
                bytes.len(),
                0,
                (&kernel as *const libc::sockaddr_nl).cast(),
                std::mem::size_of_val(&kernel) as libc::socklen_t,
            )
        };
        if n < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if n as usize != bytes.len() {
            return Err(Error::Unknown("partial netfilter submission"));
        }
        Ok(())
    }
    pub(crate) fn current(&self) -> Result<(), Error> {
        if Instant::now() >= self.deadline {
            return Err(Error::Unavailable("original attachment deadline elapsed"));
        }
        Ok(())
    }
    fn receive(&self, deadline: Instant) -> Result<Vec<u8>, Error> {
        let deadline = deadline.min(self.deadline);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Error::Unknown("netfilter response deadline"));
            }
            let mut p = libc::pollfd {
                fd: self.socket.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            if unsafe { libc::poll(&mut p, 1, remaining.as_millis().clamp(1, 1000) as i32) } < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            if p.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                return Err(Error::Unknown("netfilter response continuity lost"));
            }
            if p.revents & libc::POLLIN == 0 {
                continue;
            }
            let mut bytes = vec![0u8; 65536];
            let mut kernel: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
            let mut iov = libc::iovec {
                iov_base: bytes.as_mut_ptr().cast(),
                iov_len: bytes.len(),
            };
            let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
            msg.msg_name = (&mut kernel as *mut libc::sockaddr_nl).cast();
            msg.msg_namelen = std::mem::size_of_val(&kernel) as libc::socklen_t;
            msg.msg_iov = &mut iov;
            msg.msg_iovlen = 1;
            let n = unsafe { libc::recvmsg(self.socket.as_raw_fd(), &mut msg, 0) };
            if n < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            if n == 0
                || msg.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0
                || msg.msg_namelen as usize != std::mem::size_of_val(&kernel)
                || kernel.nl_family != libc::AF_NETLINK as u16
                || kernel.nl_pid != 0
                || kernel.nl_groups != 0
            {
                return Err(Error::Unknown("untrusted or incomplete netfilter response"));
            }
            bytes.truncate(n as usize);
            return Ok(bytes);
        }
    }
}
pub(crate) fn next_generation(value: u32) -> u32 {
    let next = value.wrapping_add(1);
    if next == 0 { 1 } else { next }
}
fn policy_message(table: &str, handle: u64, sequence: u32, port: u32) -> Vec<u8> {
    let mut body = vec![5, 0, 0, 0]; // NFPROTO_NETDEV
    let mut name = table.as_bytes().to_vec();
    name.push(0);
    body.extend(attribute(1, &name)); // NFTA_CHAIN_TABLE
    body.extend(attribute(2 | 0x4000, &handle.to_be_bytes())); // HANDLE only
    body.extend(attribute(5 | 0x4000, &0u32.to_be_bytes())); // NF_DROP
    message(NEWCHAIN, REQUEST | ACK, sequence, port, &body)
}
fn attribute(kind: u16, bytes: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend(((bytes.len() + 4) as u16).to_ne_bytes());
    v.extend(kind.to_ne_bytes());
    v.extend(bytes);
    v.resize((v.len() + 3) & !3, 0);
    v
}
fn message(kind: u16, flags: u16, sequence: u32, port: u32, body: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend(((body.len() + 16) as u32).to_ne_bytes());
    v.extend(kind.to_ne_bytes());
    v.extend(flags.to_ne_bytes());
    v.extend(sequence.to_ne_bytes());
    v.extend(port.to_ne_bytes());
    v.extend(body);
    v.resize((v.len() + 3) & !3, 0);
    v
}
struct Message<'a> {
    kind: u16,
    sequence: u32,
    body: &'a [u8],
}
fn decode(mut bytes: &[u8], port: u32) -> Result<Vec<Message<'_>>, Error> {
    let mut out = Vec::new();
    while !bytes.is_empty() {
        if bytes.len() < 16 {
            return Err(Error::Invalid("short netfilter header"));
        }
        let n = u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize;
        let aligned = (n + 3) & !3;
        if n < 16
            || aligned > bytes.len()
            || u32::from_ne_bytes(bytes[12..16].try_into().unwrap()) != port
        {
            return Err(Error::Invalid("invalid netfilter response framing"));
        }
        out.push(Message {
            kind: u16::from_ne_bytes(bytes[4..6].try_into().unwrap()),
            sequence: u32::from_ne_bytes(bytes[8..12].try_into().unwrap()),
            body: &bytes[16..n],
        });
        bytes = &bytes[aligned..];
    }
    if out.is_empty() {
        return Err(Error::Invalid("empty netfilter response"));
    }
    Ok(out)
}
fn attributes(mut bytes: &[u8]) -> Result<Vec<(u16, &[u8])>, Error> {
    let mut out = Vec::new();
    while !bytes.is_empty() {
        if bytes.len() < 4 {
            return Err(Error::Invalid("short netfilter attribute"));
        }
        let n = u16::from_ne_bytes(bytes[..2].try_into().unwrap()) as usize;
        let aligned = (n + 3) & !3;
        if n < 4 || aligned > bytes.len() {
            return Err(Error::Invalid("invalid netfilter attribute"));
        }
        out.push((
            u16::from_ne_bytes(bytes[2..4].try_into().unwrap()),
            &bytes[4..n],
        ));
        bytes = &bytes[aligned..];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_wire_has_only_table_handle_and_drop_policy() {
        let bytes = policy_message("original_table", 0x0102030405060708, 3, 42);
        let messages = decode(&bytes, 42).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].kind, NEWCHAIN);
        assert_eq!(
            u16::from_ne_bytes(bytes[6..8].try_into().unwrap()),
            REQUEST | ACK
        );
        assert_eq!(&messages[0].body[..4], &[5, 0, 0, 0]);
        let attrs = attributes(&messages[0].body[4..]).unwrap();
        assert_eq!(
            attrs.iter().map(|item| item.0).collect::<Vec<_>>(),
            [1, 2 | 0x4000, 5 | 0x4000]
        );
        assert_eq!(attrs[0].1, b"original_table\0");
        assert_eq!(attrs[1].1, &0x0102030405060708u64.to_be_bytes());
        assert_eq!(attrs[2].1, &0u32.to_be_bytes());
    }
    #[test]
    fn generation_and_framing_fail_closed() {
        assert_eq!(next_generation(u32::MAX), 1);
        assert_eq!(next_generation(1), 2);
        let packet = message(NEWGEN, 0, 4, 7, &[0, 0, 0, 0]);
        assert!(decode(&packet, 8).is_err());
        assert!(decode(&packet[..packet.len() - 1], 7).is_err());
        assert!(attributes(&[3, 0, 1, 0]).is_err());
        assert!(attributes(&[8, 0, 1, 0, 0]).is_err());
    }

    /// Actual nfnetlink CAS/handle behavior, deliberately selected inside a
    /// fresh network-disabled container. No mocked kernel or public authority.
    #[test]
    #[ignore = "requires explicitly provisioned disposable root network namespace"]
    fn live_original_handle_activation_races() {
        use crate::tool::NftTool;
        use std::path::Path;
        use std::process::Command;
        assert_eq!(std::env::var("OCE_FENCE_KERNEL_TEST").as_deref(), Ok("1"));
        assert!(Path::new("/.dockerenv").exists());
        assert_eq!(unsafe { libc::geteuid() }, 0);
        fn command(program: &str, args: &[&str]) -> Vec<u8> {
            let r = Command::new(program).args(args).output().unwrap();
            assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
            r.stdout
        }
        let links: serde_json::Value =
            serde_json::from_slice(&command("ip", &["-j", "link", "show"])).unwrap();
        assert_eq!(links.as_array().unwrap().len(), 1);
        assert_eq!(links[0]["ifname"], "lo");
        struct Processes(Vec<std::process::Child>);
        impl Drop for Processes {
            fn drop(&mut self) {
                for child in self.0.iter_mut().rev() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        let mut processes = Processes(Vec::new());
        let child = Command::new("unshare")
            .args(["--net", "sleep", "120"])
            .spawn()
            .unwrap();
        let namespace = format!("/proc/{}/ns/net", child.id());
        processes.0.push(child);
        let original = std::fs::read_link("/proc/self/ns/net").unwrap();
        let wait = Instant::now() + Duration::from_secs(3);
        while std::fs::read_link(&namespace).unwrap() == original {
            assert!(Instant::now() < wait);
            std::thread::sleep(Duration::from_millis(5));
        }
        let enter = format!("--net={namespace}");
        let server = "import socket; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('0.0.0.0',18764)); s.listen(8)\nwhile True:\n c,_=s.accept(); c.sendall(b'original-handle'); c.close()";
        processes.0.push(
            Command::new("python3")
                .args(["-c", server])
                .spawn()
                .unwrap(),
        );
        processes.0.push(
            Command::new("nsenter")
                .args([&enter, "--", "python3", "-c", server])
                .spawn()
                .unwrap(),
        );
        let setup = || {
            command(
                "ip",
                &[
                    "link",
                    "set",
                    "fencecase1",
                    "netns",
                    &processes.0[0].id().to_string(),
                ],
            );
            command("ip", &["addr", "add", "192.0.2.1/30", "dev", "fencecase0"]);
            command("ip", &["link", "set", "fencecase0", "up"]);
            command(
                "nsenter",
                &[
                    &enter,
                    "--",
                    "ip",
                    "addr",
                    "add",
                    "192.0.2.2/30",
                    "dev",
                    "fencecase1",
                ],
            );
            command(
                "nsenter",
                &[&enter, "--", "ip", "link", "set", "fencecase1", "up"],
            );
        };
        let healthy = || {
            let client = "import socket,sys; s=socket.create_connection((sys.argv[1],18764),1); assert s.recv(32)==b'original-handle'";
            command("python3", &["-c", client, "192.0.2.2"]);
            command(
                "nsenter",
                &[&enter, "--", "python3", "-c", client, "192.0.2.1"],
            );
        };
        let nft = Path::new("/usr/sbin/nft");
        let digest: String = ds_contracts::snapshot_verify::sha256(&std::fs::read(nft).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let tool = NftTool::open(nft, &digest).unwrap();
        for mode in ["replace-link", "replace-table", "missing-second-chain"] {
            command(
                "ip",
                &[
                    "link",
                    "add",
                    "fencecase0",
                    "type",
                    "veth",
                    "peer",
                    "name",
                    "fencecase1",
                ],
            );
            setup();
            healthy();
            let table = Table::allocate("fencecase0").unwrap();
            let mut activation =
                Activation::open(Instant::now() + Duration::from_secs(10)).unwrap();
            let g0 = activation.generation().unwrap();
            tool.install(&table).unwrap();
            let original = activation.generation().unwrap();
            assert_eq!(original, next_generation(g0));
            tool.inspect_anchor(&table).unwrap();
            assert_eq!(activation.generation().unwrap(), original);
            match mode {
                "replace-link" => {
                    // Unregister removes the original hooked chains. New same-name
                    // interfaces must not be resolved by handle-only activation.
                    command("ip", &["link", "del", "fencecase0"]);
                    command(
                        "ip",
                        &[
                            "link",
                            "add",
                            "fencecase0",
                            "type",
                            "veth",
                            "peer",
                            "name",
                            "fencecase1",
                        ],
                    );
                    setup();
                    healthy();
                }
                "replace-table" => {
                    // Per-table chain handles can repeat. Original generation CAS
                    // must reject this otherwise identical named replacement.
                    command("nft", &["delete", "table", "netdev", table.name()]);
                    tool.install(&table).unwrap();
                    let bytes = command("nft", &["-j", "list", "table", "netdev", table.name()]);
                    let view: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                    assert_eq!(
                        view["nftables"][2]["chain"]["handle"].as_u64(),
                        Some(table.observed().unwrap().from_handle)
                    );
                    assert_eq!(
                        view["nftables"][3]["chain"]["handle"].as_u64(),
                        Some(table.observed().unwrap().toward_handle)
                    );
                }
                "missing-second-chain" => {
                    command(
                        "nft",
                        &["delete", "chain", "netdev", table.name(), "toward_pod"],
                    );
                    // This mechanism-level probe deliberately uses the new actual
                    // generation to isolate all-or-nothing handle update failure.
                    // Production never refreshes its original generation.
                    let changed = activation.generation().unwrap();
                    assert!(activation.drop_original(&table, changed).is_err());
                }
                _ => unreachable!(),
            }
            assert!(activation.drop_original(&table, original).is_err());
            let current: serde_json::Value = serde_json::from_slice(&command(
                "nft",
                &["-j", "list", "table", "netdev", table.name()],
            ))
            .unwrap();
            for entry in current["nftables"].as_array().unwrap() {
                if let Some(chain) = entry.get("chain") {
                    assert_eq!(chain["policy"], "accept", "race activated DROP: {mode}");
                }
            }
            healthy();
            command("ip", &["link", "show", "fencecase0"]);
            command("nft", &["delete", "table", "netdev", table.name()]);
            command("ip", &["link", "del", "fencecase0"]);
        }
    }
}
