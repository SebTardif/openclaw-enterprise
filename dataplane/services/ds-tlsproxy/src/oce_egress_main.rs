// Modified for OpenClaw Enterprise.
#![forbid(unsafe_code)]
use ds_tlsproxy::oce_egress::Service;
fn main() {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() == 2 && args[1] == "--version" {
        println!("oce-egress {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if !(args.len() == 3 || args.len() == 4)
        || args[1] != "--config"
        || (args.len() == 4 && args[3] != "--ready" && args[3] != "--check-config")
    {
        eprintln!(
            "usage: oce-egress --config <administrator-owned-json> [--ready | --check-config]"
        );
        std::process::exit(2);
    }
    if args.len() == 3 && !install_sigterm_handler() {
        eprintln!("oce-egress unavailable: shutdown handler");
        std::process::exit(1);
    }
    let result = Service::load(args[2].clone().into()).and_then(|s| {
        if args.len() == 4 && args[3] == "--check-config" {
            Ok(())
        } else if args.len() == 4 {
            s.ready()
        } else {
            s.run()
        }
    });
    if let Err(error) = result {
        eprintln!("oce-egress unavailable: {error}");
        std::process::exit(1);
    }
}

// PID1 must explicitly observe SIGTERM. Immediate process teardown closes every
// owned socket; incomplete receipts remain unknown in authoritative state.
fn install_sigterm_handler() -> bool {
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    if std::thread::Builder::new()
        .name("oce-sigterm".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .build()
            {
                Ok(r) => r,
                Err(_) => {
                    let _ = ready_tx.send(false);
                    return;
                }
            };
            runtime.block_on(async move {
                let mut signal =
                    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    {
                        Ok(s) => s,
                        Err(_) => {
                            let _ = ready_tx.send(false);
                            return;
                        }
                    };
                let _ = ready_tx.send(true);
                if signal.recv().await.is_some() {
                    std::process::exit(0);
                }
            });
        })
        .is_err()
    {
        return false;
    }
    ready_rx.recv().unwrap_or(false)
}
