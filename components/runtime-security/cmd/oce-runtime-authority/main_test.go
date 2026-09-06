package main_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicebridge"
)

func validProfile() servicebridge.Profile {
	return servicebridge.Profile{SchemaVersion: 1, OperationPolicy: "read-operation-only-v1", SourceRef: "source/command-test",
		SourceConfigurationDigest: "sha256:" + strings.Repeat("1", 64), WorkloadAPISocketPath: "/nonexistent-command-fixture/api.sock",
		OwnSPIFFEID: "spiffe://readback.test/controller/history", PeerSPIFFEID: "spiffe://readback.test/service/reader",
		RecipientRef: "recipient/history", RecipientSPIFFEID: "spiffe://readback.test/controller/history", TrustDomain: "readback.test",
		TrustRootsRef: "roots/readback", TrustBundleSHA256: "sha256:" + strings.Repeat("2", 64), VerifierProfileRef: "verifier/readback",
		NativeExecutableSHA256: "sha256:" + strings.Repeat("3", 64), TransportProfileRef: "owned-child-stdio-readback-v1",
		Limits: servicebridge.Limits{HandshakeTimeoutMs: 3000, RecheckIntervalMs: 1000, MaxConnectionAgeMs: 30000, MaxConnections: 1, RequestTimeoutMs: 3000}}
}

func encode(raw []byte) []byte {
	frame := make([]byte, 4+len(raw))
	binary.BigEndian.PutUint32(frame, uint32(len(raw)))
	copy(frame[4:], raw)
	return frame
}

func buildCommand(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "oce-runtime-authority")
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-p=2", "-mod=readonly", "-trimpath", "-buildvcs=false", "-o", binary, ".")
	build.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=off", "GOMAXPROCS=2")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build actual command: %v\n%s", err, output)
	}
	return binary
}

func TestActualProfileValidationExecutable(t *testing.T) {
	binary := buildCommand(t)
	valid, err := json.Marshal(validProfile())
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name     string
		wire     []byte
		accepted bool
	}{
		{"valid pure profile", encode(valid), true},
		{"empty stdin", nil, false},
		{"truncated length", []byte{0, 0, 0}, false},
		{"truncated body", []byte{0, 0, 0, 9, '{'}, false},
		{"oversized length", []byte{0xff, 0xff, 0xff, 0xff}, false},
		{"malformed body", encode([]byte("{")), false},
		{"duplicate key", encode(bytes.Replace(valid, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1)), false},
		{"case alias", encode(bytes.Replace(valid, []byte(`"schemaVersion":1`), []byte(`"SchemaVersion":1`), 1)), false},
		{"injected actor", encode(bytes.Replace(valid, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"actorId":"must-not-leak"`), 1)), false},
		{"two profiles", append(encode(valid), encode(valid)...), false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, binary, "validate-profile")
			command.Env = []string{}
			command.Stdin = bytes.NewReader(scenario.wire)
			var output, diagnostics bytes.Buffer
			command.Stdout = &output
			command.Stderr = &diagnostics
			err := command.Run()
			if scenario.accepted && err != nil {
				t.Fatalf("valid profile executable: %v", err)
			}
			if !scenario.accepted && err == nil {
				t.Fatal("invalid profile exited successfully")
			}
			if ctx.Err() != nil {
				t.Fatal("profile command exceeded bounded completion")
			}
			if diagnostics.Len() != 0 {
				t.Fatalf("unexpected command diagnostics: %s", diagnostics.Bytes())
			}
			reader := bytes.NewReader(output.Bytes())
			raw, frameErr := servicebridge.ReadFrame(reader, servicebridge.MaxRequestBytes)
			if frameErr != nil {
				t.Fatalf("missing framed validation result: %v", frameErr)
			}
			var result map[string]any
			if err := json.Unmarshal(raw, &result); err != nil {
				t.Fatal(err)
			}
			expected := "invalid"
			if scenario.accepted {
				expected = "valid"
			}
			if len(result) != 2 || result["schemaVersion"] != float64(1) || result["result"] != expected || reader.Len() != 0 {
				t.Fatalf("unexpected validation output: %s", raw)
			}
			if bytes.Contains(output.Bytes(), []byte("must-not-leak")) {
				t.Fatal("raw rejected input escaped")
			}
		})
	}
}

func TestActualCommandCancellationClosesIncompleteInput(t *testing.T) {
	binary := buildCommand(t)
	for _, mode := range []string{"validate-profile", "serve"} {
		t.Run(mode, func(t *testing.T) {
			command := exec.Command(binary, mode)
			command.Env = []string{}
			input, err := command.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			var output, diagnostics bytes.Buffer
			command.Stdout = &output
			command.Stderr = &diagnostics
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- command.Wait() }()
			finished := false
			t.Cleanup(func() {
				input.Close()
				if !finished {
					command.Process.Kill()
					<-done
				}
			})
			if _, err := input.Write([]byte{0, 0, 1, 0, '{'}); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				finished = true
				t.Fatalf("command did not wait for incomplete input: %v", err)
			case <-time.After(100 * time.Millisecond):
			}
			if err := command.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				finished = true
				var exit *exec.ExitError
				if !errors.As(err, &exit) || exit.ExitCode() != 1 {
					t.Fatalf("cancelled command did not return its fixed failure exit: %v", err)
				}
				status, ok := exit.Sys().(syscall.WaitStatus)
				if !ok || status.Signaled() || !status.Exited() || status.ExitStatus() != 1 {
					t.Fatalf("cancellation terminated by signal instead of joining normally: %v", exit)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("native process did not join incomplete-input cancellation")
			}
			if diagnostics.Len() != 0 {
				t.Fatal("cancelled command emitted raw diagnostics")
			}
		})
	}
}
