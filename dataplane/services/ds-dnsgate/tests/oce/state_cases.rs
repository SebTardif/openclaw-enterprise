// Modified for OpenClaw Enterprise.
//! Real Service/UDS consumer regressions. The controlled authority producer only
//! supplies protocol observations; it is NOT canonical OCE authority. Recorded
//! Enforcement calls prove transaction ownership/deadlines, NOT kernel effects.
use super::*;
use hickory_server::proto::{
    op::{Message, MessageType},
    rr::{rdata::A, Name, RData, Record},
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Condvar, Mutex as StdMutex,
    },
};
use tokio::{
    net::{UdpSocket, UnixStream},
    sync::Notify,
};

static NEXT: AtomicU64 = AtomicU64::new(1);
fn socket_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "oce-{label}-{}-{}.sock",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}
fn operation(id: &str) -> Operation {
    Operation {
        operation_id: id.into(),
        reservation_ref: "11".repeat(32),
        request_sha256: "22".repeat(32),
        authority_instance_ref: "00000000-0000-0000-0000-000000000002".into(),
        assignment_id: "00000000-0000-0000-0000-000000000001".into(),
        generation: 1,
        policy_version: 1,
        provider_binding_ref: "provider-a".into(),
        credential_binding: protocol::CredentialBinding {
            provider_binding_ref: "provider-a".into(),
            service_account_id: "account-a".into(),
            credential_profile_ref: "credential-a".into(),
            provider_profile_ref: "profile-a".into(),
            audience_ref: "audience-a".into(),
            transport_profile_ref: "transport-a".into(),
        },
        recipient: protocol::Recipient {
            scheme: "https".into(),
            host: "api.openai.com".into(),
            port: 443,
        },
        protocol: "tcp".into(),
    }
}
#[derive(Clone)]
struct Reply {
    state: &'static str,
    server: u64,
    duration: u64,
    dispatch: u64,
    expires: u64,
    delay: Duration,
}
impl Default for Reply {
    fn default() -> Self {
        Self {
            state: "accepted",
            server: 10_000,
            duration: 5_000,
            dispatch: 20_000,
            expires: 60_000,
            delay: Duration::ZERO,
        }
    }
}
impl Reply {
    fn short() -> Self {
        Self {
            duration: 1_000,
            ..Self::default()
        }
    }
    fn frame(&self, op: &Operation) -> Value {
        json!({"version":1,"ok":true,"authority_profile":"oce-delegated-model-v1","authority_instance_ref":op.authority_instance_ref,"authority_evidence_ref":"00000000-0000-0000-0000-000000000003","operation_id":op.operation_id,"reservation_ref":op.reservation_ref,"request_sha256":op.request_sha256,"assignment_id":op.assignment_id,"generation":op.generation,"policy_version":op.policy_version,"provider_binding_ref":op.provider_binding_ref,"credential_binding":op.credential_binding,"operation_state":self.state,"server_time_ms":self.server,"valid_until_ms":self.server+self.duration,"dispatch_before_ms":self.dispatch,"operation_expires_at_ms":self.expires})
    }
}
#[derive(Clone, Debug)]
enum Effect {
    Replace(BTreeMap<Ipv4Addr, Instant>),
    Destroy(Ipv4Addr),
}
#[derive(Default)]
struct RecordedKernel {
    effects: StdMutex<Vec<Effect>>,
    gate: StdMutex<(bool, bool)>,
    entered: Notify,
    release: Condvar,
}
impl RecordedKernel {
    fn block_next(&self) {
        *self.gate.lock().unwrap() = (true, false);
    }
    fn unblock(&self) {
        self.gate.lock().unwrap().1 = true;
        self.release.notify_all();
    }
    fn last_replace(&self) -> BTreeMap<Ipv4Addr, Instant> {
        self.effects
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find_map(|effect| match effect {
                Effect::Replace(values) => Some(values.clone()),
                _ => None,
            })
            .unwrap()
    }
}
#[async_trait::async_trait]
impl Enforcement for RecordedKernel {
    fn replace(&self, desired: &BTreeMap<Ipv4Addr, Instant>) -> io::Result<()> {
        let mut gate = self.gate.lock().unwrap();
        if gate.0 && !desired.is_empty() {
            gate.0 = false;
            self.entered.notify_one();
            while !gate.1 {
                gate = self.release.wait(gate).unwrap();
            }
        }
        drop(gate);
        self.effects
            .lock()
            .unwrap()
            .push(Effect::Replace(desired.clone()));
        Ok(())
    }
    async fn destroy(&self, ip: Ipv4Addr) -> io::Result<()> {
        self.effects.lock().unwrap().push(Effect::Destroy(ip));
        Ok(())
    }
}
struct Fixture {
    service: Arc<Service>,
    kernel: Arc<RecordedKernel>,
    scripts: Arc<StdMutex<VecDeque<Reply>>>,
    calls: Arc<AtomicU64>,
    authority_task: tokio::task::JoinHandle<()>,
    dns_task: tokio::task::JoinHandle<()>,
    authority_path: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.kernel.unblock();
        self.authority_task.abort();
        self.dns_task.abort();
        let _ = std::fs::remove_file(&self.authority_path);
    }
}
impl Fixture {
    async fn new() -> Self {
        let authority_path = socket_path("authority");
        let listener = UnixListener::bind(&authority_path).unwrap();
        let scripts = Arc::new(StdMutex::new(VecDeque::<Reply>::new()));
        let producer_scripts = scripts.clone();
        let calls = Arc::new(AtomicU64::new(0));
        let producer_calls = calls.clone();
        let authority_task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request: Value = protocol::read_frame(&mut socket).await.unwrap();
                producer_calls.fetch_add(1, Ordering::Relaxed);
                let reply = producer_scripts
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_default();
                tokio::time::sleep(reply.delay).await;
                let frame = if request["method"] == "ready" {
                    json!({"version":1,"ok":true,"authority_profile":"oce-delegated-model-v1","authority_instance_ref":"00000000-0000-0000-0000-000000000002","server_time_ms":reply.server,"valid_until_ms":reply.server+reply.duration})
                } else {
                    reply.frame(&operation(request["operation_id"].as_str().unwrap()))
                };
                let _ = protocol::write_frame(&mut socket, &frame).await;
            }
        });
        let dns = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let upstream = dns.local_addr().unwrap();
        let dns_task = tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            loop {
                let (size, peer) = dns.recv_from(&mut buf).await.unwrap();
                let request = Message::from_vec(&buf[..size]).unwrap();
                let mut response = Message::query();
                response.metadata.id = request.metadata.id;
                response.metadata.message_type = MessageType::Response;
                response.metadata.recursion_available = true;
                response.add_query(request.queries[0].clone());
                response.add_answer(Record::from_rdata(
                    Name::from_ascii("api.openai.com.").unwrap(),
                    60,
                    RData::A(A(Ipv4Addr::new(8, 8, 8, 8))),
                ));
                dns.send_to(&response.to_vec().unwrap(), peer)
                    .await
                    .unwrap();
            }
        });
        let layer=ds_contracts::pol1::parse_layer("schema_version: pol1/v0\nlayer: org\nposture: standard\nallowlist:\n  - domain: api.openai.com\n").unwrap();
        let kernel = Arc::new(RecordedKernel::default());
        let service = Arc::new(Service {
            authority_socket: authority_path.clone(),
            resolver: Arc::new(LiveReResolver::new(&ForwarderConfig {
                upstreams: vec![upstream],
                timeout: Duration::from_millis(300),
            })),
            policy: PolicyCorePolicy::new(policy_core::pol1_eval::compose(&[layer], &[])),
            kernel: kernel.clone(),
            state: Mutex::new(State::default()),
            startup_id: "fixture-instance".into(),
            capacity_limit: MAX_RETIRED,
            authority_fixture_uid: Some(unsafe { libc::geteuid() }),
        });
        Self {
            service,
            kernel,
            scripts,
            calls,
            authority_task,
            dns_task,
            authority_path,
        }
    }
    fn replies(&self, values: impl IntoIterator<Item = Reply>) {
        self.scripts.lock().unwrap().extend(values);
    }
    async fn pending(&self, id: &str) -> Value {
        self.service.resolve(operation(id)).await.unwrap()
    }
    async fn bound(&self, id: &str) -> Value {
        let pending = self.pending(id).await;
        self.service
            .bind(
                operation(id),
                pending["ip"].as_str().unwrap().into(),
                pending["admission_id"].as_str().unwrap().into(),
                "33".repeat(32),
            )
            .await
            .unwrap()
    }
    async fn check(&self, id: &str, flow: &Value, release: bool) -> io::Result<Value> {
        self.service
            .check(
                operation(id),
                flow["ip"].as_str().unwrap().into(),
                flow["admission_id"].as_str().unwrap().into(),
                flow["connection_ref"].as_str().unwrap().into(),
                flow["flow_ref"].as_str().unwrap().into(),
                release,
            )
            .await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_dns_after_first_observation_fences_retry_before_clock_rollback() {
    let fixture = Fixture::new().await;
    // Close the real UDP receiver so the production resolver observes an
    // unavailable upstream after the first valid framed authority observation.
    fixture.dns_task.abort();
    tokio::task::yield_now().await;
    assert!(fixture
        .service
        .resolve(operation("failed-dns"))
        .await
        .is_err());
    assert_eq!(fixture.calls.load(Ordering::Relaxed), 1);
    {
        let state = fixture.service.state.lock().await;
        assert!(state.attempts.contains("failed-dns"));
        assert!(state.admissions.is_empty());
        assert!(state.retired.is_empty());
    }
    assert!(fixture.kernel.effects.lock().unwrap().is_empty());
    // If contacted again this controlled producer would move its clock back.
    // The actual service refuses the failed observed attempt before another RPC
    // or kernel effect; there is no invented admission/IP to stand in for it.
    fixture.replies([Reply {
        server: 9_000,
        ..Reply::default()
    }]);
    assert!(fixture
        .service
        .resolve(operation("failed-dns"))
        .await
        .is_err());
    assert_eq!(fixture.calls.load(Ordering::Relaxed), 1);
    assert_eq!(fixture.scripts.lock().unwrap().len(), 1);
    assert!(fixture.kernel.effects.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn narrower_final_observation_withdraws_resolve_bind_check_replay_and_maintenance() {
    for method in ["resolve", "bind", "check", "bind-replay", "maintenance"] {
        let fixture = Fixture::new().await;
        let result = match method {
            "resolve" => {
                fixture.replies([Reply::default(), Reply::default(), Reply::short()]);
                fixture.service.resolve(operation("op-a")).await
            }
            "bind" => {
                let pending = fixture.pending("op-a").await;
                fixture.replies([Reply::default(), Reply::short()]);
                fixture
                    .service
                    .bind(
                        operation("op-a"),
                        pending["ip"].as_str().unwrap().into(),
                        pending["admission_id"].as_str().unwrap().into(),
                        "33".repeat(32),
                    )
                    .await
            }
            "check" => {
                let bound = fixture.bound("op-a").await;
                fixture.replies([Reply::default(), Reply::short()]);
                fixture.check("op-a", &bound, false).await
            }
            "bind-replay" => {
                let bound = fixture.bound("op-a").await;
                fixture.replies([Reply::short()]);
                fixture
                    .service
                    .bind(
                        operation("op-a"),
                        bound["ip"].as_str().unwrap().into(),
                        bound["admission_id"].as_str().unwrap().into(),
                        "33".repeat(32),
                    )
                    .await
            }
            _ => {
                fixture.bound("op-a").await;
                fixture.replies([Reply::short()]);
                fixture.service.maintain().await;
                Err(denied())
            }
        };
        assert!(
            result.is_err(),
            "{method} must not return the earlier long lease"
        );
        let state = fixture.service.state.lock().await;
        assert!(state.admissions.is_empty(), "{method}");
        assert!(state.retired.contains_key("op-a"), "{method}");
        assert!(state
            .map
            .lookup(&AdmissionKey {
                session_uuid: "op-a".into(),
                original_query_fqdn: "api.openai.com".into()
            })
            .is_none());
        assert!(
            fixture.kernel.last_replace().is_empty(),
            "{method} must request actual withdrawal"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shorter_observation_preserves_shared_endpoint_owner() {
    let fixture = Fixture::new().await;
    let a = fixture.bound("op-a").await;
    fixture.bound("op-b").await;
    let sibling = fixture.service.state.lock().await.admissions["op-b"].deadline;
    fixture.replies([Reply::default(), Reply::short()]);
    assert!(fixture.check("op-a", &a, false).await.is_err());
    assert_eq!(
        fixture
            .kernel
            .last_replace()
            .get(&Ipv4Addr::new(8, 8, 8, 8)),
        Some(&sibling)
    );
    assert!(!fixture
        .kernel
        .effects
        .lock()
        .unwrap()
        .iter()
        .any(|effect| matches!(effect, Effect::Destroy(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn first_rpc_start_pins_operation_and_dispatch_despite_later_clock_rollback() {
    let fixture = Fixture::new().await;
    let initial = Reply {
        duration: 1400,
        dispatch: 11_500,
        expires: 11_800,
        ..Reply::default()
    };
    fixture.replies([
        Reply {
            delay: Duration::from_millis(120),
            ..initial.clone()
        },
        initial.clone(),
        initial,
    ]);
    let started = Instant::now();
    fixture.pending("op-a").await;
    let before = fixture.service.state.lock().await.admissions["op-a"].clone();
    assert!(before.retirement_deadline <= started + Duration::from_millis(1820));
    assert!(before.dispatch_deadline <= started + Duration::from_millis(1520));
    let rollback = Reply {
        state: "dispatched",
        server: 5_000,
        dispatch: 11_500,
        expires: 11_800,
        ..Reply::default()
    };
    fixture.replies([rollback.clone(), rollback.clone()]);
    let bound = fixture
        .service
        .bind(
            operation("op-a"),
            before.ip.to_string(),
            before.admission_id.clone(),
            "33".repeat(32),
        )
        .await
        .unwrap();
    for _ in 0..2 {
        fixture.replies([rollback.clone(), rollback.clone()]);
        fixture.check("op-a", &bound, false).await.unwrap();
    }
    let after = fixture.service.state.lock().await.admissions["op-a"].clone();
    assert_eq!(after.retirement_deadline, before.retirement_deadline);
    assert_eq!(after.dispatch_deadline, before.dispatch_deadline);
    tokio::time::sleep(
        before
            .retirement_deadline
            .saturating_duration_since(Instant::now())
            + Duration::from_millis(10),
    )
    .await;
    assert!(fixture.check("op-a", &bound, false).await.is_err());
    fixture.service.maintain().await;
    assert!(fixture.kernel.last_replace().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_and_release_replay_return_only_existing_objects_and_keep_consumed_fences() {
    let fixture = Fixture::new().await;
    fixture.replies(std::iter::repeat_n(
        Reply {
            duration: 900,
            dispatch: 11_000,
            expires: 11_200,
            ..Reply::default()
        },
        5,
    ));
    let pending = fixture.pending("op-a").await;
    let original = fixture.service.state.lock().await.admissions["op-a"].clone();
    let calls = fixture.calls.load(Ordering::Relaxed);
    let replay = fixture.pending("op-a").await;
    assert_eq!(pending["admission_id"], replay["admission_id"]);
    assert_eq!(fixture.calls.load(Ordering::Relaxed), calls);
    assert_eq!(
        fixture.service.state.lock().await.admissions["op-a"].deadline,
        original.deadline
    );
    let mut wrong = operation("op-a");
    wrong.request_sha256 = "44".repeat(32);
    assert!(fixture.service.resolve(wrong).await.is_err());
    let flow = fixture
        .service
        .bind(
            operation("op-a"),
            original.ip.to_string(),
            original.admission_id,
            "33".repeat(32),
        )
        .await
        .unwrap();
    let receipt = fixture.check("op-a", &flow, true).await.unwrap();
    let effects = fixture.kernel.effects.lock().unwrap().len();
    assert_eq!(fixture.check("op-a", &flow, true).await.unwrap(), receipt);
    assert_eq!(fixture.kernel.effects.lock().unwrap().len(), effects);
    let mut wrong_flow = flow.clone();
    wrong_flow["connection_ref"] = json!("55".repeat(32));
    assert!(fixture.check("op-a", &wrong_flow, true).await.is_err());
    // Let the original real monotonic expiry pass; local expiry must not erase
    // a consumed ID in the absence of authoritative irreversible terminality.
    let deadline = fixture.service.state.lock().await.retired["op-a"]
        .admission
        .retirement_deadline;
    tokio::time::sleep(
        deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(10),
    )
    .await;
    fixture.service.maintain().await;
    assert!(fixture.service.resolve(operation("op-a")).await.is_err());
    assert!(fixture
        .service
        .state
        .lock()
        .await
        .retired
        .contains_key("op-a"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatched_resolve_and_changed_authority_incarnation_deny() {
    let fixture = Fixture::new().await;
    fixture.replies([Reply {
        state: "dispatched",
        ..Reply::default()
    }]);
    assert!(fixture.service.resolve(operation("op-a")).await.is_err());
    assert!(fixture.kernel.effects.lock().unwrap().is_empty());
    let flow = fixture.bound("op-b").await;
    let mut wrong = operation("op-b");
    wrong.authority_instance_ref = "00000000-0000-0000-0000-000000000099".into();
    assert!(fixture
        .service
        .check(
            wrong,
            flow["ip"].as_str().unwrap().into(),
            flow["admission_id"].as_str().unwrap().into(),
            "33".repeat(32),
            flow["flow_ref"].as_str().unwrap().into(),
            false
        )
        .await
        .is_err());
}

#[tokio::test]
async fn delayed_ready_frame_is_rejected_by_real_probe_consumer() {
    let path = socket_path("probe");
    let listener = UnixListener::bind(&path).unwrap();
    let producer = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let _: Value = protocol::read_frame(&mut socket).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        protocol::write_frame(
            &mut socket,
            &json!({"version":1,"ok":true,"server_time_ms":1000,"valid_until_ms":1010}),
        )
        .await
        .unwrap();
    });
    assert!(protocol::probe_from(&path, unsafe { libc::geteuid() })
        .await
        .is_err());
    producer.await.unwrap();
    std::fs::remove_file(path).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn listener_error_drains_real_disconnected_client_mutation_before_cleanup() {
    let fixture = Fixture::new().await;
    let path = socket_path("service");
    let listener = UnixListener::bind(&path).unwrap();
    let fail = Arc::new(Notify::new());
    let listener = FaultListener {
        listener,
        fail: fail.clone(),
    };
    fixture.kernel.block_next();
    let service = fixture.service.clone();
    let running = tokio::spawn(serve(service, listener, std::future::pending(), unsafe {
        libc::geteuid()
    }));
    let mut client = UnixStream::connect(&path).await.unwrap();
    let mut request = serde_json::to_value(operation("op-a")).unwrap();
    request["version"] = json!(1);
    request["method"] = json!("resolve");
    protocol::write_frame(&mut client, &request).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), fixture.kernel.entered.notified())
        .await
        .unwrap();
    drop(client);
    // Simulate accept's EMFILE failure after a real framed request has entered
    // the production mutation path. This is error-path orchestration, not proof
    // of operating-system descriptor exhaustion or a live firewall transition.
    fail.notify_one();
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!running.is_finished());
    fixture.kernel.unblock();
    let result = tokio::time::timeout(Duration::from_secs(3), running)
        .await
        .unwrap()
        .unwrap();
    assert!(result.is_err());
    assert!(fixture.kernel.last_replace().is_empty());
    assert!(fixture.service.state.lock().await.admissions.is_empty());
    std::fs::remove_file(path).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capacity_refuses_new_operation_without_evicting_consumed_fences() {
    let mut fixture = Fixture::new().await;
    // Exercise the same capacity guard with a stricter configured bound; every
    // entry is produced and released through the actual service methods.
    Arc::get_mut(&mut fixture.service).unwrap().capacity_limit = 2;
    for id in ["op-a", "op-b"] {
        let flow = fixture.bound(id).await;
        fixture.check(id, &flow, true).await.unwrap();
    }
    let calls = fixture.calls.load(Ordering::Relaxed);
    assert!(fixture.service.resolve(operation("op-c")).await.is_err());
    let state = fixture.service.state.lock().await;
    assert_eq!(state.retired.len(), 2);
    assert!(state.retired.contains_key("op-a") && state.retired.contains_key("op-b"));
    assert!(state.admissions.is_empty());
    assert_eq!(
        fixture.calls.load(Ordering::Relaxed),
        calls,
        "capacity denial must not request another grant observation"
    );
}

struct FaultListener {
    listener: UnixListener,
    fail: Arc<Notify>,
}
#[async_trait::async_trait]
impl Acceptor for FaultListener {
    async fn accept_connection(&self) -> io::Result<UnixStream> {
        tokio::select! { connection=self.listener.accept()=>connection.map(|(socket,_)|socket),_=self.fail.notified()=>Err(io::Error::from_raw_os_error(libc::EMFILE)) }
    }
}
