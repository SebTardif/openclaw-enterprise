import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, fstatSync, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { CustodyClockV1 } from "@openclaw-enterprise/occ/credential-custody-v1/ports";
import { verifyNativeExecutable } from "./native-child-lifetime.ts";
import { closedNativeObject, nativeJson } from "./runtime-authority-wire.ts";

const unavailable = () => new Error("Custody clock is unavailable.");
const maximumBinaryBytes = 16 * 1024 * 1024;
const maximumOutputBytes = 1024;
const invocationMilliseconds = 1000;
const maximumInteger = BigInt(Number.MAX_SAFE_INTEGER);
const millisecond = 1_000_000n;

export interface LinuxCustodyClockOptionsV1 {
  readonly binaryPath: string;
  readonly nativeExecutableSha256: string;
}

/** The deployment owns the protected executable and synchronized host clock.
 * This supplier reports the kernel's error estimate, not independent UTC proof. */
export interface LinuxCustodyClockV1 extends CustodyClockV1 {
  close(): Promise<void>;
}

type ClockCorrelation = Readonly<{ lower: bigint; upper: bigint }>;

/** Pure numeric refusal/rounding filter. It creates no clock, observation
 * producer or authority handle. Correlation intervals use nanoseconds. */
export function checkCustodyClockContinuityV1(
  original: ClockCorrelation,
  final: Readonly<{
    nativeWallMs: number;
    invocationBeforeNs: bigint;
    beforeNs: bigint;
    wallMs: number;
    afterNs: bigint;
    completeNs: bigint;
  }>,
): Readonly<{ correlation: ClockCorrelation; ageMs: bigint }> | undefined {
  if (
    original.lower > original.upper ||
    !Number.isSafeInteger(final.nativeWallMs) ||
    final.nativeWallMs < 0 ||
    !Number.isSafeInteger(final.wallMs) ||
    final.wallMs < final.nativeWallMs ||
    final.invocationBeforeNs < 0n ||
    final.beforeNs < final.invocationBeforeNs ||
    final.afterNs < final.beforeNs ||
    final.completeNs < final.afterNs
  )
    return undefined;
  // Date.now floors the actual realtime observation to milliseconds. Retain
  // that whole millisecond and both sides of its monotonic sampling bracket.
  const lower = BigInt(final.wallMs) * millisecond - final.afterNs;
  const upper = (BigInt(final.wallMs) + 1n) * millisecond - final.beforeNs;
  const correlation = {
    lower: lower > original.lower ? lower : original.lower,
    upper: upper < original.upper ? upper : original.upper,
  };
  if (correlation.lower > correlation.upper) return undefined;
  const elapsed = final.completeNs - final.invocationBeforeNs;
  const monotonicAge = (elapsed + millisecond - 1n) / millisecond;
  // Charge realtime age even when rounding or a wide sampling bracket hides a
  // small step/suspend. One millisecond covers the two floor-ms observations.
  // The final wall read occurred no earlier than beforeNs; include its whole
  // measured tail so a prior suspend cannot conceal later awake elapsed time.
  const tail = (final.completeNs - final.beforeNs + millisecond - 1n) / millisecond;
  const realtimeAge = BigInt(final.wallMs) - BigInt(final.nativeWallMs) + 1n + tail;
  const ageMs = realtimeAge > monotonicAge ? realtimeAge : monotonicAge;
  if (ageMs > BigInt(invocationMilliseconds)) return undefined;
  return Object.freeze({ correlation: Object.freeze(correlation), ageMs });
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}

/** Retain and hash the same executable descriptor that every read executes.
 * Read-only mode and the existing native custody check do not defend against a
 * privileged concurrent writer; the deployment must protect the inode/parents. */
async function captureExecutable(
  path: string,
  expected: string,
  signal: AbortSignal,
): Promise<{ file: FileHandle; identity: BigIntStats }> {
  await verifyNativeExecutable(path, expected, signal);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const identity = await file.stat({ bigint: true });
    if (
      signal.aborted ||
      !identity.isFile() ||
      identity.size < 1n ||
      identity.size > BigInt(maximumBinaryBytes) ||
      (identity.mode & 0o222n) !== 0n ||
      (identity.mode & 0o111n) === 0n ||
      (identity.uid !== 0n && identity.uid !== BigInt(process.getuid!()))
    )
      throw unavailable();
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < Number(identity.size)) {
      if (signal.aborted) throw unavailable();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, Number(identity.size) - offset),
        offset,
      );
      if (bytesRead === 0) throw unavailable();
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (
      signal.aborted ||
      !sameFile(identity, await file.stat({ bigint: true })) ||
      `sha256:${digest.digest("hex")}` !== expected
    )
      throw unavailable();
    return { file, identity };
  } catch {
    await file.close();
    throw unavailable();
  }
}

/** Async startup selects one original protected Linux executable. Returned read
 * is synchronous and has no command, argument, clock allowance or callback input. */
export async function createLinuxCustodyClockV1(
  input: LinuxCustodyClockOptionsV1,
  signal: AbortSignal,
): Promise<LinuxCustodyClockV1> {
  const options = Object.freeze({
    binaryPath: input.binaryPath,
    nativeExecutableSha256: input.nativeExecutableSha256,
  });
  const began = process.hrtime.bigint();
  const startup = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
  let retained: { file: FileHandle; identity: BigIntStats } | undefined;
  try {
    if (process.platform !== "linux" || !process.getuid || startup.aborted) throw unavailable();
    retained = await captureExecutable(options.binaryPath, options.nativeExecutableSha256, startup);
    const { file, identity } = retained;
    const realtimeNow = Date.now.bind(Date);
    let invalid = false;
    let closing: Promise<void> | undefined;
    let originalOffset: ClockCorrelation | undefined;
    let previous: ReturnType<CustodyClockV1["read"]> | undefined;
    const clock: LinuxCustodyClockV1 = Object.freeze({
      read() {
        try {
          if (invalid) throw unavailable();
          // Linux Node hrtime uses CLOCK_MONOTONIC, the same stable kernel epoch
          // selected by the helper. Include all custody checks and process time.
          const before = process.hrtime.bigint();
          if (!sameFile(identity, fstatSync(file.fd, { bigint: true }))) throw unavailable();
          const result = spawnSync("/proc/self/fd/3", ["read"], {
            stdio: ["ignore", "pipe", "ignore", file.fd],
            env: {},
            cwd: "/",
            timeout: invocationMilliseconds,
            killSignal: "SIGKILL",
            maxBuffer: maximumOutputBytes,
            windowsHide: true,
          });
          if (!sameFile(identity, fstatSync(file.fd, { bigint: true }))) throw unavailable();
          const after = process.hrtime.bigint();
          const elapsed = after - before;
          if (
            result.error ||
            result.status !== 0 ||
            result.signal !== null ||
            elapsed < 0n ||
            elapsed > BigInt(invocationMilliseconds) * millisecond ||
            !Buffer.isBuffer(result.stdout) ||
            result.stdout.length < 2 ||
            result.stdout.length > maximumOutputBytes ||
            result.stdout.at(-1) !== 10
          )
            throw unavailable();
          const observation = closedNativeObject(nativeJson(result.stdout.subarray(0, -1)), [
            "version",
            "wall_ms",
            "monotonic_ms",
            "uncertainty_ms",
            "correlation_error_ms",
          ]);
          if (observation.version !== 1) throw unavailable();
          const wallMs = integer(observation.wall_ms);
          const monotonicMs = integer(observation.monotonic_ms);
          const kernelUncertainty = integer(observation.uncertainty_ms);
          const correlation = integer(observation.correlation_error_ms);
          const monotonic = BigInt(monotonicMs);
          if (
            correlation > kernelUncertainty ||
            monotonic < before / millisecond ||
            monotonic > after / millisecond ||
            (previous !== undefined &&
              (wallMs < previous.wallMs || monotonicMs < previous.monotonicMs))
          )
            throw unavailable();
          const offset = (BigInt(wallMs) - monotonic) * millisecond;
          const lower = offset - BigInt(correlation) * millisecond;
          const upper = offset + BigInt(correlation) * millisecond;
          // Retain the intersection with the original observed correlation. UTC
          // maxerror never excuses a detected clock step, suspend or epoch swap.
          const intersection = originalOffset
            ? {
                lower: lower > originalOffset.lower ? lower : originalOffset.lower,
                upper: upper < originalOffset.upper ? upper : originalOffset.upper,
              }
            : { lower, upper };
          if (intersection.lower > intersection.upper) throw unavailable();
          // CLOCK_MONOTONIC excludes suspend. Check actual parent realtime after
          // all wire/descriptor work, covering suspension after the helper's
          // last sample. UTC maxerror cannot excuse that stale-age gap.
          const finalBefore = process.hrtime.bigint();
          const finalWall = integer(realtimeNow());
          const finalAfter = process.hrtime.bigint();
          const complete = process.hrtime.bigint();
          const final = checkCustodyClockContinuityV1(intersection, {
            nativeWallMs: wallMs,
            invocationBeforeNs: before,
            beforeNs: finalBefore,
            wallMs: finalWall,
            afterNs: finalAfter,
            completeNs: complete,
          });
          if (!final) throw unavailable();
          const completeElapsed = complete - before;
          const uncertainty = BigInt(kernelUncertainty) + final.ageMs;
          if (
            completeElapsed < elapsed ||
            completeElapsed > BigInt(invocationMilliseconds) * millisecond ||
            uncertainty > maximumInteger ||
            BigInt(wallMs) + uncertainty > maximumInteger ||
            monotonic + uncertainty > maximumInteger
          )
            throw unavailable();
          originalOffset = final.correlation;
          previous = Object.freeze({ wallMs, monotonicMs, uncertaintyMs: Number(uncertainty) });
          return previous;
        } catch {
          invalid = true;
          throw unavailable();
        }
      },
      close() {
        invalid = true;
        closing ??= file.close();
        return closing;
      },
    });
    clock.read();
    if (startup.aborted || process.hrtime.bigint() - began > 3_000_000_000n) {
      await clock.close();
      retained = undefined;
      throw unavailable();
    }
    return clock;
  } catch {
    await retained?.file.close();
    throw unavailable();
  }
}
