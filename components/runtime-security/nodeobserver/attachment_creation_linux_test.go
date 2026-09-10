//go:build linux

package nodeobserver

import (
	"bytes"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func attachmentFDReferences(t *testing.T, original unix.Stat_t) int {
	t.Helper()
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		fd, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		var st unix.Stat_t
		if unix.Fstat(fd, &st) == nil && st.Dev == original.Dev && st.Ino == original.Ino {
			count++
		}
	}
	return count
}

func TestAttachmentAcquirePacketRetainsActualNamespaceAfterSenderCloses(t *testing.T) {
	// This proves kernel descriptor transfer and retained namespace identity only.
	// No fake capture, CNI ADD, veth pair or installed fence is asserted.
	sender, receiver := attachmentPair(t)
	original, err := os.Open("/proc/self/ns/net")
	if err != nil {
		t.Fatal(err)
	}
	identity, err := attachmentNamespaceIdentity(original)
	if err != nil {
		original.Close()
		t.Fatal(err)
	}
	if _, _, err := sender.WriteMsgUnix([]byte("namespace"), unix.UnixRights(int(original.Fd())), nil); err != nil {
		original.Close()
		t.Fatal(err)
	}
	original.Close()
	sender.Close()
	raw, files, err := receiveAttachmentPacket(receiver, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer files[0].Close()
	if string(raw) != "namespace" || len(files) != 1 {
		t.Fatal("wrong packet or descriptor count")
	}
	actual, err := attachmentNamespaceIdentity(files[0])
	if err != nil || actual != identity {
		t.Fatalf("lost original namespace: %v", err)
	}
	flags, err := unix.FcntlInt(files[0].Fd(), unix.F_GETFD, 0)
	if err != nil || flags&unix.FD_CLOEXEC == 0 {
		t.Fatal("transferred descriptor lacks CLOEXEC")
	}
	if _, _, err := receiveAttachmentPacket(receiver, 1); err == nil {
		t.Fatal("disconnected acquisition accepted")
	}
}

func TestAttachmentAcquirePacketRejectsWrongRightsAndAncillary(t *testing.T) {
	for _, scenario := range []struct {
		name           string
		rights, extent int
		credentials    bool
	}{
		{"missing", 0, 1, false}, {"multiple", 2, 1, false}, {"maximum", 253, 1, false},
		{"truncated-payload", 1, MaxBytes + 1, false}, {"credentials", 1, 1, true},
		{"truncated-control", 253, 1, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			// Unique memfd identity exposes leaked receiver references, including the
			// descriptors that fit before kernel control-buffer truncation.
			fd, err := unix.MemfdCreate("attachment-acquire-rejected", unix.MFD_CLOEXEC)
			if err != nil {
				t.Fatal(err)
			}
			defer unix.Close(fd)
			var original unix.Stat_t
			if unix.Fstat(fd, &original) != nil {
				t.Fatal("memfd stat")
			}
			sender, receiver := attachmentPair(t)
			if scenario.credentials {
				raw, err := receiver.SyscallConn()
				if err != nil {
					t.Fatal(err)
				}
				var optionErr error
				if raw.Control(func(socket uintptr) {
					optionErr = unix.SetsockoptInt(int(socket), unix.SOL_SOCKET, unix.SO_PASSCRED, 1)
				}) != nil || optionErr != nil {
					t.Fatal("cannot enable kernel credentials")
				}
			}
			rights := make([]int, scenario.rights)
			for i := range rights {
				rights[i] = fd
			}
			var control []byte
			if len(rights) > 0 {
				control = unix.UnixRights(rights...)
			}
			if _, _, err := sender.WriteMsgUnix(bytes.Repeat([]byte{'x'}, scenario.extent), control, nil); err != nil {
				t.Fatal(err)
			}
			if _, _, err := receiveAttachmentPacket(receiver, 1); err == nil {
				t.Fatal("invalid acquisition packet accepted")
			}
			if count := attachmentFDReferences(t, original); count != 1 {
				t.Fatalf("leaked %d transferred references", count-1)
			}
		})
	}
}

func TestAttachmentAcquireReplyClosesDescriptorOnMalformedRecord(t *testing.T) {
	// Exercise rejection at the real reply boundary. These bytes deliberately
	// claim no successful runtime/CNI creation or valid physical attachment.
	for _, scenario := range []string{"json", "hash", "namespace", "request", "regular-file", "pid-namespace"} {
		t.Run(scenario, func(t *testing.T) {
			sender, receiver := attachmentPair(t)
			path := "/proc/self/ns/net"
			if scenario == "regular-file" {
				path = "/dev/null"
			}
			if scenario == "pid-namespace" {
				path = "/proc/self/ns/pid"
			}
			file, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			var original unix.Stat_t
			if unix.Fstat(int(file.Fd()), &original) != nil {
				t.Fatal("descriptor stat")
			}
			before := attachmentFDReferences(t, original)
			ns := attachmentNamespace{Device: uint64(original.Dev), Inode: original.Ino}
			request := attachmentRequest{SchemaVersion: 1, Operation: "ACQUIRE", RequestRef: "node:original", ContainerID: strings.Repeat("a", 64), NetworkName: "pods", InterfaceName: "eth0"}
			// A correctly shaped wire object allows distinct malformed fields to be
			// checked; it is never accepted as a genuine kernel topology in this test.
			record := attachmentRecord{SchemaVersion: 1, Kind: "closed-network-observation", ServiceInstance: strings.Repeat("b", 32), ObservationRef: strings.Repeat("c", 32), RequestRef: request.RequestRef, ContainerID: request.ContainerID, NetworkName: request.NetworkName, InterfaceName: request.InterfaceName, OperationRef: "original-operation", Topology: attachmentTopology{HostNamespace: attachmentNamespace{Device: ns.Device, Inode: ns.Inode + 1}, PodNamespace: ns, Host: attachmentLink{Index: 4, PeerIndex: 5, Name: "veth0", Kind: "veth", PeerNamespaceID: 0}, Pod: attachmentLink{Index: 5, PeerIndex: 4, Name: "eth0", Kind: "veth", PeerNamespaceID: 0}}, KernelIdentity: attachmentKernel{TableHandle: 1, FromHandle: 2, TowardHandle: 3}}
			if scenario == "namespace" {
				record.Topology.PodNamespace.Inode++
			}
			if scenario == "request" {
				record.RequestRef = "node:successor"
			}
			recordBytes := encoded(record)
			reply := attachmentReply{SchemaVersion: 1, Status: "observed", RequestRef: request.RequestRef, RecordDigest: hash(recordBytes), Record: json.RawMessage(recordBytes)}
			if scenario == "hash" {
				reply.RecordDigest = "sha256:" + strings.Repeat("0", 64)
			}
			payload := encoded(reply)
			if scenario == "json" {
				payload = []byte("{")
			}
			if _, _, err := sender.WriteMsgUnix(payload, unix.UnixRights(int(file.Fd())), nil); err != nil {
				t.Fatal(err)
			}
			a := &retainedAttachment{connection: receiver, request: request}
			if a.readAcquiredReply() == nil {
				if a.namespace != nil {
					a.namespace.Close()
				}
				t.Fatal("invalid acquisition reply accepted")
			}
			if a.namespace != nil {
				t.Fatal("rejected namespace adopted")
			}
			if after := attachmentFDReferences(t, original); after != before {
				t.Fatalf("namespace reference leak: before %d, after %d", before, after)
			}
		})
	}
}

func TestAttachmentAcquireRequiresActualCapture(t *testing.T) {
	var c *capture
	if _, err := c.acquireAttachment("pods", "eth0"); err == nil {
		t.Fatal("missing capture accepted")
	}
	if _, err := c.openAttachment(nil, "pods", "eth0"); err == nil {
		t.Fatal("OBSERVE silently became ACQUIRE")
	}
}
