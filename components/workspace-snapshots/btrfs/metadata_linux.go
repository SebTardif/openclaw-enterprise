package btrfs

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"
)

// These fixed-size structures mirror Linux's stable UAPI in linux/btrfs.h.
// Unlike `subvolume show`, GET_SUBVOL_INFO does not enumerate snapshot history.
// This component supports the generic Linux ioctl ABI on amd64 and arm64.
type kernelTimespec struct {
	Seconds     uint64
	Nanoseconds uint32
	Pad         uint32
}
type kernelSubvolumeInfo struct {
	TreeID                                   uint64
	Name                                     [256]byte
	ParentID, DirectoryID, Generation, Flags uint64
	UUID, ParentUUID, ReceivedUUID           [16]byte
	CTransID, OTransID, STransID, RTransID   uint64
	CTime, OTime, STime, RTime               kernelTimespec
	Reserved                                 [8]uint64
}
type kernelFilesystemInfo struct {
	MaxID, NumDevices uint64
	FSID              [16]byte
	Rest              [992]byte
}

func kernelABI() error {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return ErrUnsupported
	}
	if unsafe.Sizeof(kernelSubvolumeInfo{}) != 504 || unsafe.Sizeof(kernelFilesystemInfo{}) != 1024 {
		return fmt.Errorf("unexpected Btrfs ioctl layout")
	}
	return nil
}

func (b *Backend) filesystemID(ctx context.Context, path string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := kernelABI(); err != nil {
		return "", err
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	var info kernelFilesystemInfo
	const request = uintptr(0x80000000 | 1024<<16 | 0x94<<8 | 31)
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), request, uintptr(unsafe.Pointer(&info)))
	if errno != 0 {
		return "", errno
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if info.FSID == [16]byte{} {
		return "", fmt.Errorf("empty Btrfs filesystem identity")
	}
	return uuidString(info.FSID[:]), nil
}

func (b *Backend) inspectSubvolume(ctx context.Context, path string) (subvolume, error) {
	var out subvolume
	if err := ctx.Err(); err != nil {
		return out, err
	}
	if err := kernelABI(); err != nil {
		return out, err
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return out, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return out, err
	}
	st, ok := stat.Sys().(*syscall.Stat_t)
	if !ok || st.Ino != 256 {
		return out, fmt.Errorf("path must name a Btrfs subvolume root")
	}
	if err := requireBtrfs(path); err != nil {
		return out, err
	}
	var info kernelSubvolumeInfo
	const request = uintptr(0x80000000 | 504<<16 | 0x94<<8 | 60)
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), request, uintptr(unsafe.Pointer(&info)))
	if errno != 0 {
		return out, errno
	}
	if err := ctx.Err(); err != nil {
		return out, err
	}
	if info.TreeID <= 5 || info.Generation == 0 || info.UUID == [16]byte{} || info.Flags & ^uint64(1) != 0 {
		return out, fmt.Errorf("invalid or unsupported Btrfs subvolume identity")
	}
	out.UUID = uuidString(info.UUID[:])
	out.Generation = info.Generation
	out.SendTransID = info.STransID
	out.ReadOnly = info.Flags&1 != 0
	if info.ParentUUID != [16]byte{} {
		out.ParentUUID = uuidString(info.ParentUUID[:])
	}
	if info.ReceivedUUID != [16]byte{} {
		out.ReceivedUUID = uuidString(info.ReceivedUUID[:])
	}
	return out, nil
}

func rejectSnapshotStubs(ctx context.Context, root string) error {
	count := 0
	var visit func(string, int) error
	visit = func(path string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if depth > 256 {
			return fmt.Errorf("workspace scope exceeds 256 directory levels")
		}
		f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		defer f.Close()
		for {
			entries, readErr := f.ReadDir(128)
			if readErr != nil && readErr != io.EOF {
				return readErr
			}
			for _, entry := range entries {
				if err := ctx.Err(); err != nil {
					return err
				}
				count++
				if count > 1_000_000 {
					return fmt.Errorf("workspace scope exceeds one million entries")
				}
				if !entry.IsDir() {
					continue
				}
				info, err := entry.Info()
				if err != nil {
					return err
				}
				st, ok := info.Sys().(*syscall.Stat_t)
				if !ok || !info.IsDir() {
					return fmt.Errorf("directory inode metadata unavailable or changed")
				}
				if st.Ino == 2 || st.Ino == 256 {
					return fmt.Errorf("nested Btrfs subvolume or snapshot stub is unsupported")
				}
				if err := visit(filepath.Join(path, entry.Name()), depth+1); err != nil {
					return err
				}
			}
			if readErr == io.EOF {
				return nil
			}
		}
	}
	return visit(root, 0)
}

func renameNoReplace(source, destination string) error {
	if err := kernelABI(); err != nil {
		return err
	}
	from, err := syscall.BytePtrFromString(source)
	if err != nil {
		return err
	}
	to, err := syscall.BytePtrFromString(destination)
	if err != nil {
		return err
	}
	// syscall's frozen amd64 API does not name renameat2. These syscall numbers
	// and AT_FDCWD/RENAME_NOREPLACE are the Linux amd64/arm64 UAPI.
	number := uintptr(316)
	if runtime.GOARCH == "arm64" {
		number = 276
	}
	_, _, errno := syscall.Syscall6(number, ^uintptr(99), uintptr(unsafe.Pointer(from)), ^uintptr(99), uintptr(unsafe.Pointer(to)), 1, 0)
	if errno != 0 {
		return errno
	}
	return nil
}
