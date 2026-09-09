package btrfs

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestBtrfsRoundTrip requires two explicitly provisioned disposable Btrfs mounts.
// It never formats, mounts or installs anything. The test owns only its random
// private child directories. This proves native storage, not a gVisor barrier.
func TestBtrfsRoundTrip(t *testing.T) {
	sourceMount, receiveMount := os.Getenv("OCE_BTRFS_TEST_SOURCE"), os.Getenv("OCE_BTRFS_TEST_RECEIVE")
	if sourceMount == "" && receiveMount == "" {
		t.Skip("set OCE_BTRFS_TEST_SOURCE and OCE_BTRFS_TEST_RECEIVE to disposable Btrfs mounts")
	}
	if sourceMount == "" || receiveMount == "" || sourceMount == receiveMount {
		t.Fatal("two distinct explicit Btrfs mounts required")
	}
	for _, mount := range []string{sourceMount, receiveMount} {
		if !filepath.IsAbs(mount) {
			t.Fatal("absolute test mount required")
		}
		if err := requireBtrfs(mount); err != nil {
			t.Fatal(err)
		}
	}
	bin := os.Getenv("OCE_BTRFS_BINARY")
	if bin == "" {
		bin = "/usr/bin/btrfs"
	}
	source, err := os.MkdirTemp(sourceMount, "oce-snapshot-test-")
	if err != nil {
		t.Fatal(err)
	}
	receive, err := os.MkdirTemp(receiveMount, "oce-snapshot-test-")
	if err != nil {
		_ = os.Remove(source)
		t.Fatal(err)
	}
	config := Config{BinaryPath: bin, WorkspaceRoot: filepath.Join(source, "workspaces"), SnapshotRoot: filepath.Join(source, "snapshots"), ExportRoot: filepath.Join(source, "exports"), CommandTimeout: 20 * time.Second, MaxStreamBytes: 32 << 20}
	for _, dir := range []string{config.WorkspaceRoot, config.SnapshotRoot, config.ExportRoot} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	b, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cleanTestTree(t, b, source); cleanTestTree(t, b, receive) })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	receiveUUID, err := b.filesystemID(ctx, receiveMount)
	if err != nil {
		t.Fatal(err)
	}
	if receiveUUID == b.filesystemUUID {
		t.Fatal("roundtrip requires independent filesystems")
	}
	native := func(args ...string) {
		t.Helper()
		if _, err := b.output(ctx, args...); err != nil {
			t.Fatal(err)
		}
	}
	workspace := filepath.Join(config.WorkspaceRoot, "work")
	native("subvolume", "create", workspace)
	large := make([]byte, 4<<20)
	if _, err := rand.Read(large); err != nil {
		t.Fatal(err)
	}
	write := func(path string, data []byte, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(path, data, mode); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(workspace, "large"), large, 0640)
	write(filepath.Join(workspace, "note"), []byte("before"), 0600)
	write(filepath.Join(workspace, "truncate"), []byte("abcdef"), 0600)
	write(filepath.Join(workspace, "delete"), []byte("remove me"), 0600)
	write(filepath.Join(workspace, "rename"), []byte("move me"), 0644)
	if err := os.Mkdir(filepath.Join(workspace, "dir"), 0750); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(workspace, "dir", "child"), []byte("linked"), 0600)
	if err := os.Link(filepath.Join(workspace, "dir", "child"), filepath.Join(workspace, "hardlink")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("dir/child", filepath.Join(workspace, "symlink")); err != nil {
		t.Fatal(err)
	}
	before := treeState(t, workspace)
	a, err := b.Capture(ctx, "work", "snapA")
	if err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(workspace, "note"), []byte("after"), 0600)
	if err := os.Truncate(filepath.Join(workspace, "truncate"), 2); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(workspace, "delete")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(workspace, "rename"), filepath.Join(workspace, "renamed")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(workspace, "note"), 0644); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(workspace, "added"), []byte("new"), 0600)
	after := treeState(t, workspace)
	captureB, err := b.Capture(ctx, "work", "snapB")
	if err != nil {
		t.Fatal(err)
	}
	pathA, err := b.SnapshotPath(ctx, "snapA")
	if err != nil {
		t.Fatal(err)
	}
	pathB, err := b.SnapshotPath(ctx, "snapB")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(treeState(t, pathA), before) || !reflect.DeepEqual(treeState(t, pathB), after) {
		t.Fatal("capture did not preserve the two filesystem states")
	}
	if !a.ReadOnly || !captureB.ReadOnly || a.NativeID == captureB.NativeID {
		t.Fatal("invalid capture identities")
	}
	full, err := b.Export(ctx, "snapA", "", "full")
	if err != nil {
		t.Fatal(err)
	}
	delta, err := b.Export(ctx, "snapB", "snapA", "delta")
	if err != nil {
		t.Fatal(err)
	}
	if delta.ParentUUID != full.SnapshotUUID || delta.ParentCTransID != full.SnapshotCTransID {
		t.Fatalf("delta parent does not identify exported full capture: %+v / %+v", full, delta)
	}
	if delta.Bytes >= full.Bytes {
		t.Fatal("incremental stream retransmitted unchanged large file")
	}
	// Receive only these backend-produced artifacts. The helper is test-private;
	// there is no API that accepts arbitrary privileged receive input.
	if _, err := receiveOwnExport(ctx, b, delta, receive); err == nil {
		t.Fatal("received an incremental stream without its parent")
	}
	receivedA, err := receiveOwnExport(ctx, b, full, receive)
	if err != nil {
		t.Fatal(err)
	}
	receivedB, err := receiveOwnExport(ctx, b, delta, receive)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(treeState(t, receivedA), before) || !reflect.DeepEqual(treeState(t, receivedB), after) {
		t.Fatal("received state differs from captured state")
	}
	left, _ := os.Stat(filepath.Join(receivedB, "hardlink"))
	right, _ := os.Stat(filepath.Join(receivedB, "dir", "child"))
	if left == nil || right == nil || !os.SameFile(left, right) {
		t.Fatal("native receive lost hard-link identity")
	}
	if _, err := receiveOwnExport(ctx, b, delta, receive); err == nil {
		t.Fatal("duplicate receive replaced existing state")
	}
	clone, err := b.Fork(ctx, "snapB", "fork")
	if err != nil {
		t.Fatal(err)
	}
	if clone.ReadOnly || clone.NativeParentID != captureB.NativeID {
		t.Fatal("fork is not an independent writable clone")
	}
	write(filepath.Join(config.WorkspaceRoot, "fork", "note"), []byte("fork change"), 0600)
	if !reflect.DeepEqual(treeState(t, pathB), after) {
		t.Fatal("fork changed immutable source")
	}
	// Forking may advance the readonly source's bookkeeping Generation. Its
	// UUID/CTRANSID still identifies the same content and must remain usable.
	if _, err := b.Fork(ctx, "snapB", "fork-two"); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Inspect(ctx, "snapB"); err != nil {
		t.Fatal(err)
	}
	exportedAfterFork, err := b.Export(ctx, "snapB", "snapA", "after-fork")
	if err != nil {
		t.Fatal(err)
	}
	if exportedAfterFork.SnapshotCTransID != delta.SnapshotCTransID || exportedAfterFork.ParentCTransID != delta.ParentCTransID {
		t.Fatal("fork changed the native content transaction identity")
	}
	// A writable clone on the receive filesystem also preserves both received
	// parents. This native qualification step is not a public restore operation.
	receivedFork := filepath.Join(receive, "fork")
	native("subvolume", "snapshot", receivedB, receivedFork)
	write(filepath.Join(receivedFork, "note"), []byte("received fork change"), 0600)
	if !reflect.DeepEqual(treeState(t, receivedA), before) || !reflect.DeepEqual(treeState(t, receivedB), after) {
		t.Fatal("received fork changed a readonly parent")
	}
	if _, err := b.Capture(ctx, "work", "snapA"); err == nil {
		t.Fatal("duplicate capture replaced original")
	}
	if _, err := b.Export(ctx, "snapB", "missing", "missing-parent"); err == nil {
		t.Fatal("exported missing parent")
	}
	if _, err := b.Export(ctx, "snapB", "snapA", "full"); err == nil {
		t.Fatal("duplicate export replaced original")
	}
	if _, err := b.Fork(ctx, "snapB", "fork"); err == nil {
		t.Fatal("duplicate fork replaced workspace")
	}
	limitedConfig := config
	limitedConfig.MaxStreamBytes = 64
	limited, err := New(limitedConfig)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := limited.Export(ctx, "snapA", "", "too-large"); !errors.Is(err, ErrLimit) {
		t.Fatalf("expected bounded stream failure, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(config.ExportRoot, "too-large")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("failed export published an artifact")
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, err := b.Capture(canceled, "work", "canceled"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled capture returned %v", err)
	}
	native("subvolume", "create", filepath.Join(workspace, "nested"))
	if _, err := b.Capture(ctx, "work", "nested-rejected"); err == nil {
		t.Fatal("captured unsupported nested subvolume")
	}
	// Snapshotting the unsupported layout turns its nested subvolume into an
	// inode-2 stub. Native send omits that directory, so this source is rejected.
	stubWorkspace := filepath.Join(config.WorkspaceRoot, "stub-work")
	native("subvolume", "snapshot", workspace, stubWorkspace)
	if _, err := b.Capture(ctx, "stub-work", "stub-rejected"); err == nil {
		t.Fatal("captured nested snapshot stub")
	}
	// Deliberately violate custody of an owned test snapshot, then reseal it.
	// The synchronized capture's pinned content transaction must reject mutation.
	if _, err := b.Capture(ctx, "fork", "tampered"); err != nil {
		t.Fatal(err)
	}
	tamperedPath, err := b.SnapshotPath(ctx, "tampered")
	if err != nil {
		t.Fatal(err)
	}
	native("property", "set", "-t", "s", tamperedPath, "ro", "false")
	write(filepath.Join(tamperedPath, "note"), []byte("unexpected snapshot mutation"), 0600)
	native("property", "set", "-t", "s", tamperedPath, "ro", "true")
	native("filesystem", "sync", config.SnapshotRoot)
	if _, err := b.Inspect(ctx, "tampered"); err == nil {
		t.Fatal("accepted modified and resealed capture")
	}
	// Truncation of our own stream must fail native receipt without publication.
	truncatedDir := filepath.Join(receive, "truncated")
	if err := os.Mkdir(truncatedDir, 0700); err != nil {
		t.Fatal(err)
	}
	in, err := os.Open(filepath.Join(config.ExportRoot, full.ID, full.FileName))
	if err != nil {
		t.Fatal(err)
	}
	truncated := filepath.Join(receive, "truncated.btrfs")
	out, err := os.OpenFile(truncated, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		in.Close()
		t.Fatal(err)
	}
	_, err = io.CopyN(out, in, full.Bytes/2)
	_ = out.Close()
	_ = in.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.output(ctx, "receive", "-f", truncated, truncatedDir); err == nil {
		t.Fatal("native receive accepted truncated stream")
	}
	if info, err := b.inspectSubvolume(ctx, filepath.Join(truncatedDir, "snapA")); err == nil && info.ReadOnly {
		t.Fatal("truncated receive created a usable readonly result")
	}
	for _, root := range []string{config.WorkspaceRoot, config.SnapshotRoot, config.ExportRoot} {
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".capture-") || strings.HasPrefix(entry.Name(), ".export-") || strings.HasPrefix(entry.Name(), ".fork-") {
				t.Fatalf("operation left staging %s", entry.Name())
			}
		}
	}
	t.Logf("native full=%d bytes delta=%d bytes; parent=%s/%d", full.Bytes, delta.Bytes, delta.ParentUUID, delta.ParentCTransID)
}

func receiveOwnExport(ctx context.Context, b *Backend, artifact Export, destination string) (string, error) {
	if !validID(artifact.ID) || !validID(artifact.SnapshotID) || artifact.FileName != "stream.btrfs" {
		return "", fmt.Errorf("invalid own export")
	}
	var stored Export
	artifactRoot := filepath.Join(b.config.ExportRoot, artifact.ID)
	if err := readJSON(filepath.Join(artifactRoot, "manifest.json"), &stored); err != nil {
		return "", err
	}
	if stored != artifact {
		return "", fmt.Errorf("own export receipt changed")
	}
	f, err := os.Open(filepath.Join(artifactRoot, artifact.FileName))
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(f, b.config.MaxStreamBytes+1))
	if err != nil {
		return "", err
	}
	if n != artifact.Bytes || fmt.Sprintf("%x", hash.Sum(nil)) != artifact.SHA256 {
		return "", fmt.Errorf("own export integrity failed")
	}
	final := filepath.Join(destination, artifact.SnapshotID)
	if err := absent(final); err != nil {
		return "", err
	}
	if artifact.ParentSnapshotID != "" {
		parent, err := b.inspectSubvolume(ctx, filepath.Join(destination, artifact.ParentSnapshotID))
		if err != nil {
			return "", err
		}
		if !parent.ReadOnly || parent.ReceivedUUID != artifact.ParentUUID || parent.SendTransID != artifact.ParentCTransID {
			return "", fmt.Errorf("wrong receive parent")
		}
	}
	if _, err := b.output(ctx, "receive", "-f", filepath.Join(artifactRoot, artifact.FileName), destination); err != nil {
		return "", err
	}
	if _, err := b.output(ctx, "filesystem", "sync", destination); err != nil {
		return "", err
	}
	got, err := b.inspectSubvolume(ctx, final)
	if err != nil {
		return "", err
	}
	if !got.ReadOnly || got.ReceivedUUID != artifact.SnapshotUUID || got.SendTransID != artifact.SnapshotCTransID {
		return "", fmt.Errorf("received identity not verified")
	}
	return final, nil
}

func treeState(t *testing.T, root string) map[string]string {
	t.Helper()
	state := make(map[string]string)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		value := fmt.Sprintf("%s:%o", info.Mode().Type(), info.Mode().Perm())
		switch {
		case info.Mode().IsRegular():
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			value += fmt.Sprintf(":%x", sha256.Sum256(data))
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			value += ":" + target
		}
		state[rel] = value
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func cleanTestTree(t *testing.T, b *Backend, root string) {
	t.Helper()
	var subvolumes []string
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Ino == 256 {
			subvolumes = append(subvolumes, path)
		}
		return nil
	})
	if err != nil {
		t.Errorf("test cleanup scan: %v", err)
		return
	}
	sort.Slice(subvolumes, func(i, j int) bool { return len(subvolumes[i]) > len(subvolumes[j]) })
	for _, path := range subvolumes {
		if _, err := b.output(context.Background(), "subvolume", "delete", path); err != nil {
			t.Errorf("test cleanup subvolume: %v", err)
			return
		}
	}
	if err := os.RemoveAll(root); err != nil {
		t.Errorf("test cleanup directory: %v", err)
	}
}
