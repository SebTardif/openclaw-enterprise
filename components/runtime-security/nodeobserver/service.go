package nodeobserver

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"sync"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/identity"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicebridge"
	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicepeer"
)

func transport(ctx context.Context, e Enrollment, client bool) (*identity.Source, *servicepeer.Transport, error) {
	own, peer, side := e.OwnSPIFFEID, e.PeerSPIFFEID, servicepeer.Server
	if client {
		own, peer, side = e.PeerSPIFFEID, e.OwnSPIFFEID, servicepeer.Client
	}
	s, err := identity.NewSource(identity.Options{SocketPath: e.WorkloadSocket, ExpectedSPIFFEID: own, Timeout: 3 * time.Second})
	if err != nil {
		return nil, nil, ErrUnavailable
	}
	if s.Start(ctx) != nil {
		s.Close()
		return nil, nil, ErrUnavailable
	}
	view, err := s.TrustView()
	if err != nil || view.BundleSHA256 != e.TrustBundleDigest {
		s.Close()
		return nil, nil, ErrUnavailable
	}
	t, err := servicepeer.New(s, servicepeer.Config{Side: side, OwnSPIFFEID: own, PeerSPIFFEID: peer, RecipientSPIFFEID: e.OwnSPIFFEID, HandshakeTimeout: 3 * time.Second, RecheckInterval: time.Second, MaxConnectionAge: Lifetime, MaxConnections: 1})
	if err != nil {
		s.Close()
		return nil, nil, ErrUnavailable
	}
	return s, t, nil
}

type originalRequest struct {
	connection   *servicepeer.Connection
	identity     *identity.Source
	bundleDigest string
	request      Request
	network      *NetworkRequest
	raw          []byte
	digest       string
	deadline     time.Time
}

// The only creator consumes bytes from the original authenticated connection.
// No exported constructor can turn Request/Peer/Record JSON into this custody.
func receive(connection *servicepeer.Connection, identitySource *identity.Source, e Enrollment) (*originalRequest, error) {
	if connection == nil {
		return nil, ErrUnavailable
	}
	if _, err := connection.Inspect(); err != nil {
		return nil, ErrUnavailable
	}
	if connection.SetReadDeadline(time.Now().Add(3*time.Second)) != nil {
		return nil, ErrUnavailable
	}
	raw, err := servicebridge.ReadFrame(connection, MaxBytes)
	if err != nil {
		return nil, ErrUnavailable
	}
	r, network, err := parseCaptureRequest(raw)
	if err != nil {
		return nil, err
	}
	d, err := time.Parse(time.RFC3339Nano, r.Deadline)
	if err != nil || !d.After(time.Now()) || d.After(time.Now().Add(Lifetime)) || r.SourceRef != e.SourceRef || r.SourceVersion != e.Version || r.ClusterRef != e.ClusterRef || r.NodeUID != e.NodeUID || r.Namespace != e.Namespace {
		return nil, ErrUnavailable
	}
	if connection.SetDeadline(d) != nil {
		return nil, ErrUnavailable
	}
	if _, err = connection.Inspect(); err != nil {
		return nil, ErrUnavailable
	}
	original := &originalRequest{connection: connection, identity: identitySource, bundleDigest: e.TrustBundleDigest, request: r, network: network, raw: bytes.Clone(raw), digest: hash(raw), deadline: d}
	if original.current() != nil {
		return nil, ErrUnavailable
	}
	return original, nil
}
func (r *originalRequest) current() error {
	if r == nil || r.connection == nil || r.identity == nil || !r.deadline.After(time.Now()) || hash(r.raw) != r.digest {
		return ErrUnavailable
	}
	view, err := r.identity.TrustView()
	if err != nil || view.BundleSHA256 != r.bundleDigest {
		return ErrUnavailable
	}
	if _, err := r.connection.Inspect(); err != nil {
		return ErrUnavailable
	}
	return nil
}

func serveConnection(ctx context.Context, source *Source, identitySource *identity.Source, connection *servicepeer.Connection) error {
	defer connection.Close()
	original, err := receive(connection, identitySource, source.enrollment)
	if err != nil {
		return err
	}
	call, cancel := context.WithDeadline(ctx, original.deadline)
	defer cancel()
	// A peer disconnect terminates the actual source work even while a provider
	// call is blocked. One reader owns commands; no competing TLS reads occur.
	commands := make(chan Command, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer cancel()
		for {
			raw, err := servicebridge.ReadFrame(connection, MaxBytes)
			if err != nil {
				return
			}
			var command Command
			if decode(raw, &command) != nil || command.SchemaVersion != 1 || command.Method != "inspect" || command.RequestDigest != original.digest || !digest.MatchString(command.RecordDigest) {
				return
			}
			select {
			case commands <- command:
			case <-call.Done():
				return
			}
		}
	}()
	defer func() { cancel(); connection.Close(); <-done }()
	var raw []byte
	var current func() error
	if original.network == nil {
		capture, err := source.capture(call, original.request, original.digest)
		if err != nil {
			return err
		}
		defer capture.close()
		raw, current = capture.raw, capture.current
	} else {
		capture, err := source.captureNetwork(call, *original.network, original.digest)
		if err != nil {
			return err
		}
		defer capture.close()
		raw, current = capture.raw, capture.current
	}
	recordDigest := hash(raw)
	write := func(status string) error {
		if original.current() != nil || current() != nil || original.current() != nil || call.Err() != nil {
			return ErrUnavailable
		}
		reply := Reply{SchemaVersion: 1, Status: status, RequestDigest: original.digest, RecordDigest: recordDigest, Record: json.RawMessage(raw)}
		if servicebridge.WriteFrame(connection, encoded(reply), MaxBytes) != nil {
			return ErrUnavailable
		}
		return nil
	}
	if write("observed") != nil {
		return ErrUnavailable
	}
	for {
		select {
		case <-call.Done():
			return ErrUnavailable
		case command := <-commands:
			if command.RecordDigest != recordDigest || write("current") != nil {
				return ErrUnavailable
			}
		}
	}
}

// Serve owns this exact node's listener and transport. Deployment must install
// the protected root-owned enrollment first; the service performs no enrollment,
// daemon deployment or OCC registry mutation. At most one capture is admitted.
func Serve(ctx context.Context, source *Source) error {
	if source == nil || source.self != source || source.current() != nil {
		return ErrUnavailable
	}
	source.mu.Lock()
	if source.closed {
		source.mu.Unlock()
		return ErrUnavailable
	}
	source.active.Add(1)
	source.mu.Unlock()
	defer source.active.Done()
	e := source.enrollment
	owned, cancel := context.WithCancel(ctx)
	defer cancel()
	stopSource := context.AfterFunc(source.lifetime, cancel)
	defer stopSource()
	identitySource, t, err := transport(owned, e, false)
	if err != nil {
		return err
	}
	defer identitySource.Close()
	defer t.Close()
	listener, err := net.Listen("tcp", e.Address)
	if err != nil {
		return ErrUnavailable
	}
	defer listener.Close()
	stop := context.AfterFunc(owned, func() { listener.Close(); t.Close() })
	defer stop()
	var pending sync.WaitGroup
	defer pending.Wait()
	slot := make(chan struct{}, 1)
	for {
		raw, err := listener.Accept()
		if err != nil {
			if owned.Err() != nil {
				return nil
			}
			return ErrUnavailable
		}
		select {
		case slot <- struct{}{}:
		default:
			raw.Close()
			continue
		}
		pending.Add(1)
		go func() {
			defer pending.Done()
			defer func() { <-slot }()
			call, end := context.WithTimeout(owned, Lifetime)
			defer end()
			connection, err := t.Handshake(call, raw)
			if err == nil {
				_ = serveConnection(call, source, identitySource, connection)
			}
		}()
	}
}

// ClientCapture keeps the original authenticated response stream private.
// Values are physical observations, not sourceCall or authority handles.
type ClientCapture struct {
	self                                                        *ClientCapture
	connection                                                  *servicepeer.Connection
	transport                                                   *servicepeer.Transport
	source                                                      *identity.Source
	cancel                                                      context.CancelFunc
	requestDigest, recordDigest, bundleDigest, enrollmentDigest string
	request                                                     Request
	network                                                     *NetworkRequest
	record                                                      Record
	raw                                                         []byte
	mu                                                          sync.Mutex
	closed                                                      bool
}

// The receiving deployment supplies the original node enrollment digest and its
// own identity socket separately. These are protected constructor inputs, never
// selectors in capture-execution requests.
type ClientConfiguration struct {
	Enrollment       Enrollment `json:"enrollment"`
	WorkloadSocket   string     `json:"workloadSocket"`
	EnrollmentDigest string     `json:"enrollmentDigest"`
}

func Capture(ctx context.Context, configuration ClientConfiguration, r Request) (*ClientCapture, error) {
	return captureClient(ctx, configuration, encoded(r))
}

func CaptureNetwork(ctx context.Context, configuration ClientConfiguration, r NetworkRequest) (*ClientCapture, error) {
	return captureClient(ctx, configuration, encoded(r))
}

func captureClient(ctx context.Context, configuration ClientConfiguration, raw []byte) (*ClientCapture, error) {
	validated, err := ParseEnrollment(encoded(configuration.Enrollment))
	if err != nil || !cleanPath(configuration.WorkloadSocket) || len(configuration.WorkloadSocket) > 103 || !digest.MatchString(configuration.EnrollmentDigest) {
		return nil, ErrUnavailable
	}
	e := validated
	e.WorkloadSocket = configuration.WorkloadSocket
	r, network, err := parseCaptureRequest(raw)
	if err != nil {
		return nil, err
	}
	deadline, _ := time.Parse(time.RFC3339Nano, r.Deadline)
	if !deadline.After(time.Now()) || deadline.After(time.Now().Add(Lifetime)) {
		return nil, ErrUnavailable
	}
	if r.SourceRef != e.SourceRef || r.SourceVersion != e.Version || r.ClusterRef != e.ClusterRef || r.NodeUID != e.NodeUID || r.Namespace != e.Namespace {
		return nil, ErrUnavailable
	}
	owned, cancel := context.WithDeadline(ctx, deadline)
	c := &ClientCapture{cancel: cancel, requestDigest: hash(raw), bundleDigest: e.TrustBundleDigest, enrollmentDigest: configuration.EnrollmentDigest, request: r, network: network}
	c.self = c
	ok := false
	defer func() {
		if !ok {
			c.Close()
		}
	}()
	c.source, c.transport, err = transport(owned, e, true)
	if err != nil {
		return nil, err
	}
	d := net.Dialer{Timeout: 3 * time.Second}
	socket, err := d.DialContext(owned, "tcp", e.Address)
	if err != nil {
		return nil, ErrUnavailable
	}
	c.connection, err = c.transport.Handshake(owned, socket)
	if err != nil {
		return nil, err
	}
	if c.connection.SetDeadline(deadline) != nil || servicebridge.WriteFrame(c.connection, raw, MaxBytes) != nil {
		return nil, ErrUnavailable
	}
	if c.reply("observed") != nil {
		return nil, ErrUnavailable
	}
	ok = true
	return c, nil
}
func (c *ClientCapture) reply(status string) error {
	view, err := c.source.TrustView()
	if err != nil || view.BundleSHA256 != c.bundleDigest {
		return ErrUnavailable
	}
	if _, err := c.connection.Inspect(); err != nil {
		return ErrUnavailable
	}
	raw, err := servicebridge.ReadFrame(c.connection, MaxBytes)
	if err != nil {
		return ErrUnavailable
	}
	var reply Reply
	if decode(raw, &reply) != nil || reply.SchemaVersion != 1 || reply.Status != status || reply.RequestDigest != c.requestDigest || !digest.MatchString(reply.RecordDigest) || hash(reply.Record) != reply.RecordDigest {
		return ErrUnavailable
	}
	var record Record
	if c.network == nil {
		if decode(reply.Record, &record) != nil || record.SchemaVersion != 1 || record.Kind != "node-physical-execution" || record.RequestDigest != c.requestDigest || record.EnrollmentDigest != c.enrollmentDigest || record.Physical.NodeUID != c.request.NodeUID || record.Physical.PodUID != c.request.PodUID || record.ValidUntil != c.request.Deadline {
			return ErrUnavailable
		}
	} else {
		network, err := parseNetworkRecord(reply.Record, *c.network, c.requestDigest, c.enrollmentDigest)
		if err != nil {
			return err
		}
		record = network.Execution
	}
	if status == "current" && (reply.RecordDigest != c.recordDigest || !bytes.Equal(c.raw, reply.Record)) {
		return ErrUnavailable
	}
	if _, err := c.connection.Inspect(); err != nil {
		return ErrUnavailable
	}
	view, err = c.source.TrustView()
	if err != nil || view.BundleSHA256 != c.bundleDigest {
		return ErrUnavailable
	}
	c.raw = bytes.Clone(reply.Record)
	c.record = record
	c.recordDigest = reply.RecordDigest
	return nil
}
func (c *ClientCapture) Record() (Record, error) {
	if c == nil || c.self != c {
		return Record{}, ErrUnavailable
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.network != nil {
		return Record{}, ErrUnavailable
	}
	var record Record
	if json.Unmarshal(c.raw, &record) != nil {
		return record, ErrUnavailable
	}
	return record, nil
}
func (c *ClientCapture) NetworkRecord() (NetworkRecord, error) {
	if c == nil || c.self != c {
		return NetworkRecord{}, ErrUnavailable
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.network == nil {
		return NetworkRecord{}, ErrUnavailable
	}
	return parseNetworkRecord(c.raw, *c.network, c.requestDigest, c.enrollmentDigest)
}
func (c *ClientCapture) Inspect() error {
	if c == nil || c.self != c {
		return ErrUnavailable
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return ErrUnavailable
	}
	if servicebridge.WriteFrame(c.connection, encoded(Command{SchemaVersion: 1, Method: "inspect", RequestDigest: c.requestDigest, RecordDigest: c.recordDigest}), MaxBytes) != nil {
		return ErrUnavailable
	}
	return c.reply("current")
}
func (c *ClientCapture) Close() {
	if c == nil || c.self != c {
		return
	}
	c.cancel()
	if c.connection != nil {
		c.connection.Close()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	if c.transport != nil {
		c.transport.Close()
	}
	if c.source != nil {
		c.source.Close()
	}
}

// RunClient consumes a trusted constructor profile and one exact request from
// owned stdio, then retains the real TLS connection until close or deadline.
func RunClient(ctx context.Context, input io.Reader, output io.Writer) error {
	raw, err := servicebridge.ReadFrame(input, MaxBytes)
	if err != nil {
		return ErrUnavailable
	}
	var configuration ClientConfiguration
	if decode(raw, &configuration) != nil {
		return ErrUnavailable
	}
	raw, err = servicebridge.ReadFrame(input, MaxBytes)
	if err != nil {
		return ErrUnavailable
	}
	c, err := captureClient(ctx, configuration, raw)
	if err != nil {
		return err
	}
	defer c.Close()
	if servicebridge.WriteFrame(output, encoded(Reply{SchemaVersion: 1, Status: "observed", RequestDigest: c.requestDigest, RecordDigest: c.recordDigest, Record: c.raw}), MaxBytes) != nil {
		return ErrUnavailable
	}
	for {
		raw, err = servicebridge.ReadFrame(input, MaxBytes)
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return ErrUnavailable
		}
		var command Command
		if decode(raw, &command) != nil || command.SchemaVersion != 1 || command.Method != "inspect" || command.RequestDigest != c.requestDigest || command.RecordDigest != c.recordDigest || c.Inspect() != nil {
			return ErrUnavailable
		}
		if servicebridge.WriteFrame(output, encoded(Reply{SchemaVersion: 1, Status: "current", RequestDigest: c.requestDigest, RecordDigest: c.recordDigest, Record: c.raw}), MaxBytes) != nil {
			return ErrUnavailable
		}
	}
}
