//go:build linux

package nodeobserver

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

type protectedFile struct {
	file  *os.File
	path  string
	stat  unix.Stat_t
	owner uint32
}

func openProtected(path string, directory bool, owner uint32) (*protectedFile, error) {
	flags := unix.O_RDONLY | unix.O_CLOEXEC | unix.O_NOFOLLOW | unix.O_NONBLOCK
	if directory {
		flags |= unix.O_DIRECTORY
	}
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{Flags: uint64(flags), Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, ErrUnavailable
	}
	f := &protectedFile{file: os.NewFile(uintptr(fd), "protected-node-source"), path: path, owner: owner}
	if unix.Fstat(fd, &f.stat) != nil || f.stat.Uid != owner || f.stat.Mode&0022 != 0 || (directory && f.stat.Mode&unix.S_IFMT != unix.S_IFDIR) || (!directory && f.stat.Mode&unix.S_IFMT != unix.S_IFREG) {
		f.file.Close()
		return nil, ErrUnavailable
	}
	return f, nil
}

func (f *protectedFile) current() error {
	if f == nil || f.file == nil {
		return ErrUnavailable
	}
	n, err := openProtected(f.path, f.stat.Mode&unix.S_IFMT == unix.S_IFDIR, f.owner)
	if err != nil {
		return err
	}
	defer n.file.Close()
	if n.stat.Dev != f.stat.Dev || n.stat.Ino != f.stat.Ino || n.stat.Mode != f.stat.Mode || n.stat.Uid != f.stat.Uid || n.stat.Gid != f.stat.Gid {
		return ErrUnavailable
	}
	// Runtime directory entries change as Pods start and stop. Pin the root
	// identity and protection; content immutability applies to regular files.
	if f.stat.Mode&unix.S_IFMT == unix.S_IFREG && (n.stat.Size != f.stat.Size || n.stat.Mtim != f.stat.Mtim || n.stat.Ctim != f.stat.Ctim) {
		return ErrUnavailable
	}
	return nil
}

func (f *protectedFile) bytes(limit int64) ([]byte, error) {
	if f.current() != nil {
		return nil, ErrUnavailable
	}
	raw, err := io.ReadAll(io.NewSectionReader(f.file, 0, limit+1))
	if err != nil || int64(len(raw)) > limit || f.current() != nil {
		return nil, ErrUnavailable
	}
	return raw, nil
}

func fileHash(ctx context.Context, file *os.File, max int64) (string, error) {
	h := sha256.New()
	reader := io.NewSectionReader(file, 0, max+1)
	buf := make([]byte, 64<<10)
	var count int64
	for {
		if ctx.Err() != nil {
			return "", ErrUnavailable
		}
		n, err := reader.Read(buf)
		count += int64(n)
		if count > max {
			return "", ErrUnavailable
		}
		h.Write(buf[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", ErrUnavailable
		}
	}
	return "sha256:" + hex.EncodeToString(h.Sum(nil)), nil
}

type processHandle struct {
	directory  *os.File
	pidfd      int
	process    Process
	owner      uint32
	executable unix.Stat_t
}

func openProcess(ctx context.Context, pid int, expected string, owner uint32) (*processHandle, error) {
	if pid < 1 || pid > 4194304 || !digest.MatchString(expected) {
		return nil, ErrUnavailable
	}
	root, err := os.Open("/proc")
	if err != nil {
		return nil, ErrUnavailable
	}
	defer root.Close()
	var fs unix.Statfs_t
	if unix.Fstatfs(int(root.Fd()), &fs) != nil || fs.Type != unix.PROC_SUPER_MAGIC {
		return nil, ErrUnavailable
	}
	fd, err := unix.Openat(int(root.Fd()), strconv.Itoa(pid), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, ErrUnavailable
	}
	h := &processHandle{directory: os.NewFile(uintptr(fd), "node-process"), pidfd: -1, owner: owner}
	ok := false
	defer func() {
		if !ok {
			h.close()
		}
	}()
	var st unix.Stat_t
	if unix.Fstat(fd, &st) != nil || st.Uid != owner {
		return nil, ErrUnavailable
	}
	h.pidfd, err = unix.PidfdOpen(pid, 0)
	if err != nil {
		return nil, ErrUnavailable
	}
	start, err := h.read("stat", 8192)
	if err != nil {
		return nil, ErrUnavailable
	}
	ticks, err := startTicks(start, pid)
	if err != nil {
		return nil, err
	}
	exe, err := unix.Openat(fd, "exe", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, ErrUnavailable
	}
	f := os.NewFile(uintptr(exe), "node-process-executable")
	if unix.Fstat(exe, &h.executable) != nil {
		f.Close()
		return nil, ErrUnavailable
	}
	observed, err := fileHash(ctx, f, 256<<20)
	f.Close()
	if err != nil || observed != expected {
		return nil, ErrUnavailable
	}
	buf := make([]byte, 128)
	n, err := unix.Readlinkat(fd, "ns/pid", buf)
	if err != nil || n == len(buf) {
		return nil, ErrUnavailable
	}
	h.process = Process{PID: pid, StartTicks: ticks, ExecutableDigest: observed, PIDNamespace: string(buf[:n])}
	if h.current() != nil {
		return nil, ErrUnavailable
	}
	ok = true
	return h, nil
}

func (h *processHandle) read(name string, limit int64) ([]byte, error) {
	fd, err := unix.Openat(int(h.directory.Fd()), name, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, ErrUnavailable
	}
	f := os.NewFile(uintptr(fd), "node-process-field")
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(raw)) > limit {
		return nil, ErrUnavailable
	}
	return raw, nil
}
func startTicks(raw []byte, pid int) (string, error) {
	s := string(raw)
	end := strings.LastIndex(s, ")")
	prefix := strconv.Itoa(pid) + " ("
	if !strings.HasPrefix(s, prefix) || end < 0 {
		return "", ErrUnavailable
	}
	fields := strings.Fields(s[end+1:])
	if len(fields) < 20 || fields[0] == "Z" || fields[0] == "X" {
		return "", ErrUnavailable
	}
	v, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || v == 0 || strconv.FormatUint(v, 10) != fields[19] {
		return "", ErrUnavailable
	}
	return fields[19], nil
}
func (h *processHandle) current() error {
	if h == nil || h.directory == nil || h.pidfd < 0 {
		return ErrUnavailable
	}
	fds := []unix.PollFd{{Fd: int32(h.pidfd), Events: unix.POLLIN}}
	n, err := unix.Poll(fds, 0)
	if err != nil || n != 0 {
		return ErrUnavailable
	}
	raw, err := h.read("stat", 8192)
	if err != nil {
		return err
	}
	ticks, err := startTicks(raw, h.process.PID)
	if err != nil || ticks != h.process.StartTicks {
		return ErrUnavailable
	}
	buf := make([]byte, 128)
	count, err := unix.Readlinkat(int(h.directory.Fd()), "ns/pid", buf)
	if err != nil || string(buf[:count]) != h.process.PIDNamespace {
		return ErrUnavailable
	}
	exe, err := unix.Openat(int(h.directory.Fd()), "exe", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return ErrUnavailable
	}
	var observed unix.Stat_t
	err = unix.Fstat(exe, &observed)
	unix.Close(exe)
	if err != nil || observed.Dev != h.executable.Dev || observed.Ino != h.executable.Ino || observed.Size != h.executable.Size || observed.Mtim != h.executable.Mtim || observed.Ctim != h.executable.Ctim {
		return ErrUnavailable
	}
	return nil
}
func (h *processHandle) close() {
	if h.directory != nil {
		h.directory.Close()
		h.directory = nil
	}
	if h.pidfd >= 0 {
		unix.Close(h.pidfd)
		h.pidfd = -1
	}
}

// Dial only the selected protected socket. Kernel credentials and inode identity
// are checked around connection establishment; no caller supplies an FD or peer.
type protectedSocket struct {
	fd    int
	path  string
	owner uint32
	stat  unix.Stat_t
}

func openSocket(path string, owner uint32) (*protectedSocket, error) {
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{Flags: unix.O_PATH | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, ErrUnavailable
	}
	s := &protectedSocket{fd: fd, path: path, owner: owner}
	if unix.Fstat(fd, &s.stat) != nil || s.stat.Mode&unix.S_IFMT != unix.S_IFSOCK || s.stat.Uid != owner || s.stat.Mode&0002 != 0 {
		unix.Close(fd)
		return nil, ErrUnavailable
	}
	return s, nil
}
func (s *protectedSocket) current() error {
	if s == nil || s.fd < 0 {
		return ErrUnavailable
	}
	again, err := openSocket(s.path, s.owner)
	if err != nil {
		return err
	}
	defer again.close()
	if again.stat.Dev != s.stat.Dev || again.stat.Ino != s.stat.Ino || again.stat.Mode != s.stat.Mode || again.stat.Uid != s.stat.Uid || again.stat.Ctim != s.stat.Ctim {
		return ErrUnavailable
	}
	return nil
}
func (s *protectedSocket) close() {
	if s.fd >= 0 {
		unix.Close(s.fd)
		s.fd = -1
	}
}
func (s *protectedSocket) dial(ctx context.Context) (net.Conn, error) {
	if s.current() != nil {
		return nil, ErrUnavailable
	}
	connection, err := dialCRI(ctx, s.path, s.owner)
	if err != nil {
		return nil, err
	}
	if s.current() != nil {
		connection.Close()
		return nil, ErrUnavailable
	}
	return connection, nil
}

func dialCRI(ctx context.Context, path string, owner uint32) (net.Conn, error) {
	var before unix.Stat_t
	fd, err := unix.Openat2(unix.AT_FDCWD, path, &unix.OpenHow{Flags: unix.O_PATH | unix.O_CLOEXEC, Resolve: unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS})
	if err != nil {
		return nil, ErrUnavailable
	}
	defer unix.Close(fd)
	if unix.Fstat(fd, &before) != nil || before.Mode&unix.S_IFMT != unix.S_IFSOCK || before.Uid != owner || before.Mode&0002 != 0 {
		return nil, ErrUnavailable
	}
	d := net.Dialer{Timeout: time.Second}
	conn, err := d.DialContext(ctx, "unix", path)
	if err != nil {
		return nil, ErrUnavailable
	}
	ok := false
	defer func() {
		if !ok {
			conn.Close()
		}
	}()
	u, valid := conn.(*net.UnixConn)
	if !valid {
		return nil, ErrUnavailable
	}
	raw, err := u.SyscallConn()
	if err != nil {
		return nil, ErrUnavailable
	}
	var credentials *unix.Ucred
	var socketErr error
	if raw.Control(func(fd uintptr) {
		credentials, socketErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}) != nil || socketErr != nil || credentials == nil || credentials.Uid != owner {
		return nil, ErrUnavailable
	}
	var after unix.Stat_t
	if unix.Lstat(path, &after) != nil || before.Ino != after.Ino || before.Dev != after.Dev || before.Mode != after.Mode || before.Uid != after.Uid {
		return nil, ErrUnavailable
	}
	ok = true
	return conn, nil
}

type boundedOutput struct {
	mu sync.Mutex
	bytes.Buffer
	overflow bool
}

func (b *boundedOutput) Write(raw []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.Len()+len(raw) > 64<<10 {
		b.overflow = true
		return 0, ErrUnavailable
	}
	return b.Buffer.Write(raw)
}

// Execute only the original pinned runtime FD, with its retained state directory.
// The command supplies physical state, never authority. It runs under the exact
// capture deadline and its actual process is joined on every completion path.
func runtimeState(ctx context.Context, binary, root *protectedFile, sandbox string) ([]byte, error) {
	if !runtimeID.MatchString(sandbox) || binary.current() != nil || root.current() != nil {
		return nil, ErrUnavailable
	}
	cmd := exec.CommandContext(ctx, "/proc/self/fd/3", "--root=/proc/self/fd/4", "state", sandbox)
	cmd.ExtraFiles = []*os.File{binary.file, root.file}
	cmd.Env = []string{"LANG=C", "LC_ALL=C"}
	cmd.Stdin = nil
	cmd.SysProcAttr = &unix.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = time.Second
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return unix.Kill(-cmd.Process.Pid, unix.SIGKILL)
	}
	var output boundedOutput
	cmd.Stdout = &output
	cmd.Stderr = io.Discard
	if cmd.Run() != nil || output.overflow || ctx.Err() != nil || binary.current() != nil || root.current() != nil {
		return nil, ErrUnavailable
	}
	return bytes.Clone(output.Bytes()), nil
}
