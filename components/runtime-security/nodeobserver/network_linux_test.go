//go:build linux

package nodeobserver

import (
	"context"
	"encoding/binary"
	"os"
	"os/exec"
	"reflect"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// These byte-level cases exercise the actual kernel-message decoder. They do
// not create an enrolled source, a current attachment or a live fence proof.
func TestNetworkMessagesRefuseLossAndUntrustedOrigin(t *testing.T) {
	kernel := &unix.SockaddrNetlink{Family: unix.AF_NETLINK}
	valid := networkTestMessage(unix.RTM_NEWLINK, unix.NLM_F_MULTI, 1, 42, networkTestLink())
	messages, err := networkMessages(valid, 0, kernel)
	must(t, err)
	if len(messages) != 1 || messages[0].seq != 1 || messages[0].port != 42 {
		t.Fatal("lost dump provenance")
	}
	for _, tc := range []struct {
		name   string
		raw    []byte
		flags  int
		sender *unix.SockaddrNetlink
	}{
		{"truncated datagram", valid, unix.MSG_TRUNC, kernel},
		{"truncated control", valid, unix.MSG_CTRUNC, kernel},
		{"userspace sender", valid, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK, Pid: 5}},
		{"missing sender", valid, 0, nil},
		{"wrong family", valid, 0, &unix.SockaddrNetlink{Family: unix.AF_UNIX}},
		{"empty", nil, 0, kernel},
		{"short header", valid[:15], 0, kernel},
		{"partial payload", valid[:len(valid)-1], 0, kernel},
		{"trailing bytes", append(append([]byte(nil), valid...), 0), 0, kernel},
		{"interrupted dump", networkTestMessage(unix.RTM_NEWLINK, unix.NLM_F_DUMP_INTR, 1, 42, networkTestLink()), 0, kernel},
		{"overrun", networkTestMessage(unix.NLMSG_OVERRUN, 0, 0, 0, nil), 0, kernel},
		{"error or unexpected ack", networkTestMessage(unix.NLMSG_ERROR, 0, 1, 42, make([]byte, 4)), 0, kernel},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := networkMessages(tc.raw, tc.flags, tc.sender)
			requireError(t, err)
		})
	}
}

func TestNetworkLinkTopologyAndMalformedAttributes(t *testing.T) {
	raw := networkTestLink()
	link, err := parseNetworkLink(raw)
	must(t, err)
	expected := networkLink{Index: 7, PeerIndex: 12, MasterIndex: 3, PeerNamespaceID: -1, HasPeerNamespaceID: true, Name: "eth0", Kind: "veth", Flags: unix.IFF_UP}
	if !reflect.DeepEqual(link, expected) {
		t.Fatalf("unexpected topology: %#v", link)
	}
	// A peer namespace ID of -1 is retained as unknown, never turned into a
	// peer pairing or treated as the host network namespace.
	for _, tc := range []struct {
		name string
		raw  []byte
	}{
		{"short ifinfomsg", raw[:unix.SizeofIfInfomsg-1]},
		{"missing name", raw[:unix.SizeofIfInfomsg]},
		{"duplicate name", append(append([]byte(nil), raw...), networkTestAttribute(unix.IFLA_IFNAME, []byte("eth1\x00"))...)},
		{"partial attribute", append(append([]byte(nil), raw...), 0)},
		{"short integer", append(append([]byte(nil), raw[:unix.SizeofIfInfomsg]...), append(networkTestAttribute(unix.IFLA_IFNAME, []byte("eth0\x00")), networkTestAttribute(unix.IFLA_LINK, []byte{1})...)...)},
		{"network byte order", append(append([]byte(nil), raw[:unix.SizeofIfInfomsg]...), networkTestAttribute(unix.IFLA_IFNAME|0x4000, []byte("eth0\x00"))...)},
		{"embedded nul", append(append([]byte(nil), raw[:unix.SizeofIfInfomsg]...), networkTestAttribute(unix.IFLA_IFNAME, []byte("eth\x000\x00"))...)},
		{"unterminated name", append(append([]byte(nil), raw[:unix.SizeofIfInfomsg]...), networkTestAttribute(unix.IFLA_IFNAME, []byte("eth0"))...)},
		{"malformed nested info", append(append([]byte(nil), raw[:unix.SizeofIfInfomsg]...), append(networkTestAttribute(unix.IFLA_IFNAME, []byte("eth0\x00")), networkTestAttribute(unix.IFLA_LINKINFO, []byte{1, 0, 1, 0})...)...)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseNetworkLink(tc.raw)
			requireError(t, err)
		})
	}
	for _, index := range []uint32{0, 0xffffffff} {
		bad := append([]byte(nil), raw...)
		binary.NativeEndian.PutUint32(bad[4:], index)
		_, err := parseNetworkLink(bad)
		requireError(t, err)
	}
}

func TestNetworkNamespaceRetainsActualFDAndRefusesExitedProcess(t *testing.T) {
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
	ns, original, err := h.openNetworkNamespace()
	must(t, err)
	defer ns.Close()
	other, current, err := h.openNetworkNamespace()
	must(t, err)
	other.Close()
	if original.Ino == 0 || original.Dev != current.Dev || original.Ino != current.Ino {
		t.Fatal("did not retain the actual process network namespace")
	}
	flags, err := unix.FcntlInt(ns.Fd(), unix.F_GETFD, 0)
	must(t, err)
	if flags&unix.FD_CLOEXEC == 0 {
		t.Fatal("namespace handle would leak through exec")
	}
	must(t, child.Process.Kill())
	child.Wait()
	// The namespace FD still refers to the same kernel object after process
	// exit. Retaining it must not make the original process current again.
	var after unix.Stat_t
	must(t, unix.Fstat(int(ns.Fd()), &after))
	if after.Dev != original.Dev || after.Ino != original.Ino {
		t.Fatal("namespace FD changed object")
	}
	_, _, err = h.openNetworkNamespace()
	requireError(t, err)
}

func TestNetworkContributionCannotBeOpenedFromMissingProcess(t *testing.T) {
	var h *processHandle
	_, err := h.openNetwork(context.Background())
	requireError(t, err)
	var n retainedNetwork
	_, err = n.topology()
	requireError(t, err)
	n.close()
	var absent *retainedNetwork
	_, err = absent.topology()
	requireError(t, err)
	absent.close()
}

func FuzzNetworkKernelDecoders(f *testing.F) {
	f.Add(networkTestMessage(unix.RTM_NEWLINK, unix.NLM_F_MULTI, 1, 42, networkTestLink()))
	f.Add(networkTestLink())
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 256<<10 {
			return
		}
		_, _ = networkMessages(raw, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK})
		_, _ = parseNetworkLink(raw)
	})
}

func networkTestMessage(kind, flags uint16, seq, port uint32, data []byte) []byte {
	size := unix.NLMSG_HDRLEN + len(data)
	raw := make([]byte, (size+3)&^3)
	binary.NativeEndian.PutUint32(raw, uint32(size))
	binary.NativeEndian.PutUint16(raw[4:], kind)
	binary.NativeEndian.PutUint16(raw[6:], flags)
	binary.NativeEndian.PutUint32(raw[8:], seq)
	binary.NativeEndian.PutUint32(raw[12:], port)
	copy(raw[unix.NLMSG_HDRLEN:], data)
	return raw
}

func networkTestAttribute(kind uint16, data []byte) []byte {
	size := 4 + len(data)
	raw := make([]byte, (size+3)&^3)
	binary.NativeEndian.PutUint16(raw, uint16(size))
	binary.NativeEndian.PutUint16(raw[2:], kind)
	copy(raw[4:], data)
	return raw
}

func networkTestLink() []byte {
	raw := make([]byte, unix.SizeofIfInfomsg)
	binary.NativeEndian.PutUint32(raw[4:], 7)
	binary.NativeEndian.PutUint32(raw[8:], unix.IFF_UP)
	raw = append(raw, networkTestAttribute(unix.IFLA_IFNAME, []byte("eth0\x00"))...)
	for _, value := range []struct {
		key   uint16
		value uint32
	}{{unix.IFLA_LINK, 12}, {unix.IFLA_MASTER, 3}, {unix.IFLA_LINK_NETNSID, 0xffffffff}} {
		data := make([]byte, 4)
		binary.NativeEndian.PutUint32(data, value.value)
		raw = append(raw, networkTestAttribute(value.key, data)...)
	}
	return append(raw, networkTestAttribute(unix.IFLA_LINKINFO|0x8000, networkTestAttribute(unix.IFLA_INFO_KIND, []byte("veth\x00")))...)
}
