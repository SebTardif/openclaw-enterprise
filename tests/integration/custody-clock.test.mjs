import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLinuxCustodyClockV1,
  checkCustodyClockContinuityV1,
} from "../../apps/controller/src/admission/custody-clock.ts";

const binary = process.env.OCC_CUSTODY_CLOCK_TEST_BINARY;
const linux = process.platform === "linux";
const actual = {
  skip: linux && binary ? false : "Select the actual Linux clock observation executable.",
  timeout: 10000,
};
const signal = () => AbortSignal.timeout(5000);
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("final realtime correlation refuses post-native suspend and charges rounded age", () => {
  // These vectors run the actual numeric acceptance filter. They create no
  // clock/source/custody handle and never change host time or invent UTC proof.
  const ms = 1_000_000n;
  const wall = 1_710_000_000_000;
  const mono = 10_000n * ms;
  const offset = BigInt(wall) * ms - mono;
  const original = { lower: offset - 3n * ms, upper: offset + 3n * ms };
  const final = {
    nativeWallMs: wall,
    invocationBeforeNs: mono,
    beforeNs: mono + 19n * ms,
    wallMs: wall + 20,
    afterNs: mono + 21n * ms,
    completeNs: mono + 22n * ms,
  };
  assert.equal(checkCustodyClockContinuityV1(original, final)?.ageMs, 24n);
  // An hour passes after the native observation, while monotonic advances only
  // milliseconds. The former monotonic-only duration omitted this stale age.
  assert.equal(
    checkCustodyClockContinuityV1(original, { ...final, wallMs: wall + 3_600_020 }),
    undefined,
  );
  assert.equal(
    checkCustodyClockContinuityV1(original, { ...final, wallMs: wall - 1000 }),
    undefined,
  );
  const wide = { lower: offset - 2000n * ms, upper: offset + 2000n * ms };
  assert.equal(
    checkCustodyClockContinuityV1(wide, { ...final, wallMs: wall + 1500 }),
    undefined,
    "a wide sampling interval cannot bypass the one-second age limit",
  );
  assert.equal(
    checkCustodyClockContinuityV1(wide, { ...final, wallMs: wall + 25 })?.ageMs,
    29n,
    "realtime age includes outward rounding and the final measured tail",
  );
  const delayed = {
    ...final,
    beforeNs: mono + 20n * ms,
    wallMs: wall + 500,
    afterNs: mono + 30n * ms,
    completeNs: mono + 30n * ms,
  };
  assert.equal(checkCustodyClockContinuityV1(wide, delayed)?.ageMs, 511n);
  assert.equal(
    checkCustodyClockContinuityV1(wide, { ...delayed, completeNs: mono + 600n * ms }),
    undefined,
    "suspend followed by an awake tail must exceed the one-second age cap",
  );
  assert.equal(
    checkCustodyClockContinuityV1(original, { ...final, completeNs: final.afterNs - 1n }),
    undefined,
  );
  assert.equal(
    checkCustodyClockContinuityV1(original, { ...final, wallMs: Number.NaN }),
    undefined,
  );
});
async function selection(path) {
  return { binaryPath: path, nativeExecutableSha256: digest(await readFile(path)) };
}
async function directory(t) {
  const path = await mkdtemp(join(homedir(), ".oce-clock-test-"));
  await chmod(path, 0o700);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fixture(t, body) {
  const path = join(await directory(t), "observer");
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o500 });
  return selection(path);
}
function currentKernel(t) {
  const result = spawnSync(binary, ["read"], {
    env: {},
    timeout: 1000,
    maxBuffer: 1024,
    killSignal: "SIGKILL",
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  if (result.status === 1) {
    assert.equal(result.stdout, '{"version":1,"error":"unavailable"}\n');
    t.diagnostic(
      "The actual kernel observer reports unavailable; no synchronization is fabricated.",
    );
    return undefined;
  }
  assert.equal(result.status, 0);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.version, 1);
  return observed;
}

test(
  "actual kernel observation reaches custody or honestly refuses current host state",
  actual,
  async (t) => {
    const selected = await selection(binary);
    if (!currentKernel(t)) {
      await assert.rejects(createLinuxCustodyClockV1(selected, signal()), /clock is unavailable/);
      return;
    }
    const clock = await createLinuxCustodyClockV1(selected, signal());
    t.after(() => clock.close());
    assert.equal(Object.isFrozen(clock), true);
    // Each read executes the actual original binary in a fresh process. Its
    // monotonic epoch must still be the same kernel epoch as this process.
    let previous;
    for (let i = 0; i < 3; i++) {
      const before = process.hrtime.bigint() / 1_000_000n;
      const sample = clock.read();
      const after = process.hrtime.bigint() / 1_000_000n;
      assert.equal(Object.isFrozen(sample), true);
      assert.deepEqual(Object.keys(sample), ["wallMs", "monotonicMs", "uncertaintyMs"]);
      assert.ok(Object.values(sample).every((value) => Number.isSafeInteger(value) && value >= 0));
      assert.ok(BigInt(sample.monotonicMs) >= before && BigInt(sample.monotonicMs) <= after);
      if (previous) {
        assert.ok(sample.monotonicMs >= previous.monotonicMs);
        assert.ok(sample.wallMs >= previous.wallMs);
      }
      previous = sample;
    }
    await clock.close();
    await clock.close();
    assert.throws(() => clock.read(), /clock is unavailable/);
  },
);

test("actual executable digest, no-follow and immutable mode are mandatory", actual, async (t) => {
  const dir = await directory(t);
  const path = join(dir, "observer");
  await copyFile(binary, path);
  await chmod(path, 0o500);
  const options = await selection(path);
  await assert.rejects(
    createLinuxCustodyClockV1(
      { ...options, nativeExecutableSha256: `sha256:${"0".repeat(64)}` },
      signal(),
    ),
    /clock is unavailable/,
  );
  const link = join(dir, "alias");
  await symlink(path, link);
  await assert.rejects(createLinuxCustodyClockV1({ ...options, binaryPath: link }, signal()));
  await chmod(path, 0o700);
  await assert.rejects(createLinuxCustodyClockV1(options, signal()), /clock is unavailable/);
  await chmod(path, 0o500);
  await assert.rejects(
    createLinuxCustodyClockV1(options, AbortSignal.abort()),
    /clock is unavailable/,
  );
});

test(
  "the original native descriptor executes the observer after pathname replacement",
  actual,
  async (t) => {
    const dir = await directory(t);
    const path = join(dir, "observer");
    await copyFile(binary, path);
    await chmod(path, 0o500);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // This is the real native process/FD primitive, including the unavailable
      // host case. The replacement is never a positive clock fixture. A failed
      // exec or reopening the pathname cannot produce the actual observer reply.
      await rename(path, join(dir, "original-observer"));
      await writeFile(path, "#!/bin/sh\nexit 42\n", { mode: 0o500 });
      const result = spawnSync("/proc/self/fd/3", ["read"], {
        stdio: ["ignore", "pipe", "ignore", file.fd],
        env: {},
        cwd: "/",
        timeout: 1000,
        killSignal: "SIGKILL",
        maxBuffer: 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.ok(Buffer.isBuffer(result.stdout));
      assert.ok(result.stdout.length > 0 && result.stdout.length <= 1024);
      if (result.status === 1) {
        assert.equal(result.stdout.toString("utf8"), '{"version":1,"error":"unavailable"}\n');
        t.diagnostic("Original FD executed actual observer; current kernel remains unavailable.");
      } else {
        assert.equal(result.status, 0);
        const value = JSON.parse(result.stdout.toString("utf8"));
        assert.deepEqual(Object.keys(value), [
          "version",
          "wall_ms",
          "monotonic_ms",
          "uncertainty_ms",
          "correlation_error_ms",
        ]);
        assert.equal(value.version, 1);
        assert.ok(Object.values(value).every((n) => Number.isSafeInteger(n) && n >= 0));
      }
    } finally {
      await file.close();
    }
  },
);

test("a retained executable change permanently invalidates the clock", actual, async (t) => {
  if (!currentKernel(t)) {
    t.skip("Actual synchronized kernel observation is unavailable for the retained-handle case.");
    return;
  }
  const path = join(await directory(t), "observer");
  await copyFile(binary, path);
  await chmod(path, 0o500);
  const options = await selection(path);
  const clock = await createLinuxCustodyClockV1(options, signal());
  t.after(() => clock.close());
  // Constructor inputs cannot redirect later reads to a different pathname.
  options.binaryPath = "/absent/other-clock";
  clock.read();
  await chmod(path, 0o400);
  assert.throws(() => clock.read(), /clock is unavailable/);
  await chmod(path, 0o500);
  assert.throws(() => clock.read(), /clock is unavailable/);
});

test(
  "bounded protocol rejection cannot substitute for a kernel observation",
  { skip: !linux, timeout: 10000 },
  async (t) => {
    // These disposable executables supply only invalid process-boundary results.
    // They never establish a positive kernel error bound or custody clock.
    for (const payload of [
      '{"version":1,"error":"unavailable"}\n',
      '{"version":1,"version":1}\n',
      `${"x".repeat(2048)}\n`,
      '{"version":1,"wall_ms":0,"monotonic_ms":0,"uncertainty_ms":0,"correlation_error_ms":0}\n',
    ]) {
      const selected = await fixture(t, `printf '%s' '${payload}'`);
      await assert.rejects(createLinuxCustodyClockV1(selected, signal()), /clock is unavailable/);
    }
    const slow = await fixture(t, "exec /bin/sleep 2");
    const began = process.hrtime.bigint();
    await assert.rejects(createLinuxCustodyClockV1(slow, signal()), /clock is unavailable/);
    assert.ok(process.hrtime.bigint() - began < 3_000_000_000n);
  },
);
