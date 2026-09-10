//go:build !linux

package clockobservation

import "errors"

var ErrUnavailable = errors.New("clock observation unavailable")

type Observation struct {
	Version            int   `json:"version"`
	WallMs             int64 `json:"wall_ms"`
	MonotonicMs        int64 `json:"monotonic_ms"`
	UncertaintyMs      int64 `json:"uncertainty_ms"`
	CorrelationErrorMs int64 `json:"correlation_error_ms"`
}

// Observe has no substitute on unsupported kernels.
func Observe() (Observation, error) { return Observation{}, ErrUnavailable }
