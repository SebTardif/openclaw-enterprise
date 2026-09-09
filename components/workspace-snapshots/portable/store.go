// Package portable stores complete filesystem roots as verified, shared SHA-256
// objects. Capture requires an immutable source or an externally enforced writer
// barrier; mutation checks are diagnostics, not a point-in-time guarantee.
//
// Version 1 preserves regular files, directories, symlink target bytes and 0777
// permission bits. It rejects hardlinks, special files, special permission bits,
// extended attributes and ACLs. Ownership, timestamps, sparse allocation and
// symlink permissions are outside the explicitly named basic-posix-v1 profile.
// Capture metadata inspection currently requires Linux. The repository must be
// host-owned and inaccessible to workspace writers; mounts and ancestor renames
// remain the trusted host's responsibility. Cancellation is cooperative between
// bounded filesystem operations, not interruption of a blocked kernel operation.
package portable

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"

	snapshots "github.com/openclaw/openclaw-enterprise/components/workspace-snapshots"
)

const (
	FormatVersion   = 1
	ChunkSize       = 1 << 20
	ChunkingProfile = "fixed-1048576-sha256-v1"
	MetadataProfile = "basic-posix-v1"
	maxPathBytes    = 4096
	maxPathDepth    = 256
)

var (
	ErrLimit       = errors.New("snapshot limit exceeded")
	ErrUnsupported = errors.New("unsupported filesystem state")
	ErrCorrupt     = errors.New("corrupt snapshot repository")
	ErrConflict    = errors.New("snapshot identity conflict")
	ErrUnsafe      = errors.New("unsafe filesystem location")
	// ErrDurability means a complete object/reference was linked into place,
	// but its subsequent local directory synchronization was not acknowledged.
	ErrDurability = errors.New("publication committed but durability acknowledgment failed")
)

// Limits bound logical content and encoded metadata. MaxFiles counts every
// entry, including the root. Zero fields select 100000 entries, 10 GiB of file
// bytes and 64 MiB of combined tree, manifest and reference metadata.
type Limits struct {
	MaxFiles         int
	MaxBytes         int64
	MaxMetadataBytes int64
}

// Manifest names a complete root. Provenance is descriptive, and a parent is
// never required to verify or restore this root. Files includes the root entry.
type Manifest struct {
	Version         int                  `json:"version"`
	Chunking        string               `json:"chunking"`
	MetadataProfile string               `json:"metadataProfile"`
	Tree            string               `json:"tree"`
	Provenance      snapshots.Provenance `json:"provenance"`
	Files           int                  `json:"files"`
	Bytes           int64                `json:"bytes"`
}

// Change describes a path addition, deletion or modification. A rename is a
// deletion plus an addition. The root's path is ".".
type Change struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

// Store owns an open handle to a protected local repository. Methods may run
// concurrently; Close must run after all operations have completed. Unreferenced
// objects from interrupted captures are retained; garbage collection is absent.
type Store struct {
	root     *os.Root
	location string
	limits   Limits
}

type entry struct {
	Path   string   `json:"path"`
	Type   string   `json:"type"`
	Mode   uint32   `json:"mode"`
	Size   int64    `json:"size,omitempty"`
	Chunks []string `json:"chunks,omitempty"`
	Target []byte   `json:"target,omitempty"`
}

type tree struct {
	Version int     `json:"version"`
	Entries []entry `json:"entries"`
}

// Open creates or opens a private repository. Existing roots and internal
// directories must belong to the current user and deny group/other access.
// Repository paths containing symlink components are rejected.
func Open(root string, limits Limits) (*Store, error) {
	if err := supportedHost(); err != nil {
		return nil, err
	}
	if limits.MaxFiles < 0 || limits.MaxBytes < 0 || limits.MaxMetadataBytes < 0 {
		return nil, fmt.Errorf("%w: negative limit", ErrLimit)
	}
	if limits.MaxFiles == 0 {
		limits.MaxFiles = 100000
	}
	if limits.MaxBytes == 0 {
		limits.MaxBytes = 10 << 30
	}
	if limits.MaxMetadataBytes == 0 {
		limits.MaxMetadataBytes = 64 << 20
	}
	abs, err := absoluteNoLinks(root, true)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(abs, 0700); err != nil {
		return nil, err
	}
	r, err := os.OpenRoot(abs)
	if err != nil {
		return nil, err
	}
	s := &Store{root: r, location: abs, limits: limits}
	fail := func(err error) (*Store, error) { r.Close(); return nil, err }
	for _, dir := range []string{".", "chunks", "trees", "manifests", "snapshots", "staging"} {
		if dir != "." {
			if err := r.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
				return fail(err)
			}
		}
		info, err := r.Lstat(dir)
		if err != nil {
			return fail(err)
		}
		if !info.IsDir() || info.Mode().Perm()&0077 != 0 || !owned(info) {
			return fail(fmt.Errorf("%w: repository directory %q must be private and owned", ErrUnsafe, dir))
		}
	}
	return s, nil
}

func (s *Store) Close() error { return s.root.Close() }

func digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func validDigest(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func validID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for i, c := range value {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			continue
		}
		if i > 0 && (c == '-' || c == '_' || c == '.') {
			continue
		}
		return false
	}
	return true
}

func validateProvenance(p snapshots.Provenance) error {
	if !validID(p.WorkspaceID) || !validID(p.SnapshotID) || p.ParentSnapshotID != "" && (!validID(p.ParentSnapshotID) || p.ParentSnapshotID == p.SnapshotID) {
		return fmt.Errorf("%w: invalid provenance identifier", ErrUnsupported)
	}
	for _, value := range []string{p.ActionRef, p.HistoryRef, p.BaseImageDigest} {
		if len(value) > 4096 || !utf8.ValidString(value) {
			return fmt.Errorf("%w: invalid provenance field", ErrLimit)
		}
		for _, c := range value {
			if c < 32 || c == 127 {
				return fmt.Errorf("%w: control character in provenance", ErrUnsupported)
			}
		}
	}
	return nil
}

func validPath(value string) bool {
	return value != "" && len(value) <= maxPathBytes && utf8.ValidString(value) &&
		!strings.ContainsAny(value, "\\\x00") && !path.IsAbs(value) && path.Clean(value) == value &&
		value != ".." && !strings.HasPrefix(value, "../") && strings.Count(value, "/") < maxPathDepth
}

// absoluteNoLinks checks every existing component without resolving a symlink.
func absoluteNoLinks(name string, allowMissing bool) (string, error) {
	if name == "" {
		return "", fmt.Errorf("%w: empty path", ErrUnsafe)
	}
	abs, err := filepath.Abs(name)
	if err != nil {
		return "", err
	}
	current := string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(abs, current), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) && allowMissing {
			continue
		}
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", fmt.Errorf("%w: path component is not a real directory", ErrUnsafe)
		}
	}
	return abs, nil
}

func overlaps(a, b string) bool {
	return a == b || strings.HasPrefix(a, b+string(filepath.Separator)) || strings.HasPrefix(b, a+string(filepath.Separator)) || a == string(filepath.Separator) || b == string(filepath.Separator)
}

func canonicalDecode(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return fmt.Errorf("%w: invalid metadata: %v", ErrCorrupt, err)
	}
	canonical, err := json.Marshal(value)
	if err != nil || !bytes.Equal(canonical, data) {
		return fmt.Errorf("%w: noncanonical metadata", ErrCorrupt)
	}
	return nil
}

func (s *Store) readRegular(ctx context.Context, name string, limit int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := s.root.Lstat(name)
	if err != nil {
		return nil, fmt.Errorf("%w: missing object %s: %w", ErrCorrupt, name, err)
	}
	if !info.Mode().IsRegular() || info.Size() < 0 || info.Size() > limit {
		return nil, fmt.Errorf("%w: invalid object type or size: %s", ErrCorrupt, name)
	}
	f, err := s.root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(info, opened) || !opened.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: object changed", ErrCorrupt)
	}
	var out bytes.Buffer
	buf := make([]byte, 64<<10)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n, err := f.Read(buf)
		if int64(out.Len())+int64(n) > limit {
			return nil, fmt.Errorf("%w: object exceeds bound", ErrLimit)
		}
		out.Write(buf[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return out.Bytes(), nil
}

func (s *Store) readObject(ctx context.Context, kind, hash string, limit int64) ([]byte, error) {
	if !validDigest(hash) {
		return nil, fmt.Errorf("%w: invalid object digest", ErrCorrupt)
	}
	data, err := s.readRegular(ctx, kind+"/"+hash, limit)
	if err != nil {
		return nil, err
	}
	if digest(data) != hash {
		return nil, fmt.Errorf("%w: %s digest mismatch", ErrCorrupt, kind)
	}
	return data, nil
}

func writeAll(ctx context.Context, f *os.File, data []byte) error {
	for len(data) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		n := min(len(data), 64<<10)
		written, err := f.Write(data[:n])
		if err != nil {
			return err
		}
		if written != n {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return ctx.Err()
}

// publish links a fully written regular file into place without replacing any
// existing name. A conflicting object/ref is an error; identical data is safe.
func (s *Store) publish(ctx context.Context, name string, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	staged := "staging/" + hex.EncodeToString(random[:])
	f, err := s.root.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer s.root.Remove(staged)
	if err = writeAll(ctx, f, data); err == nil {
		err = f.Chmod(0400)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = s.root.Link(staged, name); errors.Is(err, os.ErrExist) {
		existing, readErr := s.readRegular(ctx, name, int64(len(data)))
		if readErr != nil {
			return fmt.Errorf("%w: existing publication: %w", ErrConflict, readErr)
		}
		if !bytes.Equal(existing, data) {
			return fmt.Errorf("%w: existing publication differs", ErrConflict)
		}
		err = nil
	}
	if err != nil {
		return err
	}
	// File and directory sync strengthen local crash consistency; this is not
	// a cross-host durability or replicated acknowledgment guarantee.
	dir, err := s.root.Open(path.Dir(name))
	if err != nil {
		return fmt.Errorf("%w: %w", ErrDurability, err)
	}
	syncErr := dir.Sync()
	closeErr = dir.Close()
	if syncErr != nil {
		return fmt.Errorf("%w: %w", ErrDurability, syncErr)
	}
	if closeErr != nil {
		return fmt.Errorf("%w: %w", ErrDurability, closeErr)
	}
	return nil
}

func (s *Store) putObject(ctx context.Context, kind string, data []byte) (string, error) {
	hash := digest(data)
	return hash, s.publish(ctx, kind+"/"+hash, data)
}
