//go:build linux

package nodeobserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func attachmentPair(t *testing.T) (*net.UnixConn, *net.UnixConn) {
	t.Helper()
	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	connect := func(fd int) *net.UnixConn {
		f := os.NewFile(uintptr(fd), "attachment-test-packet")
		c, err := net.FileConn(f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		u := c.(*net.UnixConn)
		u.SetDeadline(time.Now().Add(time.Second))
		t.Cleanup(func() { u.Close() })
		return u
	}
	return connect(fds[0]), connect(fds[1])
}
func TestAttachmentActualPacketBoundariesAndDisconnect(t *testing.T) {
	sender, receiver := attachmentPair(t)
	for _, payload := range []string{"first", "second"} {
		if _, err := sender.Write([]byte(payload)); err != nil {
			t.Fatal(err)
		}
	}
	sender.Close()
	for _, want := range []string{"first", "second"} {
		raw, err := readAttachmentPacket(receiver)
		if err != nil || string(raw) != want {
			t.Fatalf("packet %q, %v", raw, err)
		}
	}
	if _, err := readAttachmentPacket(receiver); err == nil {
		t.Fatal("disconnect accepted")
	}
}
func TestAttachmentActualOversizedPacketRejected(t *testing.T) {
	sender, receiver := attachmentPair(t)
	if _, err := sender.Write(bytes.Repeat([]byte{'x'}, MaxBytes+1)); err != nil {
		t.Fatal(err)
	}
	if _, err := readAttachmentPacket(receiver); err == nil {
		t.Fatal("truncated packet accepted")
	}
}
func TestAttachmentUnexpectedRightsClosedEvenWithTruncation(t *testing.T) {
	// A unique memfd lets the test detect leaked transferred ownership without
	// relying on a process-wide FD count that concurrent tests could change.
	fd, err := unix.MemfdCreate("attachment-rejected-rights", unix.MFD_CLOEXEC)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	var original unix.Stat_t
	if unix.Fstat(fd, &original) != nil {
		t.Fatal("memfd stat")
	}
	for _, extent := range []int{1, MaxBytes + 1} {
		sender, receiver := attachmentPair(t)
		rights := make([]int, 253)
		for i := range rights {
			rights[i] = fd
		}
		if _, _, err := sender.WriteMsgUnix(bytes.Repeat([]byte{'x'}, extent), unix.UnixRights(rights...), nil); err != nil {
			t.Fatal(err)
		}
		if _, err := readAttachmentPacket(receiver); err == nil {
			t.Fatal("unexpected rights accepted")
		}
		entries, err := os.ReadDir("/proc/self/fd")
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for _, entry := range entries {
			n, e := strconv.Atoi(entry.Name())
			if e != nil {
				continue
			}
			var st unix.Stat_t
			if unix.Fstat(n, &st) == nil && st.Dev == original.Dev && st.Ino == original.Ino {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("received rights leaked: %d references", count)
		}
	}
}
func TestAttachmentNamespaceRequiresActualNetworkNS(t *testing.T) {
	f, err := os.Open("/proc/self/ns/net")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	identity, err := attachmentNamespaceIdentity(f)
	if err != nil || identity.Inode == 0 {
		t.Fatalf("actual netns: %v", err)
	}
	for _, path := range []string{"/proc/self/ns/pid", "/dev/null"} {
		other, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		_, err = attachmentNamespaceIdentity(other)
		other.Close()
		if err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
	f.Close()
	if _, err := attachmentNamespaceIdentity(f); err == nil {
		t.Fatal("closed namespace accepted")
	}
}
func TestAttachmentKernelPeerCredentials(t *testing.T) {
	sender, _ := attachmentPair(t)
	err := attachmentRootPeer(sender)
	if (os.Geteuid() == 0) != (err == nil) {
		t.Fatalf("root peer result disagrees with kernel UID: %v", err)
	}
	sender.Close()
	if attachmentRootPeer(sender) == nil {
		t.Fatal("closed peer accepted")
	}
}
func TestAttachmentClosedJSONSchemaAndUint64(t *testing.T) {
	raw := []byte(`{"tableHandle":18446744073709551615,"fromHandle":2,"towardHandle":3}`)
	var kernel attachmentKernel
	if decodeAttachment(raw, &kernel) != nil || kernel.TableHandle != ^uint64(0) {
		t.Fatal("native uint64 lost")
	}
	for _, bad := range []string{
		`{"tableHandle":1,"tableHandle":2,"fromHandle":2,"towardHandle":3}`,
		`{"TableHandle":1,"fromHandle":2,"towardHandle":3}`,
		`{"tableHandle":1,"fromHandle":2,"towardHandle":3,"extra":1}`,
		`{"tableHandle":1,"fromHandle":2}`,
		`{"tableHandle":null,"fromHandle":2,"towardHandle":3}`,
		`{"tableHandle":1e0,"fromHandle":2,"towardHandle":3}`,
		`{"tableHandle":18446744073709551616,"fromHandle":2,"towardHandle":3}`,
	} {
		if decodeAttachment([]byte(bad), &kernel) == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	var record attachmentRecord
	raw = encoded(attachmentRecord{})
	raw = bytes.Replace(raw, []byte(`"device":0`), []byte(`"device":0,"device":1`), 1)
	if decodeAttachment(raw, &record) == nil {
		t.Fatal("nested duplicate accepted")
	}
}
func TestAttachmentCurrentReplyCannotReplaceObservation(t *testing.T) {
	// This is parser/packet coverage only; no fabricated capture or mock fence
	// is used to claim runtime namespace association or actual installed DROP.
	for _, change := range []string{"valid", "digest", "request", "record", "status"} {
		t.Run(change, func(t *testing.T) {
			sender, receiver := attachmentPair(t)
			original := "sha256:" + strings.Repeat("a", 64)
			reply := attachmentReply{SchemaVersion: 1, Status: "current", RequestRef: "original", RecordDigest: original, Record: json.RawMessage("null")}
			switch change {
			case "digest":
				reply.RecordDigest = "sha256:" + strings.Repeat("b", 64)
			case "request":
				reply.RequestRef = "successor"
			case "record":
				reply.Record = json.RawMessage("{}")
			case "status":
				reply.Status = "observed"
			}
			if _, err := sender.Write(encoded(reply)); err != nil {
				t.Fatal(err)
			}
			a := retainedAttachment{connection: receiver, request: attachmentRequest{RequestRef: "original"}, digest: original}
			err := a.readReply("current")
			if (change == "valid") != (err == nil) {
				t.Fatalf("unexpected protocol result: %v", err)
			}
		})
	}
}
func TestAttachmentMissingAndCopiedCustodyRejected(t *testing.T) {
	var c *capture
	if _, err := c.openAttachment(nil, "pods", "eth0"); err == nil {
		t.Fatal("missing capture accepted")
	}
	original := &retainedAttachment{}
	original.self = original
	copied := &retainedAttachment{self: original}
	if _, err := copied.inspect(); err == nil {
		t.Fatal("copied custody accepted")
	}
}

func TestAttachmentExpiryReleasesOwnedDescriptors(t *testing.T) {
	// Exercise actual resource teardown without constructing runtime authority.
	// The session is deliberately incomplete and never used for an observation.
	connection, peer := attachmentPair(t)
	namespace, err := os.Open("/proc/self/ns/net")
	if err != nil {
		t.Fatal(err)
	}
	directory, err := unix.Open("/", unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		namespace.Close()
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &retainedAttachment{connection: connection, namespace: namespace, path: &attachmentPath{directory: directory}, ctx: ctx, cancel: cancel}
	a.self = a
	a.mu.Lock()
	a.armExpiry()
	a.mu.Unlock()
	t.Cleanup(a.close)
	cancel()
	if _, err := readAttachmentPacket(peer); err == nil {
		t.Fatal("expired socket stayed open")
	}
	deadline := time.Now().Add(time.Second)
	for {
		a.mu.Lock()
		closed := a.closed
		a.mu.Unlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("expiry failed to release resources")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := namespace.Stat(); err == nil {
		t.Fatal("expiry retained namespace descriptor")
	}
	if a.path.directory != -1 {
		t.Fatal("expiry retained protected path descriptor")
	}
	a.close()
}

func TestAttachmentRequestReferenceReplyAlphabetAndExtent(t *testing.T) {
	// These are real packet/reply decoder checks only. The wire topology is test
	// data, not a fabricated positive capture or evidence of an installed fence.
	for _, scenario := range []struct {
		name       string
		requestRef string
		recordRef  string
		accepted   bool
	}{
		{"slash-colon", "source:/node/1:request", "source:/node/1:request", true},
		{"200-bytes", strings.Repeat("a", 198) + ":/", strings.Repeat("a", 198) + ":/", true},
		{"201-bytes", strings.Repeat("a", 199) + ":/", strings.Repeat("a", 199) + ":/", false},
		{"unsupported-character", "node?request", "node?request", false},
		{"no-reference-mapping", "source:node/1", "source/node:1", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			sender, receiver := attachmentPair(t)
			request := attachmentRequest{SchemaVersion: 1, Operation: "OBSERVE", RequestRef: scenario.requestRef, ContainerID: strings.Repeat("a", 64), NetworkName: "pods", InterfaceName: "eth0"}
			namespace := attachmentNamespace{Device: 1, Inode: 2}
			record := attachmentRecord{
				SchemaVersion: 1, Kind: "closed-network-observation", ServiceInstance: strings.Repeat("b", 32), ObservationRef: strings.Repeat("c", 32),
				RequestRef: scenario.recordRef, ContainerID: request.ContainerID, NetworkName: request.NetworkName, InterfaceName: request.InterfaceName, OperationRef: "original-operation",
				Topology: attachmentTopology{HostNamespace: attachmentNamespace{Device: 1, Inode: 3}, PodNamespace: namespace,
					Host: attachmentLink{Index: 4, PeerIndex: 5, Name: "veth0", Kind: "veth", PeerNamespaceID: 0},
					Pod:  attachmentLink{Index: 5, PeerIndex: 4, Name: "eth0", Kind: "veth", PeerNamespaceID: 0}},
				KernelIdentity: attachmentKernel{TableHandle: 1, FromHandle: 2, TowardHandle: 3},
			}
			original := encoded(record)
			reply := attachmentReply{SchemaVersion: 1, Status: "observed", RequestRef: request.RequestRef, RecordDigest: hash(original), Record: json.RawMessage(original)}
			if _, err := sender.Write(encoded(reply)); err != nil {
				t.Fatal(err)
			}
			a := retainedAttachment{connection: receiver, request: request, namespaceIdentity: namespace}
			err := a.readReply("observed")
			if (err == nil) != scenario.accepted {
				t.Fatalf("accepted=%v, error=%v", scenario.accepted, err)
			}
			if scenario.accepted && (a.record.RequestRef != scenario.requestRef || !bytes.Equal(a.raw, original)) {
				t.Fatal("original reference or record bytes changed")
			}
		})
	}
}

func TestAttachmentNetworkAndInterfaceSelectorsRemainRestricted(t *testing.T) {
	// Invalid selectors must fail before touching any source. This deliberately
	// incomplete capture is used only for negative input checks, never observation.
	c := &capture{ctx: context.Background()}
	for _, selectors := range [][2]string{{"pods/name", "eth0"}, {"pods:name", "eth0"}, {"pods", "eth/0"}, {"pods", "eth:0"}} {
		if _, err := c.acquireAttachment(selectors[0], selectors[1]); err == nil {
			t.Fatalf("invalid selectors accepted: %q", selectors)
		}
	}
}
