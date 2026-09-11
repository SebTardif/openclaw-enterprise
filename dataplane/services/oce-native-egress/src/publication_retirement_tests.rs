//! GHR-06 additional lifetime schedules over the original transport and its
//! existing local UDS/mTLS/HTTPS fixture. Source-only handoff: all cases UNRUN.
//! The peer's records and synthetic token provide no production authority.
use super::tests::{Control, Fault, Fixture, Stage, SESSION};
use super::*;
use std::{
    future::{poll_fn, Future},
    pin::Pin,
    task::Poll,
};
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(3);

/// Release an entered finite blocking gate even if an assertion unwinds.
struct ReleaseOnDrop(Arc<Control>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

/// Poll the real future before claiming it is pending. A newly spawned task's
/// is_finished flag would not establish that it reached its retirement await.
async fn require_pending<F: Future>(mut future: Pin<&mut F>) {
    poll_fn(|cx| match future.as_mut().poll(cx) {
        Poll::Pending => Poll::Ready(()),
        Poll::Ready(_) => panic!("physical worker is held but caller completed"),
    })
    .await;
}

/// Continue polling the caller while waiting for a concrete gate/transport
/// transition. In particular, join_run must be polled to latch a root error.
async fn pending_until<F: Future, G: Future<Output = ()>>(future: Pin<&mut F>, signal: G) {
    timeout(WAIT, async {
        tokio::select! {
            biased;
            _ = future => panic!("caller completed before the held-worker barrier"),
            _ = signal => {},
        }
    })
    .await
    .expect("finite held-worker barrier");
}

fn known_snapshot(fixture: &Fixture) -> Value {
    // Control::Observed is entered only after observe() has enrolled the real
    // attributed response. This clones that record; it constructs no result.
    let state = fixture.run.0.owned.lock().unwrap();
    let value = state
        .observation
        .as_ref()
        .expect("actual observation")
        .0
        .clone();
    assert_eq!(value["call_ref"], "call:original");
    assert_eq!(value["outcome"]["pullRequest"]["number"], "7");
    assert_eq!(
        value["outcome"]["pullRequest"]["url"],
        "https://github.com/fixture/repo/pull/7"
    );
    value
}

fn assert_owner_keeps_ticket(fixture: &Fixture) {
    let active = fixture.owner.runs.lock().unwrap();
    assert_eq!(active.len(), 1);
    assert!(Arc::ptr_eq(active.get(SESSION).unwrap(), &fixture.run.0));
}

fn assert_closed_admission(fixture: &Fixture) {
    assert!(fixture.owner.closing.load(Ordering::Acquire));
    assert!(matches!(
        fixture.owner.serve_original(SESSION),
        Err(Refusal::AuthorityUnavailable)
    ));
    assert!(matches!(
        fixture
            .owner
            .serve_original("abcdef0123456789abcdef0123456789"),
        Err(Refusal::AuthorityUnavailable)
    ));
}

fn method_count(fixture: &Fixture, method: &str) -> usize {
    fixture
        .frames
        .lock()
        .unwrap()
        .iter()
        .filter(|frame| frame["method"] == method)
        .count()
}

fn assert_held_observation(fixture: &Fixture, control: &Control) {
    assert!(!control.finished.load(Ordering::Acquire));
    assert!(!fixture.http.lock().unwrap().is_empty());
    assert_eq!(fixture.prepared.load(Ordering::Acquire), 1);
    assert_eq!(method_count(fixture, "result-publication"), 0);
    assert_owner_keeps_ticket(fixture);
}

async fn assert_physically_joined(fixture: &Fixture) {
    assert!(timeout(WAIT, fixture.run.0.handle.lock())
        .await
        .unwrap()
        .is_none());
    let tasks = fixture.run.0.owned.lock().unwrap().tasks.clone();
    assert!(!tasks.is_empty());
    for task in tasks {
        assert!(
            timeout(WAIT, task.handle.lock()).await.unwrap().is_none(),
            "an original child JoinHandle remains unjoined"
        );
    }
}

async fn assert_same_result(fixture: &Fixture, expected: &Value, first: &Arc<RetiredPublication>) {
    assert_eq!(&first.inspect(), expected);
    let again = timeout(WAIT, fixture.owner.result(&fixture.run))
        .await
        .unwrap()
        .unwrap();
    assert!(Arc::ptr_eq(first, &again));
    assert_eq!(&again.inspect(), expected);
}

async fn finish_peers(fixture: Fixture) {
    // Sticky-failure cases deliberately cannot use Fixture::finish(), whose
    // close().unwrap() would turn the expected transport refusal into cleanup
    // failure. Production handles must already have been checked above.
    for peer in &fixture.peers {
        peer.abort();
    }
    for peer in fixture.peers {
        match timeout(WAIT, peer).await.expect("fixture peer joined") {
            Ok(()) => {}
            Err(error) => assert!(error.is_cancelled(), "fixture peer panicked: {error}"),
        }
    }
    std::fs::remove_dir_all(fixture.directory).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn join_failure_preserves_known_observation_and_sticky_failure() {
    let control = Control::new(Stage::Observed);
    let _release = ReleaseOnDrop(control.clone());
    let fixture = Fixture::start(false, Fault::ChangedPr, Some(control.clone()), b"content").await;
    timeout(WAIT, control.entered()).await.unwrap();
    let expected = known_snapshot(&fixture);
    assert_eq!(expected["outcome"]["kind"], "unknown");
    assert_eq!(
        expected["outcome"]["pullRequest"]["headOid"],
        "f".repeat(40)
    );

    // Fail the actual retained root task while its real entered observation
    // worker is held. Do not replace/take a handle or synthesize a result.
    {
        let handle = fixture.run.0.handle.lock().await;
        handle.as_ref().unwrap().abort();
    }
    let mut interrupted = Box::pin(fixture.owner.retire(&fixture.run));
    pending_until(interrupted.as_mut(), async {
        while !fixture.run.0.failed.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
        control.cancelled().await;
    })
    .await;
    assert_held_observation(&fixture, &control);
    assert!(fixture.run.0.result.borrow().is_none());

    // Cancel recovery after the original task's JoinError was consumed, while
    // drain still owns the same entered blocking child. Dropping an owned box
    // cancels the future itself, rather than only dropping a pin reference.
    drop(interrupted);
    assert!(fixture.run.0.handle.try_lock().unwrap().is_none());
    let tasks = fixture.run.0.owned.lock().unwrap().tasks.clone();
    assert!(
        tasks.iter().any(|task| {
            task.handle
                .try_lock()
                .unwrap()
                .as_ref()
                .is_some_and(|handle| !handle.is_finished())
        }),
        "cancelled recovery lost the real unfinished child handle"
    );

    let mut result = Box::pin(fixture.owner.result(&fixture.run));
    let mut closing = Box::pin(fixture.owner.close());
    let mut retiring = Box::pin(fixture.owner.retire(&fixture.run));
    require_pending(result.as_mut()).await;
    require_pending(closing.as_mut()).await;
    require_pending(retiring.as_mut()).await;
    assert_closed_admission(&fixture);
    assert_held_observation(&fixture, &control);
    control.release();

    let (result, closing, retiring) = tokio::join!(
        timeout(WAIT, result),
        timeout(WAIT, closing),
        timeout(WAIT, retiring)
    );
    let result = result.unwrap().unwrap();
    assert!(matches!(closing.unwrap(), Err(Refusal::Protocol)));
    assert!(matches!(retiring.unwrap(), Err(Refusal::Protocol)));
    assert!(!result.terminal_recorded());
    assert_same_result(&fixture, &expected, &result).await;
    assert_physically_joined(&fixture).await;
    assert_owner_keeps_ticket(&fixture);
    assert!(fixture.run.0.failed.load(Ordering::Acquire));
    assert!(matches!(
        timeout(WAIT, fixture.owner.retire(&fixture.run))
            .await
            .unwrap(),
        Err(Refusal::Protocol)
    ));
    assert!(matches!(
        timeout(WAIT, fixture.owner.close()).await.unwrap(),
        Err(Refusal::Protocol)
    ));
    assert_eq!(method_count(&fixture, "prepared-publication"), 1);
    assert_eq!(method_count(&fixture, "result-publication"), 0);
    finish_peers(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_close_and_retire_wait_for_one_physical_observation_worker() {
    let control = Control::new(Stage::Observed);
    let _release = ReleaseOnDrop(control.clone());
    let fixture = Fixture::start(false, Fault::None, Some(control.clone()), b"content").await;
    timeout(WAIT, control.entered()).await.unwrap();
    let expected = known_snapshot(&fixture);
    assert_eq!(expected["outcome"]["kind"], "draft-pr-created");

    let mut retiring = Box::pin(fixture.owner.retire(&fixture.run));
    pending_until(retiring.as_mut(), control.cancelled()).await;
    let mut closing = Box::pin(fixture.owner.close());
    let mut result = Box::pin(fixture.owner.result(&fixture.run));
    require_pending(closing.as_mut()).await;
    require_pending(result.as_mut()).await;
    require_pending(retiring.as_mut()).await;
    assert_closed_admission(&fixture);
    assert_held_observation(&fixture, &control);
    assert!(fixture.run.0.handle.try_lock().is_err());
    control.release();

    let (retiring, closing, result) = tokio::join!(
        timeout(WAIT, retiring),
        timeout(WAIT, closing),
        timeout(WAIT, result)
    );
    retiring.unwrap().unwrap();
    closing.unwrap().unwrap();
    let result = result.unwrap().unwrap();
    assert_same_result(&fixture, &expected, &result).await;
    assert_physically_joined(&fixture).await;
    assert!(fixture.owner.runs.lock().unwrap().is_empty());
    assert!(!fixture.run.0.failed.load(Ordering::Acquire));
    assert!(!fixture.premature_terminal.load(Ordering::Acquire));
    assert_eq!(method_count(&fixture, "prepared-publication"), 1);
    assert_eq!(method_count(&fixture, "result-publication"), 1);
    timeout(WAIT, fixture.owner.close()).await.unwrap().unwrap();
    finish_peers(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_result_and_close_awaiters_keep_original_join_ownership() {
    let control = Control::new(Stage::Observed);
    let _release = ReleaseOnDrop(control.clone());
    let fixture = Fixture::start(false, Fault::None, Some(control.clone()), b"content").await;
    timeout(WAIT, control.entered()).await.unwrap();
    let expected = known_snapshot(&fixture);

    // result owns the root join mutex; close enters, closes admission and
    // cancels the operation, then waits behind that same original join.
    let mut observer = Box::pin(fixture.owner.result(&fixture.run));
    require_pending(observer.as_mut()).await;
    let mut closing = Box::pin(fixture.owner.close());
    pending_until(closing.as_mut(), control.cancelled()).await;
    require_pending(observer.as_mut()).await;
    assert_closed_admission(&fixture);
    assert_held_observation(&fixture, &control);
    drop(closing);
    drop(observer);

    {
        let handle = fixture.run.0.handle.try_lock().unwrap();
        assert!(!handle
            .as_ref()
            .expect("retained original root")
            .is_finished());
    }
    assert_owner_keeps_ticket(&fixture);
    assert_closed_admission(&fixture);
    assert!(fixture.run.0.result.borrow().is_none());

    let mut recovered = Box::pin(fixture.owner.result(&fixture.run));
    let mut retiring = Box::pin(fixture.owner.retire(&fixture.run));
    let mut closing = Box::pin(fixture.owner.close());
    require_pending(recovered.as_mut()).await;
    require_pending(retiring.as_mut()).await;
    require_pending(closing.as_mut()).await;
    assert_held_observation(&fixture, &control);
    control.release();

    let (recovered, retiring, closing) = tokio::join!(
        timeout(WAIT, recovered),
        timeout(WAIT, retiring),
        timeout(WAIT, closing)
    );
    let recovered = recovered.unwrap().unwrap();
    retiring.unwrap().unwrap();
    closing.unwrap().unwrap();
    assert_same_result(&fixture, &expected, &recovered).await;
    assert_physically_joined(&fixture).await;
    assert!(fixture.owner.runs.lock().unwrap().is_empty());
    assert!(!fixture.premature_terminal.load(Ordering::Acquire));
    assert_eq!(method_count(&fixture, "prepared-publication"), 1);
    assert_eq!(method_count(&fixture, "result-publication"), 1);
    finish_peers(fixture).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observed_blocking_worker_panic_must_make_retirement_failure_sticky() {
    // This desired-behavior regression is expected to expose a frozen-source
    // gap: drain currently discards child JoinErrors. It must remain enabled;
    // neither a passing count nor a production fix is claimed by this packet.
    let control = Control::new(Stage::Observed);
    let _release = ReleaseOnDrop(control.clone());
    control.panic_after_release();
    let fixture = Fixture::start(false, Fault::None, Some(control.clone()), b"content").await;
    timeout(WAIT, control.entered()).await.unwrap();
    let expected = known_snapshot(&fixture);
    let mut retiring = Box::pin(fixture.owner.retire(&fixture.run));
    pending_until(retiring.as_mut(), control.cancelled()).await;
    assert_held_observation(&fixture, &control);
    control.release();

    // Capture outcomes and join every production/fixture worker before the
    // strict sticky-failure oracle, so its expected failure cleans up peers.
    let retirement = timeout(WAIT, retiring).await.unwrap();
    let result = timeout(WAIT, fixture.owner.result(&fixture.run))
        .await
        .unwrap()
        .unwrap();
    assert_same_result(&fixture, &expected, &result).await;
    assert_physically_joined(&fixture).await;
    let second_retirement = timeout(WAIT, fixture.owner.retire(&fixture.run))
        .await
        .unwrap();
    let closing = timeout(WAIT, fixture.owner.close()).await.unwrap();
    let second_closing = timeout(WAIT, fixture.owner.close()).await.unwrap();
    finish_peers(fixture).await;

    assert!(
        matches!(retirement, Err(Refusal::Protocol)),
        "actual observed blocking-worker panic was accepted as successful retirement"
    );
    assert!(matches!(second_retirement, Err(Refusal::Protocol)));
    assert!(matches!(closing, Err(Refusal::Protocol)));
    assert!(matches!(second_closing, Err(Refusal::Protocol)));
}
