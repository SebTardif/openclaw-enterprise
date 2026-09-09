package portable

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"

	snapshots "github.com/openclaw/openclaw-enterprise/components/workspace-snapshots"
)

// Capture reads an immutable directory supplied by a provider or an enforced
// no-writer boundary. All filesystem entries, including binary and untracked
// files, participate. No Git or ignore rules apply. Unsupported entries and
// errors before the final reference link prevent snapshot publication; complete
// unreferenced objects may remain. ErrDurability after that commit point returns
// the manifest with the error and can leave a complete, verifiable reference.
// An identical capture under the same ID is idempotent.
func (s *Store) Capture(ctx context.Context, source string, provenance snapshots.Provenance) (Manifest, error) {
	var zero Manifest
	if err := ctx.Err(); err != nil {
		return zero, err
	}
	if err := supportedHost(); err != nil {
		return zero, err
	}
	if err := validateProvenance(provenance); err != nil {
		return zero, err
	}
	abs, err := absoluteNoLinks(source, false)
	if err != nil {
		return zero, err
	}
	if overlaps(abs, s.location) {
		return zero, fmt.Errorf("%w: source and repository overlap", ErrUnsafe)
	}
	sourceRoot, err := os.OpenRoot(abs)
	if err != nil {
		return zero, err
	}
	defer sourceRoot.Close()
	repoInfo, err := s.root.Stat(".")
	if err != nil {
		return zero, err
	}
	manifest := Manifest{Version: FormatVersion, Chunking: ChunkingProfile, MetadataProfile: MetadataProfile, Provenance: provenance}
	t := tree{Version: FormatVersion}
	metadataBytes := int64(32)
	add := func(name string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !validPath(name) {
			return fmt.Errorf("%w: unsupported path", ErrUnsupported)
		}
		if len(t.Entries) >= s.limits.MaxFiles {
			return fmt.Errorf("%w: too many entries", ErrLimit)
		}
		if int64(len(name))+metadataBytes > s.limits.MaxMetadataBytes {
			return fmt.Errorf("%w: path metadata", ErrLimit)
		}
		info, err := sourceRoot.Lstat(filepath.FromSlash(name))
		if err != nil {
			return err
		}
		if os.SameFile(info, repoInfo) {
			return fmt.Errorf("%w: repository alias in source", ErrUnsafe)
		}
		if err := inspectMetadata(filepath.Join(abs, filepath.FromSlash(name)), info); err != nil {
			return fmt.Errorf("entry %q: %w", name, err)
		}
		e := entry{Path: name, Mode: uint32(info.Mode().Perm())}
		switch {
		case info.IsDir():
			e.Type = "directory"
		case info.Mode().IsRegular():
			e.Type = "file"
			if info.Size() < 0 || info.Size() > s.limits.MaxBytes-manifest.Bytes {
				return fmt.Errorf("%w: content bytes", ErrLimit)
			}
			e.Size = info.Size()
			// Bound the chunk reference array before allocating it or reading data.
			chunks := e.Size / int64(ChunkSize)
			if e.Size%int64(ChunkSize) != 0 {
				chunks++
			}
			if chunks > (s.limits.MaxMetadataBytes-metadataBytes-int64(len(name)))/67 {
				return fmt.Errorf("%w: chunk metadata", ErrLimit)
			}
			e.Chunks, err = s.captureFile(ctx, sourceRoot, name, info)
			if err != nil {
				return err
			}
			manifest.Bytes += e.Size
		case info.Mode()&os.ModeSymlink != 0:
			e.Type = "symlink"
			e.Mode = 0 // Link modes cannot be set portably; preserve target bytes.
			target, err := sourceRoot.Readlink(filepath.FromSlash(name))
			if err != nil {
				return err
			}
			if len(target) == 0 || len(target) > maxPathBytes {
				return fmt.Errorf("%w: symlink target", ErrLimit)
			}
			e.Target = []byte(target)
		default:
			return fmt.Errorf("%w: entry %q has unsupported type", ErrUnsupported, name)
		}
		encoded, err := json.Marshal(e)
		if err != nil {
			return err
		}
		metadataBytes += int64(len(encoded)) + 1
		if metadataBytes > s.limits.MaxMetadataBytes {
			return fmt.Errorf("%w: tree metadata", ErrLimit)
		}
		t.Entries = append(t.Entries, e)
		return nil
	}
	if err := add("."); err != nil {
		return zero, err
	}
	// Breadth-first iteration holds one directory descriptor at a time. Each
	// readdir batch is bounded, and the retained entry list obeys both limits.
	for i := 0; i < len(t.Entries); i++ {
		if t.Entries[i].Type != "directory" {
			continue
		}
		name := t.Entries[i].Path
		if err := s.captureDirectory(ctx, sourceRoot, name, add); err != nil {
			return zero, err
		}
	}
	sort.Slice(t.Entries, func(i, j int) bool {
		if t.Entries[i].Path == "." {
			return t.Entries[j].Path != "."
		}
		if t.Entries[j].Path == "." {
			return false
		}
		return t.Entries[i].Path < t.Entries[j].Path
	})
	treeData, err := json.Marshal(t)
	if err != nil {
		return zero, err
	}
	manifest.Tree = digest(treeData)
	manifest.Files = len(t.Entries)
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		return zero, err
	}
	if int64(len(treeData))+int64(len(manifestData))+65 > s.limits.MaxMetadataBytes {
		return zero, fmt.Errorf("%w: combined metadata", ErrLimit)
	}
	if _, err = s.putObject(ctx, "trees", treeData); err != nil {
		return zero, err
	}
	manifestHash, err := s.putObject(ctx, "manifests", manifestData)
	if err != nil {
		return zero, err
	}
	// Verify the entire reachable graph before publishing the only usable ref.
	if _, _, err := s.load(ctx, manifestHash, provenance.SnapshotID); err != nil {
		return zero, err
	}
	if err := s.publish(ctx, "snapshots/"+provenance.SnapshotID, []byte(manifestHash+"\n")); err != nil {
		if errors.Is(err, ErrDurability) {
			return manifest, err
		}
		return zero, err
	}
	return manifest, nil
}

func (s *Store) captureDirectory(ctx context.Context, root *os.Root, name string, add func(string) error) error {
	before, err := root.Lstat(filepath.FromSlash(name))
	if err != nil {
		return err
	}
	if !before.IsDir() {
		return fmt.Errorf("%w: source directory changed", ErrUnsupported)
	}
	f, err := root.Open(filepath.FromSlash(name))
	if err != nil {
		return err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return err
	}
	if !os.SameFile(before, opened) || !opened.IsDir() {
		return fmt.Errorf("%w: source directory changed", ErrUnsupported)
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		batch, readErr := f.ReadDir(128)
		for _, child := range batch {
			if err := add(path.Join(name, child.Name())); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	after, err := f.Stat()
	if err != nil {
		return err
	}
	if !before.ModTime().Equal(after.ModTime()) || before.Mode() != after.Mode() {
		return fmt.Errorf("%w: source directory changed", ErrUnsupported)
	}
	return nil
}

func (s *Store) captureFile(ctx context.Context, root *os.Root, name string, before os.FileInfo) ([]string, error) {
	f, err := root.Open(filepath.FromSlash(name))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !opened.Mode().IsRegular() || !os.SameFile(before, opened) || before.Size() != opened.Size() || !before.ModTime().Equal(opened.ModTime()) {
		return nil, fmt.Errorf("%w: source file changed", ErrUnsupported)
	}
	var chunks []string
	buffer := make([]byte, ChunkSize)
	remaining := before.Size()
	for remaining > 0 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n := int(min(remaining, int64(ChunkSize)))
		if _, err := io.ReadFull(f, buffer[:n]); err != nil {
			return nil, fmt.Errorf("read source: %w", err)
		}
		hash, err := s.putObject(ctx, "chunks", buffer[:n])
		if err != nil {
			return nil, err
		}
		chunks = append(chunks, hash)
		remaining -= int64(n)
	}
	var extra [1]byte
	if n, err := f.Read(extra[:]); n != 0 || err != io.EOF {
		return nil, fmt.Errorf("%w: source file size changed", ErrUnsupported)
	}
	after, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) || before.Mode() != after.Mode() {
		return nil, fmt.Errorf("%w: source file changed", ErrUnsupported)
	}
	return chunks, nil
}
