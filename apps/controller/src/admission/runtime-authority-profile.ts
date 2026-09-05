import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import {
  canonicalRuntimeServiceTrust,
  parseRuntimeServiceNativeProfile,
  type RuntimeServiceNativeProfile,
} from "@openclaw-enterprise/occ";
import {
  closedNativeObject,
  consumeNativeFrames,
  nativeJson,
  nativeUnavailable,
  writeNativeFrame,
} from "./runtime-authority-wire.ts";

/** The deployment must protect the executable and its parent directories from
 * replacement. A digest check does not defeat a privileged concurrent writer. */
export async function verifyNativeExecutable(
  path: string,
  expected: string,
  signal: AbortSignal,
): Promise<void> {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    !/^sha256:[0-9a-f]{64}$/.test(expected) ||
    signal.aborted
  )
    throw nativeUnavailable();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > 256 * 1024 * 1024 ||
      (before.mode & 0o022) !== 0 ||
      (before.mode & 0o111) === 0 ||
      (before.uid !== 0 && before.uid !== process.getuid?.())
    )
      throw nativeUnavailable();
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < before.size) {
      if (signal.aborted) throw nativeUnavailable();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (bytesRead === 0) throw nativeUnavailable();
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      signal.aborted ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      `sha256:${hash.digest("hex")}` !== expected
    )
      throw nativeUnavailable();
  } finally {
    await file.close();
  }
}

/** Observe the actual exit; never detach or adopt a process by PID. */
export function nativeChildExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
    child.once("error", () => {});
  });
}
export async function closeNativeChild(child: ChildProcess, exited: Promise<void>): Promise<void> {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 250);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(nativeUnavailable()), 3000);
      }),
    ]);
  } finally {
    clearTimeout(kill);
    clearTimeout(deadline);
  }
}

/** Admission's pure maintained parser. This starts no listener or Source and
 * supplies no role, registry record, authenticated context or runtime effect. */
export async function validateNativeRuntimeServiceProfile(
  binaryPath: string,
  input: Readonly<RuntimeServiceNativeProfile>,
  parentSignal: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(3000)]);
  const profile = parseRuntimeServiceNativeProfile(input);
  await verifyNativeExecutable(binaryPath, profile.nativeExecutableSha256, signal);
  const child = spawn(binaryPath, ["validate-profile"], {
    env: {},
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  const exited = nativeChildExit(child);
  let stop = () => {};
  try {
    const result = new Promise<void>((resolve, reject) => {
      let seen = false;
      const abort = () => reject(nativeUnavailable());
      signal.addEventListener("abort", abort, { once: true });
      stop = consumeNativeFrames(
        child.stdout,
        (bytes) => {
          const value = closedNativeObject(nativeJson(bytes), ["schemaVersion", "result"]);
          if (seen || value.schemaVersion !== 1 || value.result !== "valid") {
            reject(nativeUnavailable());
            return;
          }
          seen = true;
        },
        (reason) => {
          if (reason !== "eof" || !seen) reject(nativeUnavailable());
        },
      );
      exited.then(() => {
        signal.removeEventListener("abort", abort);
        if (seen && child.exitCode === 0 && !signal.aborted) resolve();
        else reject(nativeUnavailable());
      });
      if (signal.aborted) abort();
    });
    result.catch(() => {});
    // Canonical field ordering comes from the actual registry serializer.
    await writeNativeFrame(child.stdin, JSON.parse(canonicalRuntimeServiceTrust(profile)), signal);
    child.stdin.end();
    await result;
  } finally {
    stop();
    await closeNativeChild(child, exited);
  }
}
