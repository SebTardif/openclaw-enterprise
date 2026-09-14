package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/githubbridge"
)

func TestActualValidationCommandOwnedPipes(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "oce-github-mediation")
	build := exec.Command("go", "build", "-mod=readonly", "-buildvcs=false", "-o", binary, ".")
	build.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=off")
	if raw, e := build.CombinedOutput(); e != nil {
		t.Fatalf("build: %v\n%s", e, raw)
	}
	profile := githubbridge.Profile{Version: 1, WorkloadAPISocketPath: "/protected/api", OwnSPIFFEID: "spiffe://test.example/broker", PeerSPIFFEID: "spiffe://test.example/ds", RecipientSPIFFEID: "spiffe://test.example/broker", TrustBundleSHA256: "sha256:" + strings.Repeat("a", 64), ListenPath: "/protected/broker", PeerUID: 1000, TrustedAncestorUIDs: []uint32{0, 1000}, HandshakeTimeoutMs: 1000, RecheckIntervalMs: 100, MaxConnectionAgeMs: 10000, RequestTimeoutMs: 1000}
	for _, selected := range []int{0, 3, 2, 4} {
		for _, recipientValid := range []bool{true, false} {
			valid := recipientValid && (selected == 0 || selected == 3)
			p := profile
			p.ProtocolVersion = selected
			if !recipientValid {
				p.RecipientSPIFFEID = p.PeerSPIFFEID
			}
			raw, e := json.Marshal(p)
			if e != nil {
				t.Fatal(e)
			}
			cmd := exec.Command(binary, "validate-profile")
			cmd.Env = []string{}
			in, e := cmd.StdinPipe()
			if e != nil {
				t.Fatal(e)
			}
			out, e := cmd.StdoutPipe()
			if e != nil {
				t.Fatal(e)
			}
			var diagnostics bytes.Buffer
			cmd.Stderr = &diagnostics
			if e = cmd.Start(); e != nil {
				t.Fatal(e)
			}
			if e = githubbridge.WriteControlFrame(in, &githubbridge.Frame{Metadata: raw}); e != nil {
				t.Fatal(e)
			}
			in.Close()
			reply, e := githubbridge.ReadControlFrame(out)
			if e != nil {
				t.Fatal(e)
			}
			reply.Clear()
			err := cmd.Wait()
			expected := `{"version":1,"result":"invalid"}`
			if valid {
				expected = `{"version":1,"result":"valid"}`
			}
			if string(reply.Metadata) != expected || (err == nil) != valid || diagnostics.Len() != 0 {
				t.Fatal("validation command changed bounded response or leaked diagnostics")
			}
		}
	}
}
