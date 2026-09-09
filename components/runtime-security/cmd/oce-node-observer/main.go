// oce-node-observer owns a protected node source or one bounded native client.
// It does not install privileged workloads or enroll a source.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/nodeobserver"
)

func pipe(original *os.File) (*os.File, error) {
	info, err := original.Stat()
	if err != nil || info.Mode()&(os.ModeNamedPipe|os.ModeSocket) == 0 {
		return nil, os.ErrInvalid
	}
	fd, err := syscall.Dup(int(original.Fd()))
	if err != nil {
		return nil, err
	}
	if syscall.SetNonblock(fd, true) != nil {
		syscall.Close(fd)
		return nil, os.ErrInvalid
	}
	f := os.NewFile(uintptr(fd), "owned-node-observer-channel")
	if f == nil || f.SetDeadline(time.Time{}) != nil {
		syscall.Close(fd)
		return nil, os.ErrInvalid
	}
	original.Close()
	return f, nil
}
func run(args []string) int {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if len(args) == 2 && args[0] == "serve" {
		source, err := nodeobserver.Open(args[1])
		if err != nil {
			return 1
		}
		defer source.Close()
		if nodeobserver.Serve(ctx, source) != nil {
			return 1
		}
		return 0
	}
	if len(args) != 1 || args[0] != "client" {
		return 2
	}
	input, err := pipe(os.Stdin)
	if err != nil {
		return 1
	}
	defer input.Close()
	output, err := pipe(os.Stdout)
	if err != nil {
		return 1
	}
	defer output.Close()
	bounded, stop := context.WithTimeout(ctx, 13*time.Second)
	defer stop()
	interrupt := context.AfterFunc(bounded, func() { input.Close(); output.Close() })
	defer interrupt()
	if nodeobserver.RunClient(bounded, input, output) != nil {
		return 1
	}
	return 0
}
func main() { os.Exit(run(os.Args[1:])) }
