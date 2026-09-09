// oce-workspace-snapshot is a trusted-host storage utility. It does not authorize
// tenant requests or establish the application writer barrier for a capture.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	snapshots "github.com/openclaw/openclaw-enterprise/components/workspace-snapshots"
	"github.com/openclaw/openclaw-enterprise/components/workspace-snapshots/btrfs"
	"github.com/openclaw/openclaw-enterprise/components/workspace-snapshots/portable"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: oce-workspace-snapshot <capture|inspect|export|native-export|fork|verify|diff|restore> [flags]")
	}
	command := args[0]
	switch command {
	case "capture", "inspect", "export", "native-export", "fork", "verify", "diff", "restore":
	default:
		return fmt.Errorf("unknown snapshot command %q", command)
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	snapshotID := flags.String("snapshot", "", "snapshot identifier")
	var repository, destination, before, after *string
	var workspaceID, workspaceRoot, snapshotRoot, exportRoot, binary, parentID, exportID *string
	var action, history, baseImage *string
	var timeout *time.Duration
	var maxStream *int64
	needsNative := command == "capture" || command == "inspect" || command == "export" || command == "native-export" || command == "fork"
	needsPortable := command == "export" || command == "verify" || command == "diff" || command == "restore"
	if needsNative {
		workspaceRoot = flags.String("workspace-root", "", "pre-provisioned trusted Btrfs workspace parent")
		snapshotRoot = flags.String("snapshot-root", "", "trusted Btrfs snapshot parent outside workload mounts")
		exportRoot = flags.String("export-root", "", "trusted native export directory")
		binary = flags.String("btrfs-binary", "/usr/bin/btrfs", "trusted Btrfs executable")
		timeout = flags.Duration("timeout", 5*time.Minute, "maximum duration of a native command")
		maxStream = flags.Int64("max-stream-bytes", 10<<30, "maximum native export size")
	}
	if needsPortable {
		repository = flags.String("repository", "", "protected local portable repository")
	}
	if command == "capture" || command == "fork" {
		workspaceID = flags.String("workspace", "", "workspace identifier; fork requires a new destination")
	}
	if command == "native-export" || command == "export" {
		parentID = flags.String("parent", "", "parent snapshot identifier; native export requires its unchanged read-only state")
	}
	if command == "native-export" {
		exportID = flags.String("export-id", "", "new native export identifier")
	}
	if command == "export" {
		action = flags.String("action-ref", "", "descriptive action reference; does not prove quiescence")
		history = flags.String("history-ref", "", "descriptive history reference")
		baseImage = flags.String("base-image-digest", "", "descriptive pinned runtime image digest")
	}
	if command == "restore" {
		destination = flags.String("destination", "", "new protected destination directory")
	}
	if command == "diff" {
		before = flags.String("before", "", "original portable snapshot identifier")
		after = flags.String("after", "", "successor portable snapshot identifier")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if command != "diff" && *snapshotID == "" {
		return errors.New("--snapshot is required")
	}
	if repository != nil && *repository == "" {
		return errors.New("--repository is required")
	}
	if workspaceID != nil && *workspaceID == "" {
		return errors.New("--workspace is required")
	}
	if destination != nil && *destination == "" {
		return errors.New("--destination is required")
	}
	if command == "diff" && (*before == "" || *after == "") {
		return errors.New("--before and --after are required")
	}
	if exportID != nil && *exportID == "" {
		return errors.New("--export-id is required")
	}
	var backend *btrfs.Backend
	if needsNative {
		if *workspaceRoot == "" || *snapshotRoot == "" || *exportRoot == "" {
			return errors.New("--workspace-root, --snapshot-root and --export-root are required")
		}
		var err error
		backend, err = btrfs.New(btrfs.Config{
			BinaryPath: *binary, WorkspaceRoot: *workspaceRoot,
			SnapshotRoot: *snapshotRoot, ExportRoot: *exportRoot,
			CommandTimeout: *timeout, MaxStreamBytes: *maxStream,
		})
		if err != nil {
			return err
		}
	}
	var store *portable.Store
	if needsPortable {
		var err error
		store, err = portable.Open(*repository, portable.Limits{})
		if err != nil {
			return err
		}
		defer store.Close()
	}
	var result any
	var err error
	switch command {
	case "capture":
		result, err = backend.Capture(ctx, *workspaceID, *snapshotID)
	case "inspect":
		result, err = backend.Inspect(ctx, *snapshotID)
	case "native-export":
		result, err = backend.Export(ctx, *snapshotID, *parentID, *exportID)
	case "fork":
		result, err = backend.Fork(ctx, *snapshotID, *workspaceID)
	case "export":
		// Export only an inspected immutable capture. An arbitrary live source path
		// would not establish that files belong to the same capture boundary.
		var captured snapshots.Capture
		captured, err = backend.Inspect(ctx, *snapshotID)
		if err == nil {
			var source string
			source, err = backend.SnapshotPath(ctx, *snapshotID)
			if err == nil {
				result, err = store.Capture(ctx, source, snapshots.Provenance{
					WorkspaceID: captured.WorkspaceID, SnapshotID: captured.SnapshotID,
					ParentSnapshotID: *parentID, ActionRef: *action, HistoryRef: *history,
					BaseImageDigest: *baseImage,
				})
			}
		}
	case "verify":
		result, err = store.Verify(ctx, *snapshotID)
	case "diff":
		result, err = store.Diff(ctx, *before, *after)
	case "restore":
		result, err = store.Restore(ctx, *snapshotID, *destination)
	}
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(result)
}
