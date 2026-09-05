// Modified for OpenClaw Enterprise.
//! Verification only: actual ds-nft backend/generated sets and refresh output
//! inside an explicitly selected Docker --network none container. Requires only
//! NET_ADMIN, default seccomp, ip/nft/conntrack, and an initially empty ruleset.
//! The local OUTPUT fixture is intentionally distinct from DS's host-tap floor;
//! this proves crate mechanism, not an OCE Pod adapter or production deployment.
use ds_contracts::flush::{DstFilter, DstKey, LegSelector};
use ds_contracts::mark::{Leg, DS_MARK_MASK};
use ds_contracts::session::SessionRef;
use ds_nft::backend::{NftBackend, NftBatch, SpawnBackend};
use ds_nft::flush::NftWriter;
use ds_nft::mark_match::MarkMatch;
use ds_nft::refresh::{refresh_batch, withdraw_batch, RefreshRequest, RefreshStrategy};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::time::Duration;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn command(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program).args(args).output()?;
    if !output.status.success() {
        return Err(format!(
            "{program} {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(String::from_utf8(output.stdout)?)
}
fn apply(writer: &NftWriter<SpawnBackend>, text: String) -> Result<()> {
    writer.backend().apply_batch(&NftBatch::new(text))?;
    Ok(())
}
fn exchange(client: &mut TcpStream, server: &mut TcpStream, value: u8) -> Result<()> {
    client.write_all(&[value])?;
    let mut received = [0];
    server.read_exact(&mut received)?;
    if received != [value] {
        return Err("receiver observed wrong byte".into());
    }
    Ok(())
}
fn main() -> Result<()> {
    // Refuse accidental host execution before any mutation. The staging runner
    // separately verifies Docker's NetworkMode=none and its namespace identity.
    if std::env::var("DS_NFT_DISPOSABLE_CONTAINER").as_deref() != Ok("1")
        || !std::path::Path::new("/.dockerenv").exists()
    {
        return Err("explicit disposable Docker container is required".into());
    }
    let status = std::fs::read_to_string("/proc/self/status")?;
    if !status
        .lines()
        .any(|line| line == "CapEff:\t0000000000001000")
        || !status.lines().any(|line| line == "Seccomp:\t2")
    {
        return Err("expected only NET_ADMIN and enforcing default seccomp".into());
    }
    let links = std::fs::read_dir("/sys/class/net")?.collect::<std::io::Result<Vec<_>>>()?;
    if links.len() != 1 || links[0].file_name() != "lo" {
        return Err("expected network-none container with only lo".into());
    }
    if !command("nft", &["list", "ruleset"])?.trim().is_empty() {
        return Err("disposable ruleset must initially be empty".into());
    }
    println!("nft={}", command("nft", &["--version"])?.trim());
    println!("conntrack={}", command("conntrack", &["--version"])?.trim());
    println!(
        "tcp_loose={}",
        std::fs::read_to_string("/proc/sys/net/netfilter/nf_conntrack_tcp_loose")?.trim()
    );
    command("ip", &["link", "set", "lo", "up"])?;
    let writer = NftWriter::new(SpawnBackend::new());
    for index in [7, 8] {
        writer.create_session(index)?;
    }
    for (index, address) in [(7, "127.0.0.2"), (8, "127.0.0.3")] {
        // Exercise the older-kernel path on both first insertion and refresh.
        // Its ensure step must handle an initially absent element atomically.
        let request = RefreshRequest {
            set_name: format!("allow4_{index}"),
            mark: MarkMatch::for_leg(Leg::AgentVm, index),
            element: address.into(),
            timeout_secs: 30,
        };
        writer
            .backend()
            .apply_batch(&refresh_batch(RefreshStrategy::DeleteAdd, &request)?)?;
        writer
            .backend()
            .apply_batch(&refresh_batch(RefreshStrategy::DeleteAdd, &request)?)?;
    }
    let mark7 = MarkMatch::for_leg(Leg::AgentVm, 7).value();
    let mark8 = MarkMatch::for_leg(Leg::AgentVm, 8).value();
    let port = 34567;
    // Independent real TCP listeners are ready at both admitted addresses and
    // the denied address. The fixture OUTPUT chain consults the actual sets on
    // every packet, so existing-flow withdrawal does not rely on tcp_loose=0.
    let a = TcpListener::bind(("127.0.0.2", port))?;
    let b = TcpListener::bind(("127.0.0.3", port))?;
    let _denied = TcpListener::bind(("127.0.0.4", port))?;
    apply(&writer, format!(
        "add chain inet ds_filter probe_output {{ type filter hook output priority filter; policy accept; }}\n\
         add chain inet ds_filter probe_gate\n\
         add rule inet ds_filter probe_output ip daddr 127.0.0.0/8 tcp dport {port} jump probe_gate\n\
         add rule inet ds_filter probe_gate ip daddr @allow4_7 ct mark set (ct mark & {inverse:#x}) | {mark7:#x} accept\n\
         add rule inet ds_filter probe_gate ip daddr @allow4_8 ct mark set (ct mark & {inverse:#x}) | {mark8:#x} accept\n\
         add rule inet ds_filter probe_gate reject with tcp reset\n", inverse = !DS_MARK_MASK))?;
    let mut ca = TcpStream::connect_timeout(
        &format!("127.0.0.2:{port}").parse()?,
        Duration::from_millis(500),
    )?;
    let (mut sa, _) = a.accept()?;
    let mut cb = TcpStream::connect_timeout(
        &format!("127.0.0.3:{port}").parse()?,
        Duration::from_millis(500),
    )?;
    let (mut sb, _) = b.accept()?;
    for stream in [&ca, &sa, &cb, &sb] {
        stream.set_nodelay(true)?;
        stream.set_read_timeout(Some(Duration::from_millis(250)))?;
        stream.set_write_timeout(Some(Duration::from_millis(250)))?;
    }
    exchange(&mut ca, &mut sa, 41)?;
    exchange(&mut cb, &mut sb, 42)?;
    if TcpStream::connect_timeout(
        &format!("127.0.0.4:{port}").parse()?,
        Duration::from_millis(250),
    )
    .is_ok()
    {
        return Err("unadmitted destination connected".into());
    }
    println!("PASS initial admitted and independent denied TCP receivers");
    writer
        .backend()
        .apply_batch(&withdraw_batch("allow4_7", "v4:7f000002")?)?;
    writer
        .backend()
        .apply_batch(&withdraw_batch("allow4_7", "v4:7f000002")?)?;
    let session = SessionRef::new(
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
        "fixture".into(),
        7,
        "dstap-7".into(),
    );
    let filter = DstFilter::Only(vec![DstKey("127.0.0.2".into())]);
    let legs = LegSelector::Some(vec![Leg::AgentVm]);
    let report = writer
        .flush_session_report(&session, &filter, &legs)
        .map_err(|e| e.backend)?;
    if report.entries_flushed() == 0 {
        return Err("no actual marked conntrack entry deleted".into());
    }
    println!(
        "PASS actual conntrack flush entries={}",
        report.entries_flushed()
    );
    let _ = ca.write_all(&[99]);
    let mut byte = [0];
    if matches!(sa.read(&mut byte), Ok(n) if n > 0) {
        return Err("revoked established receiver got data".into());
    }
    if TcpStream::connect_timeout(
        &format!("127.0.0.2:{port}").parse()?,
        Duration::from_millis(250),
    )
    .is_ok()
    {
        return Err("revoked destination reconnected".into());
    }
    exchange(&mut cb, &mut sb, 43)?;
    // A second real deletion must be a classified empty match, not a generic
    // nonzero success. Sibling destination and established connection survive.
    if writer
        .flush_session_report(&session, &filter, &legs)
        .map_err(|e| e.backend)?
        .entries_flushed()
        != 0
    {
        return Err("second deletion unexpectedly matched".into());
    }
    println!("PASS withdrawn established/new flow denied and sibling still works");
    apply(&writer, "flush chain inet ds_filter probe_output\ndelete chain inet ds_filter probe_output\nflush chain inet ds_filter probe_gate\ndelete chain inet ds_filter probe_gate\n".into())?;
    // Simulate the reachable partial destroy: sets absent but stamp still live.
    writer.teardown_session(7)?;
    writer.destroy_session(7)?;
    writer.destroy_session(7)?;
    let table = command("nft", &["list", "table", "inet", "ds_filter"])?;
    let flowtags = command("nft", &["list", "table", "inet", "ds_flowtag"])?;
    if table.contains("allow4_7")
        || !table.contains("127.0.0.3")
        || flowtags.contains("tag_7")
        || !flowtags.contains("tag_8")
    {
        return Err("partial/double teardown did not preserve sibling".into());
    }
    writer.destroy_session(8)?;
    println!("PASS partial destroy recovery, double destroy, sibling preservation");
    println!("LIMIT fixture output policy; no host tap, OCE identity, Kubernetes, remote transport or production readiness proof");
    Ok(())
}
