package btrfs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	snapshots "github.com/openclaw/openclaw-enterprise/components/workspace-snapshots"
)

const btrfsMagic = 0x9123683e

type Backend struct {
	config         Config
	roots          map[string]os.FileInfo
	binary         os.FileInfo
	filesystemUUID string
}

var _ snapshots.CaptureProvider = (*Backend)(nil)

type snapshotReceipt struct {
	Version  int               `json:"version"`
	Capture  snapshots.Capture `json:"capture"`
	CTransID uint64            `json:"ctransid"`
}

type subvolume struct {
	UUID, ParentUUID, ReceivedUUID    string
	Generation, CTransID, SendTransID uint64
	ReadOnly                          bool
}

func New(config Config) (*Backend, error) {
	if config.CommandTimeout <= 0 || config.CommandTimeout > time.Hour || config.MaxStreamBytes <= 0 {
		return nil, fmt.Errorf("positive stream limit and command timeout up to one hour required")
	}
	b := &Backend{config: config, roots: make(map[string]os.FileInfo)}
	for _, path := range []string{config.WorkspaceRoot, config.SnapshotRoot, config.ExportRoot} {
		info, err := privateDirectory(path)
		if err != nil {
			return nil, err
		}
		for existing := range b.roots {
			if pathInside(path, existing) || pathInside(existing, path) {
				return nil, fmt.Errorf("provider roots must be separate directories")
			}
		}
		b.roots[path] = info
	}
	if !filepath.IsAbs(config.BinaryPath) || filepath.Clean(config.BinaryPath) != config.BinaryPath {
		return nil, fmt.Errorf("absolute executable path required")
	}
	info, err := os.Lstat(config.BinaryPath)
	if err != nil {
		return nil, err
	}
	b.binary = info
	if err := b.checkBinary(); err != nil {
		return nil, err
	}
	for _, path := range []string{config.WorkspaceRoot, config.SnapshotRoot} {
		if err := requireBtrfs(path); err != nil {
			return nil, err
		}
		uuid, err := b.filesystemID(context.Background(), path)
		if err != nil {
			return nil, err
		}
		if b.filesystemUUID != "" && b.filesystemUUID != uuid {
			return nil, fmt.Errorf("workspace and snapshots require the same Btrfs filesystem")
		}
		b.filesystemUUID = uuid
	}
	return b, nil
}

func privateDirectory(path string) (os.FileInfo, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, fmt.Errorf("canonical absolute root required")
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil || canonical != path {
		return nil, fmt.Errorf("provider directory cannot contain symlinks: %s", path)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode().Perm()&0077 != 0 || int(st.Uid) != os.Geteuid() {
		return nil, fmt.Errorf("provider directory must be private and owned by the invoking host user: %s", path)
	}
	return info, nil
}

func (b *Backend) checkBinary() error {
	info, err := os.Lstat(b.config.BinaryPath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 || info.Mode().Perm()&0022 != 0 || !os.SameFile(info, b.binary) {
		return fmt.Errorf("trusted Btrfs executable changed or has unsafe permissions")
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || (st.Uid != 0 && int(st.Uid) != os.Geteuid()) {
		return fmt.Errorf("Btrfs executable must belong to root or the invoking host user")
	}
	return nil
}

func (b *Backend) checkRoots() error {
	for path, original := range b.roots {
		info, err := privateDirectory(path)
		if err != nil {
			return err
		}
		if !os.SameFile(info, original) {
			return fmt.Errorf("provider root changed")
		}
	}
	for _, path := range []string{b.config.WorkspaceRoot, b.config.SnapshotRoot} {
		if err := requireBtrfs(path); err != nil {
			return err
		}
	}
	return nil
}

func requireBtrfs(path string) error {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return err
	}
	if uint64(stat.Type) != btrfsMagic {
		return ErrUnsupported
	}
	return nil
}

// lock serializes publication across independent CLI invocations. Waiting is
// cancellable; it does not turn a captured writer-barrier assertion into proof.
func (b *Backend) lock(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := b.checkRoots(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(b.config.SnapshotRoot, ".provider-lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		f.Close()
		return nil, fmt.Errorf("invalid provider lock")
	}
	for {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			f.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	if err := b.checkRoots(); err != nil {
		f.Close()
		return nil, err
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}

func pathInside(path, root string) bool {
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}

func absent(path string) error {
	_, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err == nil {
		return fmt.Errorf("destination already exists: %s", path)
	}
	return err
}

func noDescendantMounts(data []byte, path string) error {
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 7 {
			return fmt.Errorf("invalid host mount table")
		}
		mount, err := unescapeMount(fields[4])
		if err != nil {
			return err
		}
		if pathInside(mount, path) {
			return fmt.Errorf("workspace scope includes a mount: %s", mount)
		}
	}
	return nil
}

func unescapeMount(value string) (string, error) {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		if value[i] != '\\' {
			out.WriteByte(value[i])
			continue
		}
		if i+3 >= len(value) {
			return "", fmt.Errorf("invalid mount escape")
		}
		part := value[i : i+4]
		switch part {
		case `\040`:
			out.WriteByte(' ')
		case `\011`:
			out.WriteByte('\t')
		case `\012`:
			out.WriteByte('\n')
		case `\134`:
			out.WriteByte('\\')
		default:
			return "", fmt.Errorf("invalid mount escape")
		}
		i += 3
	}
	return out.String(), nil
}

func (b *Backend) verifyScope(ctx context.Context, path string) error {
	data, err := readLimitedFile("/proc/self/mountinfo", 4<<20)
	if err != nil {
		return err
	}
	if err := noDescendantMounts(data, path); err != nil {
		return err
	}
	if err := rejectSnapshotStubs(ctx, path); err != nil {
		return err
	}
	uuid, err := b.filesystemID(ctx, path)
	if err != nil {
		return err
	}
	if uuid != b.filesystemUUID {
		return fmt.Errorf("source filesystem changed")
	}
	return nil
}

func (b *Backend) Capture(ctx context.Context, workspaceID, snapshotID string) (result snapshots.Capture, err error) {
	if !validID(workspaceID) || !validID(snapshotID) {
		return result, fmt.Errorf("invalid workspace or snapshot ID")
	}
	unlock, err := b.lock(ctx)
	if err != nil {
		return result, err
	}
	defer unlock()
	source := filepath.Join(b.config.WorkspaceRoot, workspaceID)
	parent, err := b.inspectSubvolume(ctx, source)
	if err != nil {
		return result, err
	}
	if err := b.verifyScope(ctx, source); err != nil {
		return result, err
	}
	final := filepath.Join(b.config.SnapshotRoot, snapshotID)
	if err := absent(final); err != nil {
		return result, err
	}
	stage, err := os.MkdirTemp(b.config.SnapshotRoot, ".capture-")
	if err != nil {
		return result, err
	}
	native := filepath.Join(stage, snapshotID)
	defer func() {
		if stage != "" {
			err = joinedError(err, b.cleanupNative(stage, native))
		}
	}()
	if _, err = b.output(ctx, "subvolume", "snapshot", "-r", source, native); err != nil {
		return result, err
	}
	if _, err = b.output(ctx, "filesystem", "sync", b.config.SnapshotRoot); err != nil {
		return result, err
	}
	observed, err := b.inspectSubvolume(ctx, native)
	if err != nil {
		return result, err
	}
	if !observed.ReadOnly || observed.ParentUUID != parent.UUID || observed.ReceivedUUID != "" {
		return result, fmt.Errorf("unexpected captured subvolume identity")
	}
	// A mount/subvolume may have changed after the first preflight. The caller's
	// mount and writer barrier must remain held through this second observation.
	if err = b.verifyScope(ctx, source); err != nil {
		return result, err
	}
	result = snapshots.Capture{Backend: "btrfs", WorkspaceID: workspaceID, SnapshotID: snapshotID, NativeID: observed.UUID, NativeParentID: observed.ParentUUID, Generation: observed.Generation, ReadOnly: true}
	if err = writeJSON(filepath.Join(stage, "capture.json"), snapshotReceipt{Version: 1, Capture: result, CTransID: observed.CTransID}); err != nil {
		return result, err
	}
	if err = publishDirectory(ctx, stage, final); err != nil {
		return result, err
	}
	stage = ""
	return result, nil
}

func (b *Backend) Inspect(ctx context.Context, snapshotID string) (snapshots.Capture, error) {
	unlock, err := b.lock(ctx)
	if err != nil {
		return snapshots.Capture{}, err
	}
	defer unlock()
	return b.inspect(ctx, snapshotID)
}

func (b *Backend) inspectReceipt(ctx context.Context, snapshotID string) (snapshotReceipt, error) {
	var receipt snapshotReceipt
	if !validID(snapshotID) {
		return receipt, fmt.Errorf("invalid snapshot ID")
	}
	dir := filepath.Join(b.config.SnapshotRoot, snapshotID)
	if _, err := privateDirectory(dir); err != nil {
		return receipt, err
	}
	if err := readJSON(filepath.Join(dir, "capture.json"), &receipt); err != nil {
		return receipt, err
	}
	c := receipt.Capture
	if receipt.Version != 1 || receipt.CTransID == 0 || c.Backend != "btrfs" || c.SnapshotID != snapshotID || !validID(c.WorkspaceID) || !c.ReadOnly || c.ReceivedID != "" {
		return receipt, fmt.Errorf("invalid capture receipt")
	}
	native := filepath.Join(dir, snapshotID)
	observed, err := b.inspectSubvolume(ctx, native)
	if err != nil {
		return receipt, err
	}
	if !observed.ReadOnly || observed.UUID != c.NativeID || observed.ParentUUID != c.NativeParentID || observed.CTransID != receipt.CTransID || observed.ReceivedUUID != "" {
		return receipt, fmt.Errorf("stored capture identity changed")
	}
	if err := b.verifyScope(ctx, native); err != nil {
		return receipt, err
	}
	// Generic tree Generation may advance when this immutable source is forked.
	// The separately pinned CTRANSID changes with logical content updates.
	receipt.Capture.Generation = observed.Generation
	return receipt, nil
}

func (b *Backend) inspect(ctx context.Context, snapshotID string) (snapshots.Capture, error) {
	receipt, err := b.inspectReceipt(ctx, snapshotID)
	return receipt.Capture, err
}

// SnapshotPath returns an inspected immutable source for the portable exporter.
// The provider has no deletion/GC operation; the operator must retain custody
// while a consumer reads it. The path is not itself authorization evidence.
func (b *Backend) SnapshotPath(ctx context.Context, snapshotID string) (string, error) {
	if _, err := b.Inspect(ctx, snapshotID); err != nil {
		return "", err
	}
	return filepath.Join(b.config.SnapshotRoot, snapshotID, snapshotID), nil
}

func (b *Backend) Export(ctx context.Context, snapshotID, parentSnapshotID, exportID string) (result Export, err error) {
	if !validID(exportID) || (parentSnapshotID != "" && (!validID(parentSnapshotID) || parentSnapshotID == snapshotID)) {
		return result, fmt.Errorf("invalid export or parent ID")
	}
	unlock, err := b.lock(ctx)
	if err != nil {
		return result, err
	}
	defer unlock()
	selected, err := b.inspectReceipt(ctx, snapshotID)
	if err != nil {
		return result, err
	}
	capture := selected.Capture
	var parent snapshots.Capture
	var parentReceipt snapshotReceipt
	if parentSnapshotID != "" {
		parentReceipt, err = b.inspectReceipt(ctx, parentSnapshotID)
		parent = parentReceipt.Capture
		if err != nil {
			return result, err
		}
		if parent.WorkspaceID != capture.WorkspaceID {
			return result, fmt.Errorf("incremental parent must belong to the same workspace")
		}
	}
	final := filepath.Join(b.config.ExportRoot, exportID)
	if err = absent(final); err != nil {
		return result, err
	}
	stage, err := os.MkdirTemp(b.config.ExportRoot, ".export-")
	if err != nil {
		return result, err
	}
	defer func() {
		if stage != "" {
			err = joinedError(err, os.RemoveAll(stage))
		}
	}()
	f, err := os.OpenFile(filepath.Join(stage, "stream.btrfs"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return result, err
	}
	defer f.Close()
	hash := sha256.New()
	args := []string{"send", "--proto", "1"}
	if parentSnapshotID != "" {
		args = append(args, "-p", filepath.Join(b.config.SnapshotRoot, parentSnapshotID, parentSnapshotID))
	}
	args = append(args, filepath.Join(b.config.SnapshotRoot, snapshotID, snapshotID))
	if err = b.command(ctx, io.MultiWriter(f, hash), b.config.MaxStreamBytes, args...); err != nil {
		return result, err
	}
	if err = f.Sync(); err != nil {
		return result, err
	}
	info, err := f.Stat()
	if err != nil {
		return result, err
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return result, err
	}
	identity, err := readStreamIdentity(f)
	if err != nil {
		return result, err
	}
	if identity.CTransID != selected.CTransID || identity.ParentCTransID != parentReceipt.CTransID || identity.Path != snapshotID || identity.UUID != capture.NativeID || identity.ParentUUID != parent.NativeID || (parentSnapshotID == "" && identity.ParentCTransID != 0) {
		return result, fmt.Errorf("export stream identity differs from selected captures")
	}
	if _, err = b.inspect(ctx, snapshotID); err != nil {
		return result, err
	}
	if parentSnapshotID != "" {
		if _, err = b.inspect(ctx, parentSnapshotID); err != nil {
			return result, err
		}
	}
	result = Export{Version: 1, Format: "btrfs-send-v1", ID: exportID, SnapshotID: snapshotID, SnapshotUUID: identity.UUID, SnapshotCTransID: identity.CTransID, ParentSnapshotID: parentSnapshotID, ParentUUID: identity.ParentUUID, ParentCTransID: identity.ParentCTransID, SHA256: fmt.Sprintf("%x", hash.Sum(nil)), Bytes: info.Size(), FileName: "stream.btrfs"}
	if err = f.Close(); err != nil {
		return result, err
	}
	if err = writeJSON(filepath.Join(stage, "manifest.json"), result); err != nil {
		return result, err
	}
	if err = publishDirectory(ctx, stage, final); err != nil {
		return result, err
	}
	stage = ""
	return result, nil
}

func (b *Backend) Fork(ctx context.Context, snapshotID, workspaceID string) (result Workspace, err error) {
	if !validID(workspaceID) {
		return result, fmt.Errorf("invalid workspace ID")
	}
	unlock, err := b.lock(ctx)
	if err != nil {
		return result, err
	}
	defer unlock()
	capture, err := b.inspect(ctx, snapshotID)
	if err != nil {
		return result, err
	}
	final := filepath.Join(b.config.WorkspaceRoot, workspaceID)
	if err = absent(final); err != nil {
		return result, err
	}
	stage, err := os.MkdirTemp(b.config.WorkspaceRoot, ".fork-")
	if err != nil {
		return result, err
	}
	native := filepath.Join(stage, workspaceID)
	defer func() {
		if stage != "" {
			err = joinedError(err, b.cleanupNative(stage, native))
		}
	}()
	if _, err = b.output(ctx, "subvolume", "snapshot", filepath.Join(b.config.SnapshotRoot, snapshotID, snapshotID), native); err != nil {
		return result, err
	}
	if _, err = b.output(ctx, "filesystem", "sync", b.config.WorkspaceRoot); err != nil {
		return result, err
	}
	observed, err := b.inspectSubvolume(ctx, native)
	if err != nil {
		return result, err
	}
	if observed.ReadOnly || observed.ParentUUID != capture.NativeID {
		return result, fmt.Errorf("unexpected writable clone identity")
	}
	if _, err = b.inspect(ctx, snapshotID); err != nil {
		return result, err
	}
	if err = ctx.Err(); err != nil {
		return result, err
	}
	if err = renameNoReplace(native, final); err != nil {
		return result, err
	}
	if err = syncDirectory(b.config.WorkspaceRoot); err != nil {
		return result, &PublicationUncertainError{Path: final, Cause: err}
	}
	if err = os.Remove(stage); err != nil {
		return result, &PublicationUncertainError{Path: final, Cause: err}
	}
	stage = ""
	return Workspace{WorkspaceID: workspaceID, NativeID: observed.UUID, NativeParentID: observed.ParentUUID, Generation: observed.Generation, ReadOnly: false}, nil
}

func (b *Backend) cleanupNative(stage, native string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := b.checkRoots(); err != nil {
		return err
	}
	if _, err := os.Lstat(native); err == nil {
		if _, err := b.output(ctx, "subvolume", "delete", native); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Only ordinary staging metadata remains after the native subvolume is gone.
	return os.RemoveAll(stage)
}

func readLimitedFile(path string, limit int64) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("regular metadata file required")
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, ErrLimit
	}
	return data, nil
}

func readJSON(path string, out any) error {
	data, err := readLimitedFile(path, 16384)
	if err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return err
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return fmt.Errorf("trailing metadata")
	}
	return nil
}

func writeJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func syncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func publishDirectory(ctx context.Context, stage, final string) error {
	if err := syncDirectory(stage); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := absent(final); err != nil {
		return err
	}
	if err := renameNoReplace(stage, final); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(final)); err != nil {
		return &PublicationUncertainError{Path: final, Cause: err}
	}
	return nil
}
