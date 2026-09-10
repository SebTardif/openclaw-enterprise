import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

// Image-construction helper only. Neither argv nor a launch descriptor selects
// the executable, its expected digest, or the installed module's location.
const nativeBinaryPath = "/usr/local/bin/oce-runtime-authority";
const outputPath = "/app/apps/gateway/src/installed-native.mjs";
if (process.argv.length !== 2 || process.getuid() !== 0)
  throw new Error("Installed native binding requires the original image construction.");

const binary = await open(nativeBinaryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
let nativeExecutableSha256;
try {
  const before = await binary.stat();
  if (
    !before.isFile() ||
    before.uid !== 0 ||
    (before.mode & 0o777) !== 0o555 ||
    before.size < 1 ||
    before.size > 256 * 1024 * 1024
  )
    throw new Error("The copied native executable is not immutable.");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(65536);
  for (let offset = 0; offset < before.size;) {
    const { bytesRead } = await binary.read(
      buffer,
      0,
      Math.min(buffer.length, before.size - offset),
      offset,
    );
    if (bytesRead === 0) throw new Error("Incomplete copied native executable.");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = await binary.stat();
  if (
    before.size !== after.size ||
    before.ctimeMs !== after.ctimeMs ||
    before.mtimeMs !== after.mtimeMs
  )
    throw new Error("Copied native executable changed during image construction.");
  nativeExecutableSha256 = `sha256:${hash.digest("hex")}`;
} finally {
  await binary.close();
}
const output = await open(
  outputPath,
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  0o444,
);
try {
  const info = await output.stat();
  if (!info.isFile() || info.uid !== 0) throw new Error("Invalid installed native module.");
  await output.writeFile(
    "// Generated from the actual copied native executable during image construction.\n" +
      `export const nativeBinaryPath = ${JSON.stringify(nativeBinaryPath)};\n` +
      `export const nativeExecutableSha256 = ${JSON.stringify(nativeExecutableSha256)};\n`,
  );
  await output.chmod(0o444);
} finally {
  await output.close();
}
