// Package clockobservation reads a conditional trusted-host clock observation.
// It does not independently verify UTC or establish credential-use authority.
package clockobservation

import (
	"errors"
	"math"
	"math/bits"

	"golang.org/x/sys/unix"
)

var ErrUnavailable = errors.New("clock observation unavailable")

// Observation is the closed V1 wire representation. CorrelationErrorMs excludes
// absolute UTC uncertainty so a consumer can detect wall/monotonic discontinuity
// independently of a large kernel-reported synchronization error.
type Observation struct {
	Version            int   `json:"version"`
	WallMs             int64 `json:"wall_ms"`
	MonotonicMs        int64 `json:"monotonic_ms"`
	UncertaintyMs      int64 `json:"uncertainty_ms"`
	CorrelationErrorMs int64 `json:"correlation_error_ms"`
}

type clockPair struct{ before, wall, after int64 }
type kernelSample struct {
	pairs                          [3]clockPair
	discipline                     [2]unix.Timex
	states                         [2]int
	wallResolution, monoResolution int64
}

// Observe performs only clock_gettime, clock_getres and modes=0 adjtimex reads.
// The same inherited Linux time namespace supplies CLOCK_MONOTONIC's epoch
// across helper invocations; the consumer must verify its own invocation bracket.
// Linux v6.8 kernel/time/ntp.c and include/linux/timex.h define the reported
// maxerror, precision and scaled-ppm tolerance used below. These are trusted
// kernel/admin assertions, not externally measured absolute UTC accuracy.
func Observe() (Observation, error) {
	var s kernelSample
	var err error
	if s.wallResolution, err = resolution(unix.CLOCK_REALTIME); err != nil {
		return Observation{}, ErrUnavailable
	}
	if s.monoResolution, err = resolution(unix.CLOCK_MONOTONIC); err != nil {
		return Observation{}, ErrUnavailable
	}
	for i := 0; i < 3; i++ {
		if s.pairs[i], err = readPair(); err != nil {
			return Observation{}, ErrUnavailable
		}
		if i < 2 {
			// A new zero-valued timex makes the read-only mode explicit; no caller
			// configuration or returned timex is ever reused as syscall input.
			tx := unix.Timex{Modes: 0}
			state, e := unix.Adjtimex(&tx)
			if e != nil {
				return Observation{}, ErrUnavailable
			}
			s.discipline[i], s.states[i] = tx, state
		}
	}
	wallRes, e1 := resolution(unix.CLOCK_REALTIME)
	monoRes, e2 := resolution(unix.CLOCK_MONOTONIC)
	if e1 != nil || e2 != nil || wallRes != s.wallResolution || monoRes != s.monoResolution {
		return Observation{}, ErrUnavailable
	}
	return evaluate(s)
}

func resolution(clock int32) (int64, error) {
	var ts unix.Timespec
	if unix.ClockGetres(clock, &ts) != nil {
		return 0, ErrUnavailable
	}
	n, ok := nanoseconds(int64(ts.Sec), int64(ts.Nsec))
	if !ok || n == 0 {
		return 0, ErrUnavailable
	}
	return n, nil
}
func clockRead(clock int32) (int64, error) {
	var ts unix.Timespec
	if unix.ClockGettime(clock, &ts) != nil {
		return 0, ErrUnavailable
	}
	n, ok := nanoseconds(int64(ts.Sec), int64(ts.Nsec))
	if !ok {
		return 0, ErrUnavailable
	}
	return n, nil
}
func readPair() (clockPair, error) {
	var p clockPair
	var err error
	if p.before, err = clockRead(unix.CLOCK_MONOTONIC); err != nil {
		return p, err
	}
	if p.wall, err = clockRead(unix.CLOCK_REALTIME); err != nil {
		return p, err
	}
	if p.after, err = clockRead(unix.CLOCK_MONOTONIC); err != nil {
		return p, err
	}
	return p, nil
}
func nanoseconds(sec, nsec int64) (int64, bool) {
	if sec < 0 || nsec < 0 || nsec >= 1_000_000_000 || sec > (math.MaxInt64-nsec)/1_000_000_000 {
		return 0, false
	}
	return sec*1_000_000_000 + nsec, true
}
func sum(values ...int64) (int64, bool) {
	var n int64
	for _, v := range values {
		if v < 0 || n > math.MaxInt64-v {
			return 0, false
		}
		n += v
	}
	return n, true
}
func signedAdd(a, b int64) (int64, bool) {
	if b > 0 && a > math.MaxInt64-b || b < 0 && a < math.MinInt64-b {
		return 0, false
	}
	return a + b, true
}
func ceilMs(n int64) int64 {
	q := n / 1_000_000
	if n%1_000_000 != 0 {
		q++
	}
	return q
}
func mulDivCeil(a, b, den int64) (int64, bool) {
	if a < 0 || b < 0 || den <= 0 {
		return 0, false
	}
	hi, lo := bits.Mul64(uint64(a), uint64(b))
	if hi >= uint64(den) {
		return 0, false
	}
	q, r := bits.Div64(hi, lo, uint64(den))
	if q > math.MaxInt64 || r != 0 && q == math.MaxInt64 {
		return 0, false
	}
	if r != 0 {
		q++
	}
	return int64(q), true
}

func disciplineValid(tx unix.Timex, state int) bool {
	const permitted = unix.STA_PLL | unix.STA_PPSFREQ | unix.STA_PPSTIME | unix.STA_FLL | unix.STA_FREQHOLD | unix.STA_PPSSIGNAL | unix.STA_NANO | unix.STA_MODE | unix.STA_CLK
	if tx.Modes != 0 || state != unix.TIME_OK || tx.Status & ^int32(permitted) != 0 {
		return false
	}
	if tx.Status&(unix.STA_PPSFREQ|unix.STA_PPSTIME) != 0 && tx.Status&unix.STA_PPSSIGNAL == 0 {
		return false
	}
	return tx.Maxerror >= 0 && tx.Esterror >= 0 && tx.Esterror <= tx.Maxerror && tx.Precision > 0 && tx.Tolerance > 0
}
func timexWall(tx unix.Timex) (int64, int64, bool) {
	unit := int64(1000)
	if tx.Status&unix.STA_NANO != 0 {
		unit = 1
	}
	usec := int64(tx.Time.Usec)
	if usec < 0 || usec >= 1_000_000_000/unit {
		return 0, 0, false
	}
	n, ok := nanoseconds(int64(tx.Time.Sec), usec*unit)
	return n, unit, ok
}

// evaluate is arithmetic and validation only. Its synthetic test vectors are
// not a substitute for Observe's real kernel producer.
func evaluate(s kernelSample) (Observation, error) {
	unavailable := func() (Observation, error) { return Observation{}, ErrUnavailable }
	if s.wallResolution <= 0 || s.monoResolution <= 0 {
		return unavailable()
	}
	quantization, ok := sum(s.wallResolution, s.monoResolution)
	if !ok {
		return unavailable()
	}
	lower, upper := int64(math.MinInt64), int64(math.MaxInt64)
	for i, p := range s.pairs {
		if p.before < 0 || p.wall < 0 || p.after < p.before {
			return unavailable()
		}
		if i > 0 && (p.before < s.pairs[i-1].after || p.wall < s.pairs[i-1].wall) {
			return unavailable()
		}
		// Each real-time read occurred between its monotonic reads. Intersect the
		// offset intervals, widened only by measured clock resolution. A visible
		// step/suspend/epoch change is rejected rather than hidden in UTC maxerror.
		lo, ok1 := signedAdd(p.wall-p.after, -quantization)
		hi, ok2 := signedAdd(p.wall-p.before, quantization)
		if !ok1 || !ok2 {
			return unavailable()
		}
		lower = max(lower, lo)
		upper = min(upper, hi)
		if lower > upper {
			return unavailable()
		}
	}
	var maxerror, precision, tolerance int64
	for i, tx := range s.discipline {
		if !disciplineValid(tx, s.states[i]) {
			return unavailable()
		}
		wall, unit, ok := timexWall(tx)
		if !ok {
			return unavailable()
		}
		q, ok := sum(s.wallResolution, unit)
		if !ok {
			return unavailable()
		}
		// adjtimex's own real-time snapshot must also fit its surrounding reads,
		// accounting for its explicit microsecond/nanosecond representation.
		lo, ok1 := signedAdd(s.pairs[i].wall, -q)
		hi, ok2 := signedAdd(s.pairs[i+1].wall, q)
		if !ok1 || !ok2 || wall < lo || wall > hi {
			return unavailable()
		}
		maxerror = max(maxerror, int64(tx.Maxerror))
		precision = max(precision, int64(tx.Precision))
		tolerance = max(tolerance, int64(tx.Tolerance))
	}
	if s.discipline[0].Status != s.discipline[1].Status || s.discipline[0].Tai != s.discipline[1].Tai {
		return unavailable()
	}
	bracket := s.pairs[2].after - s.pairs[0].before
	correlation, ok := sum(bracket, quantization, 2_000_000)
	if !ok {
		return unavailable()
	}
	errorNs, ok := mulDivCeil(maxerror, 1000, 1)
	if !ok {
		return unavailable()
	}
	precisionNs, ok := mulDivCeil(precision, 1000, 1)
	if !ok {
		return unavailable()
	}
	// ntp.c increments maxerror at second overflow. Include one full accounting
	// second plus this complete sample's elapsed time, using the kernel-reported
	// scaled-ppm tolerance (2^16 units per ppm), with checked outward rounding.
	elapsed, ok := sum(1_000_000_000, bracket)
	if !ok {
		return unavailable()
	}
	growth, ok := mulDivCeil(elapsed, tolerance, 65536*1_000_000)
	if !ok {
		return unavailable()
	}
	uncertainty, ok := sum(errorNs, precisionNs, correlation, growth)
	if !ok {
		return unavailable()
	}
	center := s.pairs[1]
	result := Observation{Version: 1, WallMs: center.wall / 1_000_000, MonotonicMs: (center.before + (center.after-center.before)/2) / 1_000_000, UncertaintyMs: ceilMs(uncertainty), CorrelationErrorMs: ceilMs(correlation)}
	const safeInteger = 9007199254740991
	for _, n := range []int64{result.WallMs, result.MonotonicMs, result.UncertaintyMs, result.CorrelationErrorMs} {
		if n < 0 || n > safeInteger {
			return unavailable()
		}
	}
	return result, nil
}
