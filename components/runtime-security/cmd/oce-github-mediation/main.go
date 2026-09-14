// oce-github-mediation accepts only the owned parent's inherited pipes. It
// prints no provider, certificate, socket, request or credential diagnostics.
package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/githubbridge"
)

func ownedPipe(original *os.File) (*os.File, error) {
	info, e := original.Stat()
	if e != nil || info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return nil, os.ErrInvalid
	}
	fd, e := syscall.Dup(int(original.Fd()))
	if e != nil {
		return nil, e
	}
	if e = syscall.SetNonblock(fd, true); e != nil {
		syscall.Close(fd)
		return nil, e
	}
	pipe := os.NewFile(uintptr(fd), "owned-github-mediation")
	if pipe == nil {
		syscall.Close(fd)
		return nil, os.ErrInvalid
	}
	if e = pipe.SetDeadline(time.Time{}); e != nil {
		pipe.Close()
		return nil, e
	}
	original.Close()
	return pipe, nil
}
func run(args []string) int {
	if len(args) != 1 || (args[0] != "serve" && args[0] != "validate-profile") {
		return 2
	}
	in, e := ownedPipe(os.Stdin)
	if e != nil {
		return 1
	}
	defer in.Close()
	out, e := ownedPipe(os.Stdout)
	if e != nil {
		return 1
	}
	defer out.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if args[0] == "serve" {
		if githubbridge.Run(ctx, in, out) != nil {
			return 1
		}
		return 0
	}
	timer := time.AfterFunc(3*time.Second, func() { in.Close(); out.Close() })
	defer timer.Stop()
	stop := context.AfterFunc(ctx, func() { in.Close(); out.Close() })
	defer stop()
	frame, e := githubbridge.ReadControlFrame(in)
	valid := false
	if frame != nil {
		defer frame.Clear()
	}
	if e == nil && len(frame.Secret) == 0 {
		var extra [1]byte
		n, end := in.Read(extra[:])
		if n == 0 && end == io.EOF {
			_, e = githubbridge.ValidateProfile(frame.Metadata)
			valid = e == nil
		}
	}
	result := "invalid"
	if valid {
		result = "valid"
	}
	raw, _ := json.Marshal(struct {
		Version int    `json:"version"`
		Result  string `json:"result"`
	}{1, result})
	if githubbridge.WriteControlFrame(out, &githubbridge.Frame{Metadata: raw}) != nil || !valid {
		return 1
	}
	return 0
}
func main() { os.Exit(run(os.Args[1:])) }
