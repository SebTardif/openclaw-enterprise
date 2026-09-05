// oce-runtime-authority is the dedicated owned-child historical-read transport.
// It has no inherited credential environment or public diagnostic output.
package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/servicebridge"
)

// Duplicating only the two inherited owned pipe descriptors and registering
// them as nonblocking files makes Close interrupt blocked I/O using Go's public
// os.File contract. No network or descriptor received from a client is adopted.
func ownedPipe(original *os.File) (*os.File, error) {
	info, err := original.Stat()
	if err != nil || info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return nil, os.ErrInvalid
	}
	fd, err := syscall.Dup(int(original.Fd()))
	if err != nil {
		return nil, err
	}
	if err = syscall.SetNonblock(fd, true); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	pipe := os.NewFile(uintptr(fd), "owned-runtime-channel")
	if pipe == nil {
		syscall.Close(fd)
		return nil, os.ErrInvalid
	}
	if err = pipe.SetDeadline(time.Time{}); err != nil {
		pipe.Close()
		return nil, err
	}
	original.Close()
	return pipe, nil
}

func run(args []string) int {
	if len(args) != 1 {
		return 2
	}
	input, err := ownedPipe(os.Stdin)
	if err != nil {
		return 1
	}
	defer input.Close()
	output, err := ownedPipe(os.Stdout)
	if err != nil {
		return 1
	}
	defer output.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	switch args[0] {
	case "validate-profile":
		timer := time.AfterFunc(3*time.Second, func() { input.Close(); output.Close() })
		defer timer.Stop()
		interrupted := context.AfterFunc(ctx, func() { input.Close(); output.Close() })
		defer interrupted()
		raw, err := servicebridge.ReadFrame(input, servicebridge.MaxRequestBytes)
		var extra [1]byte
		if err == nil {
			n, end := input.Read(extra[:])
			if n != 0 || end != io.EOF {
				err = os.ErrInvalid
			}
		}
		result := "invalid"
		if err == nil {
			if _, err = servicebridge.ValidateProfile(raw); err == nil {
				result = "valid"
			}
		}
		reply, _ := json.Marshal(struct {
			SchemaVersion int    `json:"schemaVersion"`
			Result        string `json:"result"`
		}{1, result})
		if servicebridge.WriteFrame(output, reply, servicebridge.MaxRequestBytes) != nil {
			return 1
		}
		if result != "valid" {
			return 1
		}
		return 0
	case "serve":
		if servicebridge.Run(ctx, input, output) != nil {
			return 1
		}
		return 0
	default:
		return 2
	}
}

func main() { os.Exit(run(os.Args[1:])) }
