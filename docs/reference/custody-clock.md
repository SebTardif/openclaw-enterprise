# Linux custody clock

The controller can supply `CustodyClockV1` from a protected Linux clock observer.
Each synchronous read combines a wall-clock observation, the kernel's stable
monotonic clock and a conservatively rounded uncertainty. Custody consumers retain
their own uncertainty limits; this supplier never reduces a reported error to
make a sample acceptable.

## Supported clock contract

The uncertainty is **kernel-reported error under a trusted, synchronized host
clock**. It is not independent proof of UTC accuracy. The host administrator,
kernel, clock discipline and its time sources must be trusted. An administrator
can alter the reported error or time state, and finite observations cannot detect
every clock step followed by a compensating step between samples.

The native observer calls `adjtimex` with `modes = 0`, and reads
`CLOCK_REALTIME`, `CLOCK_MONOTONIC` and their resolutions. These operations do not
configure NTP, adjust time, request capabilities or change host settings. It
requires synchronized `TIME_OK` observations and rejects leap activity, reported
faults, invalid or overflowing values and inconsistent wall/monotonic sampling.
The Linux interface reports maximum error and precision in microseconds; a
nanosecond time mode does not change those fields' units.
See the [Linux adjtimex interface](https://man7.org/linux/man-pages/man2/adjtimex.2.html)
and [kernel clock discipline implementation](https://github.com/torvalds/linux/blob/v6.8/kernel/time/ntp.c).

The native bound includes the larger maximum error and precision from the two
kernel observations, both clock resolutions, the full native sampling bracket,
upward millisecond rounding and output quantization. It additionally accounts
for the kernel's discrete maximum-error update interval and observed oscillator
tolerance. The controller adds the full measured invocation/validation interval,
including process startup. A final host realtime observation is bracketed by
monotonic reads and checked against the native and original correlation. It
rejects a suspend or clock step visible as disjoint intervals at that final parent
observation; monotonic elapsed time alone excludes suspend. An interruption after
the final observation remains outside the atomic guarantees of a sampled clock.
The charged age is the larger of monotonic elapsed
time and the observed realtime advance plus the measured final sampling tail,
rounded outward. It must fit the same
one-second acceptance limit, including when a wide sampling bracket hides a small
suspend. A separate correlation bound excludes UTC maximum
error: the controller intersects wall-minus-monotonic intervals with its original
observation and permanently refuses a detected clock step, suspend or epoch
change. Neither a large error estimate nor repeated small changes can reset that
original correlation.

Linux Node `process.hrtime.bigint()` and the helper both use the kernel monotonic
epoch. The controller verifies every helper timestamp lies inside its actual
invocation bracket. This avoids a new process-relative origin on every read.
The supported correspondence is visible in
[Node's hrtime binding](https://github.com/nodejs/node/blob/v24.20.0/src/node_process_methods.cc)
and [libuv's Linux clock selection](https://github.com/libuv/libuv/blob/v1.52.1/src/unix/linux.c).
The final realtime fence uses Node/V8's actual host clock, with its
[millisecond floor](https://github.com/nodejs/node/blob/v24.20.0/deps/v8/include/v8-platform.h)
and [POSIX gettimeofday source](https://github.com/nodejs/node/blob/v24.20.0/deps/v8/src/base/platform/time.cc).
It creates no new UTC trust assertion. The pure numeric continuity filter is
separately tested with suspend/step and rounding vectors; it produces no clock or
authority handle.

## Construction and lifetime

Build the small observer and protect its executable and parent directories from
replacement or writes by untrusted processes:

```sh
go -C components/runtime-security build -o ./bin/oce-clock-observation ./cmd/oce-clock-observation
chmod 0500 components/runtime-security/bin/oce-clock-observation
```

Deployment selects the absolute path and exact `sha256:` executable digest once:

```ts
const clock = await createLinuxCustodyClockV1(
  { binaryPath, nativeExecutableSha256 },
  startupSignal,
);
```

`createLinuxCustodyClockV1` is defined in
`apps/controller/src/admission/custody-clock.ts`. It returns the required
synchronous `read()` method and an asynchronous, idempotent `close()`. Startup
performs an actual observation and fails if the current kernel is unavailable.
The caller selects the clock in its custody constructor and owns final closure.
Closing immediately invalidates further reads and releases the original file
descriptor. A failed read permanently invalidates that clock instance.

Construction reuses the existing native executable verification, then hashes and
retains the exact descriptor used for all future executions. The observer must
be a regular executable owned by root or the controller UID, at most 16 MiB, with
no write permission bits. Metadata checks before and after each execution reject
changes to the original file. A privileged concurrent writer remains outside
this custody boundary; a digest check is not a replacement for protected
deployment ownership.

Each read executes only `/proc/self/fd/3` with the retained executable descriptor
and fixed argument `read`, an empty environment, ignored input and stderr, a
1024-byte output cap and a one-second timeout using `SIGKILL`. The complete
measured interval must also fit one second. No command, argument, callback,
uncertainty allowance or alternate clock can be supplied to `read()`. This
synchronous process invocation blocks the controller event loop; it is intended
for the bounded custody checks that require this port. Process timeouts require
the trusted kernel to schedule and terminate the child.

## Verification and current-host availability

The actual observer's only command is:

```sh
components/runtime-security/bin/oce-clock-observation read
```

Success returns one closed JSON observation with schema version 1, wall and
monotonic milliseconds, absolute uncertainty and the separate correlation error.
Failure returns `{"version":1,"error":"unavailable"}` and exit status 1. It does
not repair synchronization. The controller exposes only the three fields of
`CustodyClockV1` and throws an unavailable error on failure.

Native tests exercise real read-only kernel observation and deterministic
sampling/error calculations. The controller test runs the actual selected
executable and checks stable kernel correspondence, executable custody and
lifetime. Disposable invalid executables test only protocol/time/output refusal;
they establish no positive clock bound. If the current kernel reports
unavailable, the suite records that result and explicitly skips the case that
requires a live synchronized retained clock. It never changes host time to make
tests pass.

```sh
go -C components/runtime-security test -race ./clockobservation ./cmd/oce-clock-observation
OCC_CUSTODY_CLOCK_TEST_BINARY=/absolute/protected/oce-clock-observation node --test tests/integration/custody-clock.test.mjs
```

This component provides the clock operand. Selecting it in the complete custody
assembly, applying the consumer's maximum uncertainty and qualifying the deployed
host clock remain the responsibilities of that assembly and deployment.
