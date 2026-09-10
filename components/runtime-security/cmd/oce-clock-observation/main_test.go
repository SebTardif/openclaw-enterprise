package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestActualFixedCommand(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "oce-clock-observation")
	build := exec.Command("go", "build", "-mod=readonly", "-buildvcs=false", "-o", binary, ".")
	build.Env = append(os.Environ(), "GOTOOLCHAIN=local", "GOPROXY=off", "GOSUMDB=off")
	if raw, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build failed: %v %s", err, raw)
	}
	info, err := os.Stat(binary)
	if err != nil || info.Size() > 16*1024*1024 {
		t.Fatal("native binary exceeds selected size cap")
	}
	for _, args := range [][]string{{"read"}, {}, {"read", "--offset=1"}, {"set"}} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		cmd := exec.CommandContext(ctx, binary, args...)
		cmd.Env = []string{}
		// No stdin is consumed: even an arbitrary input cannot configure the read.
		cmd.Stdin = bytes.NewBufferString("untrusted configuration\n")
		var output, diagnostics bytes.Buffer
		cmd.Stdout = &output
		cmd.Stderr = &diagnostics
		err := cmd.Run()
		cancel()
		if diagnostics.Len() != 0 || output.Len() >= 1024 {
			t.Fatal("unbounded or diagnostic output")
		}
		if err != nil {
			if output.String() != "{\"version\":1,\"error\":\"unavailable\"}\n" {
				t.Fatal("failure changed fixed unavailable response")
			}
			if len(args) == 1 && args[0] == "read" {
				t.Log("actual command unavailable on current host; no synchronized observation asserted")
			}
			continue
		}
		if len(args) != 1 || args[0] != "read" {
			t.Fatal("unsupported command succeeded")
		}
		var v map[string]int64
		if json.Unmarshal(output.Bytes(), &v) != nil || len(v) != 5 || v["version"] != 1 {
			t.Fatal("invalid closed observation")
		}
		for _, key := range []string{"wall_ms", "monotonic_ms", "uncertainty_ms", "correlation_error_ms"} {
			n, ok := v[key]
			if !ok || n < 0 || n > 9007199254740991 {
				t.Fatal("unsafe integer observation")
			}
		}
		if v["correlation_error_ms"] > v["uncertainty_ms"] {
			t.Fatal("inconsistent error bound")
		}
	}
}
