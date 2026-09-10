//! Explicit node service / CNI executable. No endpoint-opening mode exists.
use oce_network_fence::{Error, cni, ipc, owner::Owner};
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

fn main() {
    if unsafe { libc::geteuid() } != 0 {
        fail();
    }
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let result = if args.len() == 3 && args[0] == "serve" {
        serve(Path::new(&args[1]), args[2].to_str().unwrap_or(""))
    } else if args.is_empty() {
        cni_call()
    } else {
        Err(Error::Invalid("unsupported invocation"))
    };
    if result.is_err() {
        fail();
    }
}
fn fail() -> ! {
    // Do not expose configuration paths, tool output, or negative custody data
    // through an untrusted Pod-facing error surface.
    let _ = std::io::stdout().write_all(b"{\"cniVersion\":\"1.0.0\",\"code\":100,\"msg\":\"Closed network attachment unavailable\"}\n");
    std::process::exit(1)
}
fn serve(nft: &Path, digest: &str) -> Result<(), Error> {
    let mut owner = Owner::open(nft, digest)?;
    let server = ipc::Server::bind()?;
    loop {
        owner.poll_processes();
        let Some(mut connection) = server.accept()? else {
            continue;
        };
        let (request, namespace) = match connection.receive() {
            Ok(value) => value,
            Err(_) => continue,
        };
        // Owner completes and retains the operation even if this connection's
        // caller disappears. A failed reply never destroys the attachment.
        let reply = owner.handle(request, namespace);
        let _ = connection.reply(&reply);
    }
}
fn cni_call() -> Result<(), Error> {
    let command =
        std::env::var("CNI_COMMAND").map_err(|_| Error::Invalid("missing CNI operation"))?;
    if command == "VERSION" {
        std::io::stdout().write_all(
            b"{\"cniVersion\":\"1.1.0\",\"supportedVersions\":[\"1.0.0\",\"1.1.0\"]}\n",
        )?;
        return Ok(());
    }
    let operation = match command.as_str() {
        "ADD" => cni::Operation::Add,
        "CHECK" => cni::Operation::Check,
        "DEL" => cni::Operation::Del,
        _ => return Err(Error::Invalid("unsupported CNI operation")),
    };
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(cni::MAX_INPUT as u64 + 1)
        .read_to_end(&mut bytes)?;
    let config = cni::Configuration::parse(&bytes)?;
    let request = cni::Request {
        schema_version: 1,
        operation,
        container_id: std::env::var("CNI_CONTAINERID")
            .map_err(|_| Error::Invalid("missing CNI container"))?,
        network_name: config.name.clone(),
        interface_name: std::env::var("CNI_IFNAME")
            .map_err(|_| Error::Invalid("missing CNI interface"))?,
    };
    request.validate()?;
    let namespace: Option<OwnedFd> = if operation == cni::Operation::Del {
        None
    } else {
        let path = std::env::var_os("CNI_NETNS").ok_or(Error::Invalid("missing CNI namespace"))?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)?;
        Some(file.into())
    };
    let reply = ipc::client(&request, namespace.as_ref())?;
    if reply.schema_version != 1
        || reply.status != cni::Status::Closed
        || reply.operation_ref.is_none()
    {
        return Err(Error::Unavailable("closed attachment not observed"));
    }
    if operation == cni::Operation::Add {
        std::io::stdout().write_all(&config.closed_result()?)?;
        std::io::stdout().write_all(b"\n")?;
    }
    Ok(())
}
