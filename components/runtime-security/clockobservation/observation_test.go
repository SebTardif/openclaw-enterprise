//go:build linux

package clockobservation

import (
	"errors"
	"math"
	"testing"

	"golang.org/x/sys/unix"
)

// These values exercise the actual calculation and rejection rules. They are
// arithmetic vectors, not a synchronized-kernel or custody-authority fixture.
func arithmeticSample() kernelSample {
	const wall = int64(1_710_000_000_000_000_000)
	const mono = int64(10_000_000_000)
	s := kernelSample{wallResolution: 1, monoResolution: 1}
	for i := range s.pairs {
		d := int64(i) * 100_000
		s.pairs[i] = clockPair{before: mono + d, wall: wall + d, after: mono + d + 20}
	}
	for i := range s.discipline {
		s.discipline[i] = unix.Timex{Modes: 0, Status: unix.STA_PLL | unix.STA_NANO, Maxerror: 100_000, Esterror: 10_000, Precision: 1, Tolerance: 500 * 65536, Time: unix.Timeval{Sec: 1_710_000_000, Usec: int64(i)*100_000 + 50_000}}
		s.states[i] = unix.TIME_OK
	}
	return s
}
func TestConservativeErrorAndIndependentCorrelation(t *testing.T) {
	s := arithmeticSample()
	got, err := evaluate(s)
	if err != nil {
		t.Fatal(err)
	}
	if got != (Observation{Version: 1, WallMs: 1_710_000_000_000, MonotonicMs: 10_000, UncertaintyMs: 103, CorrelationErrorMs: 3}) {
		t.Fatalf("unexpected outward-rounded result: %+v", got)
	}
	s.discipline[1].Maxerror = 5_000_000
	high, err := evaluate(s)
	if err != nil {
		t.Fatal(err)
	}
	if high.UncertaintyMs != 5003 || high.CorrelationErrorMs != got.CorrelationErrorMs {
		t.Fatal("absolute error was clamped or concealed correlation")
	}
	// Microsecond-mode adjtimex snapshots remain coherent and precision retains
	// microsecond units even when the separate clock snapshots have nanoseconds.
	for i := range s.discipline {
		s.discipline[i].Status &^= unix.STA_NANO
		s.discipline[i].Time.Usec /= 1000
	}
	if _, err = evaluate(s); err != nil {
		t.Fatal("valid microsecond representation rejected")
	}
}
func TestRejectsUnusableKernelStateAndDiscontinuity(t *testing.T) {
	cases := map[string]func(*kernelSample){
		"unsynchronized":           func(s *kernelSample) { s.states[0] = unix.TIME_ERROR },
		"leap-state":               func(s *kernelSample) { s.states[1] = unix.TIME_WAIT },
		"leap-flag":                func(s *kernelSample) { s.discipline[0].Status |= unix.STA_INS },
		"unsync-flag":              func(s *kernelSample) { s.discipline[0].Status |= unix.STA_UNSYNC },
		"clock-error":              func(s *kernelSample) { s.discipline[0].Status |= unix.STA_CLOCKERR },
		"pps-error":                func(s *kernelSample) { s.discipline[0].Status |= unix.STA_PPSERROR },
		"missing-pps":              func(s *kernelSample) { s.discipline[0].Status |= unix.STA_PPSTIME },
		"unknown-status":           func(s *kernelSample) { s.discipline[0].Status |= 1 << 29 },
		"mutating-mode":            func(s *kernelSample) { s.discipline[0].Modes = 1 },
		"negative-maxerror":        func(s *kernelSample) { s.discipline[0].Maxerror = -1 },
		"inconsistent-esterror":    func(s *kernelSample) { s.discipline[0].Esterror = s.discipline[0].Maxerror + 1 },
		"missing-precision":        func(s *kernelSample) { s.discipline[0].Precision = 0 },
		"negative-tolerance":       func(s *kernelSample) { s.discipline[0].Tolerance = -1 },
		"bad-time-fraction":        func(s *kernelSample) { s.discipline[0].Time.Usec = 1_000_000_000 },
		"time-not-bracketed":       func(s *kernelSample) { s.discipline[0].Time.Sec++ },
		"status-change":            func(s *kernelSample) { s.discipline[1].Status |= unix.STA_FLL },
		"tai-change":               func(s *kernelSample) { s.discipline[1].Tai++ },
		"missing-resolution":       func(s *kernelSample) { s.wallResolution = 0 },
		"backward-pair":            func(s *kernelSample) { s.pairs[1].after = s.pairs[1].before - 1 },
		"backward-between-pairs":   func(s *kernelSample) { s.pairs[1].before = s.pairs[0].before },
		"backward-wall":            func(s *kernelSample) { s.pairs[1].wall = s.pairs[0].wall - 1 },
		"forward-wall-step":        func(s *kernelSample) { s.pairs[1].wall += 10_000 },
		"changed-monotonic-origin": func(s *kernelSample) { s.pairs[1].before += 1000; s.pairs[1].after += 1000 },
		"nanosecond-overflow":      func(s *kernelSample) { s.discipline[0].Maxerror = math.MaxInt64 },
		"resolution-overflow":      func(s *kernelSample) { s.wallResolution = math.MaxInt64 },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			s := arithmeticSample()
			change(&s)
			if _, err := evaluate(s); !errors.Is(err, ErrUnavailable) {
				t.Fatal("unsafe observation accepted")
			}
		})
	}
}
func TestCheckedArithmeticRoundsOutAndRejectsOverflow(t *testing.T) {
	if _, ok := nanoseconds(math.MaxInt64, 0); ok {
		t.Fatal("time overflow accepted")
	}
	for _, fraction := range []int64{-1, 1_000_000_000} {
		if _, ok := nanoseconds(1, fraction); ok {
			t.Fatal("invalid fraction accepted")
		}
	}
	if n, ok := mulDivCeil(1, 1, 3); !ok || n != 1 {
		t.Fatal("fraction rounded inward")
	}
	if n, ok := mulDivCeil(math.MaxInt64, 65536, 65536); !ok || n != math.MaxInt64 {
		t.Fatal("valid wide product lost")
	}
	if _, ok := mulDivCeil(math.MaxInt64, 2, 1); ok {
		t.Fatal("overflow accepted")
	}
	if _, ok := signedAdd(math.MinInt64, -1); ok {
		t.Fatal("negative overflow accepted")
	}
	if _, ok := sum(math.MaxInt64, 1); ok {
		t.Fatal("sum overflow accepted")
	}
}
func TestActualReadOnlyKernelObservation(t *testing.T) {
	before, err := clockRead(unix.CLOCK_MONOTONIC)
	if err != nil {
		t.Fatal(err)
	}
	value, err := Observe()
	after, readErr := clockRead(unix.CLOCK_MONOTONIC)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if errors.Is(err, ErrUnavailable) {
		t.Log("actual kernel observation unavailable; no usable UTC-bound claim")
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if value.Version != 1 || value.MonotonicMs < before/1_000_000 || value.MonotonicMs > after/1_000_000 || value.CorrelationErrorMs <= 0 || value.UncertaintyMs < value.CorrelationErrorMs {
		t.Fatal("actual observation outside invocation or error bounds")
	}
	t.Logf("actual kernel reported uncertainty_ms=%d; conditional host bound only", value.UncertaintyMs)
}
