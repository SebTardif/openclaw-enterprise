package btrfs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"
)

type limitedOutput struct {
	dst       io.Writer
	remaining int64
	cancel    context.CancelFunc
	exceeded  bool
}

func (w *limitedOutput) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		w.exceeded = true
		w.cancel()
		return 0, ErrLimit
	}
	n, err := w.dst.Write(p)
	w.remaining -= int64(n)
	if err != nil {
		w.cancel()
	}
	return n, err
}

func (b *Backend) command(ctx context.Context, dst io.Writer, limit int64, args ...string) error {
	if err := b.checkBinary(); err != nil {
		return err
	}
	return runCommand(ctx, b.config.BinaryPath, b.config.CommandTimeout, dst, limit, args...)
}

// runCommand bounds both pipes and reaps the actual native child on cancellation.
// No shell or caller-controlled environment is involved.
func runCommand(ctx context.Context, binary string, timeout time.Duration, dst io.Writer, limit int64, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = []string{"LC_ALL=C", "LANG=C", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"}
	cmd.WaitDelay = 2 * time.Second
	var diagnostic bytes.Buffer
	out := &limitedOutput{dst: dst, remaining: limit, cancel: cancel}
	errout := &limitedOutput{dst: &diagnostic, remaining: 8192, cancel: cancel}
	cmd.Stdout, cmd.Stderr = out, errout
	err := cmd.Run()
	if out.exceeded || errout.exceeded {
		return ErrLimit
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err != nil {
		// Native output is bounded and contains diagnostics, never file content.
		return fmt.Errorf("native command failed: %w: %s", err, diagnostic.String())
	}
	return nil
}

func (b *Backend) output(ctx context.Context, args ...string) ([]byte, error) {
	var out bytes.Buffer
	err := b.command(ctx, &out, 65536, args...)
	return out.Bytes(), err
}

func joinedError(original, cleanup error) error {
	if cleanup == nil {
		return original
	}
	return errors.Join(original, fmt.Errorf("operation staging cleanup failed: %w", cleanup))
}
