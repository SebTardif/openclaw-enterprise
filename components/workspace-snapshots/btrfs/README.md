# Btrfs workspace provider

This package captures a pre-provisioned host workspace subvolume into an immutable
snapshot, inspects its stored identity, exports a full or incremental Btrfs stream,
and creates an independent writable clone. It runs on Linux amd64 and arm64.
The application owns authorization, workspace provisioning, all writer barriers,
and the runtime mount configuration. This utility does not establish an action
checkpoint or cross-host durability.

`New(Config)` requires an absolute trusted `btrfs` executable and three existing,
separate, private directories owned by the invoking host user. The workspace and
snapshot roots must share the same Btrfs filesystem. The export root may be on
another filesystem, including a scratch volume. The directories and their
ancestors must remain under the host operator's custody. Only individual live
workspace subvolumes may be exposed to workloads; the provider roots, capture
receipts and export directories must remain inaccessible to them. Root privileges
or appropriately delegated native Btrfs permissions are required for operations.

Supply positive `MaxStreamBytes` and `CommandTimeout` values; the timeout must not
exceed one hour. IDs contain 1–64 ASCII letters, digits, hyphens or underscores,
starting with a letter or digit. A workspace must already exist as
`WorkspaceRoot/<workspaceID>`. The package never formats or mounts a filesystem.

## Stored state and operations

- `Capture(ctx, workspaceID, snapshotID)` produces
  `SnapshotRoot/<snapshotID>/{capture.json,<snapshotID>}`. The inner path is the
  actual read-only subvolume. An operation stages both state and receipt before
  publishing their parent directory.
- `Inspect(ctx, snapshotID)` checks the native UUID, origin UUID, content transaction,
  read-only flag and supported filesystem scope against the stored receipt.
- `SnapshotPath(ctx, snapshotID)` returns that inspected immutable subvolume for
  a portable exporter. The operator must retain it while consumers read it.
- `Export(ctx, snapshotID, parentSnapshotID, exportID)` produces
  `ExportRoot/<exportID>/{stream.btrfs,manifest.json}`. An empty parent selects a
  full stream. The initial format uses send protocol 1. An incremental parent
  must be an immutable capture of the same workspace.
- `Fork(ctx, snapshotID, workspaceID)` publishes a separate writable subvolume
  under the workspace root. Existing destinations are rejected.

Metadata readback uses fixed-size Linux ioctls, so inspecting a workspace does
not enumerate its snapshot history. Scope checks use the host mount table and a
batched walk that does not follow symlinks, bounded to one million entries and
256 directory levels. Nested mounts,
nested subvolumes and snapshot stubs are rejected. This scan currently contributes
to capture latency. It cannot observe a different runtime mount namespace or prove
that a gVisor private overlay has flushed its effective writable state.

Native command stdout, diagnostics, elapsed time and stream bytes are bounded.
Independent invocations sharing the snapshot root serialize through a provider
lock; publication also uses the kernel's no-replace rename. Files and containing
directories are synchronized before success. Cancellation before publication
leaves no final artifact; cleanup has its own bounded lifetime. A
`PublicationUncertainError` means rename succeeded and a later synchronization or
cleanup failed: the final object may exist. Do not treat that error as absence or
an acknowledgment of durability. Inspect and synchronize the exact stored object,
then reconcile its receipt before retrying or advertising it as durable.

Capture receipts pin the native CTRANSID in addition to UUID, origin and read-only
state. Generic tree Generation is observational: creating a writable clone can
advance it without changing the source contents. CTRANSID does not prove that the
read-only flag was never toggled, so protected host custody remains required.

The export receipt records SHA-256 and byte length plus the actual first stream
command's UUID and CTRANSID. The incremental parent pair is distinct from the
capture's origin UUID and local generation. Both stream transaction IDs are
checked against the selected capture receipts. Keep every required parent stream or
received immutable parent available until its dependents are retired. Native
receive is test-only in this slice; there is no arbitrary privileged stream
admission API. A digest and a receipt supplied by an untrusted party do not
authenticate a stream. Object-store transport, retention/GC and authenticated
restore admission remain future integration work.

## Verification

Run ordinary package checks from `components/workspace-snapshots`:

```sh
go test -race ./btrfs
go vet ./btrfs
```

The real test requires two explicitly prepared disposable Btrfs filesystems,
each mounted at its top-level subvolume. Two new 512 MiB image files are sufficient
for the fixture. The test creates and cleans up its own random private children;
it does not provision the images or mounts. Run with the native permissions
required for send and receive:

```sh
OCE_BTRFS_TEST_SOURCE=/absolute/source-mount \
OCE_BTRFS_TEST_RECEIVE=/absolute/receive-mount \
go test -v ./btrfs -run TestBtrfsRoundTrip -count=1
```

`OCE_BTRFS_BINARY` optionally selects the trusted executable; its default for the
test is `/usr/bin/btrfs`. Leaving both selectors unset skips the native test;
incomplete or unusable selection fails it. The test verifies real full/incremental receive,
content, ordinary modes, symlinks, hard links, native identity and writable clone
isolation, plus missing/duplicate parents, output bounds, cancellation, nested
subvolume/stub rejection and truncated-stream failure. Unit process fixtures only
test process bounds; they are not native filesystem evidence. This suite does not
qualify gVisor, Kubernetes, application barriers, every POSIX metadata feature,
power-loss recovery, or production deployment.

## Primary references

- [Btrfs subvolume semantics](https://btrfs.readthedocs.io/en/latest/btrfs-subvolume.html)
- [Btrfs send](https://btrfs.readthedocs.io/en/latest/btrfs-send.html)
- [Btrfs receive](https://btrfs.readthedocs.io/en/latest/btrfs-receive.html)
- [Native stream format](https://btrfs.readthedocs.io/en/latest/dev/dev-send-stream.html)
- [Linux Btrfs ioctl API](https://docs.kernel.org/filesystems/btrfs-ioctl.html)
- [gVisor filesystem overlays](https://gvisor.dev/docs/user_guide/filesystem/)
