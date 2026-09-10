// oce-clock-observation exposes only the fixed read-only Linux observation.
package main

import (
	"encoding/json"
	"io"
	"os"

	"github.com/openclaw/openclaw-enterprise/components/runtime-security/clockobservation"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout)) }
func run(args []string, out io.Writer) int {
	unavailable := func() int { _, _ = io.WriteString(out, "{\"version\":1,\"error\":\"unavailable\"}\n"); return 1 }
	if len(args) != 1 || args[0] != "read" {
		return unavailable()
	}
	value, err := clockobservation.Observe()
	if err != nil {
		return unavailable()
	}
	raw, err := json.Marshal(value)
	if err != nil || len(raw)+1 >= 1024 {
		return unavailable()
	}
	raw = append(raw, '\n')
	n, err := out.Write(raw)
	if err != nil || n != len(raw) {
		return 1
	}
	return 0
}
