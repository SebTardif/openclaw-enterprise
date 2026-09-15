import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const retainChild = fileURLToPath(new URL("./retain-child.mjs", import.meta.url));

export function interruptProtectedGitHubRetain({
  directory,
  envelopeFile,
  originalContext,
  limit,
  record,
}) {
  assert.ok(existsSync("/usr/bin/prlimit"), "util-linux prlimit is required on Linux");
  assert.deepEqual(readdirSync(directory), []);
  const child = spawnSync(
    "/usr/bin/prlimit",
    [
      `--fsize=${limit}:${limit}`,
      "--core=0:0",
      "--",
      process.execPath,
      retainChild,
      directory,
      envelopeFile,
      originalContext,
      String(limit),
    ],
    {
      cwd: repositoryRoot,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
    },
  );
  assert.equal(child.error, undefined);
  const events = child.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).event);
  assert.equal(events[0], "before-retain");
  assert.ok(
    child.signal === "SIGXFSZ" || (child.status === 0 && events.includes("retain-rejected")),
    `unexpected limited child exit: status=${child.status} signal=${child.signal}`,
  );
  assert.equal(events.includes("unexpected-retain-success"), false);
  assert.equal(child.stderr, "");

  // The real owner chooses the staging name and commitment. The fixture only
  // observes its genuine short write; it never reconstructs the record codec.
  const names = readdirSync(directory);
  assert.equal(names.length, 1);
  const [pendingName] = names;
  assert.ok(pendingName.startsWith(".pending-"));
  const pending = join(directory, pendingName);
  const short = lstatSync(pending);
  assert.equal(short.size, limit);
  assert.equal(short.mode & 0o777, 0o600);
  assert.equal(short.nlink, 1);
  assert.deepEqual(readFileSync(pending), record.subarray(0, limit));
  return { pending, pendingName };
}
