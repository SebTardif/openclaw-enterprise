# Workspace snapshot providers and portable state

Status: Implementing.

## Problem and selected implementation

Agent workspace files need immutable capture points that can be inspected,
exported incrementally, and restored into independent writable workspaces.
The first storage implementation uses host-managed Btrfs snapshots. A portable
content-addressed repository records complete logical filesystem roots while
sharing unchanged file content. VM disk backends can implement the same capture
boundary later without changing the portable snapshot identity model.

This is an additive host storage component under `components/workspace-snapshots`.
It does not create a new platform resource or run privileged filesystem commands
inside OCC. A trusted caller owns placement, exact workspace authorization, and
the action barrier. The initial executable is a local operator utility.

## Capture contract

A provider receives validated workspace and snapshot identifiers under configured
host-owned roots. It creates and verifies an immutable filesystem capture and
returns its backend identity. Snapshot creation, inspection, incremental native
export, and writable cloning are separate operations. Unsupported backends fail
explicitly; selecting a VM backend does not silently choose Btrfs.

The initial Btrfs provider must:

- Derive paths from validated identifiers and configured protected roots; avoid
  caller-supplied subprocess arguments and shell evaluation.
- Verify the actual filesystem, subvolume identity and read-only property.
- Reject unsupported nested subvolumes and descendant mounts.
- Keep snapshots, export staging and receive state outside workload mounts.
- Use bounded, cancellable native processes, fixed locale, bounded diagnostics
  and bounded stream output. Publish a complete verified artifact atomically.
- Keep full/incremental stream identities and required immutable parents
  explicit. A missing acknowledgment or partial export is not a usable artifact.
- Create a separate writable clone for continued execution.

A filesystem snapshot is not an application checkpoint. The integration caller
must exclude every workspace writer, including gateway and background writers,
and establish runtime-to-backing-store visibility before claiming an action
boundary. Private gVisor overlays must not hide workspace changes from capture.
Conversation/control state has separate owners and is not atomically committed
by a filesystem operation.

## Portable repository contract

The repository stores immutable SHA-256-addressed content and canonical metadata.
Each snapshot references a complete logical filesystem root and records optional
parent/action/history provenance. Unchanged content is shared. A path change
index can be derived by comparing roots; restoration does not replay every
parent delta. Explicitly version the supported metadata and chunking profile.

Capture must read a stable directory supplied by the capture provider or an
externally enforced no-writer boundary. It must not promise point-in-time
consistency for an arbitrary live directory. Repository/staging paths cannot be
inside the captured source. Errors and unsupported filesystem entries prevent
publication; limits apply to file count, content bytes, metadata, and restore.

Verify object hashes before use. Restore into a new protected destination, with
safe path handling and explicit supported file, directory and symlink semantics.
Retained snapshots protect all reachable objects. This slice does not implement
automatic garbage collection or claim cross-host durability from a local store.

## Delivery and verification

The first vertical slice provides the native component, an operator CLI, real
temporary-filesystem portable capture/diff/verify/restore tests, and an explicitly
selected real Btrfs full/incremental round-trip test. Missing native privileges
must be reported; substitute commands do not establish native behavior.

Later integration connects the provider to trusted node execution, Agent
storage provisioning, action barriers, mandatory audit/publication, object-store
transport, and user-facing session forks. Those integrations remain explicit
work after this standalone storage slice. Existing retained-volume recovery
continues to describe its own supported scope.

The living reference will be `docs/reference/workspace-snapshots.md` and records
actual source behavior, invocation, metadata limits and verification evidence.
