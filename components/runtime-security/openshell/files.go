package openshell

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

func absolutePath(path string) bool { return filepath.IsAbs(path) }

// Credentials may follow Kubernetes projected-volume symlinks, but the opened
// descriptor must be a bounded regular file. Nonblocking open prevents a FIFO
// from trapping a worker before that descriptor check. Operations have one
// deadline including setup; late file results cannot cause a late RPC.
func readCredential(ctx context.Context, path string, limit int64) ([]byte, error) {
	if err := contextFailure(ctx); err != nil {
		return nil, err
	}
	type result struct {
		content []byte
		err     error
	}
	finished := make(chan result, 1)
	go func() {
		file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
		if err != nil {
			finished <- result{err: &Error{Code: CodeCredentialRead}}
			return
		}
		defer file.Close()
		stop := context.AfterFunc(ctx, func() { file.Close() })
		defer stop()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
			finished <- result{err: &Error{Code: CodeCredentialRead}}
			return
		}
		content, err := io.ReadAll(io.LimitReader(file, limit+1))
		if err != nil || int64(len(content)) > limit {
			finished <- result{err: &Error{Code: CodeCredentialRead}}
			return
		}
		finished <- result{content: content}
	}()
	select {
	case <-ctx.Done():
		return nil, contextFailure(ctx)
	case read := <-finished:
		if err := contextFailure(ctx); err != nil {
			return nil, err
		}
		return read.content, read.err
	}
}
