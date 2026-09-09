// Package btrfs implements local immutable workspace capture through the host's
// Btrfs tools. Its operator owns provisioning, path custody and writer barriers.
package btrfs

import (
	"errors"
	"fmt"
	"time"
)

// PublicationUncertainError means the final name became visible but a later
// durability/cleanup step failed. Never infer absence from this error. The host
// must inspect the exact artifact, synchronize storage and reconcile its receipt
// before acknowledging local durability or retrying with the same identifier.
type PublicationUncertainError struct {
	Path  string
	Cause error
}

func (e *PublicationUncertainError) Error() string {
	return fmt.Sprintf("publication outcome uncertain at %s: %v", e.Path, e.Cause)
}
func (e *PublicationUncertainError) Unwrap() error { return e.Cause }

var (
	ErrUnsupported = errors.New("Btrfs snapshots require Linux and a provisioned Btrfs filesystem")
	ErrLimit       = errors.New("native command output exceeds configured limit")
)

// Config selects existing private host directories. Workloads may write within
// individual workspace subvolumes, but cannot mutate these directories or their
// ancestors. None of the snapshot or export directories may enter a workload.
// BinaryPath is an absolute path to the trusted installed btrfs executable.
type Config struct {
	BinaryPath     string
	WorkspaceRoot  string
	SnapshotRoot   string
	ExportRoot     string
	CommandTimeout time.Duration
	MaxStreamBytes int64
}

// Export describes one complete native artifact, stored under ExportRoot/ID.
// Parent UUID/CTRANSID identifies the exact receive dependency. It is different
// from a subvolume's snapshot-origin UUID and must be retained with the stream.
// SHA256 detects corruption; an untrusted receipt does not authenticate a stream.
type Export struct {
	Version          int    `json:"version"`
	Format           string `json:"format"`
	ID               string `json:"id"`
	SnapshotID       string `json:"snapshotId"`
	SnapshotUUID     string `json:"snapshotUuid"`
	SnapshotCTransID uint64 `json:"snapshotCtransid"`
	ParentSnapshotID string `json:"parentSnapshotId,omitempty"`
	ParentUUID       string `json:"parentUuid,omitempty"`
	ParentCTransID   uint64 `json:"parentCtransid,omitempty"`
	SHA256           string `json:"sha256"`
	Bytes            int64  `json:"bytes"`
	FileName         string `json:"fileName"`
}

// Workspace is a writable clone, deliberately distinct from an immutable capture.
type Workspace struct {
	WorkspaceID    string `json:"workspaceId"`
	NativeID       string `json:"nativeId"`
	NativeParentID string `json:"nativeParentId"`
	Generation     uint64 `json:"generation"`
	ReadOnly       bool   `json:"readOnly"`
}
