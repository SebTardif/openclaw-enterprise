//! Standalone fixed Git-read child of the original protected native launcher.
//! The launch/material producer owns authority; this entry checks correspondence.
use oce_native_egress::Refusal;
use std::{
    ffi::OsString,
    io::Read,
    net::TcpListener,
    os::{
        fd::FromRawFd,
        unix::fs::{FileTypeExt, MetadataExt},
    },
};
#[path = "../git_read_bootstrap.rs"]
mod bootstrap;
#[path = "../json.rs"]
mod json;

#[derive(Debug, PartialEq, Eq)]
enum Mode {
    Version,
    Serve,
}
fn mode(args: &[OsString]) -> Result<Mode, Refusal> {
    match args {
        [arg] if arg == "--version" => Ok(Mode::Version),
        [arg] if arg == "serve-git-read-v3" => Ok(Mode::Serve),
        _ => Err(Refusal::Configuration),
    }
}

fn inherited_listener() -> Result<TcpListener, Refusal> {
    // The original launcher supplies an empty environment and private pipes.
    // These conditions cannot establish original provider/Work authority.
    if std::env::vars_os().next().is_some() {
        return Err(Refusal::Configuration);
    }
    let metadata = |name: &str| std::fs::metadata(name).map_err(|_| Refusal::Configuration);
    let input = metadata("/proc/self/fd/0")?;
    let output = metadata("/proc/self/fd/1")?;
    let image = metadata("/proc/self/fd/3")?;
    let executable = metadata("/proc/self/exe")?;
    let socket = metadata("/proc/self/fd/4")?;
    let fifos = input.file_type().is_fifo() && output.file_type().is_fifo();
    let sockets = input.file_type().is_socket() && output.file_type().is_socket();
    if (!fifos && !sockets)
        || (input.dev(), input.ino()) == (output.dev(), output.ino())
        || !image.is_file()
        || (image.dev(), image.ino()) != (executable.dev(), executable.ino())
        || !socket.file_type().is_socket()
    {
        return Err(Refusal::Configuration);
    }
    if sockets {
        // Node/libuv's selected stdio:"pipe" uses unnamed connected Unix stream
        // pairs. Reject named/path-connected, datagram and listening endpoints.
        let mut table = String::new();
        std::fs::File::open("/proc/self/net/unix")
            .map_err(|_| Refusal::Configuration)?
            .take(4 * 1024 * 1024 + 1)
            .read_to_string(&mut table)
            .map_err(|_| Refusal::Configuration)?;
        if table.len() > 4 * 1024 * 1024 {
            return Err(Refusal::Bounds);
        }
        for inode in [input.ino().to_string(), output.ino().to_string()] {
            if !table.lines().skip(1).any(|line| {
                let fields: Vec<&str> = line.split_ascii_whitespace().collect();
                fields.len() == 7
                    && fields[3] == "00000000"
                    && fields[4] == "0001"
                    && fields[5] == "03"
                    && fields[6] == inode
            }) {
                return Err(Refusal::Configuration);
            }
        }
    }
    // Confirm that this inode is an IPv4 LISTEN socket in this network namespace.
    // This is a bounded fd-specific lookup; no alternative address is selected.
    let mut table = String::new();
    std::fs::File::open("/proc/self/net/tcp")
        .map_err(|_| Refusal::Configuration)?
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut table)
        .map_err(|_| Refusal::Configuration)?;
    if table.len() > 4 * 1024 * 1024 {
        return Err(Refusal::Bounds);
    }
    let inode = socket.ino().to_string();
    if !table.lines().skip(1).any(|line| {
        let fields: Vec<&str> = line.split_ascii_whitespace().take(11).collect();
        fields.len() >= 10 && fields[3] == "0A" && fields[9] == inode
    }) {
        return Err(Refusal::Configuration);
    }
    // SAFETY: this runs exactly once, before runtime/threads or any fd-taking
    // code. fd4 is an open, inherited IPv4 LISTEN socket owned by this process,
    // checked above. No Rust owner/alias exists and no intervening code closes
    // or replaces fd4. The original launcher retains its own distinct process
    // descriptor. This conversion creates the sole child owner and single close.
    let listener = unsafe { TcpListener::from_raw_fd(4) };
    if !listener
        .local_addr()
        .map_err(|_| Refusal::Configuration)?
        .is_ipv4()
    {
        return Err(Refusal::Configuration);
    }
    listener.set_nonblocking(true).map_err(|_| Refusal::Io)?;
    Ok(listener)
}

fn main() {
    let result = (|| -> Result<(), Refusal> {
        match mode(&std::env::args_os().skip(1).collect::<Vec<_>>())? {
            Mode::Version => {
                println!("oce-github-read {}", env!("CARGO_PKG_VERSION"));
                Ok(())
            }
            Mode::Serve => {
                let listener = inherited_listener()?;
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .map_err(|_| Refusal::Configuration)?;
                runtime.block_on(bootstrap::serve(
                    listener,
                    std::io::stdin(),
                    std::io::stdout(),
                ))
            }
        }
    })();
    // No peer, material, path, header, body or token enters a diagnostic.
    if result.is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_command_and_version_are_disjoint() {
        assert_eq!(mode(&["--version".into()]), Ok(Mode::Version));
        assert_eq!(mode(&["serve-git-read-v3".into()]), Ok(Mode::Serve));
    }
    #[test]
    fn unknown_missing_and_material_arguments_refuse() {
        for args in [
            vec![],
            vec!["serve".into()],
            vec!["serve-git-read-v3".into(), "--pem".into()],
            vec!["--version".into(), "serve-git-read-v3".into()],
        ] {
            assert_eq!(mode(&args), Err(Refusal::Configuration));
        }
    }
}
