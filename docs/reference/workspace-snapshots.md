# Workspace snapshots

The native `components/workspace-snapshots` module provides a local host storage
utility. It captures and inspects Btrfs snapshots, exports full or incremental
native streams, creates writable workspace clones, and stores supported files in
a portable content-addressed repository.

This is a standalone storage component. Automatic model/tool action hooks,
OCC authorization and publication, Kubernetes provisioning, remote object-store
transport, native session restoration and VM storage providers remain separate
integration work. The current ComputeDriver does not automatically invoke it.

## Ownership and consistency

The operator provisions protected workspace, snapshot and export roots. The
snapshot provider derives paths from bounded identifiers; clients do not supply
native command arguments. The source must already be a Btrfs subvolume, and its
snapshot destination must be on the same Btrfs filesystem. Snapshot and export
roots are private host state and must not be mounted into agent workloads.

The caller must establish an action boundary before making an application
checkpoint claim: exclude all workspace writers, including gateway and background
processes, and establish visibility through the actual sandbox mount. A gVisor
overlay above the host directory can retain changes that the host cannot capture.
Neither a Btrfs snapshot nor an action-reference string proves that barrier.

The provider returns verified read-only filesystem observations. Conversation
history and control records remain separate stores. Unknown external tool
outcomes remain unknown after a filesystem snapshot or fork.

## Build and prerequisites

Build from the repository root with the Go version selected by the module:

```sh
go -C components/workspace-snapshots build -o ./bin/oce-workspace-snapshot ./cmd/oce-workspace-snapshot
```

The executable is `components/workspace-snapshots/bin/oce-workspace-snapshot`.
The initial utility requires Linux, including portable metadata inspection.
The Btrfs backend supports amd64 and arm64, requires the Btrfs tools,
pre-provisioned supported filesystems, and permission for the selected operations. It does not
format devices or mount filesystems. Native receive is a controlled integration
test operation; the CLI does not accept arbitrary streams for privileged receive.

## Commands

Commands return JSON on success and a nonzero status on failure. Replace the
illustrative host roots with the exact operator-provisioned locations:

```sh
components/workspace-snapshots/bin/oce-workspace-snapshot capture \
  --workspace-root /var/lib/openclaw/workspaces \
  --snapshot-root /var/lib/openclaw/snapshots \
  --export-root /var/lib/openclaw/exports \
  --workspace workspace-a --snapshot snapshot-a
```

The native root flags are required by `capture`, `inspect`, `export`,
`native-export` and `fork`. `--btrfs-binary` selects the trusted executable
(default `/usr/bin/btrfs`); `--timeout` and `--max-stream-bytes` bound native work.

| Command         | Additional arguments                              | Result                                                                |
| --------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `capture`       | `--workspace`, `--snapshot`                       | Verified read-only capture under the protected snapshot root          |
| `inspect`       | `--snapshot`                                      | Revalidated backend identity and read-only state                      |
| `export`        | `--snapshot`, `--repository`; optional `--parent` | Portable snapshot from an inspected immutable Btrfs source            |
| `native-export` | `--snapshot`, `--export-id`; optional `--parent`  | Complete native stream and receipt; parent selects incremental export |
| `fork`          | `--snapshot`, `--workspace`                       | New independently writable Btrfs workspace                            |
| `verify`        | `--repository`, `--snapshot`                      | Verified portable manifest and all referenced content                 |
| `diff`          | `--repository`, `--before`, `--after`             | Added/deleted/modified paths; renames appear as delete plus add       |
| `restore`       | `--repository`, `--snapshot`, `--destination`     | Reconstructed supported state in a new destination                    |

Portable export accepts descriptive `--action-ref`, `--history-ref` and
`--base-image-digest` fields. These preserve correlation supplied by the caller;
they do not grant authority or prove a completed action.

Portable restore requires no running agent or source workspace:

```sh
components/workspace-snapshots/bin/oce-workspace-snapshot restore \
  --repository /var/lib/openclaw/portable \
  --snapshot snapshot-a \
  --destination /var/lib/openclaw/restored-workspace
```

The destination must not already exist. Restore reserves and populates a new
directory; callers must not expose it to workloads until success. Restored
ownership belongs to the restoring process under the basic metadata profile;
workload activation must apply its separately authorized ownership policy.

## Portable format and limits

Format V1 stores fixed 1 MiB chunks identified by SHA-256. A deterministic flat
tree records paths, entry types, ordinary permissions and content references.
The tree and manifest are also content-addressed. A snapshot reference is
published only after its required objects are complete. Conflicting reuse of an
existing snapshot identifier is rejected.

Each tree describes the complete supported filesystem. Unchanged chunks are
shared across snapshots, and restoration needs only the selected tree's reachable
objects; it does not replay parent patches. Parent IDs record lineage. Local
retention is explicit: automatic garbage collection and remote archive transport
are not implemented by this module.

The basic profile preserves regular-file bytes, directories, symlinks and ordinary
permission bits. Hard links, special file types and special mode bits are
rejected. Ownership, timestamps, ACLs and extended attributes are outside this
profile; detected xattrs are rejected. This profile is not a full POSIX or VM
backup. Source files must be stable throughout capture, and the repository must
not be inside the source tree.

The Go repository API accepts finite `Limits` for entry count, logical content
bytes and encoded metadata. Zero values select defaults: 100,000 entries,
10 GiB logical content and 64 MiB encoded metadata. Paths are bounded to
4,096 bytes and 256 components. Fixed chunking can amplify changed data after
insertions; content-defined chunking and shared directory subtrees are future
format extensions.

## Native stream dependencies

Native export uses Btrfs send protocol V1 and records its digest, byte length,
actual stream identity and any required parent identity. Native stream
UUID/CTRANSID are distinct from local subvolume generation and creation metadata.
Creating a fork can advance the source generation without changing its contents;
capture receipts therefore pin CTRANSID and UUID while reporting generation as
an observation.
All participating snapshots remain read-only. Receivers need the exact native
parent state; losing that state cannot be repaired by a successful-looking
filename or by an unrelated portable snapshot with the same label.

Native snapshots and export artifacts are published in separate protected
directories. Incomplete command/export state does not become a completed receipt.
Cancellation, limits, subprocess errors, unsupported nested state, identity
changes and read-only-state failures return errors. A native
`PublicationUncertainError` or portable `ErrDurability` can occur after a complete
artifact becomes visible but its subsequent synchronization was not acknowledged.
Inspect and reconcile that exact artifact before retrying or acknowledging it. Native snapshots on local
storage do not protect against loss of that storage.

## Verification

Run the actual Go package tests, CLI composition tests and vet:

```sh
go -C components/workspace-snapshots test -race ./...
go -C components/workspace-snapshots vet ./...
```

The portable tests use real temporary files and restore after changing/removing
the source. Native Btrfs qualification is explicitly selected:

```sh
OCE_BTRFS_TEST_SOURCE=/path/to/disposable/source-mount \
OCE_BTRFS_TEST_RECEIVE=/path/to/disposable/receive-mount \
go -C components/workspace-snapshots test -v ./btrfs -run TestBtrfsRoundTrip -count=1
```

Both paths must be explicitly allocated Btrfs test mounts at the top-level
subvolume. The test operates on its own children. Missing selectors skip native
qualification; a selected but invalid environment must fail. Preparing these
mounts is a separate operator action and must use disposable storage.

Local qualification on Linux 6.8.0 with Btrfs tools 6.6.3 passed full/incremental
receive, repeated fork/inspect/export, and modified-snapshot rejection. The
composed CLI also restored both portable states after deleting the original
workspace. These checks used two disposable 512 MiB Btrfs images.

This test establishes the filesystem backend only. gVisor mount visibility,
multi-writer action barriers, remote durability, Kubernetes placement and full
session recovery require their own integrated evidence.

## Design references

The [implementation specification](../../specs/workspace-snapshots.md) records
the selected slice. Primary references are [Btrfs subvolumes](https://btrfs.readthedocs.io/en/latest/btrfs-subvolume.html),
[Btrfs send](https://btrfs.readthedocs.io/en/latest/btrfs-send.html),
[gVisor filesystems](https://gvisor.dev/docs/user_guide/filesystem/), and
[QEMU incremental backup](https://www.qemu.org/docs/master/interop/bitmaps.html).
