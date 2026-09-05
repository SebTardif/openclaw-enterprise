// Modified for OpenClaw Enterprise.
// Modified for OpenClaw Enterprise: dedicated network namespace enforcement.
// This module never enters a namespace and never changes a host-global table.
use super::protocol::denied;
use ds_nft::backend::{NftBackend, NftBatch, SpawnBackend};
use std::{
    collections::BTreeMap,
    io,
    net::{Ipv4Addr, SocketAddrV4},
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command};

#[async_trait::async_trait]
pub trait Enforcement: Send + Sync {
    fn replace(&self, desired: &BTreeMap<Ipv4Addr, Instant>) -> io::Result<()>;
    async fn destroy(&self, ip: Ipv4Addr) -> io::Result<()>;
}
#[async_trait::async_trait]
impl Enforcement for Kernel {
    fn replace(&self, desired: &BTreeMap<Ipv4Addr, Instant>) -> io::Result<()> {
        Kernel::replace(self, desired)
    }
    async fn destroy(&self, ip: Ipv4Addr) -> io::Result<()> {
        destroy(ip).await
    }
}

pub const TABLE: &str = "oce_egress";
pub struct Kernel {
    backend: SpawnBackend,
}
impl Kernel {
    pub fn new() -> io::Result<Self> {
        // The selected corrected backend bounds its real subprocess and output.
        Ok(Self {
            backend: SpawnBackend::new()
                .with_command_timeout(Duration::from_millis(400))
                .map_err(|_| denied())?,
        })
    }
    pub fn install(
        &self,
        resolvers: &[SocketAddrV4],
        authority: &[SocketAddrV4],
        ingress_port: u16,
    ) -> io::Result<()> {
        // Exclusive creation fails if a prior process left an unverified table.
        let mut batch = format!("create table inet {TABLE}\nadd set inet {TABLE} upstream4 {{ type ipv4_addr; flags timeout; }}\nadd chain inet {TABLE} output {{ type filter hook output priority -20; policy drop; }}\n");
        batch.push_str(&format!(
            "add rule inet {TABLE} output meta nfproto ipv6 drop\n"
        ));
        for address in resolvers {
            batch.push_str(&format!("add rule inet {TABLE} output meta skuid 0 ip daddr {} udp dport {} accept\nadd rule inet {TABLE} output meta skuid 0 ip daddr {} tcp dport {} accept\n", address.ip(), address.port(), address.ip(), address.port()));
        }
        for address in authority {
            batch.push_str(&format!(
                "add rule inet {TABLE} output meta skuid 10003 ip daddr {} tcp dport {} accept\n",
                address.ip(),
                address.port()
            ));
        }
        // Every upstream packet checks membership, including established flows.
        batch.push_str(&format!("add rule inet {TABLE} output meta skuid 10002 ip daddr @upstream4 tcp dport 443 accept\nadd rule inet {TABLE} output meta skuid 10002 ct direction reply tcp sport {ingress_port} accept\n"));
        self.apply(batch)
    }
    pub fn replace(&self, desired: &BTreeMap<Ipv4Addr, Instant>) -> io::Result<()> {
        let now = Instant::now();
        let mut batch = format!("flush set inet {TABLE} upstream4\n");
        for (ip, deadline) in desired {
            let millis = deadline
                .saturating_duration_since(now + Duration::from_millis(450))
                .as_millis();
            if millis == 0 {
                continue;
            }
            // Reserve the bounded 400ms apply deadline plus 50ms scheduling margin;
            // this is a conservative scheduling allowance, not a hard realtime
            // guarantee. TLS independently gates effects on its monotonic lease.
            batch.push_str(&format!(
                "add element inet {TABLE} upstream4 {{ {ip} timeout {millis}ms }}\n"
            ));
        }
        self.apply(batch)
    }
    fn apply(&self, batch: String) -> io::Result<()> {
        self.backend
            .apply_batch(&NftBatch::new(batch))
            .map_err(|_| denied())
    }
}
/// Delete only the final-owner destination TCP/443 flows in this dedicated netns.
/// DS's destroy API is intentionally not used: its identity is a DS packet mark.
/// Set deletion already blocks every outbound packet; cleanup failure still denies
/// readiness and remains owned for retry, rather than claiming an applied state.
pub async fn destroy(ip: Ipv4Addr) -> io::Result<()> {
    let mut child = Command::new("conntrack")
        .args([
            "-D",
            "-f",
            "ipv4",
            "-p",
            "tcp",
            "--dst",
            &ip.to_string(),
            "--dport",
            "443",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdout = child.stdout.take().ok_or_else(denied)?;
    let mut stderr = child.stderr.take().ok_or_else(denied)?;
    let result = tokio::time::timeout(Duration::from_millis(400), async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut stdout = (&mut stdout).take(65_537);
        let mut stderr = (&mut stderr).take(65_537);
        let (status, a, b) = tokio::join!(
            child.wait(),
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err)
        );
        a?;
        b?;
        if out.len() > 65_536 || err.len() > 65_536 {
            return Err(denied());
        }
        let status = status?;
        // conntrack's documented no-match result is exact status1 and one summary.
        let error = std::str::from_utf8(&err).map_err(|_| denied())?.trim();
        let no_match = status.code() == Some(1)
            && out.is_empty()
            && error.starts_with("conntrack v")
            && error.ends_with(": 0 flow entries have been deleted.")
            && error.lines().count() == 1;
        if status.success() || no_match {
            Ok(())
        } else {
            Err(denied())
        }
    })
    .await;
    match result {
        Ok(value) => value,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(denied())
        }
    }
}
