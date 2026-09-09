import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

const unavailable = () => new Error("Gateway native executable unavailable");
const hashPattern = /^sha256:[0-9a-f]{64}$/u;

/** The original deployment must protect the binary AND its parent directories.
 * This bounded digest check cannot defeat a privileged concurrent replacement. */
export async function verifyGatewayNativeExecutableV1(
  path: string,
  expected: string,
  signal: AbortSignal,
) {
  if (!isAbsolute(path) || normalize(path) !== path || !hashPattern.test(expected))
    throw unavailable();
  signal.throwIfAborted();
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
      throw unavailable();
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    try {
      for (let offset = 0; offset < before.size;) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - offset),
          offset,
        );
        if (!bytesRead) throw unavailable();
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await file.stat();
      signal.throwIfAborted();
      if (
        before.size !== after.size ||
        before.ctimeMs !== after.ctimeMs ||
        before.mtimeMs !== after.mtimeMs ||
        `sha256:${hash.digest("hex")}` !== expected
      )
        throw unavailable();
    } finally {
      buffer.fill(0);
    }
  } finally {
    await file.close();
  }
}
