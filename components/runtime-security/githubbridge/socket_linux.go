//go:build linux

package githubbridge

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// unixEndpoint owns only the created endpoint. Never unlink a path that existed
// before admission or that now names a different inode.
type unixEndpoint struct {
	listener *net.UnixListener
	path     string
	info     os.FileInfo
}

func protectedAncestors(path string, allowed []uint32) error {
	current := filepath.Dir(path)
	immediate := true
	for {
		info, e := os.Lstat(current)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 {
			return errRejected
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return errRejected
		}
		trusted := false
		for _, uid := range allowed {
			if uid == st.Uid {
				trusted = true
			}
		}
		if !trusted {
			return errRejected
		}
		if immediate && (st.Uid != uint32(os.Geteuid()) || info.Mode().Perm() != 0700) {
			return errRejected
		}
		immediate = false
		if current == "/" {
			break
		}
		current = filepath.Dir(current)
	}
	return nil
}
func listenProtected(p Profile) (*unixEndpoint, error) {
	if !pathValid(p.ListenPath) || strings.HasPrefix(p.ListenPath, "@") || protectedAncestors(p.ListenPath, p.TrustedAncestorUIDs) != nil {
		return nil, errRejected
	}
	if _, e := os.Lstat(p.ListenPath); !os.IsNotExist(e) {
		return nil, errRejected
	}
	listener, e := net.ListenUnix("unix", &net.UnixAddr{Name: p.ListenPath, Net: "unix"})
	if e != nil {
		return nil, errRejected
	}
	listener.SetUnlinkOnClose(false)
	ep := &unixEndpoint{listener: listener, path: p.ListenPath}
	info, e := os.Lstat(p.ListenPath)
	if e != nil {
		listener.Close()
		return nil, errRejected
	}
	ep.info = info
	if info.Mode()&os.ModeSocket == 0 || os.Chmod(p.ListenPath, 0600) != nil || protectedAncestors(p.ListenPath, p.TrustedAncestorUIDs) != nil {
		ep.close()
		return nil, errRejected
	}
	after, e := os.Lstat(p.ListenPath)
	if e != nil || !os.SameFile(info, after) || after.Mode().Perm() != 0600 {
		ep.close()
		return nil, errRejected
	}
	return ep, nil
}
func (e *unixEndpoint) close() {
	if e == nil {
		return
	}
	e.listener.Close()
	now, err := os.Lstat(e.path)
	if err == nil && e.info != nil && os.SameFile(e.info, now) {
		_ = os.Remove(e.path)
	}
}
func peerUID(c *net.UnixConn, expected uint32) error {
	raw, e := c.SyscallConn()
	if e != nil {
		return errRejected
	}
	var cred *unix.Ucred
	var inner error
	e = raw.Control(func(fd uintptr) { cred, inner = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED) })
	if e != nil || inner != nil || cred == nil || cred.Uid != expected {
		return errRejected
	}
	return nil
}
