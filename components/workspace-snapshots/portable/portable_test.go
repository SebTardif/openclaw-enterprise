//go:build linux

package portable

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"syscall"
	"testing"
	"time"

	snapshots "github.com/openclaw/openclaw-enterprise/components/workspace-snapshots"
)

func testStore(t *testing.T, limits Limits) (*Store, string, string) {
	t.Helper()
	base := t.TempDir()
	// The restore contract requires an explicitly protected caller-owned parent.
	if err := os.Chmod(base, 0700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(base, "source")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(base, "repository"), limits)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, source, base
}

func writeFile(t *testing.T, name string, data []byte, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(name, data, mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(name, mode); err != nil {
		t.Fatal(err)
	}
}

func provenance(id string) snapshots.Provenance {
	return snapshots.Provenance{WorkspaceID: "workspace", SnapshotID: id}
}

func capture(t *testing.T, s *Store, source, id string) Manifest {
	t.Helper()
	m, err := s.Capture(context.Background(), source, provenance(id))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func names(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	result := make([]string, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry.Name())
	}
	return result
}

func TestCaptureDiffRestoreCompleteRoot(t *testing.T) {
	s, source, base := testStore(t, Limits{})
	if err := os.Mkdir(filepath.Join(source, "nested"), 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(source, "empty"), 0700); err != nil {
		t.Fatal(err)
	}
	data := append(bytes.Repeat([]byte{0, 255, 17, 128}, ChunkSize/4), bytes.Repeat([]byte{31}, ChunkSize)...)
	data = append(data, []byte("old ending")...)
	writeFile(t, filepath.Join(source, "untracked.bin"), data, 0640)
	writeFile(t, filepath.Join(source, "deleted"), []byte("removed"), 0600)
	writeFile(t, filepath.Join(source, "old-name"), []byte("renamed content"), 0600)
	writeFile(t, filepath.Join(source, "mode"), []byte("same bytes"), 0600)
	writeFile(t, filepath.Join(source, "empty-file"), nil, 0600)
	if err := os.Symlink("../untracked.bin", filepath.Join(source, "nested", "link")); err != nil {
		t.Fatal(err)
	}
	first := capture(t, s, source, "first")
	initialChunks := names(t, filepath.Join(s.location, "chunks"))
	if err := os.Remove(filepath.Join(source, "deleted")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(source, "old-name"), filepath.Join(source, "new-name")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(source, "mode"), 0751); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(source, "nested"), 0710); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(source, "nested", "link")); err != nil {
		t.Fatal(err)
	}
	// Target bytes need not be valid UTF-8, and capture must never follow them.
	target := string([]byte{'/', 'u', 'n', 'k', 'n', 'o', 'w', 'n', 0xff})
	if err := os.Symlink(target, filepath.Join(source, "nested", "link")); err != nil {
		t.Fatal(err)
	}
	data[len(data)-1] ^= 63
	writeFile(t, filepath.Join(source, "untracked.bin"), data, 0640)
	p := provenance("second")
	p.ParentSnapshotID = "first"
	p.ActionRef = "action-2"
	second, err := s.Capture(context.Background(), source, p)
	if err != nil {
		t.Fatal(err)
	}
	if first.Tree == second.Tree || second.MetadataProfile != MetadataProfile || second.Chunking != ChunkingProfile {
		t.Fatal("unexpected manifest profiles or unchanged root")
	}
	finalChunks := names(t, filepath.Join(s.location, "chunks"))
	if len(finalChunks) != len(initialChunks)+1 {
		t.Fatalf("expected only changed final chunk; before=%d after=%d", len(initialChunks), len(finalChunks))
	}
	for _, hash := range initialChunks {
		if _, err := os.Stat(filepath.Join(s.location, "chunks", hash)); err != nil {
			t.Fatal("unchanged object lost:", err)
		}
	}
	changes, err := s.Diff(context.Background(), "first", "second")
	if err != nil {
		t.Fatal(err)
	}
	want := []Change{{"deleted", "deleted"}, {"mode", "modified"}, {"nested", "modified"}, {"nested/link", "modified"}, {"new-name", "added"}, {"old-name", "deleted"}, {"untracked.bin", "modified"}}
	if !reflect.DeepEqual(changes, want) {
		t.Fatalf("changes = %#v, want %#v", changes, want)
	}
	// Deleting the old root metadata proves restoration does not replay parents.
	ref, err := os.ReadFile(filepath.Join(s.location, "snapshots", "first"))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{filepath.Join(s.location, "snapshots", "first"), filepath.Join(s.location, "manifests", string(ref[:64])), filepath.Join(s.location, "trees", first.Tree)} {
		if err := os.Remove(name); err != nil {
			t.Fatal(err)
		}
	}
	if verified, err := s.Verify(context.Background(), "second"); err != nil || verified != second {
		t.Fatalf("verify: %#v %v", verified, err)
	}
	destination := filepath.Join(base, "restored")
	if _, err := s.Restore(context.Background(), "second", destination); err != nil {
		t.Fatal(err)
	}
	assertTreeEqual(t, source, destination)
	if got, err := os.Readlink(filepath.Join(destination, "nested", "link")); err != nil || got != target {
		t.Fatalf("target bytes: %q %v", got, err)
	}
	// A restored file is independently writable and cannot change stored chunks.
	writeFile(t, filepath.Join(destination, "untracked.bin"), []byte("independent"), 0600)
	if _, err := s.Verify(context.Background(), "second"); err != nil {
		t.Fatal(err)
	}
	third := filepath.Join(base, "restored-again")
	if _, err := s.Restore(context.Background(), "second", third); err != nil {
		t.Fatal(err)
	}
	assertTreeEqual(t, source, third)
}

func assertTreeEqual(t *testing.T, a, b string) {
	t.Helper()
	for _, source := range []string{a, b} {
		other := b
		if source == b {
			other = a
		}
		err := filepath.WalkDir(source, func(name string, item os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(source, name)
			if err != nil {
				return err
			}
			left, err := os.Lstat(name)
			if err != nil {
				return err
			}
			right, err := os.Lstat(filepath.Join(other, rel))
			if err != nil {
				return err
			}
			if left.Mode() != right.Mode() {
				t.Errorf("mode differs at %s: %v %v", rel, left.Mode(), right.Mode())
			}
			if left.Mode().IsRegular() {
				x, err := os.ReadFile(name)
				if err != nil {
					return err
				}
				y, err := os.ReadFile(filepath.Join(other, rel))
				if err != nil {
					return err
				}
				if !bytes.Equal(x, y) {
					t.Errorf("bytes differ at %s", rel)
				}
			}
			if left.Mode()&os.ModeSymlink != 0 {
				x, err := os.Readlink(name)
				if err != nil {
					return err
				}
				y, err := os.Readlink(filepath.Join(other, rel))
				if err != nil {
					return err
				}
				if x != y {
					t.Errorf("symlink differs at %s", rel)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestDeterministicCaptureAndNoClobber(t *testing.T) {
	s, source, _ := testStore(t, Limits{})
	writeFile(t, filepath.Join(source, "file"), []byte("content"), 0600)
	first := capture(t, s, source, "same")
	if again := capture(t, s, source, "same"); again != first {
		t.Fatal("capture is not deterministic")
	}
	before, err := os.ReadFile(filepath.Join(s.location, "snapshots", "same"))
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(source, "file"), []byte("changed"), 0600)
	if _, err := s.Capture(context.Background(), source, provenance("same")); !errors.Is(err, ErrConflict) {
		t.Fatalf("expected identity conflict: %v", err)
	}
	after, err := os.ReadFile(filepath.Join(s.location, "snapshots", "same"))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("existing ref changed: %v", err)
	}
	if verified, err := s.Verify(context.Background(), "same"); err != nil || verified != first {
		t.Fatalf("original snapshot changed: %v", err)
	}
	if staged := names(t, filepath.Join(s.location, "staging")); len(staged) != 0 {
		t.Fatalf("staging leaked: %v", staged)
	}
}

func TestMissingAndCorruptObjectsPreventRestore(t *testing.T) {
	for _, kind := range []string{"chunks", "trees", "manifests", "snapshots"} {
		for _, damage := range []string{"missing", "corrupt", "symlink"} {
			t.Run(kind+"/"+damage, func(t *testing.T) {
				s, source, base := testStore(t, Limits{})
				writeFile(t, filepath.Join(source, "file"), []byte("binary\x00payload"), 0600)
				capture(t, s, source, "snapshot")
				files := names(t, filepath.Join(s.location, kind))
				name := filepath.Join(s.location, kind, files[0])
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
				switch damage {
				case "corrupt":
					writeFile(t, name, []byte("corruption"), 0400)
				case "symlink":
					if err := os.Symlink(filepath.Join(source, "file"), name); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := s.Verify(context.Background(), "snapshot"); !errors.Is(err, ErrCorrupt) {
					t.Fatalf("expected corruption: %v", err)
				}
				dest := filepath.Join(base, "restore")
				if _, err := s.Restore(context.Background(), "snapshot", dest); err == nil {
					t.Fatal("damaged snapshot restored")
				}
				if _, err := os.Lstat(dest); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("destination created for invalid snapshot: %v", err)
				}
			})
		}
	}
}

func TestBoundsCancellationAndPartialPublication(t *testing.T) {
	cases := []struct {
		name   string
		limits Limits
		setup  func(*testing.T, string)
		want   error
	}{
		{"files", Limits{MaxFiles: 1}, func(t *testing.T, p string) { writeFile(t, filepath.Join(p, "extra"), nil, 0600) }, ErrLimit},
		{"bytes", Limits{MaxBytes: 3}, func(t *testing.T, p string) { writeFile(t, filepath.Join(p, "extra"), []byte("1234"), 0600) }, ErrLimit},
		{"metadata", Limits{MaxMetadataBytes: 80}, func(t *testing.T, p string) {}, ErrLimit},
		{"fifo", Limits{}, func(t *testing.T, p string) {
			writeFile(t, filepath.Join(p, "a-file"), []byte("captured before failure"), 0600)
			// Breadth-first capture must finish the root's regular file before
			// encountering this unsupported entry, regardless of readdir order.
			if err := os.Mkdir(filepath.Join(p, "nested"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := syscall.Mkfifo(filepath.Join(p, "nested", "fifo"), 0600); err != nil {
				t.Fatal(err)
			}
		}, ErrUnsupported},
		{"hardlinked-symlink", Limits{}, func(t *testing.T, p string) {
			if err := os.Symlink("target", filepath.Join(p, "link")); err != nil {
				t.Fatal(err)
			}
			if err := os.Link(filepath.Join(p, "link"), filepath.Join(p, "alias")); err != nil {
				t.Fatal(err)
			}
		}, ErrUnsupported},
		{"hardlink", Limits{}, func(t *testing.T, p string) {
			writeFile(t, filepath.Join(p, "file"), []byte("linked"), 0600)
			if err := os.Link(filepath.Join(p, "file"), filepath.Join(filepath.Dir(p), "outside-link")); err != nil {
				t.Fatal(err)
			}
		}, ErrUnsupported},
		{"special-mode", Limits{}, func(t *testing.T, p string) {
			if err := os.Chmod(p, 0700|os.ModeSticky); err != nil {
				t.Fatal(err)
			}
		}, ErrUnsupported},
		{"xattr", Limits{}, func(t *testing.T, p string) {
			writeFile(t, filepath.Join(p, "file"), []byte("data"), 0600)
			if err := syscall.Setxattr(filepath.Join(p, "file"), "user.snapshot-test", []byte("attribute"), 0); errors.Is(err, syscall.ENOTSUP) {
				t.Skip("filesystem has no extended attributes")
			} else if err != nil {
				t.Fatal(err)
			}
		}, ErrUnsupported},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, source, _ := testStore(t, tc.limits)
			tc.setup(t, source)
			if _, err := s.Capture(context.Background(), source, provenance("failed")); !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
			if refs := names(t, filepath.Join(s.location, "snapshots")); len(refs) != 0 {
				t.Fatalf("partial snapshot published: %v", refs)
			}
			if staged := names(t, filepath.Join(s.location, "staging")); len(staged) != 0 {
				t.Fatalf("staging leaked: %v", staged)
			}
			if tc.name == "fifo" && len(names(t, filepath.Join(s.location, "chunks"))) == 0 {
				t.Fatal("partial-publication case did not first store content")
			}
		})
	}
	t.Run("cancelled", func(t *testing.T) {
		s, source, base := testStore(t, Limits{})
		writeFile(t, filepath.Join(source, "file"), []byte("content"), 0600)
		capture(t, s, source, "valid")
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := s.Capture(ctx, source, provenance("cancelled")); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		if _, err := s.Verify(ctx, "valid"); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		if _, err := s.Diff(ctx, "valid", "valid"); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		if _, err := s.Restore(ctx, "valid", filepath.Join(base, "cancelled")); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		if got := names(t, filepath.Join(s.location, "snapshots")); !reflect.DeepEqual(got, []string{"valid"}) {
			t.Fatal(got)
		}
	})
}

func TestUnsafeDestinationsAndRepositoryLocations(t *testing.T) {
	s, source, base := testStore(t, Limits{})
	writeFile(t, filepath.Join(source, "file"), []byte("preserved"), 0600)
	if err := os.Symlink(filepath.Join(base, "outside"), filepath.Join(source, "outward-link")); err != nil {
		t.Fatal(err)
	}
	capture(t, s, source, "snapshot")
	outside := filepath.Join(base, "outside")
	if err := os.Mkdir(outside, 0700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(outside, "sentinel"), []byte("untouched"), 0600)
	link := filepath.Join(base, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	for _, dest := range []string{source, outside, link, filepath.Join(link, "new"), s.location, filepath.Join(s.location, "new"), base} {
		if _, err := s.Restore(context.Background(), "snapshot", dest); err == nil {
			t.Fatalf("unsafe restore succeeded: %s", dest)
		}
	}
	if data, err := os.ReadFile(filepath.Join(outside, "sentinel")); err != nil || string(data) != "untouched" {
		t.Fatal("existing destination changed")
	}
	for _, src := range []string{s.location, base, filepath.Join(s.location, "chunks"), link} {
		if _, err := s.Capture(context.Background(), src, provenance("unsafe")); !errors.Is(err, ErrUnsafe) {
			t.Fatalf("unsafe source accepted or wrong error: %s %v", src, err)
		}
	}
	if _, err := Open(filepath.Join(link, "repository"), Limits{}); !errors.Is(err, ErrUnsafe) {
		t.Fatalf("repository through symlink: %v", err)
	}
	unprotected := filepath.Join(base, "unprotected")
	if err := os.Mkdir(unprotected, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(unprotected, 0777); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(unprotected, Limits{}); !errors.Is(err, ErrUnsafe) {
		t.Fatalf("unprotected repository accepted: %v", err)
	}
	if _, err := s.Restore(context.Background(), "snapshot", filepath.Join(unprotected, "new")); !errors.Is(err, ErrUnsafe) {
		t.Fatalf("unprotected parent accepted: %v", err)
	}
	valid := filepath.Join(base, "safe")
	if _, err := s.Restore(context.Background(), "snapshot", valid); err != nil {
		t.Fatal(err)
	}
	if got, err := os.Readlink(filepath.Join(valid, "outward-link")); err != nil || got != outside {
		t.Fatalf("literal outward target lost: %q %v", got, err)
	}
	if got := names(t, outside); !reflect.DeepEqual(got, []string{"sentinel"}) {
		t.Fatalf("restore wrote through link: %v", got)
	}
}

func TestInvalidTreesRejectedBeforeDestinationCreation(t *testing.T) {
	cases := map[string][]entry{
		"traversal":      {{Path: ".", Type: "directory", Mode: 0700}, {Path: "../outside", Type: "file"}},
		"symlink-parent": {{Path: ".", Type: "directory", Mode: 0700}, {Path: "link", Type: "symlink", Target: []byte("../outside")}, {Path: "link/file", Type: "file"}},
		"duplicate":      {{Path: ".", Type: "directory", Mode: 0700}, {Path: "file", Type: "file"}, {Path: "file", Type: "file"}},
		"no-root":        {{Path: "file", Type: "file"}},
		"bad-digest":     {{Path: ".", Type: "directory", Mode: 0700}, {Path: "file", Type: "file", Size: 1, Chunks: []string{"invalid"}}},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			s, _, base := testStore(t, Limits{})
			encoded, err := json.Marshal(tree{Version: FormatVersion, Entries: entries})
			if err != nil {
				t.Fatal(err)
			}
			hash, err := s.putObject(context.Background(), "trees", encoded)
			if err != nil {
				t.Fatal(err)
			}
			m := Manifest{Version: FormatVersion, Chunking: ChunkingProfile, MetadataProfile: MetadataProfile, Tree: hash, Provenance: provenance("invalid"), Files: len(entries)}
			for _, entry := range entries {
				m.Bytes += entry.Size
			}
			encoded, err = json.Marshal(m)
			if err != nil {
				t.Fatal(err)
			}
			hash, err = s.putObject(context.Background(), "manifests", encoded)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.publish(context.Background(), "snapshots/invalid", []byte(hash+"\n")); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Restore(context.Background(), "invalid", filepath.Join(base, "destination")); !errors.Is(err, ErrCorrupt) {
				t.Fatalf("invalid tree accepted: %v", err)
			}
			if _, err := os.Lstat(filepath.Join(base, "destination")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("destination created")
			}
		})
	}
}

func TestConcurrentCaptureSameAndConflictingIDs(t *testing.T) {
	s, source, base := testStore(t, Limits{})
	writeFile(t, filepath.Join(source, "file"), []byte("first"), 0600)
	other := filepath.Join(base, "other")
	if err := os.Mkdir(other, 0700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(other, "file"), []byte("second"), 0600)
	results := make(chan error, 8)
	for i := 0; i < cap(results); i++ {
		go func(i int) {
			src := source
			if i%2 != 0 {
				src = other
			}
			_, err := s.Capture(context.Background(), src, provenance("contended"))
			results <- err
		}(i)
	}
	var successes, conflicts int
	for i := 0; i < cap(results); i++ {
		err := <-results
		if err == nil {
			successes++
		} else if errors.Is(err, ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 4 || conflicts != 4 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
	if _, err := s.Verify(context.Background(), "contended"); err != nil {
		t.Fatal(err)
	}
	if staged := names(t, filepath.Join(s.location, "staging")); len(staged) != 0 {
		t.Fatal(staged)
	}
}

func TestDeterministicOrderingAndEmptyRoot(t *testing.T) {
	s, source, base := testStore(t, Limits{})
	empty := capture(t, s, source, "empty")
	if empty.Files != 1 || empty.Bytes != 0 {
		t.Fatal(empty)
	}
	if _, err := s.Restore(context.Background(), "empty", filepath.Join(base, "restored")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"z", ".hidden", "a", "!important", "#notes", "$file", "-dash"} {
		writeFile(t, filepath.Join(source, name), nil, 0600)
	}
	capture(t, s, source, "ordered")
	_, root, err := s.readSnapshot(context.Background(), "ordered")
	if err != nil {
		t.Fatal(err)
	}
	paths := make([]string, len(root.Entries))
	for i, e := range root.Entries {
		paths[i] = e.Path
	}
	if !sort.StringsAreSorted(paths[1:]) || !reflect.DeepEqual(paths, []string{".", "!important", "#notes", "$file", "-dash", ".hidden", "a", "z"}) {
		t.Fatal(paths)
	}
	if _, err := s.Restore(context.Background(), "ordered", filepath.Join(base, "punctuation")); err != nil {
		t.Fatal(err)
	}
	assertTreeEqual(t, source, filepath.Join(base, "punctuation"))
}

func TestRestoreRejectsInheritedACL(t *testing.T) {
	s, source, base := testStore(t, Limits{})
	writeFile(t, filepath.Join(source, "file"), []byte("content"), 0600)
	capture(t, s, source, "snapshot")
	parent := filepath.Join(base, "acl-parent")
	if err := os.Mkdir(parent, 0700); err != nil {
		t.Fatal(err)
	}
	// Linux POSIX ACL xattrs encode a version followed by tag/permission/ID
	// entries. A default ACL is independent of the parent's 0700 access mode.
	acl := make([]byte, 4+3*8)
	binary.LittleEndian.PutUint32(acl, 2)
	type aclEntry struct {
		tag, permissions uint16
		id               uint32
	}
	entries := []aclEntry{{1, 7, ^uint32(0)}, {4, 0, ^uint32(0)}, {32, 0, ^uint32(0)}}
	for i, e := range entries {
		offset := 4 + i*8
		binary.LittleEndian.PutUint16(acl[offset:], e.tag)
		binary.LittleEndian.PutUint16(acl[offset+2:], e.permissions)
		binary.LittleEndian.PutUint32(acl[offset+4:], e.id)
	}
	if err := syscall.Setxattr(parent, "system.posix_acl_default", acl, 0); errors.Is(err, syscall.ENOTSUP) {
		t.Skip("filesystem has no POSIX ACL support")
	} else if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(parent); err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("fixture is not a private parent: %v %v", info, err)
	}
	if _, err := s.Restore(context.Background(), "snapshot", filepath.Join(parent, "restored")); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("default ACL accepted: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(parent, "restored")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("destination created under default ACL")
	}
}

func TestCancellationAfterRealContentProgress(t *testing.T) {
	s, source, _ := testStore(t, Limits{})
	// A sparse fixture gives the real capture enough bounded reads for another
	// goroutine to cancel after observing a completely published content chunk.
	f, err := os.Create(filepath.Join(source, "large"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(128 * ChunkSize); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := s.Capture(ctx, source, provenance("cancelled-progress")); done <- err }()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case err := <-done:
			t.Fatalf("capture finished before cancellation after progress: %v", err)
		case <-deadline.C:
			cancel()
			<-done
			t.Fatal("capture made no observable progress")
		case <-tick.C:
			if len(names(t, filepath.Join(s.location, "chunks"))) > 0 {
				cancel()
				if err := <-done; !errors.Is(err, context.Canceled) {
					t.Fatalf("capture ignored cancellation: %v", err)
				}
				if len(names(t, filepath.Join(s.location, "snapshots"))) != 0 {
					t.Fatal("cancelled capture published")
				}
				if len(names(t, filepath.Join(s.location, "staging"))) != 0 {
					t.Fatal("cancelled capture left staging")
				}
				return
			}
		}
	}
}

func TestRestoreBoundsAndRestrictiveModes(t *testing.T) {
	s, source, base := testStore(t, Limits{})
	if err := os.Mkdir(filepath.Join(source, "readonly"), 0700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(source, "readonly", "file"), []byte("content"), 0400)
	if err := os.Chmod(filepath.Join(source, "readonly"), 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(filepath.Join(source, "readonly"), 0700) })
	capture(t, s, source, "snapshot")
	for _, limits := range []Limits{{MaxFiles: 2}, {MaxBytes: 3}, {MaxMetadataBytes: 100}} {
		bounded, err := Open(s.location, limits)
		if err != nil {
			t.Fatal(err)
		}
		_, err = bounded.Restore(context.Background(), "snapshot", filepath.Join(base, "bounded"))
		bounded.Close()
		if err == nil {
			t.Fatal("restore limits ignored")
		}
		if _, err := os.Lstat(filepath.Join(base, "bounded")); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("bounded restore created destination")
		}
	}
	destination := filepath.Join(base, "readonly-restore")
	if _, err := s.Restore(context.Background(), "snapshot", destination); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(filepath.Join(destination, "readonly"), 0700) })
	assertTreeEqual(t, source, destination)
}
