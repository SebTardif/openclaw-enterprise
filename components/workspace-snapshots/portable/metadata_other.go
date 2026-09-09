//go:build !linux

package portable

import (
	"fmt"
	"os"
)

func owned(info os.FileInfo) bool { return false }
func supportedHost() error {
	return fmt.Errorf("%w: metadata inspection requires Linux", ErrUnsupported)
}
func inspectMetadata(name string, info os.FileInfo) error { return supportedHost() }
