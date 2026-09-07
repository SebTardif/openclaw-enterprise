import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { nativeUnavailable } from "./runtime-authority-wire.ts";

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
