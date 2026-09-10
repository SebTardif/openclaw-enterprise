//go:build linux

package nodeobserver

import (
	"bytes"
	"context"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// retainedAttachment owns one uninterrupted observation session and a duplicate
// of the original CNI namespace descriptor. It cannot be restored from a record.
// The namespace comes either from original upstream custody (OBSERVE) or from
// the fence's continuously retained original ADD attempt (ACQUIRE).
// TODO(original-runtime-attachment): Compute must associate that original ADD
// attempt with its sandbox creation/Pod/create-effect owner and bracket uses
// with that owner's currentness. This helper does not establish Work authority.
// The physical execution service does not expose this contribution yet.
type retainedAttachment struct {
	self              *retainedAttachment
	capture           *capture
	request           attachmentRequest
	namespace         *os.File
	namespaceIdentity attachmentNamespace
	path              *attachmentPath
	connection        *net.UnixConn
	ctx               context.Context
	cancel            context.CancelFunc
	stop              func() bool
	mu                sync.Mutex
	closed            bool
	inspections       int
	record            attachmentRecord
	raw               []byte
	digest            string
}

// namespace must come from the original runtime/CNI owner, not a path reopened
// from a supplied record or the sentry's possibly unrelated network namespace.
// networkName/interfaceName are correlation selectors, never authority.
func (c *capture) openAttachment(namespace *os.File, networkName, interfaceName string) (*retainedAttachment, error) {
	if namespace == nil {
		return nil, ErrUnavailable
	}
	return c.attachment(namespace, networkName, interfaceName)
}

// Both acquisition paths share capture, transport, lifetime and reply checks.
// A nil namespace selects ACQUIRE; its descriptor must arrive from the daemon.
func (c *capture) attachment(namespace *os.File, networkName, interfaceName string) (*retainedAttachment, error) {
	if c == nil || c.ctx == nil || !attachmentReference.MatchString(networkName) || !attachmentInterface.MatchString(interfaceName) || c.current() != nil || !runtimeID.MatchString(c.record.Physical.SandboxID) || !ref.MatchString(c.request.RequestRef) {
		return nil, ErrUnavailable
	}
	operation := "OBSERVE"
	if namespace == nil {
		operation = "ACQUIRE"
	}
	a := &retainedAttachment{capture: c, request: attachmentRequest{SchemaVersion: 1, Operation: operation, RequestRef: c.request.RequestRef, ContainerID: c.record.Physical.SandboxID, NetworkName: networkName, InterfaceName: interfaceName}}
	a.self = a
	a.ctx, a.cancel = context.WithTimeout(c.ctx, Lifetime)
	ok := false
	defer func() {
		if !ok {
			a.close()
		}
	}()
	var err error
	var rights []byte
	if namespace != nil {
		raw, err := namespace.SyscallConn()
		if err != nil {
			return nil, ErrUnavailable
		}
		duplicated := -1
		var duplicateErr error
		if raw.Control(func(fd uintptr) { duplicated, duplicateErr = unix.FcntlInt(fd, unix.F_DUPFD_CLOEXEC, 0) }) != nil || duplicateErr != nil || duplicated < 0 {
			return nil, ErrUnavailable
		}
		a.namespace = os.NewFile(uintptr(duplicated), "original-cni-namespace")
		a.namespaceIdentity, err = attachmentNamespaceIdentity(a.namespace)
		if err != nil {
			return nil, err
		}
		rights = unix.UnixRights(duplicated)
	}
	a.path, err = openAttachmentPath()
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: time.Second}
	conn, err := dialer.DialContext(a.ctx, "unixpacket", attachmentSocketPath)
	if err != nil {
		return nil, ErrUnavailable
	}
	var yes bool
	a.connection, yes = conn.(*net.UnixConn)
	if !yes {
		conn.Close()
		return nil, ErrUnavailable
	}
	// Serialize construction with expiry cleanup. Closing the socket happens
	// before taking the mutex so cancellation also interrupts blocked I/O.
	a.mu.Lock()
	defer a.mu.Unlock()
	a.armExpiry()
	if a.sourceCurrent() != nil || a.deadline() != nil {
		return nil, ErrUnavailable
	}
	payload := encoded(a.request)
	n, oob, err := a.connection.WriteMsgUnix(payload, rights, nil)
	if err != nil || n != len(payload) || oob != len(rights) {
		return nil, ErrUnavailable
	}
	if namespace == nil {
		err = a.readAcquiredReply()
	} else {
		err = a.readReply("observed")
	}
	if err != nil || a.physicalCurrent() != nil {
		return nil, ErrUnavailable
	}
	ok = true
	return a, nil
}

// Called under the construction mutex after the connection is installed.
func (a *retainedAttachment) armExpiry() {
	a.stop = context.AfterFunc(a.ctx, func() {
		a.connection.Close()
		a.mu.Lock()
		defer a.mu.Unlock()
		a.release()
	})
}

func attachmentNamespaceIdentity(file *os.File) (attachmentNamespace, error) {
	var identity attachmentNamespace
	if file == nil {
		return identity, ErrUnavailable
	}
	raw, err := file.SyscallConn()
	if err != nil {
		return identity, ErrUnavailable
	}
	valid := false
	err = raw.Control(func(fd uintptr) {
		var st unix.Stat_t
		var fs unix.Statfs_t
		kind, e := unix.IoctlRetInt(int(fd), unix.NS_GET_NSTYPE)
		if e == nil && kind == unix.CLONE_NEWNET && unix.Fstatfs(int(fd), &fs) == nil && fs.Type == unix.NSFS_MAGIC && unix.Fstat(int(fd), &st) == nil && st.Ino != 0 {
			identity = attachmentNamespace{Device: uint64(st.Dev), Inode: st.Ino}
			valid = true
		}
	})
	if err != nil || !valid {
		return attachmentNamespace{}, ErrUnavailable
	}
	return identity, nil
}
func (a *retainedAttachment) deadline() error {
	d, ok := a.ctx.Deadline()
	if !ok || a.ctx.Err() != nil {
		return ErrUnavailable
	}
	if limit := time.Now().Add(time.Second); limit.Before(d) {
		d = limit
	}
	return a.connection.SetDeadline(d)
}
func (a *retainedAttachment) sourceCurrent() error {
	if a.ctx.Err() != nil || a.capture.current() != nil || a.path.current() != nil || attachmentRootPeer(a.connection) != nil {
		return ErrUnavailable
	}
	return nil
}
func (a *retainedAttachment) physicalCurrent() error {
	if a.sourceCurrent() != nil {
		return ErrUnavailable
	}
	identity, err := attachmentNamespaceIdentity(a.namespace)
	if err != nil || identity != a.namespaceIdentity {
		return ErrUnavailable
	}
	return nil
}
func (a *retainedAttachment) readReply(status string) error {
	raw, err := readAttachmentPacket(a.connection)
	if err != nil {
		return err
	}
	return a.acceptReply(raw, status)
}
func (a *retainedAttachment) acceptReply(raw []byte, status string) error {
	var reply attachmentReply
	if decodeAttachment(raw, &reply) != nil || reply.SchemaVersion != 1 || reply.Status != status || reply.RequestRef != a.request.RequestRef || !digest.MatchString(reply.RecordDigest) {
		return ErrUnavailable
	}
	if status == "current" {
		if reply.RecordDigest != a.digest || !bytes.Equal(bytes.TrimSpace(reply.Record), []byte("null")) {
			return ErrUnavailable
		}
		return nil
	}
	var record attachmentRecord
	if hash(reply.Record) != reply.RecordDigest || decodeAttachment(reply.Record, &record) != nil || !record.matches(a.request, a.namespaceIdentity) {
		return ErrUnavailable
	}
	a.record = record
	a.raw = bytes.Clone(reply.Record)
	a.digest = reply.RecordDigest
	return nil
}

// inspect performs fresh readback through the original connection. Every
// failure is terminal; a later successful packet cannot revive this session.
func (a *retainedAttachment) inspect() (attachmentRecord, error) {
	if a == nil || a.self != a {
		return attachmentRecord{}, ErrUnavailable
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	fail := func() (attachmentRecord, error) { a.release(); return attachmentRecord{}, ErrUnavailable }
	if a.closed || a.inspections >= 16 || a.physicalCurrent() != nil || a.deadline() != nil {
		return fail()
	}
	a.inspections++
	command := encoded(attachmentInspect{SchemaVersion: 1, Operation: "INSPECT", RequestRef: a.request.RequestRef, ObservationRef: a.record.ObservationRef, RecordDigest: a.digest})
	if n, err := a.connection.Write(command); err != nil || n != len(command) {
		return fail()
	}
	if a.readReply("current") != nil || a.physicalCurrent() != nil {
		return fail()
	}
	return a.record, nil
}
func (a *retainedAttachment) close() {
	if a == nil || a.self != a {
		return
	}
	a.cancel()
	if a.connection != nil {
		a.connection.Close()
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.release()
}
func (a *retainedAttachment) release() {
	if a.closed {
		return
	}
	a.closed = true
	a.cancel()
	if a.stop != nil {
		a.stop()
	}
	if a.connection != nil {
		a.connection.Close()
	}
	if a.namespace != nil {
		a.namespace.Close()
	}
	if a.path != nil {
		a.path.close()
	}
}

// The entire fixed path has protected root-owned ancestry, no symlinks, and
// an exact mode-0600 socket. Retain both parent and socket inode identities.
type attachmentPath struct {
	directory     int
	directoryStat unix.Stat_t
	socket        *protectedSocket
}

func openAttachmentPath() (*attachmentPath, error) {
	if os.Geteuid() != 0 {
		return nil, ErrUnavailable
	}
	fd, err := unix.Open("/", unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, ErrUnavailable
	}
	p := &attachmentPath{directory: fd}
	ok := false
	defer func() {
		if !ok {
			p.close()
		}
	}()
	components := append([]string{""}, strings.Split(strings.TrimPrefix(strings.TrimSuffix(attachmentSocketPath, "/control.sock"), "/"), "/")...)
	for _, part := range components {
		if part != "" {
			next, e := unix.Openat(p.directory, part, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
			if e != nil {
				return nil, ErrUnavailable
			}
			unix.Close(p.directory)
			p.directory = next
		}
		if unix.Fstat(p.directory, &p.directoryStat) != nil || p.directoryStat.Mode&unix.S_IFMT != unix.S_IFDIR || p.directoryStat.Uid != 0 || p.directoryStat.Mode&0022 != 0 {
			return nil, ErrUnavailable
		}
	}
	p.socket, err = openSocket(attachmentSocketPath, 0)
	if err != nil || p.socket.stat.Mode&07777 != 0600 {
		return nil, ErrUnavailable
	}
	ok = true
	return p, nil
}
func (p *attachmentPath) current() error {
	if p == nil || p.directory < 0 || p.socket == nil {
		return ErrUnavailable
	}
	again, err := openAttachmentPath()
	if err != nil {
		return err
	}
	defer again.close()
	if again.directoryStat.Dev != p.directoryStat.Dev || again.directoryStat.Ino != p.directoryStat.Ino || again.socket.stat.Dev != p.socket.stat.Dev || again.socket.stat.Ino != p.socket.stat.Ino || again.socket.stat.Ctim != p.socket.stat.Ctim {
		return ErrUnavailable
	}
	return nil
}
func (p *attachmentPath) close() {
	if p.socket != nil {
		p.socket.close()
	}
	if p.directory >= 0 {
		unix.Close(p.directory)
		p.directory = -1
	}
}
func attachmentRootPeer(connection *net.UnixConn) error {
	if connection == nil {
		return ErrUnavailable
	}
	raw, err := connection.SyscallConn()
	if err != nil {
		return ErrUnavailable
	}
	var credentials *unix.Ucred
	var socketErr error
	if raw.Control(func(fd uintptr) {
		credentials, socketErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}) != nil || socketErr != nil || credentials == nil || credentials.Uid != 0 || credentials.Pid <= 0 {
		return ErrUnavailable
	}
	return nil
}

// Ordinary observation and INSPECT replies never transfer descriptors.
func readAttachmentPacket(connection *net.UnixConn) ([]byte, error) {
	raw, _, err := receiveAttachmentPacket(connection, 0)
	return raw, err
}
