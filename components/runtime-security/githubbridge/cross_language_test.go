package githubbridge

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
	"golang.org/x/sys/unix"
)

// fixturePeerProcess pins the actual socket peer process with a pidfd before
// TLS authentication. Only after the exact handshake succeeds does the fixture
// expose test-only stop/resume controls. A caller can never supply a PID.
// SO_PEERPIDFD obtains the exact socket process atomically; no numeric-PID
// lookup or signal can affect a replacement process after PID reuse.
type fixturePeerProcess struct {
	fd, pid int
	paused  bool
}

// fixturePeerError exposes only fixed diagnostic stages and numeric syscall
// errors. It never includes process IDs, proc paths, credentials or metadata.
type fixturePeerError struct {
	stage string
	err   error
}

func (e *fixturePeerError) Error() string       { return e.stage }
func (e *fixturePeerError) Unwrap() error       { return e.err }
func peerFailure(stage string, err error) error { return &fixturePeerError{stage: stage, err: err} }

// Only fixed error categories cross the external test boundary. In particular,
// a local I/O deadline or write failure is not evidence of a peer refusal.
func fixtureIOError(err error) (string, bool) {
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		return "timeout", true
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "peer-eof", false
	}
	if errors.Is(err, syscall.ECONNRESET) {
		return "peer-reset", false
	}
	return "other", false
}

// ReadFrame deliberately sanitizes errors. Retain only the actual transport's
// original I/O error for fixed-category diagnostics, without changing parsing.
type fixtureObservedReader struct {
	io.Reader
	err error
}

func (r *fixtureObservedReader) Read(buffer []byte) (int, error) {
	n, err := r.Reader.Read(buffer)
	if err != nil {
		r.err = err
	}
	return n, err
}

func TestCrossLanguageReadFailureCategories(t *testing.T) {
	for _, closePeer := range []bool{true, false} {
		name := "local-read-deadline"
		if closePeer {
			name = "remote-eof"
		}
		t.Run(name, func(t *testing.T) {
			client, peer := net.Pipe()
			defer client.Close()
			defer peer.Close()
			must(t, client.SetReadDeadline(time.Now().Add(50*time.Millisecond)))
			if closePeer {
				must(t, peer.Close())
			}
			// Both failures pass through the actual parser, which sanitizes its
			// error. Only the retained underlying I/O separates timeout from EOF.
			observed := &fixtureObservedReader{Reader: client}
			frame, err := ReadFrame(observed)
			if frame != nil || err == nil {
				t.Fatal("expected actual incomplete-frame refusal")
			}
			code, timedOut := fixtureIOError(observed.err)
			if closePeer {
				if code != "peer-eof" || timedOut {
					t.Fatal("remote EOF was not distinguished")
				}
			} else if code != "timeout" || !timedOut {
				t.Fatal("local read deadline was accepted as peer closure")
			}
		})
	}
}

// Poll the original client socket without reading, writing, or setting a deadline.
// Its client's current authority is inspected separately before this observation.
func fixturePeerWriteClosed(raw net.Conn) (bool, error) {
	connection, ok := raw.(*net.UnixConn)
	if !ok {
		return false, errRejected
	}
	fd, err := connection.SyscallConn()
	if err != nil {
		return false, err
	}
	var closed bool
	var inner error
	err = fd.Control(func(value uintptr) {
		fds := []unix.PollFd{{Fd: int32(value), Events: unix.POLLRDHUP}}
		for {
			_, inner = unix.Poll(fds, 0)
			if !errors.Is(inner, unix.EINTR) {
				break
			}
		}
		if inner == nil && fds[0].Revents&(unix.POLLNVAL|unix.POLLERR) != 0 {
			inner = errRejected
		}
		closed = fds[0].Revents&(unix.POLLRDHUP|unix.POLLHUP) != 0
	})
	if err != nil {
		return false, err
	}
	return closed, inner
}

func captureFixturePeer(raw net.Conn) (*fixturePeerProcess, error) {
	connection, ok := raw.(*net.UnixConn)
	if !ok {
		return nil, errRejected
	}
	fd, err := connection.SyscallConn()
	if err != nil {
		return nil, errRejected
	}
	var cred *unix.Ucred
	var inner error
	pidfd := -1
	err = fd.Control(func(value uintptr) {
		cred, inner = unix.GetsockoptUcred(int(value), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if inner == nil {
			pidfd, inner = unix.GetsockoptInt(int(value), unix.SOL_SOCKET, unix.SO_PEERPIDFD)
		}
	})
	if err != nil || inner != nil || cred == nil || cred.Pid <= 0 || cred.Uid != uint32(os.Geteuid()) || pidfd < 0 {
		if pidfd >= 0 {
			unix.Close(pidfd)
		}
		return nil, errRejected
	}
	unix.CloseOnExec(pidfd)
	return &fixturePeerProcess{fd: pidfd, pid: int(cred.Pid)}, nil
}
func (p *fixturePeerProcess) exited() (bool, error) {
	fds := []unix.PollFd{{Fd: int32(p.fd), Events: unix.POLLIN}}
	for {
		_, err := unix.Poll(fds, 0)
		// Go runtime signals can interrupt a raw poll. EINTR says nothing about
		// this original process and must not become a failed state observation.
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return false, err
		}
		if fds[0].Revents&unix.POLLNVAL != 0 {
			return false, peerFailure("pidfd-invalid", unix.EBADF)
		}
		if fds[0].Revents&unix.POLLERR != 0 {
			return false, peerFailure("pidfd-error", unix.EIO)
		}
		// Only process exit readiness establishes retirement. A closed or
		// otherwise invalid descriptor must never be treated as an exited peer.
		return fds[0].Revents&(unix.POLLIN|unix.POLLHUP) != 0, nil
	}
}
func (p *fixturePeerProcess) state() (string, error) {
	done, err := p.exited()
	if err != nil {
		return "", peerFailure("pidfd-poll-before", err)
	}
	if done {
		return "exited", nil
	}
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(p.pid), "status"))
	after, afterErr := p.exited()
	if afterErr != nil {
		return "", peerFailure("pidfd-poll-after", afterErr)
	}
	if after {
		return "exited", nil
	}
	if err != nil {
		return "", peerFailure("proc-status-read", err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "State:") {
			words := strings.Fields(line)
			if len(words) < 2 {
				return "", peerFailure("proc-state-empty", nil)
			}
			if words[1] == "T" || words[1] == "t" {
				return "stopped", nil
			}
			return "running", nil
		}
	}
	return "", peerFailure("proc-state-missing", nil)
}
func (p *fixturePeerProcess) signal(stop bool) (string, error) {
	signal := unix.SIGCONT
	expected := "running"
	if stop {
		signal = unix.SIGSTOP
		expected = "stopped"
	}
	if state, err := p.state(); err != nil {
		return "", err
	} else if state == "exited" {
		if stop {
			return "", errRejected
		}
		p.paused = false
		return state, nil
	}
	if err := unix.PidfdSendSignal(p.fd, signal, nil, 0); err != nil {
		return "", errRejected
	}
	p.paused = stop
	until := time.Now().Add(time.Second)
	for time.Now().Before(until) {
		state, err := p.state()
		if err != nil {
			return "", err
		}
		if state == expected || (!stop && state == "exited") {
			return state, nil
		}
		time.Sleep(time.Millisecond)
	}
	return "", errRejected
}
func (p *fixturePeerProcess) close() {
	if p.paused {
		_ = unix.PidfdSendSignal(p.fd, unix.SIGCONT, nil, 0)
		p.paused = false
	}
	_ = unix.Close(p.fd)
}

// TestCrossLanguageFixture is compiled only into a test binary. It substitutes
// the external Workload API and acts as a real DS TLS client. It contains no
// broker, current-registration adapter, Work grant, policy callback or issuer.
// The consuming Node test must install its real trust/identity/accepting owners.
func TestCrossLanguageFixture(t *testing.T) {
	if os.Getenv("OCE_GITHUB_BRIDGE_FIXTURE") != "1" {
		t.Skip("explicit cross-language external fixture only")
	}
	dir := protectedDirectory(t)
	ca := newCA(t)
	serverSVID := ca.issue(t, serverID)
	serverPath, serverAPI := api(t, dir, "bapi", serverSVID)
	clientPath, _ := api(t, dir, "capi", ca.issue(t, clientID))
	profile := Profile{Version: 1, WorkloadAPISocketPath: serverPath, OwnSPIFFEID: serverID, PeerSPIFFEID: clientID, RecipientSPIFFEID: serverID, TrustBundleSHA256: digest(serverSVID.Bundle), ListenPath: filepath.Join(dir, "broker"), PeerUID: uint32(os.Getuid()), HandshakeTimeoutMs: 1000, RecheckIntervalMs: 100, MaxConnectionAgeMs: 30000, RequestTimeoutMs: 3000}
	switch os.Getenv("OCE_GITHUB_BRIDGE_FIXTURE_PROTOCOL_VERSION") {
	case "":
	case "3":
		profile.ProtocolVersion = 3
	default:
		t.Fatal("unsupported external fixture protocol selection")
	}
	profile.TrustedAncestorUIDs = ancestorUIDs(t, profile.ListenPath)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	source, e := identity.NewSource(identity.Options{SocketPath: clientPath, ExpectedSPIFFEID: clientID, Timeout: time.Second})
	must(t, e)
	defer source.Close()
	must(t, source.Start(ctx))
	clientMaximumAge := 30 * time.Second
	switch os.Getenv("OCE_GITHUB_BRIDGE_FIXTURE_SCENARIO") {
	case "":
	case "server-expiry":
		// Only the external client's lifetime changes. The real broker retains
		// its supported 30-second profile and its own independent expiry watcher.
		clientMaximumAge = 60 * time.Second
	default:
		t.Fatal("unsupported external fixture scenario")
	}
	transport, e := servicepeer.New(source, servicepeer.Config{Side: servicepeer.Client, OwnSPIFFEID: clientID, PeerSPIFFEID: serverID, RecipientSPIFFEID: serverID, ApplicationProtocol: profile.applicationProtocol(), HandshakeTimeout: time.Second, RecheckInterval: 100 * time.Millisecond, MaxConnectionAge: clientMaximumAge, MaxConnections: 4})
	must(t, e)
	defer transport.Close()
	var output sync.Mutex
	emit := func(event any) {
		output.Lock()
		defer output.Unlock()
		if json.NewEncoder(os.Stdout).Encode(event) != nil {
			cancel()
		}
	}
	type clientSession struct {
		connection *servicepeer.Connection
		raw        net.Conn
		connected  time.Time
		requests   int
		cancel     context.CancelFunc
		busy       bool
		work       sync.WaitGroup
	}
	var sessionsMu sync.Mutex
	sessions := map[string]*clientSession{}
	peers := map[string]*fixturePeerProcess{}
	closeAll := func() {
		sessionsMu.Lock()
		old := sessions
		originalPeers := peers
		sessions = map[string]*clientSession{}
		peers = map[string]*fixturePeerProcess{}
		sessionsMu.Unlock()
		// Resume every exactly retained process before closing fixture sockets.
		// This deferred cleanup also runs if the test exits through t.Fatal.
		for _, peer := range originalPeers {
			if peer.paused {
				_, _ = peer.signal(false)
			}
		}
		for _, s := range old {
			s.cancel()
			s.connection.Close()
			s.work.Wait()
		}
		for _, peer := range originalPeers {
			peer.close()
		}
	}
	defer closeAll()
	emit(map[string]any{"kind": "ready", "version": 1, "native_profile": profile, "client_max_connection_age_ms": clientMaximumAge.Milliseconds()})
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), MaxControlMetadata)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return
		}
		raw := scanner.Bytes()
		var command struct {
			Kind      string          `json:"kind"`
			CommandID string          `json:"command_id"`
			Session   string          `json:"session"`
			Metadata  json.RawMessage `json:"metadata"`
		}
		fieldsValue, e := decodeObject(raw)
		if e != nil || json.Unmarshal(raw, &command) != nil || !referencePattern.MatchString(command.CommandID) {
			t.Fatal("invalid external fixture command")
		}
		fail := func() {
			emit(map[string]any{"kind": "failed", "command_id": command.CommandID, "session": command.Session, "operation": command.Kind})
		}
		switch command.Kind {
		case "connect":
			if !fields(fieldsValue, "kind command_id session") || !referencePattern.MatchString(command.Session) {
				t.Fatal("invalid fixture connect")
			}
			sessionsMu.Lock()
			_, exists := peers[command.Session]
			full := len(peers) >= 64
			sessionsMu.Unlock()
			if exists || full {
				fail()
				continue
			}
			life, stop := context.WithCancel(ctx)
			raw, e := net.DialTimeout("unix", profile.ListenPath, time.Second)
			if e != nil {
				stop()
				fail()
				continue
			}
			peer, e := captureFixturePeer(raw)
			if e != nil {
				raw.Close()
				stop()
				fail()
				continue
			}
			connection, e := transport.Handshake(life, raw)
			if e != nil {
				peer.close()
				stop()
				fail()
				continue
			}
			sessionsMu.Lock()
			peers[command.Session] = peer
			sessions[command.Session] = &clientSession{connection: connection, raw: raw, connected: time.Now(), cancel: stop}
			sessionsMu.Unlock()
			emit(map[string]any{"kind": "connected", "command_id": command.CommandID, "session": command.Session})
		case "request":
			if !fields(fieldsValue, "kind command_id session metadata") || len(command.Metadata) > MaxMetadata {
				t.Fatal("invalid fixture request")
			}
			if _, e := decodeObject(command.Metadata); e != nil {
				t.Fatal("fixture metadata must be an object")
			}
			sessionsMu.Lock()
			s := sessions[command.Session]
			if s == nil || s.busy {
				sessionsMu.Unlock()
				fail()
				continue
			}
			s.busy = true
			s.requests++
			s.work.Add(1)
			sessionsMu.Unlock()
			// Copy nonsecret metadata before scanner advances. The raw object bytes are
			// retained; no synthetic parent authorization or result is constructed here.
			metadata := append([]byte(nil), command.Metadata...)
			id, name := command.CommandID, command.Session
			go func() {
				defer s.work.Done()
				defer func() { sessionsMu.Lock(); s.busy = false; sessionsMu.Unlock() }()
				failure := func(stage string, err error) {
					code, timeout := fixtureIOError(err)
					emit(map[string]any{"kind": "failed", "command_id": id, "session": name, "operation": "request", "failure_stage": stage, "error_code": code, "timed_out": timeout})
				}
				if err := s.connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
					failure("set-deadline", err)
					return
				}
				if err := WriteFrame(s.connection, &Frame{Metadata: metadata}); err != nil {
					failure("write", err)
					return
				}
				emit(map[string]any{"kind": "request-started", "command_id": id, "session": name})
				observed := &fixtureObservedReader{Reader: s.connection}
				frame, e := ReadFrame(observed)
				if e != nil {
					failure("read", observed.err)
					return
				}
				defer frame.Clear()
				// A fixture never forwards token bytes to its parent stdout. The real DS
				// receive primitive owns and clears them even on a test-only positive reply.
				count := len(frame.Secret)
				frame.Clear()
				if err := s.connection.SetDeadline(time.Time{}); err != nil {
					failure("clear-deadline", err)
					return
				}
				emit(map[string]any{"kind": "response", "command_id": id, "session": name, "metadata": json.RawMessage(frame.Metadata), "secret_length": count})
			}()
		case "client-state":
			if !fields(fieldsValue, "kind command_id session") {
				t.Fatal("invalid fixture client state")
			}
			sessionsMu.Lock()
			s := sessions[command.Session]
			if s == nil || s.busy {
				sessionsMu.Unlock()
				fail()
				continue
			}
			requests := s.requests
			sessionsMu.Unlock()
			peer, err := s.connection.Inspect()
			if err != nil {
				fail()
				continue
			}
			closed, err := fixturePeerWriteClosed(s.raw)
			if err != nil {
				fail()
				continue
			}
			emit(map[string]any{"kind": "client-state", "command_id": command.CommandID, "session": command.Session, "client_authority_current": true, "client_remaining_ms": time.Until(peer.ExpiresAt).Milliseconds(), "connected_age_ms": time.Since(s.connected).Milliseconds(), "requests_started": requests, "peer_write_closed": closed})
		case "close":
			if !fields(fieldsValue, "kind command_id session") {
				t.Fatal("invalid fixture close")
			}
			sessionsMu.Lock()
			s := sessions[command.Session]
			delete(sessions, command.Session)
			sessionsMu.Unlock()
			if s == nil {
				fail()
				continue
			}
			s.cancel()
			s.connection.Close()
			s.work.Wait()
			emit(map[string]any{"kind": "closed", "command_id": command.CommandID, "session": command.Session})
		case "pause-peer", "resume-peer", "peer-state":
			if !fields(fieldsValue, "kind command_id session") {
				t.Fatal("invalid fixture peer control")
			}
			sessionsMu.Lock()
			peer := peers[command.Session]
			live := sessions[command.Session]
			sessionsMu.Unlock()
			if peer == nil || (command.Kind == "pause-peer" && live == nil) {
				fail()
				continue
			}
			var state string
			var err error
			switch command.Kind {
			case "pause-peer":
				if _, err = live.connection.Inspect(); err == nil {
					state, err = peer.signal(true)
				}
			case "resume-peer":
				state, err = peer.signal(false)
			case "peer-state":
				state, err = peer.state()
			}
			if err != nil {
				code := "peer-control-rejected"
				var diagnostic *fixturePeerError
				var errno unix.Errno
				if errors.As(err, &diagnostic) {
					code = diagnostic.stage
					// Prefer a precise descriptor failure over its polling stage.
					var inner *fixturePeerError
					if errors.As(diagnostic.err, &inner) {
						code = inner.stage
					}
					errors.As(err, &errno)
				}
				emit(map[string]any{"kind": "failed", "command_id": command.CommandID, "session": command.Session, "operation": command.Kind, "error_code": code, "errno": int(errno)})
				fmt.Fprintf(os.Stderr, "fixture peer control failed: %s errno=%d\n", code, int(errno))
				continue
			}
			kind := "peer-state"
			if command.Kind == "pause-peer" {
				kind = "peer-paused"
			}
			if command.Kind == "resume-peer" {
				kind = "peer-resumed"
			}
			emit(map[string]any{"kind": kind, "command_id": command.CommandID, "session": command.Session, "state": state})
		case "withdraw":
			if !fields(fieldsValue, "kind command_id") {
				t.Fatal("invalid fixture withdrawal")
			}
			serverAPI.Stop()
			emit(map[string]any{"kind": "withdrawn", "command_id": command.CommandID})
		case "shutdown":
			if !fields(fieldsValue, "kind command_id") {
				t.Fatal("invalid fixture shutdown")
			}
			closeAll()
			cancel()
			emit(map[string]any{"kind": "stopped", "command_id": command.CommandID})
			return
		default:
			t.Fatal("unknown external fixture command")
		}
	}
	if e := scanner.Err(); e != nil {
		t.Fatal("external fixture control stream invalid")
	}
}

// This subprocess exists only to test real kernel pidfd lifecycle observations.
// It has no identity, broker policy or authority behavior.
func TestFixturePeerStateChild(t *testing.T) {
	if os.Getenv("OCE_FIXTURE_PEER_STATE_CHILD") != "1" {
		t.Skip("explicit child process only")
	}
	time.Sleep(30 * time.Second)
}

func TestFixturePeerStateActualSignalsAndRetirement(t *testing.T) {
	// clone supplies the pidfd atomically for this owned test child. This is
	// separate from the socket fixture's mandatory SO_PEERPIDFD acquisition.
	pidfd := -1
	child := exec.Command(os.Args[0], "-test.run=^TestFixturePeerStateChild$")
	child.Env = append(os.Environ(), "OCE_FIXTURE_PEER_STATE_CHILD=1")
	child.SysProcAttr = &syscall.SysProcAttr{PidFD: &pidfd}
	must(t, child.Start())
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	if pidfd < 0 {
		t.Fatal("kernel did not supply the owned child pidfd")
	}
	peer := &fixturePeerProcess{fd: pidfd, pid: child.Process.Pid}
	defer peer.close()

	// Deliver actual runtime-preemption signals during repeated kernel reads.
	// This does not identify the errno of any earlier uninstrumented failure.
	stop, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			select {
			case <-stop:
				return
			default:
				_ = unix.Kill(os.Getpid(), unix.SIGURG)
				time.Sleep(20 * time.Microsecond)
			}
		}
	}()
	defer func() { close(stop); <-stopped }()
	for range 500 {
		state, err := peer.state()
		if err != nil || state != "running" {
			t.Fatalf("live pidfd state=%q error=%v", state, err)
		}
	}
	must(t, unix.PidfdSendSignal(pidfd, unix.SIGKILL, nil, 0))
	_ = child.Wait()
	state, err := peer.state()
	if err != nil || state != "exited" {
		t.Fatalf("exited pidfd state=%q error=%v", state, err)
	}
	must(t, unix.Close(pidfd))
	// No intervening descriptor allocation may reuse this numeric fd. Poll
	// itself must distinguish POLLNVAL from the exit readiness checked above.
	exited, err := peer.exited()
	peer.fd = -1
	var diagnostic *fixturePeerError
	if exited || !errors.As(err, &diagnostic) || diagnostic.stage != "pidfd-invalid" || !errors.Is(err, unix.EBADF) {
		t.Fatalf("closed pidfd claimed exit=%v error=%v", exited, err)
	}
}
