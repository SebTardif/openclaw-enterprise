import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lockPath = join(repository, "deploy/egress/runtime-packages.lock.json");
const destination = join(repository, ".build/mvp/egress-debs");
const digestPattern = /^[a-f0-9]{64}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateLock(lock) {
  requireValue(lock?.schemaVersion === 1, "unsupported runtime package lock");
  requireValue(
    lock.architecture === "amd64",
    "runtime packages are qualified only for linux/amd64",
  );
  requireValue(
    /^node:24-trixie-slim@sha256:[a-f0-9]{64}$/.test(lock.baseImage),
    "a pinned official Node trixie image is required",
  );
  requireValue(
    Array.isArray(lock.packages) && lock.packages.length > 0 && lock.packages.length <= 64,
    "invalid runtime package closure",
  );
  const names = new Set();
  for (const entry of lock.packages) {
    requireValue(
      typeof entry.filename === "string" && /^[a-z0-9][a-z0-9.+_~%-]*\.deb$/.test(entry.filename),
      "invalid runtime package filename",
    );
    requireValue(!names.has(entry.filename), "duplicate runtime package filename");
    names.add(entry.filename);
    requireValue(digestPattern.test(entry.sha256), "invalid runtime package digest");
    requireValue(
      Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= 32 * 1024 * 1024,
      "invalid runtime package size",
    );
    const url = new URL(entry.url);
    requireValue(
      url.origin === "https://deb.debian.org" &&
        url.pathname.startsWith("/debian/pool/") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "runtime packages must come from the official Debian archive",
    );
    requireValue(
      decodeURIComponent(url.pathname.split("/").at(-1)) === decodeURIComponent(entry.filename),
      "package URL and filename disagree",
    );
  }
  return lock;
}

async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}

export async function verifyDirectory(lock, directory) {
  validateLock(lock);
  const directoryStat = await lstat(directory);
  requireValue(
    directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
    "invalid runtime package directory",
  );
  const expected = new Set(["SHA256SUMS", ...lock.packages.map((entry) => entry.filename)]);
  const actual = await readdir(directory);
  requireValue(
    actual.length === expected.size && actual.every((name) => expected.has(name)),
    "runtime package directory does not match the complete locked closure",
  );
  for (const entry of lock.packages) {
    const path = join(directory, entry.filename);
    const stat = await lstat(path);
    requireValue(
      stat.isFile() && !stat.isSymbolicLink() && stat.size === entry.bytes,
      "runtime package file is invalid",
    );
    requireValue((await hashFile(path)) === entry.sha256, "runtime package checksum mismatch");
  }
  const sums = await lstat(join(directory, "SHA256SUMS"));
  requireValue(
    sums.isFile() && !sums.isSymbolicLink(),
    "invalid runtime package checksum manifest",
  );
  requireValue(
    (await readFile(join(directory, "SHA256SUMS"), "utf8")) === checksumManifest(lock),
    "runtime package checksum manifest does not match the lock",
  );
}

export function checksumManifest(lock) {
  return lock.packages.map((entry) => `${entry.sha256}  ${entry.filename}\n`).join("");
}

async function download(entry, directory) {
  const response = await fetch(entry.url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  requireValue(response.ok && response.body, "runtime package download failed");
  const chunks = [];
  let bytes = 0;
  const digest = createHash("sha256");
  for await (const chunk of response.body) {
    bytes += chunk.length;
    requireValue(bytes <= entry.bytes, "runtime package exceeded its locked size");
    chunks.push(chunk);
    digest.update(chunk);
  }
  requireValue(
    bytes === entry.bytes && digest.digest("hex") === entry.sha256,
    "runtime package download does not match the lock",
  );
  await writeFile(join(directory, entry.filename), Buffer.concat(chunks), {
    mode: 0o644,
    flag: "wx",
  });
}

async function main() {
  requireValue(
    process.argv.length <= 3 && [undefined, "--verify"].includes(process.argv[2]),
    "usage: node deploy/egress/download-packages.mjs [--verify]",
  );
  requireValue(
    process.platform === "linux" && process.arch === "x64",
    "runtime image packaging is qualified only on linux/amd64",
  );
  const lock = validateLock(JSON.parse(await readFile(lockPath, "utf8")));
  if (process.argv[2] === "--verify") {
    await verifyDirectory(lock, destination);
    console.log("Verified the complete locked runtime package closure.");
    return;
  }
  const existing = await lstat(destination).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing) {
    // Existing unexplained content is never silently replaced or sent to Docker.
    await verifyDirectory(lock, destination);
    console.log("The complete locked runtime package closure is already present.");
    return;
  }
  await mkdir(dirname(destination), { recursive: true });
  const staging = `${destination}.download-${process.pid}`;
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const entry of lock.packages) await download(entry, staging);
    await writeFile(join(staging, "SHA256SUMS"), checksumManifest(lock), {
      flag: "wx",
      mode: 0o644,
    });
    await verifyDirectory(lock, staging);
    await rename(staging, destination);
    console.log("Downloaded and verified the complete locked runtime package closure.");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Egress package preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
