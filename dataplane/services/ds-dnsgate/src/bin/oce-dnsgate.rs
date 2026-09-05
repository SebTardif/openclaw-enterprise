// Modified for OpenClaw Enterprise.
// Modified for OpenClaw Enterprise: bounded fixed-origin DNS/admission service.
#[path = "../oce/mod.rs"]
mod oce;
use std::{io, net::SocketAddrV4, path::PathBuf};

#[tokio::main(worker_threads = 2)]
async fn main() {
    if execute().await.is_err() {
        eprintln!("oce-dnsgate: configuration, authority, or enforcement unavailable");
        std::process::exit(1);
    }
}
async fn execute() -> io::Result<()> {
    if std::env::args().skip(1).collect::<Vec<_>>() == ["--version"] {
        println!("oce-dnsgate {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let mut socket = None;
    let mut authority_socket = None;
    let mut policy_file = None;
    let mut upstreams = Vec::new();
    let mut authority_upstreams = Vec::new();
    let mut ingress_port = 8443;
    let mut probe = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--probe" {
            probe = true;
            continue;
        }
        let value = args.next().ok_or_else(oce::protocol::denied)?;
        match arg.as_str() {
            "--socket" if socket.is_none() => socket = Some(PathBuf::from(value)),
            "--authority-socket" if authority_socket.is_none() => {
                authority_socket = Some(PathBuf::from(value))
            }
            "--policy-file" if policy_file.is_none() => policy_file = Some(PathBuf::from(value)),
            "--upstream" => {
                let addr: SocketAddrV4 = value.parse().map_err(|_| oce::protocol::denied())?;
                if addr.port() != 53 || addr.ip().is_unspecified() || addr.ip().is_multicast() {
                    return Err(oce::protocol::denied());
                }
                upstreams.push(addr);
            }
            "--authority-upstream" => {
                let addr: SocketAddrV4 = value.parse().map_err(|_| oce::protocol::denied())?;
                if addr.port() == 0 || addr.ip().is_unspecified() || addr.ip().is_multicast() {
                    return Err(oce::protocol::denied());
                }
                authority_upstreams.push(addr);
            }
            "--ingress-port" => {
                ingress_port = value.parse().map_err(|_| oce::protocol::denied())?;
                if ingress_port < 1024 {
                    return Err(oce::protocol::denied());
                }
            }
            _ => return Err(oce::protocol::denied()),
        }
    }
    let socket = socket.ok_or_else(oce::protocol::denied)?;
    if probe {
        return oce::protocol::probe(&socket).await;
    }
    if upstreams.is_empty() || upstreams.len() > 2 || authority_upstreams.len() > 4 {
        return Err(oce::protocol::denied());
    }
    oce::run(oce::Config {
        socket,
        authority_socket: authority_socket.ok_or_else(oce::protocol::denied)?,
        policy_file: policy_file.ok_or_else(oce::protocol::denied)?,
        upstreams,
        authority_upstreams,
        ingress_port,
    })
    .await
}
