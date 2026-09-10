//go:build linux

package nodeobserver

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"runtime"
	"sort"
	"sync"

	"golang.org/x/sys/unix"
)

// These observations are not attachment, fence, original-effect or current-grant
// authority. A netns inode and link indexes identify only retained kernel objects
// during this handle's uninterrupted lifetime. In particular, PeerIndex and
// PeerNamespaceID do not establish a cross-namespace veth pairing by themselves.
// For a runsc sentry this is the sentry process's namespace, which is not
// automatically the workload/CNI attachment namespace. That correspondence must
// come from the original runtime and CNI owners, not from these observations.
type networkLink struct {
	Index, PeerIndex, MasterIndex int32
	PeerNamespaceID               int32
	HasPeerNamespaceID            bool
	Name, Kind                    string
	Flags                         uint32
}

type networkTopology struct {
	NamespaceDevice, NamespaceInode uint64
	Links                           []networkLink
}

// retainedNetwork has no exported constructor or restorable representation.
// TODO(node-fence): join this physical contribution to the original admitted
// CNI attachment and installed-rule observer before exposing a network record.
// The existing physical execution protocol deliberately remains unchanged.
type retainedNetwork struct {
	self    *retainedNetwork
	mu      sync.Mutex
	process *processHandle
	netns   *os.File
	stat    unix.Stat_t
	route   int
	port    uint32
	links   []networkLink
	valid   bool
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
}

// openNetwork must be called while the original process handle is retained by
// its owner. It obtains independent process/namespace custody, compares against
// that original handle, and never accepts a caller-provided namespace path/FD.
func (h *processHandle) openNetwork(ctx context.Context) (*retainedNetwork, error) {
	if ctx == nil || ctx.Err() != nil || h.current() != nil {
		return nil, ErrUnavailable
	}
	n := &retainedNetwork{route: -1, done: make(chan struct{})}
	n.self = n
	n.ctx, n.cancel = context.WithTimeout(ctx, Lifetime)
	ok := false
	defer func() {
		if !ok {
			n.cancel()
			n.release()
		}
	}()
	var err error
	n.process, err = openProcess(n.ctx, h.process.PID, h.process.ExecutableDigest, h.owner)
	if err != nil || n.process.process != h.process || h.current() != nil {
		return nil, ErrUnavailable
	}
	n.netns, n.stat, err = n.process.openNetworkNamespace()
	if err != nil {
		return nil, ErrUnavailable
	}
	n.route, n.port, err = openNetworkRoute(n.netns, n.stat)
	if err != nil {
		return nil, ErrUnavailable
	}
	n.links, err = n.initialLinks()
	if err != nil || n.namespaceCurrent() != nil || n.drain() != nil {
		return nil, ErrUnavailable
	}
	n.valid = true
	ok = true
	go n.watch()
	return n, nil
}

func (h *processHandle) openNetworkNamespace() (*os.File, unix.Stat_t, error) {
	var st unix.Stat_t
	if h.current() != nil {
		return nil, st, ErrUnavailable
	}
	// The proc directory and live process are retained. Following this specific
	// procfs magic link is intentional; arbitrary supplied links are not accepted.
	fd, err := unix.Openat(int(h.directory.Fd()), "ns/net", unix.O_RDONLY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, st, ErrUnavailable
	}
	f := os.NewFile(uintptr(fd), "node-network-namespace")
	var fs unix.Statfs_t
	kind, err := unix.IoctlRetInt(fd, unix.NS_GET_NSTYPE)
	if err != nil || kind != unix.CLONE_NEWNET || unix.Fstatfs(fd, &fs) != nil || fs.Type != unix.NSFS_MAGIC || unix.Fstat(fd, &st) != nil || h.current() != nil {
		f.Close()
		return nil, st, ErrUnavailable
	}
	return f, st, nil
}

func (n *retainedNetwork) namespaceCurrent() error {
	if n.ctx.Err() != nil || n.process == nil || n.netns == nil {
		return ErrUnavailable
	}
	f, st, err := n.process.openNetworkNamespace()
	if err != nil {
		return ErrUnavailable
	}
	f.Close()
	var retained unix.Stat_t
	if unix.Fstat(int(n.netns.Fd()), &retained) != nil || st.Dev != n.stat.Dev || st.Ino != n.stat.Ino || retained.Dev != n.stat.Dev || retained.Ino != n.stat.Ino {
		return ErrUnavailable
	}
	return nil
}

// Only the socket-creating thread enters the retained namespace. A restoration
// failure destroys that locked thread when the goroutine exits; it must never
// return a thread in the workload namespace to the Go scheduler.
func openNetworkRoute(target *os.File, targetStat unix.Stat_t) (int, uint32, error) {
	type result struct {
		fd   int
		port uint32
		err  error
	}
	resultCh := make(chan result, 1)
	go func() {
		runtime.LockOSThread()
		restored := true
		defer func() {
			if restored {
				runtime.UnlockOSThread()
			}
		}()
		origin, err := os.Open("/proc/thread-self/ns/net")
		if err != nil {
			resultCh <- result{fd: -1, err: ErrUnavailable}
			return
		}
		defer origin.Close()
		var st unix.Stat_t
		if unix.Fstat(int(origin.Fd()), &st) != nil {
			resultCh <- result{fd: -1, err: ErrUnavailable}
			return
		}
		changed := st.Dev != targetStat.Dev || st.Ino != targetStat.Ino
		if changed {
			if unix.Setns(int(target.Fd()), unix.CLONE_NEWNET) != nil {
				resultCh <- result{fd: -1, err: ErrUnavailable}
				return
			}
			restored = false
		}
		fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK, unix.NETLINK_ROUTE)
		if changed {
			restored = unix.Setns(int(origin.Fd()), unix.CLONE_NEWNET) == nil
		}
		if err != nil || !restored {
			if fd >= 0 {
				unix.Close(fd)
			}
			resultCh <- result{fd: -1, err: ErrUnavailable}
			return
		}
		// Never enable NETLINK_NO_ENOBUFS: notification loss is terminal. Bind
		// before requesting the dump so deletion/reuse during capture is visible.
		if unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_RCVBUF, 256<<10) != nil || unix.Bind(fd, &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Groups: unix.RTMGRP_LINK}) != nil {
			unix.Close(fd)
			resultCh <- result{fd: -1, err: ErrUnavailable}
			return
		}
		address, err := unix.Getsockname(fd)
		nl, yes := address.(*unix.SockaddrNetlink)
		if err != nil || !yes || nl.Pid == 0 {
			unix.Close(fd)
			resultCh <- result{fd: -1, err: ErrUnavailable}
			return
		}
		resultCh <- result{fd: fd, port: nl.Pid}
	}()
	r := <-resultCh
	return r.fd, r.port, r.err
}

type networkMessage struct {
	kind, flags uint16
	seq, port   uint32
	data        []byte
}

func networkMessages(raw []byte, flags int, sender *unix.SockaddrNetlink) ([]networkMessage, error) {
	if flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 || sender == nil || sender.Family != unix.AF_NETLINK || sender.Pid != 0 || len(raw) == 0 {
		return nil, ErrUnavailable
	}
	var out []networkMessage
	for len(raw) > 0 {
		if len(raw) < unix.NLMSG_HDRLEN {
			return nil, ErrUnavailable
		}
		size := int(binary.NativeEndian.Uint32(raw))
		if size < unix.NLMSG_HDRLEN || size > len(raw) || (size+3)&^3 > len(raw) {
			return nil, ErrUnavailable
		}
		m := networkMessage{kind: binary.NativeEndian.Uint16(raw[4:]), flags: binary.NativeEndian.Uint16(raw[6:]), seq: binary.NativeEndian.Uint32(raw[8:]), port: binary.NativeEndian.Uint32(raw[12:]), data: raw[unix.NLMSG_HDRLEN:size]}
		if m.flags&unix.NLM_F_DUMP_INTR != 0 || m.kind == unix.NLMSG_OVERRUN || m.kind == unix.NLMSG_ERROR {
			return nil, ErrUnavailable
		}
		out = append(out, m)
		raw = raw[(size+3)&^3:]
	}
	return out, nil
}

func (n *retainedNetwork) receive() ([]networkMessage, error) {
	raw := make([]byte, 256<<10)
	count, _, flags, address, err := unix.Recvmsg(n.route, raw, nil, unix.MSG_DONTWAIT)
	if err != nil {
		return nil, err
	}
	sender, _ := address.(*unix.SockaddrNetlink)
	return networkMessages(raw[:count], flags, sender)
}

func (n *retainedNetwork) initialLinks() ([]networkLink, error) {
	raw := make([]byte, unix.NLMSG_HDRLEN+unix.SizeofIfInfomsg)
	binary.NativeEndian.PutUint32(raw, uint32(len(raw)))
	binary.NativeEndian.PutUint16(raw[4:], unix.RTM_GETLINK)
	binary.NativeEndian.PutUint16(raw[6:], unix.NLM_F_REQUEST|unix.NLM_F_DUMP)
	binary.NativeEndian.PutUint32(raw[8:], 1)
	if unix.Sendto(n.route, raw, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}) != nil {
		return nil, ErrUnavailable
	}
	var links []networkLink
	seen := make(map[int32]bool)
	for n.ctx.Err() == nil {
		messages, err := n.receive()
		if err == unix.EAGAIN || err == unix.EWOULDBLOCK {
			if networkPoll(n.route) != nil {
				return nil, ErrUnavailable
			}
			continue
		}
		if err != nil {
			return nil, ErrUnavailable
		}
		for i, m := range messages {
			// Sequence zero is a concurrent multicast change, never dump data.
			if m.seq != 1 || m.port != n.port || m.flags&unix.NLM_F_MULTI == 0 {
				return nil, ErrUnavailable
			}
			if m.kind == unix.NLMSG_DONE {
				if i != len(messages)-1 || (len(m.data) != 0 && (len(m.data) != 4 || binary.NativeEndian.Uint32(m.data) != 0)) || len(links) == 0 {
					return nil, ErrUnavailable
				}
				sort.Slice(links, func(i, j int) bool { return links[i].Index < links[j].Index })
				return links, nil
			}
			if m.kind != unix.RTM_NEWLINK || len(links) >= 4096 {
				return nil, ErrUnavailable
			}
			link, err := parseNetworkLink(m.data)
			if err != nil || seen[link.Index] {
				return nil, ErrUnavailable
			}
			seen[link.Index] = true
			links = append(links, link)
		}
	}
	return nil, ErrUnavailable
}

// Every post-dump message invalidates this conservative lineage contribution.
// This includes NEWLINK on an unchanged index, deletion/recreation, unexpected
// control messages and notification loss. No resynchronization can revive it.
func (n *retainedNetwork) drain() error {
	_, err := n.receive()
	if err == unix.EAGAIN || err == unix.EWOULDBLOCK {
		return nil
	}
	return ErrUnavailable
}

func networkPoll(fd int) error {
	fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
	_, err := unix.Poll(fds, 50)
	if err != nil || fds[0].Revents & ^int16(unix.POLLIN) != 0 {
		return ErrUnavailable
	}
	return nil
}

func (n *retainedNetwork) watch() {
	defer close(n.done)
	defer func() {
		n.mu.Lock()
		defer n.mu.Unlock()
		n.valid = false
		n.release()
	}()
	for {
		if n.ctx.Err() != nil || networkPoll(n.route) != nil {
			return
		}
		n.mu.Lock()
		if !n.valid || n.namespaceCurrent() != nil || n.drain() != nil {
			n.valid = false
			n.mu.Unlock()
			return
		}
		n.mu.Unlock()
	}
}

func (n *retainedNetwork) topology() (networkTopology, error) {
	if n == nil || n.self != n {
		return networkTopology{}, ErrUnavailable
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if !n.valid || n.namespaceCurrent() != nil || n.drain() != nil {
		n.valid = false
		return networkTopology{}, ErrUnavailable
	}
	return networkTopology{NamespaceDevice: uint64(n.stat.Dev), NamespaceInode: n.stat.Ino, Links: append([]networkLink(nil), n.links...)}, nil
}

func (n *retainedNetwork) close() {
	if n == nil || n.self != n {
		return
	}
	n.cancel()
	<-n.done
}

func (n *retainedNetwork) release() {
	if n.route >= 0 {
		unix.Close(n.route)
		n.route = -1
	}
	if n.netns != nil {
		n.netns.Close()
		n.netns = nil
	}
	if n.process != nil {
		n.process.close()
		n.process = nil
	}
}

func networkAttributes(raw []byte) (map[uint16][]byte, error) {
	out := make(map[uint16][]byte)
	for len(raw) > 0 {
		if len(raw) < 4 {
			return nil, ErrUnavailable
		}
		size := int(binary.NativeEndian.Uint16(raw))
		encodedKind := binary.NativeEndian.Uint16(raw[2:])
		kind := encodedKind & 0x3fff
		if encodedKind&0x4000 != 0 || size < 4 || size > len(raw) || (size+3)&^3 > len(raw) {
			return nil, ErrUnavailable
		}
		if _, duplicate := out[kind]; duplicate {
			return nil, ErrUnavailable
		}
		out[kind] = raw[4:size]
		raw = raw[(size+3)&^3:]
	}
	return out, nil
}

func networkString(raw []byte, limit int) (string, error) {
	if len(raw) < 2 || len(raw) > limit || raw[len(raw)-1] != 0 || bytes.IndexByte(raw[:len(raw)-1], 0) >= 0 {
		return "", ErrUnavailable
	}
	return string(raw[:len(raw)-1]), nil
}

func parseNetworkLink(raw []byte) (networkLink, error) {
	var link networkLink
	if len(raw) < unix.SizeofIfInfomsg {
		return link, ErrUnavailable
	}
	link.Index = int32(binary.NativeEndian.Uint32(raw[4:]))
	link.Flags = binary.NativeEndian.Uint32(raw[8:])
	attrs, err := networkAttributes(raw[unix.SizeofIfInfomsg:])
	if err != nil || link.Index <= 0 {
		return link, ErrUnavailable
	}
	link.Name, err = networkString(attrs[unix.IFLA_IFNAME], unix.IFNAMSIZ)
	if err != nil {
		return link, ErrUnavailable
	}
	for key, target := range map[uint16]*int32{unix.IFLA_LINK: &link.PeerIndex, unix.IFLA_MASTER: &link.MasterIndex, unix.IFLA_LINK_NETNSID: &link.PeerNamespaceID} {
		if value, exists := attrs[key]; exists {
			if len(value) != 4 {
				return link, ErrUnavailable
			}
			*target = int32(binary.NativeEndian.Uint32(value))
			if key == unix.IFLA_LINK_NETNSID {
				link.HasPeerNamespaceID = true
			} else if *target < 0 {
				return link, ErrUnavailable
			}
		}
	}
	if nested, exists := attrs[unix.IFLA_LINKINFO]; exists {
		info, err := networkAttributes(nested)
		if err != nil {
			return link, ErrUnavailable
		}
		if kind, exists := info[unix.IFLA_INFO_KIND]; exists {
			link.Kind, err = networkString(kind, 64)
			if err != nil {
				return link, ErrUnavailable
			}
		}
	}
	return link, nil
}
