package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	snapshots "github.com/openclaw/openclaw-enterprise/components/workspace-snapshots"
	"github.com/openclaw/openclaw-enterprise/components/workspace-snapshots/portable"
)

func TestPortableCommands(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "source")
	repository := filepath.Join(root, "repository")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(source, "work.txt")
	if err := os.WriteFile(file, []byte("before"), 0640); err != nil {
		t.Fatal(err)
	}
	store, err := portable.Open(repository, portable.Limits{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	// The fixture has no concurrent writers; seed through the real repository.
	if _, err := store.Capture(ctx, source, snapshots.Provenance{WorkspaceID: "workspace", SnapshotID: "first"}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("after"), 0640); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Capture(ctx, source, snapshots.Provenance{WorkspaceID: "workspace", SnapshotID: "second", ParentSnapshotID: "first"}); err != nil {
		t.Fatal(err)
	}
	// Remove the original source: restore must depend only on retained objects.
	if err := os.RemoveAll(source); err != nil {
		t.Fatal(err)
	}
	var out, diagnostic bytes.Buffer
	if err := run(ctx, []string{"verify", "--repository", repository, "--snapshot", "second"}, &out, &diagnostic); err != nil {
		t.Fatal(err)
	}
	var manifest portable.Manifest
	if err := json.Unmarshal(out.Bytes(), &manifest); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := run(ctx, []string{"diff", "--repository", repository, "--before", "first", "--after", "second"}, &out, &diagnostic); err != nil {
		t.Fatal(err)
	}
	var changes []portable.Change
	if err := json.Unmarshal(out.Bytes(), &changes); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, change := range changes {
		if change.Path == "work.txt" && change.Kind == "modified" {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing changed file: %+v", changes)
	}
	out.Reset()
	destination := filepath.Join(root, "restored")
	args := []string{"restore", "--repository", repository, "--snapshot", "second", "--destination", destination}
	if err := run(ctx, args, &out, &diagnostic); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(destination, "work.txt"))
	if err != nil || string(got) != "after" {
		t.Fatalf("restored bytes = %q, error = %v", got, err)
	}
	if err := run(ctx, args, &out, &diagnostic); err == nil {
		t.Fatal("existing destination was accepted")
	}
}

func TestRejectMalformedInvocation(t *testing.T) {
	for _, args := range [][]string{
		nil, {"unknown"}, {"verify"}, {"verify", "--snapshot", "x"},
		{"capture", "--snapshot", "x", "--workspace", "w"},
		{"diff", "--repository", "/unused", "--before", "a"},
		{"restore", "--repository", "/unused", "--snapshot", "a"},
		{"inspect", "--snapshot", "x", "unexpected"},
	} {
		var output bytes.Buffer
		if err := run(context.Background(), args, &output, &output); err == nil {
			t.Fatalf("accepted malformed arguments: %q", args)
		}
	}
}
