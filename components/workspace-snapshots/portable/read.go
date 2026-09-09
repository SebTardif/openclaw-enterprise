package portable

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
)

// Verify checks the canonical manifest/tree and hashes and sizes of every
// reachable chunk. Parent references are descriptive and are not dereferenced.
func (s *Store) Verify(ctx context.Context, snapshotID string) (Manifest, error) {
	m, _, err := s.readSnapshot(ctx, snapshotID)
	return m, err
}

func (s *Store) readSnapshot(ctx context.Context, id string) (Manifest, tree, error) {
	if !validID(id) {
		return Manifest{}, tree{}, fmt.Errorf("%w: invalid snapshot identifier", ErrUnsafe)
	}
	ref, err := s.readRegular(ctx, "snapshots/"+id, 65)
	if err != nil {
		return Manifest{}, tree{}, err
	}
	if len(ref) != 65 || ref[64] != '\n' || !validDigest(string(ref[:64])) {
		return Manifest{}, tree{}, fmt.Errorf("%w: invalid snapshot reference", ErrCorrupt)
	}
	return s.load(ctx, string(ref[:64]), id)
}

func (s *Store) load(ctx context.Context, hash, id string) (Manifest, tree, error) {
	var m Manifest
	var t tree
	fail := func(err error) (Manifest, tree, error) { return Manifest{}, tree{}, err }
	data, err := s.readObject(ctx, "manifests", hash, s.limits.MaxMetadataBytes)
	if err != nil {
		return fail(err)
	}
	if err := canonicalDecode(data, &m); err != nil {
		return fail(err)
	}
	if m.Version != FormatVersion || m.Chunking != ChunkingProfile || m.MetadataProfile != MetadataProfile {
		return fail(fmt.Errorf("%w: manifest profile", ErrUnsupported))
	}
	if err := validateProvenance(m.Provenance); err != nil {
		return fail(fmt.Errorf("%w: manifest provenance: %v", ErrCorrupt, err))
	}
	if m.Provenance.SnapshotID != id {
		return fail(fmt.Errorf("%w: manifest identity differs", ErrCorrupt))
	}
	if m.Files <= 0 || m.Files > s.limits.MaxFiles || m.Bytes < 0 || m.Bytes > s.limits.MaxBytes {
		return fail(fmt.Errorf("%w: manifest totals", ErrLimit))
	}
	remaining := s.limits.MaxMetadataBytes - int64(len(data)) - 65
	if remaining <= 0 {
		return fail(fmt.Errorf("%w: manifest metadata", ErrLimit))
	}
	treeData, err := s.readObject(ctx, "trees", m.Tree, remaining)
	if err != nil {
		return fail(err)
	}
	if err := canonicalDecode(treeData, &t); err != nil {
		return fail(err)
	}
	if t.Version != FormatVersion {
		return fail(fmt.Errorf("%w: tree version", ErrUnsupported))
	}
	if len(t.Entries) != m.Files {
		return fail(fmt.Errorf("%w: entry count differs", ErrCorrupt))
	}
	seen := make(map[string]string, len(t.Entries))
	var total int64
	for i, e := range t.Entries {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		if !validPath(e.Path) || i > 1 && t.Entries[i-1].Path >= e.Path || i > 0 && e.Path == "." {
			return fail(fmt.Errorf("%w: unordered or unsafe path", ErrCorrupt))
		}
		if i == 0 {
			if e.Path != "." || e.Type != "directory" {
				return fail(fmt.Errorf("%w: missing root directory", ErrCorrupt))
			}
		} else if seen[path.Dir(e.Path)] != "directory" {
			return fail(fmt.Errorf("%w: invalid path parent", ErrCorrupt))
		}
		seen[e.Path] = e.Type
		if e.Mode > 0777 {
			return fail(fmt.Errorf("%w: unsupported permission bits", ErrCorrupt))
		}
		switch e.Type {
		case "directory":
			if e.Size != 0 || len(e.Chunks) != 0 || len(e.Target) != 0 {
				return fail(fmt.Errorf("%w: invalid directory metadata", ErrCorrupt))
			}
		case "symlink":
			if e.Mode != 0 || e.Size != 0 || len(e.Chunks) != 0 || len(e.Target) == 0 || len(e.Target) > maxPathBytes || bytes.IndexByte(e.Target, 0) >= 0 {
				return fail(fmt.Errorf("%w: invalid symlink metadata", ErrCorrupt))
			}
		case "file":
			if e.Size < 0 || e.Size > s.limits.MaxBytes-total || len(e.Target) != 0 {
				return fail(fmt.Errorf("%w: invalid file size or metadata", ErrCorrupt))
			}
			count := e.Size / int64(ChunkSize)
			if e.Size%int64(ChunkSize) != 0 {
				count++
			}
			if int64(len(e.Chunks)) != count {
				return fail(fmt.Errorf("%w: invalid chunk count", ErrCorrupt))
			}
			left := e.Size
			for _, chunk := range e.Chunks {
				content, err := s.readObject(ctx, "chunks", chunk, int64(ChunkSize))
				if err != nil {
					return fail(err)
				}
				expected := min(left, int64(ChunkSize))
				if int64(len(content)) != expected {
					return fail(fmt.Errorf("%w: chunk size differs", ErrCorrupt))
				}
				left -= expected
			}
			total += e.Size
		default:
			return fail(fmt.Errorf("%w: invalid entry type", ErrCorrupt))
		}
	}
	if total != m.Bytes {
		return fail(fmt.Errorf("%w: byte total differs", ErrCorrupt))
	}
	return m, t, nil
}

// Diff compares two independently verified complete roots in deterministic path
// order. Permissions, type, symlink targets and content all affect modification.
func (s *Store) Diff(ctx context.Context, beforeID, afterID string) ([]Change, error) {
	_, before, err := s.readSnapshot(ctx, beforeID)
	if err != nil {
		return nil, err
	}
	_, after, err := s.readSnapshot(ctx, afterID)
	if err != nil {
		return nil, err
	}
	old := make(map[string]entry, len(before.Entries))
	for _, e := range before.Entries {
		old[e.Path] = e
	}
	changes := make([]Change, 0)
	for _, e := range after.Entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		previous, ok := old[e.Path]
		if !ok {
			changes = append(changes, Change{Path: e.Path, Kind: "added"})
		} else {
			a, _ := json.Marshal(previous)
			b, _ := json.Marshal(e)
			if !bytes.Equal(a, b) {
				changes = append(changes, Change{Path: e.Path, Kind: "modified"})
			}
		}
		delete(old, e.Path)
	}
	for name := range old {
		changes = append(changes, Change{Path: name, Kind: "deleted"})
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Path < changes[j].Path })
	return changes, nil
}

// Restore verifies the entire root, reserves a nonexistent destination under an
// owned parent that denies group/other writes, and creates independent writable
// file inodes. It never overlays an existing directory. The reserved directory
// is visible while being filled; callers must wait for success before using it.
// Ordinary failures remove that operation's incomplete directory. A process
// crash may leave an incomplete directory which must not be used as a result.
// Absolute and outward symlinks preserve their literal targets, but no restored
// entry is ever written through a symlink. Repository locations cannot overlap.
func (s *Store) Restore(ctx context.Context, snapshotID, destination string) (result Manifest, resultErr error) {
	var zero Manifest
	if err := supportedHost(); err != nil {
		return zero, err
	}
	m, t, err := s.readSnapshot(ctx, snapshotID)
	if err != nil {
		return zero, err
	}
	if destination == "" {
		return zero, fmt.Errorf("%w: empty destination", ErrUnsafe)
	}
	abs, err := filepath.Abs(destination)
	if err != nil {
		return zero, err
	}
	parentName, err := absoluteNoLinks(filepath.Dir(abs), false)
	if err != nil {
		return zero, err
	}
	if overlaps(abs, s.location) {
		return zero, fmt.Errorf("%w: restore and repository overlap", ErrUnsafe)
	}
	parent, err := os.OpenRoot(parentName)
	if err != nil {
		return zero, err
	}
	defer parent.Close()
	parentInfo, err := parent.Stat(".")
	if err != nil {
		return zero, err
	}
	if parentInfo.Mode().Perm()&0022 != 0 || !owned(parentInfo) {
		return zero, fmt.Errorf("%w: restore parent must be owned and deny other writers", ErrUnsafe)
	}
	// A default ACL can be present on a private directory and would otherwise
	// introduce unsupported inherited metadata into freshly restored entries.
	if err := inspectMetadata(parentName, parentInfo); err != nil {
		return zero, fmt.Errorf("restore parent metadata: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	base := filepath.Base(abs)
	if err := parent.Mkdir(base, 0700); err != nil {
		return zero, fmt.Errorf("reserve fresh destination: %w", err)
	}
	complete := false
	var dest *os.Root
	defer func() {
		if dest != nil {
			if !complete {
				// Reset parents before descendants so restrictive modes cannot
				// prevent removal of this operation's incomplete directory.
				for _, e := range t.Entries {
					if e.Type == "directory" {
						dest.Chmod(filepath.FromSlash(e.Path), 0700)
					}
				}
			}
			dest.Close()
		}
		if !complete {
			if err := parent.RemoveAll(base); err != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("remove incomplete restore: %w", err))
			}
		}
	}()
	dest, err = parent.OpenRoot(base)
	if err != nil {
		return zero, err
	}
	for _, e := range t.Entries {
		if err := ctx.Err(); err != nil {
			return zero, err
		}
		name := filepath.FromSlash(e.Path)
		switch e.Type {
		case "directory":
			if e.Path != "." {
				if err := dest.Mkdir(name, 0700); err != nil {
					return zero, err
				}
			}
		case "file":
			if err := s.restoreFile(ctx, dest, e); err != nil {
				return zero, err
			}
		case "symlink":
			if err := dest.Symlink(string(e.Target), name); err != nil {
				return zero, err
			}
		}
	}
	// Apply restrictive directory modes only after all descendants are complete.
	// Descendants precede ancestors when reversing canonical lexical ordering.
	for i := len(t.Entries) - 1; i >= 0; i-- {
		if err := ctx.Err(); err != nil {
			return zero, err
		}
		e := t.Entries[i]
		if e.Type == "directory" {
			if err := dest.Chmod(filepath.FromSlash(e.Path), os.FileMode(e.Mode)); err != nil {
				return zero, err
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	complete = true
	return m, nil
}

func (s *Store) restoreFile(ctx context.Context, dest *os.Root, e entry) error {
	f, err := dest.OpenFile(filepath.FromSlash(e.Path), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	left := e.Size
	for _, hash := range e.Chunks {
		data, err := s.readObject(ctx, "chunks", hash, int64(ChunkSize))
		if err != nil {
			return err
		}
		expected := min(left, int64(ChunkSize))
		if int64(len(data)) != expected {
			return fmt.Errorf("%w: chunk size changed during restore", ErrCorrupt)
		}
		if err := writeAll(ctx, f, data); err != nil {
			return err
		}
		left -= expected
	}
	if left != 0 {
		return fmt.Errorf("%w: incomplete restored file", ErrCorrupt)
	}
	if err := f.Chmod(os.FileMode(e.Mode)); err != nil {
		return err
	}
	if err := f.Sync(); err != nil {
		return err
	}
	return f.Close()
}
