package githubbridge

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func sendRequest(t *testing.T, h *bridgeHarness, c io.Writer, request map[string]any) Control {
	t.Helper()
	raw := marshal(t, request)
	must(t, WriteFrame(c, &Frame{Metadata: raw}))
	event := h.next(t)
	if event.Kind != "request" || event.RequestSHA256 != digest(raw) || event.MetadataBase64 != base64.StdEncoding.EncodeToString(raw) || event.DeadlineMs <= time.Now().UnixMilli() {
		t.Fatal("native request lost exact bytes or deadline")
	}
	return event
}
func readReply(t *testing.T, c io.Reader, raw, secret []byte) {
	t.Helper()
	f, e := ReadFrame(c)
	must(t, e)
	defer f.Clear()
	if !bytes.Equal(f.Metadata, raw) || !bytes.Equal(f.Secret, secret) {
		t.Fatal("framed response changed")
	}
}
func TestActualUnixMutualTLSSequentialInspectionAndSecretSuffix(t *testing.T) {
	h := harness(t, nil)
	c := h.connect(t)
	request := openRequest()
	event := sendRequest(t, h, c, request)
	view := h.inspect(t, event)
	if !view.Valid || view.PeerSPIFFEID != clientID || view.OwnSPIFFEID != serverID || view.RecipientSPIFFEID != serverID || view.AuthenticatedAtMs > time.Now().UnixMilli() || view.ExpiresAtMs <= view.AuthenticatedAtMs {
		t.Fatal("actual native peer not inspected")
	}
	reply := opened(t, request)
	raw := marshal(t, reply)
	h.command(t, event, "reply", "", raw, nil)
	readReply(t, c, raw, nil)
	ackWritten(t, h, event)
	// The second request preserves the original authenticated connection while
	// the protected pipe receives a new digest/exchange and fresh inspection.
	dispatch := map[string]any{}
	for _, key := range []string{"version", "request_ref", "session_ref", "effect_ref", "work_binding_sha256", "request_sha256", "dns_binding_ref", "upstream_ipv4"} {
		dispatch[key] = reply[key]
	}
	dispatch["sequence"] = 2
	dispatch["method"] = "dispatch-read"
	dispatch["peer_certificate_sha256"] = "sha256:" + string(bytes.Repeat([]byte("f"), 64))
	next := sendRequest(t, h, c, dispatch)
	if next.ConnectionID != event.ConnectionID || next.ExchangeID == event.ExchangeID || next.RequestSHA256 == event.RequestSHA256 {
		t.Fatal("session/exchange custody incorrect")
	}
	second := h.inspect(t, next)
	if !second.Valid || second.AuthenticatedAtMs != view.AuthenticatedAtMs || second.ExpiresAtMs != view.ExpiresAtMs {
		t.Fatal("inspection renewed the original connection")
	}
	release := map[string]any{}
	for k, v := range reply {
		release[k] = v
	}
	release["sequence"] = 2
	release["phase"] = "dispatch-once"
	release["release_ref"] = "release/1"
	release["peer_certificate_sha256"] = dispatch["peer_certificate_sha256"]
	token := []byte("controlled-token-canary-123")
	raw = marshal(t, release)
	h.command(t, next, "reply", "", raw, token)
	readReply(t, c, raw, token)
	ackWritten(t, h, next)
	complete := map[string]any{}
	for _, key := range []string{"version", "request_ref", "session_ref", "effect_ref", "work_binding_sha256", "request_sha256", "release_ref"} {
		complete[key] = release[key]
	}
	complete["sequence"] = 3
	complete["method"] = "complete-read"
	complete["outcome"] = "completed"
	last := sendRequest(t, h, c, complete)
	recorded := map[string]any{}
	for k, v := range complete {
		if k != "method" && k != "outcome" {
			recorded[k] = v
		}
	}
	recorded["ok"] = true
	recorded["phase"] = "recorded"
	raw = marshal(t, recorded)
	h.command(t, last, "reply", "", raw, nil)
	readReply(t, c, raw, nil)
	ackWritten(t, h, last)
	closed := h.next(t)
	if closed.Kind != "closed" || closed.ConnectionID != event.ConnectionID {
		t.Fatal("session not closed")
	}
}
func TestActualSourceWithdrawalClosesWarmUnixSession(t *testing.T) {
	h := harness(t, nil)
	c := h.connect(t)
	request := openRequest()
	event := sendRequest(t, h, c, request)
	raw := marshal(t, opened(t, request))
	h.command(t, event, "reply", "", raw, nil)
	readReply(t, c, raw, nil)
	ackWritten(t, h, event)
	// Stop the real Workload API stream. The maintained Source withdraws current
	// material, and native health closes the otherwise idle accepting socket.
	h.serverAPI.Stop()
	var b [1]byte
	_, e := c.Read(b[:])
	if e == nil {
		t.Fatal("withdrawn source left session usable")
	}
}
func TestActualWrongSPIFFEAndWrongUIDCannotReachParent(t *testing.T) {
	for _, kind := range []string{"spiffe", "uid"} {
		t.Run(kind, func(t *testing.T) {
			h := harness(t, func(p *Profile) {
				if kind == "spiffe" {
					p.PeerSPIFFEID = otherID
				} else {
					p.PeerUID++
				}
			})
			raw, e := net.Dial("unix", h.profile.ListenPath)
			must(t, e)
			c, e := h.clientTransport.Handshake(context.Background(), raw)
			if c != nil {
				defer c.Close()
				_ = WriteFrame(c, &Frame{Metadata: marshal(t, openRequest())})
				var b [1]byte
				_, e = c.Read(b[:])
			}
			if e == nil {
				t.Fatal("wrong peer accepted")
			}
			must(t, h.parent.SetReadDeadline(time.Now().Add(100*time.Millisecond)))
			if _, e = ReadControlFrame(h.parent); e == nil {
				t.Fatal("unauthenticated peer reached parent")
			}
		})
	}
}
func TestActualSessionRejectsPipeliningAndExpiredReply(t *testing.T) {
	for _, kind := range []string{"pipeline", "expiry"} {
		t.Run(kind, func(t *testing.T) {
			h := harness(t, func(p *Profile) { p.RequestTimeoutMs = 150 })
			c := h.connect(t)
			_ = sendRequest(t, h, c, openRequest())
			if kind == "pipeline" {
				must(t, WriteFrame(c, &Frame{Metadata: marshal(t, openRequest())}))
			}
			var b [1]byte
			if _, e := c.Read(b[:]); e == nil {
				t.Fatal("session remained eligible")
			}
			closed := h.next(t)
			if closed.Kind != "closed" {
				t.Fatal("no closed event")
			}
		})
	}
}
func TestProtectedSocketNeverDeletesPreexistingOrReplacement(t *testing.T) {
	dir := protectedDirectory(t)
	path := filepath.Join(dir, "endpoint")
	p := Profile{ListenPath: path, TrustedAncestorUIDs: ancestorUIDs(t, path)}
	must(t, os.WriteFile(path, []byte("existing"), 0600))
	if _, e := listenProtected(p); e == nil {
		t.Fatal("existing path accepted")
	}
	raw, e := os.ReadFile(path)
	must(t, e)
	if string(raw) != "existing" {
		t.Fatal("existing data changed")
	}
	must(t, os.Remove(path))
	ep, e := listenProtected(p)
	must(t, e)
	must(t, os.Remove(path))
	must(t, os.WriteFile(path, []byte("replacement"), 0600))
	ep.close()
	raw, e = os.ReadFile(path)
	must(t, e)
	if string(raw) != "replacement" {
		t.Fatal("replacement removed")
	}
}

func TestActualPartialRequestAndParentOutputCancellationJoin(t *testing.T) {
	t.Run("partial-request", func(t *testing.T) {
		h := harness(t, func(p *Profile) { p.RequestTimeoutMs = 100 })
		c := h.connect(t)
		must(t, func() error { _, e := c.Write([]byte{0}); return e }())
		var b [1]byte
		if _, e := c.Read(b[:]); e == nil {
			t.Fatal("partial request not closed")
		}
		if h.next(t).Kind != "closed" {
			t.Fatal("missing close")
		}
	})
	t.Run("blocked-parent-output", func(t *testing.T) {
		h := harness(t, func(p *Profile) { p.RequestTimeoutMs = 100 })
		c := h.connect(t)
		must(t, WriteFrame(c, &Frame{Metadata: marshal(t, openRequest())}))
		var b [1]byte
		if _, e := c.Read(b[:]); e == nil {
			t.Fatal("blocked output kept socket alive")
		}
	})
}
func TestActualControlReplayClosesOriginalSession(t *testing.T) {
	h := harness(t, nil)
	c := h.connect(t)
	event := sendRequest(t, h, c, openRequest())
	first := h.inspect(t, event)
	if !first.Valid {
		t.Fatal("positive control missing")
	}
	// Reuse the exact old command sequence against the actual native loop.
	h.sequence--
	h.command(t, event, "inspect", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", nil, nil)
	var b [1]byte
	if _, e := c.Read(b[:]); e == nil {
		t.Fatal("replayed control kept session alive")
	}
}
func TestProtectedSocketRejectsWritableAndSymlinkAncestors(t *testing.T) {
	dir := protectedDirectory(t)
	inner := filepath.Join(dir, "inner")
	must(t, os.Mkdir(inner, 0700))
	path := filepath.Join(inner, "endpoint")
	p := Profile{ListenPath: path, TrustedAncestorUIDs: ancestorUIDs(t, path)}
	must(t, os.Chmod(inner, 0770))
	if _, e := listenProtected(p); e == nil {
		t.Fatal("writable parent accepted")
	}
	must(t, os.Chmod(inner, 0700))
	alias := filepath.Join(dir, "alias")
	must(t, os.Symlink(inner, alias))
	p.ListenPath = filepath.Join(alias, "endpoint")
	if _, e := listenProtected(p); e == nil {
		t.Fatal("symlink accepted")
	}
}

func TestActualLeaseExpiresIdleAndDoesNotStartAtReplyReceipt(t *testing.T) {
	for _, kind := range []string{"idle", "late"} {
		t.Run(kind, func(t *testing.T) {
			h := harness(t, nil)
			c := h.connect(t)
			request := openRequest()
			event := sendRequest(t, h, c, request)
			response := opened(t, request)
			now := time.Now().UnixMilli()
			response["server_time_ms"] = now
			response["valid_until_ms"] = now + 100
			if kind == "late" {
				time.Sleep(150 * time.Millisecond)
				response["server_time_ms"] = time.Now().UnixMilli()
				response["valid_until_ms"] = time.Now().Add(100 * time.Millisecond).UnixMilli()
			}
			raw := marshal(t, response)
			h.command(t, event, "reply", "", raw, nil)
			if kind == "idle" {
				readReply(t, c, raw, nil)
				ackWritten(t, h, event)
			}
			// In the late case the syntactically future lease cannot renew the original
			// call-start budget. No opened response is delivered at all.
			var b [1]byte
			if _, e := c.Read(b[:]); e == nil {
				t.Fatal("expired lease remained usable")
			}
			if h.next(t).Kind != "closed" {
				t.Fatal("lease expiry did not close session")
			}
		})
	}
}

func ackWritten(t *testing.T, h *bridgeHarness, event Control) {
	t.Helper()
	ack := h.next(t)
	if ack.Kind != "written" || ack.ConnectionID != event.ConnectionID || ack.ExchangeID != event.ExchangeID || ack.RequestSHA256 != event.RequestSHA256 || ack.DeadlineMs != event.DeadlineMs || ack.MetadataBase64 != "" || ack.Challenge != "" {
		t.Fatal("missing exact socket-write acknowledgment")
	}
}

func closeSession(t *testing.T, h *bridgeHarness, id string) {
	t.Helper()
	h.sequence++
	command := Control{Version: 1, Kind: "close-session", Incarnation: h.incarnation, Sequence: h.sequence, ConnectionID: id}
	must(t, WriteControlFrame(h.parent, &Frame{Metadata: marshal(t, command)}))
}
func TestActualSessionClosePreservesEndpointAndCannotCloseSuccessor(t *testing.T) {
	h := harness(t, nil)
	first := h.connect(t)
	old := sendRequest(t, h, first, openRequest())
	closeSession(t, h, old.ConnectionID)
	closed := h.next(t)
	if closed.Kind != "closed" || closed.ConnectionID != old.ConnectionID {
		t.Fatal("original session not retired")
	}
	// A new actual socket and TLS handshake acquire a different native identity;
	// a queued old cleanup command may not terminate the new session.
	second := h.connect(t)
	next := sendRequest(t, h, second, openRequest())
	if next.ConnectionID == old.ConnectionID {
		t.Fatal("connection identity reused")
	}
	closeSession(t, h, old.ConnectionID)
	if !h.inspect(t, next).Valid {
		t.Fatal("old cleanup affected successor")
	}
	closeSession(t, h, next.ConnectionID)
	if h.next(t).Kind != "closed" {
		t.Fatal("new session did not close")
	}
	if _, e := os.Lstat(h.profile.ListenPath); e != nil {
		t.Fatal("session cleanup removed listener")
	}
}

func TestActualSlowRequestCannotRenewFirstByteDeadline(t *testing.T) {
	h := harness(t, func(p *Profile) { p.RequestTimeoutMs = 250 })
	c := h.connect(t)
	raw := encodedFrame(marshal(t, openRequest()), nil)
	started := time.Now()
	_, e := c.Write(raw[:1])
	must(t, e)
	time.Sleep(100 * time.Millisecond)
	_, e = c.Write(raw[1:])
	must(t, e)
	event := h.next(t)
	if event.Kind != "request" || event.DeadlineMs > started.Add(275*time.Millisecond).UnixMilli() {
		t.Fatal("frame completion renewed original ingress deadline")
	}
	closeSession(t, h, event.ConnectionID)
	if h.next(t).Kind != "closed" {
		t.Fatal("session cleanup did not settle")
	}
}

func TestActualLateInspectionAndSecretReplyCannotPoisonSuccessor(t *testing.T) {
	h := harness(t, nil)
	first := h.connect(t)
	request := openRequest()
	opening := sendRequest(t, h, first, request)
	open := opened(t, request)
	raw := marshal(t, open)
	h.command(t, opening, "reply", "", raw, nil)
	readReply(t, first, raw, nil)
	ackWritten(t, h, opening)
	dispatch := map[string]any{}
	for _, key := range []string{"version", "request_ref", "session_ref", "effect_ref", "work_binding_sha256", "request_sha256", "dns_binding_ref", "upstream_ipv4"} {
		dispatch[key] = open[key]
	}
	dispatch["sequence"] = 2
	dispatch["method"] = "dispatch-read"
	dispatch["peer_certificate_sha256"] = "sha256:" + string(bytes.Repeat([]byte("f"), 64))
	old := sendRequest(t, h, first, dispatch)
	// The authenticated DS socket disappears while its parent-owned dispatch is
	// outstanding. Its subsequently drained control frames must remain terminal.
	must(t, first.Close())
	closed := h.next(t)
	if closed.Kind != "closed" || closed.ConnectionID != old.ConnectionID {
		t.Fatal("original disconnect not retired")
	}
	if h.inspect(t, old).Valid {
		t.Fatal("retired inspection became positive")
	}
	release := map[string]any{}
	for k, v := range open {
		release[k] = v
	}
	release["sequence"] = 2
	release["phase"] = "dispatch-once"
	release["release_ref"] = "release/late"
	release["peer_certificate_sha256"] = dispatch["peer_certificate_sha256"]
	h.command(t, old, "reply", "", marshal(t, release), []byte("retired-token-canary"))
	second := h.connect(t)
	fresh := sendRequest(t, h, second, openRequest())
	// No written acknowledgment was emitted for the abandoned token; next is the
	// actual successor request, and delayed old inspection cannot borrow its peer.
	if fresh.ConnectionID == old.ConnectionID {
		t.Fatal("connection identity reused")
	}
	if h.inspect(t, old).Valid {
		t.Fatal("old proof borrowed successor")
	}
	if !h.inspect(t, fresh).Valid {
		t.Fatal("late commands poisoned successor")
	}
	closeSession(t, h, fresh.ConnectionID)
	if h.next(t).Kind != "closed" {
		t.Fatal("successor cleanup failed")
	}
}
func TestActualRetiredExchangeStillRejectsMismatchedCorrespondence(t *testing.T) {
	for _, kind := range []string{"digest", "deadline", "exchange"} {
		t.Run(kind, func(t *testing.T) {
			h := harness(t, nil)
			first := h.connect(t)
			old := sendRequest(t, h, first, openRequest())
			must(t, first.Close())
			if h.next(t).Kind != "closed" {
				t.Fatal("original not closed")
			}
			switch kind {
			case "digest":
				old.RequestSHA256 = "sha256:" + string(bytes.Repeat([]byte("0"), 64))
			case "deadline":
				old.DeadlineMs++
			case "exchange":
				old.ExchangeID = "00000000000000000000000000000000"
			}
			h.command(t, old, "inspect", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", nil, nil)
			if f, e := ReadControlFrame(h.parent); e == nil {
				f.Clear()
				t.Fatal("mismatched retired correspondence accepted")
			}
		})
	}
}
