//go:build !linux

package btrfs

import (
	"context"
	snapshots "github.com/openclaw/openclaw-enterprise/components/workspace-snapshots"
)

type Backend struct{}

func New(Config) (*Backend, error) { return nil, ErrUnsupported }
func (*Backend) Capture(context.Context, string, string) (snapshots.Capture, error) {
	return snapshots.Capture{}, ErrUnsupported
}
func (*Backend) Inspect(context.Context, string) (snapshots.Capture, error) {
	return snapshots.Capture{}, ErrUnsupported
}
func (*Backend) SnapshotPath(context.Context, string) (string, error) { return "", ErrUnsupported }
func (*Backend) Export(context.Context, string, string, string) (Export, error) {
	return Export{}, ErrUnsupported
}
func (*Backend) Fork(context.Context, string, string) (Workspace, error) {
	return Workspace{}, ErrUnsupported
}
