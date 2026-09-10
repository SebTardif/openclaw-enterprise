//! Bounded listener selection over the DS gate's shared Hickory dispatch and TCP framing.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use hickory_server::net::xfer::Protocol;
use hickory_server::server::RequestHandler;
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinSet;

use super::{dispatch_wire_request, next_serial, serve_tcp_connection, TcpServeLimits};

const MAX_FRAME_BYTES: usize = 4096;
const MAX_TCP_CONNECTIONS: usize = 32;
const MAX_UDP_REQUESTS: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(1);

/// Bound the shared response queue to one message even if a handler clones its
/// response handle. Encoding remains Hickory's responsibility.
#[derive(Clone)]
pub(super) struct SingleResponseHandle {
    inner: hickory_server::server::ResponseHandle,
    sent: Arc<std::sync::atomic::AtomicBool>,
}

impl SingleResponseHandle {
    pub(super) fn new(inner: hickory_server::server::ResponseHandle) -> Self {
        Self {
            inner,
            sent: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
}

#[async_trait::async_trait]
impl hickory_server::server::ResponseHandler for SingleResponseHandle {
    async fn send_response<'a>(
        &mut self,
        response: hickory_server::zone_handler::MessageResponse<
            '_,
            'a,
            impl Iterator<Item = &'a hickory_server::proto::rr::Record> + Send + 'a,
            impl Iterator<Item = &'a hickory_server::proto::rr::Record> + Send + 'a,
            impl Iterator<Item = &'a hickory_server::proto::rr::Record> + Send + 'a,
            impl Iterator<Item = &'a hickory_server::proto::rr::Record> + Send + 'a,
        >,
    ) -> Result<hickory_server::server::ResponseInfo, hickory_server::net::NetError> {
        if self.sent.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return Err(
                io::Error::new(io::ErrorKind::InvalidData, "multiple DNS responses").into(),
            );
        }
        self.inner.send_response(response).await
    }
}

/// A selected listener pair. Only socket addresses and lifecycle operations cross
/// the public boundary; the handler and Hickory types remain crate-private.
pub struct Running {
    udp_local: SocketAddr,
    tcp_local: SocketAddr,
    shutdown: watch::Sender<bool>,
    tasks: JoinSet<()>,
}

impl Running {
    pub fn udp_local_addr(&self) -> SocketAddr {
        self.udp_local
    }

    pub fn tcp_local_addr(&self) -> SocketAddr {
        self.tcp_local
    }

    /// Wait for an unexpected listener exit. Normal operation has no completed
    /// listener task; callers should supervise this future alongside signals.
    pub async fn block_until_done(&mut self) -> io::Result<()> {
        match self.tasks.join_next().await {
            Some(Err(error)) => Err(io::Error::other(error)),
            Some(Ok(())) | None => Err(io::Error::other("DNS listener exited unexpectedly")),
        }
    }

    /// Stop intake and cancel active connections and requests. A client cannot
    /// prolong shutdown by continuing to send queries or withholding reads.
    pub async fn shutdown(mut self) -> io::Result<()> {
        let _ = self.shutdown.send(true);
        let drain = async {
            let mut failure = None;
            while let Some(result) = self.tasks.join_next().await {
                if let Err(error) = result {
                    failure.get_or_insert_with(|| io::Error::other(error));
                }
            }
            failure.map_or(Ok(()), Err)
        };
        match tokio::time::timeout(IO_TIMEOUT, drain).await {
            Ok(result) => result,
            Err(_) => {
                self.tasks.abort_all();
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "DNS listener shutdown timed out",
                ))
            }
        }
    }
}

pub(crate) async fn spawn<H: RequestHandler>(
    udp_addr: SocketAddr,
    tcp_addr: SocketAddr,
    handler: H,
) -> io::Result<Running> {
    // Bind both before spawning so a failed second bind leaves no running task.
    let udp = Arc::new(UdpSocket::bind(udp_addr).await?);
    let tcp_addr = if tcp_addr == udp_addr && udp_addr.port() == 0 {
        udp.local_addr()?
    } else {
        tcp_addr
    };
    let tcp = TcpListener::bind(tcp_addr).await?;
    let udp_local = udp.local_addr()?;
    let tcp_local = tcp.local_addr()?;
    let handler = Arc::new(handler);
    let (shutdown, shutdown_rx) = watch::channel(false);
    let mut tasks = JoinSet::new();
    tasks.spawn(serve_udp(udp, handler.clone(), shutdown_rx.clone()));
    tasks.spawn(serve_tcp(tcp, handler, shutdown_rx));
    Ok(Running {
        udp_local,
        tcp_local,
        shutdown,
        tasks,
    })
}

async fn serve_udp<H: RequestHandler>(
    socket: Arc<UdpSocket>,
    handler: Arc<H>,
    mut shutdown: watch::Receiver<bool>,
) {
    let permits = Arc::new(Semaphore::new(MAX_UDP_REQUESTS));
    let mut requests = JoinSet::new();
    // One extra byte distinguishes an oversized datagram from a valid maximum-
    // sized request even when the kernel truncates the received datagram.
    let mut buffer = [0u8; MAX_FRAME_BYTES + 1];
    loop {
        let received = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            result = socket.recv_from(&mut buffer) => result,
        };
        let Ok((length, source)) = received else {
            break;
        };
        while requests.try_join_next().is_some() {}
        if length > MAX_FRAME_BYTES || source.port() == 0 {
            continue;
        }
        // Acquire before allocating or spawning; overload never creates tasks
        // waiting for a semaphore permit.
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            continue;
        };
        let message = buffer[..length].to_vec();
        let socket = socket.clone();
        let handler = handler.clone();
        requests.spawn(async move {
            let _permit = permit;
            let exchange = async {
                let Some(mut receiver) =
                    dispatch_wire_request(&*handler, message, source, Protocol::Udp, true).await
                else {
                    return;
                };
                while let Some(serial) = next_serial(&mut receiver).await {
                    let (bytes, _) = serial.into_parts();
                    if bytes.len() > MAX_FRAME_BYTES {
                        return;
                    }
                    if socket.send_to(&bytes, source).await.is_err() {
                        return;
                    }
                }
            };
            let _ = tokio::time::timeout(IO_TIMEOUT, exchange).await;
        });
    }
    requests.abort_all();
    while requests.join_next().await.is_some() {}
}

async fn serve_tcp<H: RequestHandler>(
    listener: TcpListener,
    handler: Arc<H>,
    mut shutdown: watch::Receiver<bool>,
) {
    let permits = Arc::new(Semaphore::new(MAX_TCP_CONNECTIONS));
    let mut connections = JoinSet::new();
    loop {
        let permit = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            result = permits.clone().acquire_owned() => match result {
                Ok(permit) => permit,
                Err(_) => break,
            },
        };
        let accepted = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            result = listener.accept() => result,
        };
        let Ok((stream, source)) = accepted else {
            continue;
        };
        while connections.try_join_next().is_some() {}
        let handler = handler.clone();
        connections.spawn(async move {
            let _permit = permit;
            serve_tcp_connection(
                stream,
                source,
                handler,
                IO_TIMEOUT,
                Some(TcpServeLimits {
                    max_frame_bytes: MAX_FRAME_BYTES,
                    exchange_timeout: IO_TIMEOUT,
                }),
            )
            .await;
        });
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_server::net::runtime::Time;
    use hickory_server::proto::op::{Message, Metadata, Query, ResponseCode};
    use hickory_server::proto::rr::{Name, RecordType};
    use hickory_server::server::{Request, ResponseHandler, ResponseInfo};
    use hickory_server::zone_handler::MessageResponseBuilder;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    // This transport probe deliberately stalls inside dispatch. It exercises
    // listener resource ownership, without claiming DNS routing authority.
    struct PendingHandler(Arc<AtomicUsize>);

    #[async_trait::async_trait]
    impl RequestHandler for PendingHandler {
        async fn handle_request<R: ResponseHandler, T: Time>(
            &self,
            _: &Request,
            _: R,
        ) -> ResponseInfo {
            self.0.fetch_add(1, Ordering::SeqCst);
            std::future::pending().await
        }
    }

    fn wire_query() -> Vec<u8> {
        let mut message = Message::new(
            7,
            hickory_server::proto::op::MessageType::Query,
            hickory_server::proto::op::OpCode::Query,
        );
        message.add_query(Query::query(
            Name::from_ascii("example.test.").unwrap(),
            RecordType::A,
        ));
        message.to_vec().unwrap()
    }

    async fn wait_for_count(count: &AtomicUsize, minimum: usize) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while count.load(Ordering::SeqCst) < minimum {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn udp_caps_pending_dispatch_and_releases_it_on_deadline() {
        let count = Arc::new(AtomicUsize::new(0));
        let address = "127.0.0.1:0".parse().unwrap();
        let running = spawn(address, address, PendingHandler(count.clone()))
            .await
            .unwrap();
        assert_eq!(running.udp_local_addr(), running.tcp_local_addr());
        let socket = UdpSocket::bind(address).await.unwrap();
        for _ in 0..128 {
            socket
                .send_to(&wire_query(), running.udp_local_addr())
                .await
                .unwrap();
        }
        wait_for_count(&count, 1).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let admitted = count.load(Ordering::SeqCst);
        assert!((1..=MAX_UDP_REQUESTS).contains(&admitted));
        tokio::time::sleep(IO_TIMEOUT).await;
        socket
            .send_to(&wire_query(), running.udp_local_addr())
            .await
            .unwrap();
        wait_for_count(&count, admitted + 1).await;
        // Shutdown must cancel this new pending request, without its cooperation.
        running.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn tcp_rejects_oversized_frames_and_times_out_partial_frames() {
        let count = Arc::new(AtomicUsize::new(0));
        let address = "127.0.0.1:0".parse().unwrap();
        let running = spawn(address, address, PendingHandler(count.clone()))
            .await
            .unwrap();
        let mut oversized = TcpStream::connect(running.tcp_local_addr()).await.unwrap();
        oversized
            .write_all(&((MAX_FRAME_BYTES + 1) as u16).to_be_bytes())
            .await
            .unwrap();
        let mut byte = [0];
        let read = tokio::time::timeout(IO_TIMEOUT, oversized.read(&mut byte))
            .await
            .unwrap();
        assert!(matches!(read, Ok(0)) || read.is_err());
        let mut partial = TcpStream::connect(running.tcp_local_addr()).await.unwrap();
        partial.write_all(&[0]).await.unwrap();
        let read = tokio::time::timeout(Duration::from_secs(2), partial.read(&mut byte))
            .await
            .unwrap();
        assert!(matches!(read, Ok(0)) || read.is_err());
        assert_eq!(count.load(Ordering::SeqCst), 0);
        running.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn tcp_caps_pending_connections_and_shutdown_cancels_dispatch() {
        let count = Arc::new(AtomicUsize::new(0));
        let address = "127.0.0.1:0".parse().unwrap();
        let running = spawn(address, address, PendingHandler(count.clone()))
            .await
            .unwrap();
        let mut connections = Vec::new();
        let wire = wire_query();
        for _ in 0..MAX_TCP_CONNECTIONS + 8 {
            let mut stream = TcpStream::connect(running.tcp_local_addr()).await.unwrap();
            stream
                .write_all(&(wire.len() as u16).to_be_bytes())
                .await
                .unwrap();
            stream.write_all(&wire).await.unwrap();
            connections.push(stream);
        }
        wait_for_count(&count, MAX_TCP_CONNECTIONS).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(count.load(Ordering::SeqCst), MAX_TCP_CONNECTIONS);
        running.shutdown().await.unwrap();
        let mut byte = [0];
        let read = tokio::time::timeout(IO_TIMEOUT, connections[0].read(&mut byte))
            .await
            .unwrap();
        assert!(matches!(read, Ok(0)) || read.is_err());
    }

    #[tokio::test]
    async fn response_handle_clones_share_a_single_response_budget() {
        let source = "127.0.0.1:12345".parse().unwrap();
        let request = Request::from_bytes(wire_query(), source, Protocol::Tcp).unwrap();
        let (stream_handle, mut receiver) = hickory_server::net::BufDnsStreamHandle::new(source);
        let mut first = SingleResponseHandle::new(hickory_server::server::ResponseHandle::new(
            source,
            stream_handle,
            Protocol::Tcp,
        ));
        let mut second = first.clone();
        let mut metadata = Metadata::response_from_request(&request.metadata);
        metadata.response_code = ResponseCode::Refused;
        first
            .send_response(
                MessageResponseBuilder::from_message_request(&request).build_no_records(metadata),
            )
            .await
            .unwrap();
        assert!(second
            .send_response(
                MessageResponseBuilder::from_message_request(&request).build_no_records(metadata)
            )
            .await
            .is_err());
        assert!(next_serial(&mut receiver).await.is_some());
        assert!(next_serial(&mut receiver).await.is_none());
    }

    #[tokio::test]
    async fn unexpected_listener_exit_is_visible_to_supervision_and_shutdown() {
        let address = "127.0.0.1:0".parse().unwrap();
        let mut running = spawn(
            address,
            address,
            PendingHandler(Arc::new(AtomicUsize::new(0))),
        )
        .await
        .unwrap();
        // Abort the actual listener tasks to model a runtime task failure. The
        // public lifecycle must report it instead of appearing to keep serving.
        running.tasks.abort_all();
        assert!(tokio::time::timeout(IO_TIMEOUT, running.block_until_done())
            .await
            .unwrap()
            .is_err());
        assert!(running.shutdown().await.is_err());
    }
}
