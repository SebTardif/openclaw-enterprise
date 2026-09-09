//go:build linux

package portable

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

func owned(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Geteuid())
}

func supportedHost() error { return nil }

func inspectMetadata(name string, info os.FileInfo) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%w: unavailable inode metadata", ErrUnsupported)
	}
	if !info.IsDir() && stat.Nlink != 1 {
		return fmt.Errorf("%w: hardlinked entry", ErrUnsupported)
	}
	if info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		return fmt.Errorf("%w: special permission bits", ErrUnsupported)
	}
	// llistxattr observes the link itself, never its possibly external target.
	pointer, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	size, _, errno := syscall.Syscall(syscall.SYS_LLISTXATTR, uintptr(unsafe.Pointer(pointer)), 0, 0)
	runtime.KeepAlive(pointer)
	if errno != 0 && !errors.Is(errno, syscall.ENOTSUP) {
		return fmt.Errorf("inspect extended attributes: %w", errno)
	}
	if errno == 0 && size != 0 {
		return fmt.Errorf("%w: extended attributes or ACLs", ErrUnsupported)
	}
	return nil
}
