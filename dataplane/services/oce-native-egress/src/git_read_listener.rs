//! Fixed Git-read listener and retained connection ownership.
//! The original bootstrap supplies an already-bound listener, its one attachment
//! association, incoming interception TLS, GitHub web trust and current broker
//! client identity. Typed configuration and locators are not Work custody.
//! The bootstrap keeps those original providers alive through result/retire and
//! then joins their own tasks. This component manufactures none of those owners.
use crate::{
    mediated::{BrokerConfig, Mediator},
    Limits, Refusal, Repository,
};
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, MutexGuard,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{watch, Mutex as AsyncMutex},
    task::JoinHandle,
};

struct Connection {
    handle: AsyncMutex<Option<JoinHandle<Result<(), Refusal>>>>,
    joined: AtomicBool,
    completed: Arc<AtomicBool>,
}
struct Completion {
    completed: Arc<AtomicBool>,
    wake: watch::Sender<()>,
}
impl Drop for Completion {
    fn drop(&mut self) {
        self.completed.store(true, Ordering::Release);
        self.wake.send_replace(());
    }
}
struct State {
    closing: bool,
    connections: Vec<Arc<Connection>>,
    mediator: Option<Arc<Mediator>>,
    attachment: Option<Arc<str>>,
}
struct Shared {
    state: Mutex<State>,
    stop: watch::Sender<bool>,
    completed: watch::Sender<()>,
    failed: AtomicBool,
    maximum: usize,
    #[cfg(test)]
    registered: AtomicUsize,
    #[cfg(test)]
    finished: AtomicUsize,
    #[cfg(test)]
    accept_joined: AtomicBool,
}
impl Shared {
    fn state(&self) -> MutexGuard<'_, State> {
        match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                self.failed.store(true, Ordering::Release);
                poisoned.into_inner()
            }
        }
    }
    fn cancel(&self) {
        // The same lock covers connection enrollment. After sealing, even an
        // accept that already completed cannot start another mediated request.
        self.state().closing = true;
        self.stop.send_replace(true);
    }
    fn fail(&self) {
        self.failed.store(true, Ordering::Release);
        self.cancel();
    }
    fn enroll(&self, socket: TcpStream) {
        let mut state = self.state();
        if state.closing
            || self.failed.load(Ordering::Acquire)
            || state.connections.len() >= self.maximum
        {
            // No TLS/broker work starts for this refused accepted socket.
            return;
        }
        let (Some(mediator), Some(attachment)) = (&state.mediator, &state.attachment) else {
            self.failed.store(true, Ordering::Release);
            state.closing = true;
            drop(state);
            self.stop.send_replace(true);
            return;
        };
        let mediator = mediator.clone();
        let attachment = attachment.clone();
        let stop = self.stop.subscribe();
        let connection = Arc::new(Connection {
            handle: AsyncMutex::new(None),
            joined: AtomicBool::new(false),
            completed: Arc::new(AtomicBool::new(false)),
        });
        // Publish the row under the sealing lock BEFORE creating work. The
        // freshly owned handle is installed before any retire can inspect it.
        state.connections.push(connection.clone());
        let completion = Completion {
            completed: connection.completed.clone(),
            wake: self.completed.clone(),
        };
        let handle = tokio::spawn(async move {
            let _completion = completion;
            mediator.serve_until(socket, &attachment, stop).await
        });
        *connection.handle.try_lock().expect("new connection handle") = Some(handle);
        #[cfg(test)]
        self.registered.fetch_add(1, Ordering::AcqRel);
    }
    async fn join_connection(
        &self,
        connection: &Connection,
        handle: &mut Option<JoinHandle<Result<(), Refusal>>>,
    ) {
        if let Some(task) = handle.as_mut() {
            // A request-level refusal is an ordinary completed exchange. A task
            // JoinError is unexpected: this owner never aborts these handles.
            if task.await.is_err() {
                self.fail();
            }
            *handle = None;
        }
        if !connection.joined.swap(true, Ordering::AcqRel) {
            #[cfg(test)]
            self.finished.fetch_add(1, Ordering::AcqRel);
        }
    }
    async fn reap(&self) {
        let connections = self.state().connections.clone();
        for connection in connections {
            if let Ok(mut handle) = connection.handle.try_lock() {
                if connection.completed.load(Ordering::Acquire)
                    || handle.as_ref().is_none_or(JoinHandle::is_finished)
                {
                    self.join_connection(&connection, &mut handle).await;
                }
            };
        }
        self.state()
            .connections
            .retain(|c| !c.joined.load(Ordering::Acquire));
    }
    async fn drain(&self) {
        // Registration is sealed first. Each handle stays in its original row
        // while awaited; cancelling this wait does not drop or detach it.
        self.cancel();
        let connections = self.state().connections.clone();
        for connection in connections {
            let mut handle = connection.handle.lock().await;
            self.join_connection(&connection, &mut handle).await;
        }
        self.state()
            .connections
            .retain(|c| !c.joined.load(Ordering::Acquire));
    }
    fn release_inputs(&self) {
        if self.failed.load(Ordering::Acquire) {
            return;
        }
        let mut state = self.state();
        if state.closing && state.connections.is_empty() {
            state.mediator.take();
            state.attachment.take();
        }
    }
    async fn accept(self: Arc<Self>, listener: TcpListener) {
        let mut stop = self.stop.subscribe();
        let mut completed = self.completed.subscribe();
        loop {
            self.reap().await;
            if self.state().closing || self.failed.load(Ordering::Acquire) {
                break;
            }
            let accepted = tokio::select! {
                biased;
                _ = cancelled(&mut stop) => break,
                changed = completed.changed() => {
                    if changed.is_err() { self.fail(); break; }
                    continue;
                },
                value = listener.accept() => value,
            };
            match accepted {
                Ok((socket, _)) => {
                    // Completed rows may have become joinable during accept.
                    self.reap().await;
                    self.enroll(socket);
                }
                Err(_) => {
                    self.fail();
                    break;
                }
            }
        }
        self.cancel();
        drop(listener);
        self.drain().await;
        self.release_inputs();
    }
}
async fn cancelled(stop: &mut watch::Receiver<bool>) {
    loop {
        if *stop.borrow() {
            return;
        }
        if stop.changed().await.is_err() {
            return;
        }
    }
}

/// Owns the actual accept task and its independently retained connection rows.
/// A cancelled result/retire wait can be resumed on the same owner. Drop asks
/// for cancellation only; it makes no physical-retirement assertion.
pub struct GitReadListener {
    shared: Arc<Shared>,
    accept: AsyncMutex<Option<JoinHandle<()>>>,
}
impl GitReadListener {
    /// Start one explicitly selected Git-read listener. The original bootstrap
    /// must bind this actual listener and fixed attachment to the same accepted
    /// execution. Nothing is read from HTTP/argv to manufacture that association.
    /// Every request still uses the authentic V3 broker/Work/State path.
    pub fn start(
        listener: TcpListener,
        repository: Repository,
        incoming: Arc<rustls::ServerConfig>,
        upstream: Arc<rustls::ClientConfig>,
        broker: BrokerConfig,
        attachment_ref: String,
        limits: Limits,
        max_concurrent: usize,
    ) -> Result<Arc<Self>, Refusal> {
        if max_concurrent == 0 || max_concurrent > 128 {
            return Err(Refusal::Configuration);
        }
        crate::broker_rpc::reference(&attachment_ref)?;
        let mediator = Mediator::new_git_read(
            repository,
            incoming,
            upstream,
            broker,
            limits,
            max_concurrent,
        )?;
        Self::launch(listener, mediator, attachment_ref, max_concurrent)
    }
    fn launch(
        listener: TcpListener,
        mediator: Mediator,
        attachment_ref: String,
        max_concurrent: usize,
    ) -> Result<Arc<Self>, Refusal> {
        if max_concurrent == 0 || max_concurrent > 128 {
            return Err(Refusal::Configuration);
        }
        crate::broker_rpc::reference(&attachment_ref)?;
        tokio::runtime::Handle::try_current().map_err(|_| Refusal::Configuration)?;
        let (stop, _) = watch::channel(false);
        let (completed, _) = watch::channel(());
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                closing: false,
                connections: Vec::new(),
                mediator: Some(Arc::new(mediator)),
                attachment: Some(Arc::from(attachment_ref)),
            }),
            stop,
            completed,
            failed: AtomicBool::new(false),
            maximum: max_concurrent,
            #[cfg(test)]
            registered: AtomicUsize::new(0),
            #[cfg(test)]
            finished: AtomicUsize::new(0),
            #[cfg(test)]
            accept_joined: AtomicBool::new(false),
        });
        let owner = Arc::new(Self {
            shared: shared.clone(),
            accept: AsyncMutex::new(None),
        });
        let task = tokio::spawn(shared.accept(listener));
        *owner.accept.try_lock().expect("new accept handle") = Some(task);
        Ok(owner)
    }
    pub fn cancel(&self) {
        self.shared.cancel();
    }

    /// Wait for the original listener to finish, then join every retained
    /// connection, including after an accept-task failure. No timeout substitutes
    /// for these joins, and no serving future is aborted by this owner.
    pub async fn result(&self) -> Result<(), Refusal> {
        {
            let mut accept = self.accept.lock().await;
            if let Some(task) = accept.as_mut() {
                if task.await.is_err() {
                    self.shared.fail();
                }
                *accept = None;
                #[cfg(test)]
                self.shared.accept_joined.store(true, Ordering::Release);
            }
        }
        self.shared.drain().await;
        self.shared.release_inputs();
        if self.shared.failed.load(Ordering::Acquire) {
            Err(Refusal::Protocol)
        } else {
            Ok(())
        }
    }
    pub async fn retire(&self) -> Result<(), Refusal> {
        self.cancel();
        self.result().await
    }

    /// Existing controlled-peer tests may set only the mediator's existing
    /// private test endpoints before launching this same owner. This constructor
    /// is absent from production and grants no identity or broker authority.
    #[cfg(test)]
    pub(crate) fn start_fixture(
        listener: TcpListener,
        mediator: Mediator,
        attachment_ref: String,
        max_concurrent: usize,
    ) -> Result<Arc<Self>, Refusal> {
        Self::launch(listener, mediator, attachment_ref, max_concurrent)
    }
    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> ListenerSnapshot {
        let state = self.shared.state();
        ListenerSnapshot {
            closing: state.closing,
            registered: self.shared.registered.load(Ordering::Acquire),
            finished: self.shared.finished.load(Ordering::Acquire),
            accept_joined: self.shared.accept_joined.load(Ordering::Acquire),
        }
    }
}
impl Drop for GitReadListener {
    fn drop(&mut self) {
        self.shared.cancel();
    }
}
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub(crate) struct ListenerSnapshot {
    pub closing: bool,
    /// Cumulative actual connection registrations, not current concurrency.
    pub registered: usize,
    /// Cumulative joins of those original connection task handles.
    pub finished: usize,
    pub accept_joined: bool,
}
