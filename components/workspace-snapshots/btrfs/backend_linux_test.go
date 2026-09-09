package btrfs

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIdentifiersAndMountScope(t *testing.T) {
	for _, id := range []string{"", "..", "a/b", "-option", "a.b", "a\n", strings.Repeat("a", 65)} {
		if validID(id) {
			t.Fatalf("accepted invalid ID %q", id)
		}
	}
	for _, id := range []string{"a", "Snapshot_42", "action-1"} {
		if !validID(id) {
			t.Fatalf("rejected ID %q", id)
		}
	}
	data := []byte("20 1 0:1 / /workspace-other rw - ext4 /dev/a rw\n")
	if err := noDescendantMounts(data, "/workspace"); err != nil {
		t.Fatal(err)
	}
	data = []byte("20 1 0:1 / /workspace/sub\\040dir rw - ext4 /dev/a rw\n")
	if err := noDescendantMounts(data, "/workspace"); err == nil {
		t.Fatal("accepted descendant mount")
	}
	if err := noDescendantMounts(data, "/workspace/sub dir"); err == nil {
		t.Fatal("accepted workspace itself as mount")
	}
	if _, err := unescapeMount(`bad\999`); err == nil {
		t.Fatal("accepted invalid mount escape")
	}
}

// This is parser coverage, not native Btrfs proof. The opt-in integration reads
// the same identities from actual kernel-generated full and incremental streams.
func TestStreamIdentity(t *testing.T) {
	for _, incremental := range []bool{false, true} {
		data := streamFixture(incremental)
		got, err := readStreamIdentity(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		if got.Path != "snapA" || got.CTransID != 29 {
			t.Fatalf("wrong stream identity: %+v", got)
		}
		if incremental && got.ParentCTransID != 19 {
			t.Fatal("lost parent transaction")
		}
		for _, n := range []int{0, 16, 24, len(data) - 1} {
			if _, err := readStreamIdentity(bytes.NewReader(data[:n])); err == nil {
				t.Fatalf("accepted truncated header at %d", n)
			}
		}
		data[len(data)-1] ^= 1
		if _, err := readStreamIdentity(bytes.NewReader(data)); err == nil {
			t.Fatal("accepted incorrect checksum")
		}
	}
	data := streamFixture(false)
	binary.LittleEndian.PutUint32(data[17:21], 1<<30)
	if _, err := readStreamIdentity(bytes.NewReader(data)); err == nil {
		t.Fatal("accepted oversized first command")
	}
}

func streamFixture(incremental bool) []byte {
	var payload bytes.Buffer
	attribute := func(key uint16, value []byte) {
		_ = binary.Write(&payload, binary.LittleEndian, key)
		_ = binary.Write(&payload, binary.LittleEndian, uint16(len(value)))
		payload.Write(value)
	}
	u64 := func(n uint64) []byte { data := make([]byte, 8); binary.LittleEndian.PutUint64(data, n); return data }
	attribute(15, []byte("snapA"))
	attribute(2, u64(29))
	attribute(1, bytes.Repeat([]byte{0x11}, 16))
	kind := uint16(1)
	if incremental {
		kind = 2
		attribute(21, u64(19))
		attribute(20, bytes.Repeat([]byte{0x22}, 16))
	}
	command := make([]byte, 10)
	binary.LittleEndian.PutUint32(command[:4], uint32(payload.Len()))
	binary.LittleEndian.PutUint16(command[4:6], kind)
	command = append(command, payload.Bytes()...)
	crc := ^crc32.Update(^uint32(0), crc32.MakeTable(crc32.Castagnoli), command)
	binary.LittleEndian.PutUint32(command[6:10], crc)
	header := append([]byte("btrfs-stream\x00"), 1, 0, 0, 0)
	return append(header, command...)
}

func TestPrivateRootsAndFilesystemRejection(t *testing.T) {
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := privateDirectory(root); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	if _, err := privateDirectory(link); err == nil {
		t.Fatal("accepted symlink root")
	}
	if err := os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := privateDirectory(root); err == nil {
		t.Fatal("accepted shared root")
	}
	if err := requireBtrfs(t.TempDir()); err == nil {
		t.Skip("temporary filesystem is Btrfs")
	} else if !errors.Is(err, ErrUnsupported) {
		t.Fatal(err)
	}
}

func TestAtomicDirectoryPublicationAndCancellation(t *testing.T) {
	root := t.TempDir()
	stage := filepath.Join(root, "stage")
	final := filepath.Join(root, "final")
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(filepath.Join(stage, "manifest.json"), map[string]int{"version": 1}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := publishDirectory(ctx, stage, final); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(final); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("canceled publication became visible")
	}
	if err := publishDirectory(context.Background(), stage, final); err != nil {
		t.Fatal(err)
	}
	var got map[string]int
	if err := readJSON(filepath.Join(final, "manifest.json"), &got); err != nil || got["version"] != 1 {
		t.Fatalf("bad publication: %v", err)
	}
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	if err := publishDirectory(context.Background(), stage, final); err == nil {
		t.Fatal("replaced existing artifact")
	}
}

func TestKernelABINoReplace(t *testing.T) {
	if err := kernelABI(); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	source, target := filepath.Join(root, "source"), filepath.Join(root, "target")
	for _, path := range []string{source, target} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	// The kernel operation itself must reject even an empty existing directory;
	// this covers a destination appearing after the separate preflight check.
	if err := renameNoReplace(source, target); err == nil {
		t.Fatal("replaced existing empty directory")
	}
	for _, path := range []string{source, target} {
		if _, err := os.Stat(path); err != nil {
			t.Fatal(err)
		}
	}
}

// These tests exercise real child lifetime/output handling, using the test binary
// as a process fixture. They do not substitute it for the Btrfs backend.
func TestCommandCancellationAndOutputLimit(t *testing.T) {
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	err = runCommand(context.Background(), bin, time.Second, io.Discard, 1024, "-test.run=TestNativeProcessFixture", "--", "output")
	if !errors.Is(err, ErrLimit) {
		t.Fatalf("output bound failed: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	err = runCommand(ctx, bin, time.Second, io.Discard, 1024, "-test.run=TestNativeProcessFixture", "--", "wait")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancellation failed: %v", err)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("child was not promptly reaped")
	}
}

func TestNativeProcessFixture(t *testing.T) {
	if len(os.Args) < 2 || os.Args[len(os.Args)-2] != "--" {
		return
	}
	switch os.Args[len(os.Args)-1] {
	case "output":
		_, _ = os.Stdout.Write(bytes.Repeat([]byte("x"), 65536))
	case "wait":
		time.Sleep(10 * time.Second)
	default:
		os.Exit(2)
	}
	os.Exit(0)
}
