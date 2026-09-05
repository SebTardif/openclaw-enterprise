// Modified for OpenClaw Enterprise.
// SPDX-License-Identifier: Apache-2.0

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ds_telemetry::event::{EventEnvelope, EventKind};
use ds_telemetry::provenance::Provenance;
use ds_telemetry::spool::{Spool, SpoolBounds};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::var_os("DS_WT_ROOT")
            .or_else(|| std::env::var_os("TMPDIR"))
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = root.join(format!(
            "ds-spool-failures-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn segment(&self) -> PathBuf {
        self.0.join("segment.spool")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn event() -> EventEnvelope {
    EventEnvelope::new(
        EventKind::FlowRecord,
        Provenance::new("rule", "layer", "version").unwrap(),
        b"retained event".to_vec(),
    )
}

#[tokio::test]
async fn reopening_a_segment_preserves_previously_flushed_bytes() {
    let scratch = Scratch::new();
    let path = scratch.segment();
    let spool = Spool::open(&path, SpoolBounds::default()).await.unwrap();
    spool.sink().emit_async(event()).await.unwrap();
    spool.shutdown().await.unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(!before.is_empty());

    match Spool::open(&path, SpoolBounds::default()).await {
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists),
        Ok(spool) => {
            spool.shutdown().await.unwrap();
            panic!("opening an existing segment must fail without replacing its bytes");
        }
    }
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

#[tokio::test]
async fn a_second_writer_cannot_open_an_active_segment() {
    let scratch = Scratch::new();
    let path = scratch.segment();
    let spool = Spool::open(&path, SpoolBounds::default()).await.unwrap();
    let second = Spool::open(&path, SpoolBounds::default()).await;
    spool.shutdown().await.unwrap();
    match second {
        Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists),
        Ok(spool) => {
            spool.shutdown().await.unwrap();
            panic!("two spool writers must not own the same segment");
        }
    }
}

#[tokio::test]
async fn invalid_bounds_return_errors_before_creating_a_segment() {
    let scratch = Scratch::new();
    let defaults = SpoolBounds::default();
    for bounds in [
        SpoolBounds {
            max_records: 0,
            ..defaults
        },
        SpoolBounds {
            batch_size: 0,
            ..defaults
        },
        SpoolBounds {
            channel_depth: 0,
            ..defaults
        },
        SpoolBounds {
            channel_depth: usize::MAX,
            ..defaults
        },
        SpoolBounds {
            flush_interval: Duration::ZERO,
            ..defaults
        },
        SpoolBounds {
            flush_interval: Duration::MAX,
            ..defaults
        },
    ] {
        let path = scratch.segment();
        match Spool::open(&path, bounds).await {
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput),
            Ok(spool) => {
                spool.shutdown().await.unwrap();
                panic!("invalid bounds must be rejected");
            }
        }
        assert!(!path.exists());
    }
}

#[tokio::test]
async fn shutdown_reports_a_real_segment_open_failure() {
    let scratch = Scratch::new();
    let path = scratch.segment();
    let spool = Spool::open(&path, SpoolBounds::default()).await.unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    spool.sink().emit_async(event()).await.unwrap();
    assert!(spool.shutdown().await.is_err());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn disk_full_stops_the_worker_and_shutdown_returns_the_write_error() {
    for batch_size in [1, usize::MAX] {
        let scratch = Scratch::new();
        let path = scratch.segment();
        let spool = Spool::open(
            &path,
            SpoolBounds {
                batch_size,
                flush_interval: Duration::from_millis(1),
                ..SpoolBounds::default()
            },
        )
        .await
        .unwrap();
        // /dev/full rejects actual write(2) calls with ENOSPC. Exercise both
        // batch-triggered and timer-triggered flushes through the public API.
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink("/dev/full", &path).unwrap();
        let sink = spool.sink();
        sink.emit_async(event()).await.unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                tokio::time::sleep(Duration::from_millis(5)).await;
                if sink.emit_async(event()).await.is_err() {
                    return;
                }
            }
        })
        .await;
        let result = spool.shutdown().await;
        assert!(closed.is_ok(), "write failure must close the event channel");
        assert_eq!(result.unwrap_err().raw_os_error(), Some(28));
    }
}

#[tokio::test]
async fn shutdown_completes_with_live_sinks_and_rejects_later_events() {
    let scratch = Scratch::new();
    let spool = Spool::open(scratch.segment(), SpoolBounds::default())
        .await
        .unwrap();
    let sink = spool.sink();
    sink.emit_async(event()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), spool.shutdown())
        .await
        .unwrap()
        .unwrap();
    assert!(sink.emit_async(event()).await.is_err());
    assert!(!std::fs::read(scratch.segment()).unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_closes_intake_while_producers_are_active() {
    let scratch = Scratch::new();
    let spool = Spool::open(scratch.segment(), SpoolBounds::default())
        .await
        .unwrap();
    let mut producers = Vec::new();
    for _ in 0..4 {
        let sink = spool.sink();
        producers.push(tokio::spawn(async move {
            while sink.emit_async(event()).await.is_ok() {}
        }));
    }
    tokio::time::sleep(Duration::from_millis(10)).await;
    tokio::time::timeout(Duration::from_secs(2), async move {
        spool.shutdown().await.unwrap();
        for producer in producers {
            producer.await.unwrap();
        }
    })
    .await
    .expect("shutdown must close intake before draining active producers");
}
