//go:build linux

package nodeobserver

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProtectedFileRetainsActualInodeAndRefusesReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "source")
	must(t, os.WriteFile(path, []byte("original"), 0600))
	f, err := openProtected(path, false, uint32(os.Getuid()))
	must(t, err)
	defer f.file.Close()
	raw, err := f.bytes(64)
	must(t, err)
	if string(raw) != "original" {
		t.Fatal("wrong physical bytes")
	}
	must(t, os.Rename(path, path+".old"))
	must(t, os.WriteFile(path, []byte("original"), 0600))
	requireError(t, f.current())
	must(t, os.Chmod(path, 0666))
	_, err = openProtected(path, false, uint32(os.Getuid()))
	requireError(t, err)
	must(t, os.Chmod(path, 0600))
	link := path + ".link"
	must(t, os.Symlink(path, link))
	_, err = openProtected(link, false, uint32(os.Getuid()))
	requireError(t, err)
}

func TestProtectedRuntimeDirectoryAllowsEntryChurnButNotReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime")
	must(t, os.Mkdir(path, 0700))
	root, err := openProtected(path, true, uint32(os.Getuid()))
	must(t, err)
	defer root.file.Close()
	entry := filepath.Join(path, "state.lock")
	must(t, os.WriteFile(entry, []byte("state"), 0600))
	must(t, root.current())
	must(t, os.Remove(entry))
	must(t, root.current())
	must(t, os.Rename(path, path+".old"))
	must(t, os.Mkdir(path, 0700))
	requireError(t, root.current())
}

func TestKernelProcessHandleDetectsActualExit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, "/bin/sleep", "30")
	must(t, child.Start())
	defer func() { child.Process.Kill(); child.Wait() }()
	exe, err := os.Open("/proc/" + strconv.Itoa(child.Process.Pid) + "/exe")
	must(t, err)
	expected, err := fileHash(ctx, exe, 256<<20)
	exe.Close()
	must(t, err)
	h, err := openProcess(ctx, child.Process.Pid, expected, uint32(os.Getuid()))
	must(t, err)
	defer h.close()
	must(t, h.current())
	if h.process.StartTicks == "" || h.process.PIDNamespace == "" {
		t.Fatal("missing kernel identity")
	}
	_, err = openProcess(ctx, child.Process.Pid, "sha256:"+strings.Repeat("0", 64), uint32(os.Getuid()))
	requireError(t, err)
	must(t, child.Process.Kill())
	child.Wait()
	requireError(t, h.current())
}

func TestCRIDialChecksActualUnixPeerWithoutProductionEnrollment(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cri.sock")
	listener, err := net.Listen("unix", path)
	must(t, err)
	defer listener.Close()
	must(t, os.Chmod(path, 0600))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	// This is a real local Unix endpoint, not a fake CRI response. The test
	// exercises kernel credentials only and never produces runtime evidence.
	conn, err := dialCRI(ctx, path, uint32(os.Getuid()))
	must(t, err)
	conn.Close()
	if os.Getuid() != 0 {
		_, err = dialCRI(ctx, path, 0)
		requireError(t, err)
	}
	must(t, os.Chmod(path, 0666))
	_, err = dialCRI(ctx, path, uint32(os.Getuid()))
	requireError(t, err)
	must(t, os.Chmod(path, 0600))
	pinned, err := openSocket(path, uint32(os.Getuid()))
	must(t, err)
	defer pinned.close()
	must(t, pinned.current())
	listener.Close()
	replacement, err := net.Listen("unix", path)
	must(t, err)
	defer replacement.Close()
	must(t, os.Chmod(path, 0600))
	requireError(t, pinned.current())
}

func TestUnenrolledSourceRefusesBeforeAnyRuntimeRead(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("requires ordinary unprivileged fixture owner")
	}
	path := filepath.Join(t.TempDir(), "enrollment.json")
	must(t, os.WriteFile(path, encoded(testEnrollment()), 0600))
	_, err := Open(path)
	requireError(t, err)
	var copied Source
	requireError(t, copied.current())
}
