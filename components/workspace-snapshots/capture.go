// Package snapshots defines the storage boundary for immutable workspace captures.
// Callers remain responsible for authorization and application writer barriers.
package snapshots

import "context"

// Capture is a filesystem observation, not proof of an application checkpoint.
// NativeID is a backend-owned identity, independent of its current host path.
// Generation is a local observation and is not a native send-stream transaction ID.
type Capture struct {
	Backend        string `json:"backend"`
	WorkspaceID    string `json:"workspaceId"`
	SnapshotID     string `json:"snapshotId"`
	NativeID       string `json:"nativeId"`
	NativeParentID string `json:"nativeParentId,omitempty"`
	ReceivedID     string `json:"receivedId,omitempty"`
	Generation     uint64 `json:"generation"`
	ReadOnly       bool   `json:"readOnly"`
}

// CaptureProvider owns immutable filesystem captures under trusted host roots.
// It must inspect actual stored state before returning success. Implementations
// may provide additional native export and writable-clone operations.
type CaptureProvider interface {
	Capture(ctx context.Context, workspaceID, snapshotID string) (Capture, error)
	Inspect(ctx context.Context, snapshotID string) (Capture, error)
}

// Provenance supplies descriptive correlation fields. It is never authorization
// evidence and does not prove that all writers stopped at the named action.
type Provenance struct {
	WorkspaceID      string `json:"workspaceId"`
	SnapshotID       string `json:"snapshotId"`
	ParentSnapshotID string `json:"parentSnapshotId,omitempty"`
	ActionRef        string `json:"actionRef,omitempty"`
	HistoryRef       string `json:"historyRef,omitempty"`
	BaseImageDigest  string `json:"baseImageDigest,omitempty"`
}
