//! Explicit node service / CNI executable. No endpoint-opening mode exists.
use oce_network_fence::{attachment, cni, ipc, owner::Owner, Error};
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
    let mut observations: Vec<(ipc::Connection, attachment::Observation)> = Vec::new();
    let mut pending: Vec<(ipc::Connection, std::time::Instant)> = Vec::new();
    loop {
        owner.poll_processes();
        observations.retain_mut(|(connection, observation)| {
            let result = (|| -> Result<(), Error> {
                observation.current()?;
                if !connection.ready()? {
                    return Ok(());
                }
                let ipc::Incoming::Attachment(attachment::Request::Inspect(request), None) =
                    connection.receive_request()?
                else {
                    return Err(Error::Invalid("expected original observation inspection"));
                };
                observation.matches(&request)?;
                owner.inspect(observation)?;
                connection.reply_observation(&observation.reply(false)?)
            })();
            result.is_ok()
        });
        // A silent newly accepted root caller cannot monopolize the service's
        // blocking receive timeout. Keep a bounded, polled first-packet pool.
        pending.retain(|(connection, deadline)| {
            std::time::Instant::now() < *deadline && connection.request_ready().is_ok()
        });
        if let Some(connection) = server.accept()? {
            if pending.len() < attachment::MAX_SESSIONS {
                pending.push((connection, std::time::Instant::now() + attachment::LIFETIME));
            }
        }
        let Some(index) = pending
            .iter()
            .position(|(connection, _)| connection.request_ready().unwrap_or(false))
        else {
            continue;
        };
        let (mut connection, _) = pending.swap_remove(index);
        let request = match connection.receive_request() {
            Ok(value) => value,
            Err(_) => continue,
        };
        // Owner completes and retains the operation even if this connection's
        // caller disappears. A failed reply never destroys the attachment.
        match request {
            ipc::Incoming::Cni(request, namespace) => {
                let reply = owner.handle(request, namespace);
                let _ = connection.reply(&reply);
            }
            ipc::Incoming::Attachment(attachment::Request::Acquire(request), None)
                if observations.len() < attachment::MAX_SESSIONS =>
            {
                if let Ok((observation, namespace)) = owner.acquire(request) {
                    if let Ok(reply) = observation.reply(true) {
                        if connection.reply_acquired(&reply, &namespace).is_ok() {
                            observations.push((connection, observation));
                        }
                    }
                }
            }
            ipc::Incoming::Attachment(attachment::Request::Observe(request), Some(namespace))
                if observations.len() < attachment::MAX_SESSIONS =>
            {
                if let Ok(observation) = owner.observe(request, namespace) {
                    if let Ok(reply) = observation.reply(true) {
                        if connection.reply_observation(&reply).is_ok() {
                            observations.push((connection, observation));
                        }
                    }
                }
            }
            _ => {}
        }
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
