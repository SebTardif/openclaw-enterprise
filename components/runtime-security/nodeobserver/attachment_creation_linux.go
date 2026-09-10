//go:build linux

package nodeobserver

import (
	"net"
	"os"

	"golang.org/x/sys/unix"
)

// acquireAttachment receives the namespace directly from the fence's original
// continuously retained ADD attempt. No caller supplies a namespace FD or path.
// The actual capture supplies SandboxID and requestRef. Compute must separately
// retain the create-effect/assignment association and, across bounded reads,
// require the same serviceInstance + operationRef. Acquisition proves neither
// Work/execution-purpose ownership nor permission to open an endpoint.
func (c *capture) acquireAttachment(networkName, interfaceName string) (*retainedAttachment, error) {
	return c.attachment(nil, networkName, interfaceName)
}

// The caller owns the construction mutex and already authenticated the protected
// root peer. Namespace and record are adopted together only after validation.
func (a *retainedAttachment) readAcquiredReply() error {
	if a.namespace != nil || a.request.Operation != "ACQUIRE" {
		return ErrUnavailable
	}
	raw, files, err := receiveAttachmentPacket(a.connection, 1)
	if err != nil {
		return err
	}
	namespace := files[0]
	accepted := false
	defer func() {
		if !accepted {
			namespace.Close()
		}
	}()
	identity, err := attachmentNamespaceIdentity(namespace)
	if err != nil {
		return err
	}
	a.namespaceIdentity = identity
	if a.acceptReply(raw, "observed") != nil {
		a.namespaceIdentity = attachmentNamespace{}
		return ErrUnavailable
	}
	a.namespace = namespace
	accepted = true
	return nil
}

// Receive all kernel-delivered descriptors into ownership before applying packet
// or protocol validation. MSG_CMSG_CLOEXEC prevents a concurrent child from
// inheriting them. Every rejection closes all received rights, including on
// truncated payload/control, wrong cardinality or unexpected ancillary messages.
// Only ACQUIRE's initial reply permits exactly one descriptor; all other replies
// require zero. Kernel namespace type and record identity are checked separately.
func receiveAttachmentPacket(connection *net.UnixConn, expectedRights int) ([]byte, []*os.File, error) {
	if connection == nil || (expectedRights != 0 && expectedRights != 1) {
		return nil, nil, ErrUnavailable
	}
	raw, err := connection.SyscallConn()
	if err != nil {
		return nil, nil, ErrUnavailable
	}
	data := make([]byte, MaxBytes)
	control := make([]byte, unix.CmsgSpace(253*4))
	var count, ancillary, flags int
	var receiveErr error
	err = raw.Read(func(fd uintptr) bool {
		count, ancillary, flags, _, receiveErr = unix.Recvmsg(int(fd), data, control, unix.MSG_CMSG_CLOEXEC)
		return receiveErr != unix.EAGAIN && receiveErr != unix.EWOULDBLOCK
	})
	// Control headers and descriptor numbers here are produced by the kernel.
	if ancillary < 0 || ancillary > len(control) {
		return nil, nil, ErrUnavailable
	}
	messages, controlErr := unix.ParseSocketControlMessage(control[:ancillary])
	files := make([]*os.File, 0, 1)
	accepted := false
	defer func() {
		if !accepted {
			for _, file := range files {
				file.Close()
			}
		}
	}()
	invalid := false
	rightsMessages := 0
	for _, message := range messages {
		if message.Header.Level != unix.SOL_SOCKET || message.Header.Type != unix.SCM_RIGHTS {
			invalid = true
			continue
		}
		rightsMessages++
		descriptors, parseErr := unix.ParseUnixRights(&message)
		if parseErr != nil {
			invalid = true
		}
		for _, fd := range descriptors {
			if fd < 0 {
				invalid = true
				continue
			}
			files = append(files, os.NewFile(uintptr(fd), "fence-transferred-namespace"))
			fdFlags, flagErr := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
			if flagErr != nil || fdFlags&unix.FD_CLOEXEC == 0 {
				invalid = true
			}
		}
	}
	if err != nil || receiveErr != nil || controlErr != nil || invalid || rightsMessages > 1 || len(files) != expectedRights || flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 || count <= 0 || count > MaxBytes {
		return nil, nil, ErrUnavailable
	}
	accepted = true
	return data[:count], files, nil
}
