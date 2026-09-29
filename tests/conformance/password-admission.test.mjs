import assert from "node:assert/strict";
import test from "node:test";
import {
  bindPasswordBudgetKey,
  passwordBudgetKeyBinding,
  preparePasswordBudgetKey,
  requirePasswordAdmission,
} from "../../apps/controller/src/auth/password-admission.ts";

const keyBytes = () => Uint8Array.from({ length: 32 }, (_, index) => index);

test("password admission binds keyed identity to the Installation and key epoch", async () => {
  const key = keyBytes();
  const seen = [];
  const binding = await preparePasswordBudgetKey("installation-test", {
    policyEpoch: "1",
    keyProvider: { load: async () => ({ epoch: "key-1", bytes: key }) },
  });
  const admission = bindPasswordBudgetKey(binding, {
    reserve: async (digest) => {
      seen.push(Buffer.from(digest));
      return { status: "allowed" };
    },
  });
  key.fill(255);
  await requirePasswordAdmission(admission, "person@example.com");
  const metadata = passwordBudgetKeyBinding(binding);
  assert.equal(metadata.installationId, "installation-test");
  assert.equal(metadata.keyEpoch, "key-1");
  assert.equal(metadata.policyEpoch, "1");
  // Independent fixed vectors specify the public framing/domain contract.
  assert.equal(
    Buffer.from(metadata.keyConfirmation).toString("hex"),
    "08febe7f22d6b745536d7db3d68ac56ddc4715ae5d220cb112ce02c85d0b23da",
  );
  assert.equal(
    seen[0].toString("hex"),
    "1ebe8a27cc63f0b058ada1e7155dc27b642b76b461a3190fcba10a470e9276b8",
  );
  assert.notDeepEqual(seen[0], metadata.keyConfirmation);
});

test("password admission fails closed without retrying a denied or uncertain reservation", async () => {
  for (const result of [
    { status: "limited", retryAfterSeconds: 17 },
    { status: "unknown" },
    { status: "unavailable" },
    { status: "limited", retryAfterSeconds: -1 },
    { status: "unexpected" },
    { status: "allowed", retryAfterSeconds: 31 },
    { status: "allowed", extra: true },
    Object.create({ status: "allowed" }),
    Object.assign(Object.create({ retryAfterSeconds: 31 }), { status: "allowed" }),
    Object.defineProperty({}, "status", {
      get() {
        throw new Error("accessor must not run");
      },
      enumerable: true,
    }),
    new Error("lost acknowledgement"),
  ]) {
    let calls = 0;
    const prepared = await preparePasswordBudgetKey("installation-test", {
      policyEpoch: "1",
      keyProvider: { load: async () => ({ epoch: "key-1", bytes: keyBytes() }) },
    });
    const admission = bindPasswordBudgetKey(prepared, {
      reserve: async () => {
        calls += 1;
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
    });
    await assert.rejects(requirePasswordAdmission(admission, "unknown@example.com"), (error) => {
      const limited =
        Object.getOwnPropertyDescriptor(result, "status")?.value === "limited" &&
        result.retryAfterSeconds > 0;
      assert.equal(error.status, limited ? 429 : 503);
      assert.equal(error.retryAfterSeconds, limited ? 17 : undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("password admission rejects noncanonical policy epochs before loading a key", async () => {
  for (const policyEpoch of ["0", "01", "-1", "1.0", "9223372036854775808"]) {
    let loaded = false;
    await assert.rejects(
      preparePasswordBudgetKey("installation-test", {
        policyEpoch,
        keyProvider: {
          load: async () => {
            loaded = true;
            return { epoch: "key-1", bytes: keyBytes() };
          },
        },
      }),
      /configuration is invalid/,
    );
    assert.equal(loaded, false);
  }
});

test("password admission rejects copied or substituted owner handles", async () => {
  const first = await preparePasswordBudgetKey("installation-test", {
    policyEpoch: "1",
    keyProvider: { load: async () => ({ epoch: "key-1", bytes: keyBytes() }) },
  });
  const second = await preparePasswordBudgetKey("installation-test", {
    policyEpoch: "1",
    keyProvider: { load: async () => ({ epoch: "key-2", bytes: new Uint8Array(32).fill(9) }) },
  });
  let calls = 0;
  const store = {
    reserve: async () => {
      calls += 1;
      return { status: "allowed" };
    },
  };
  const real = bindPasswordBudgetKey(first, store);
  for (const fake of [
    { ...first },
    new Proxy(first, {}),
    { ...passwordBudgetKeyBinding(first), bind: () => bindPasswordBudgetKey(second, store) },
  ]) {
    assert.throws(() => passwordBudgetKeyBinding(fake), /not recognized/);
    assert.throws(() => bindPasswordBudgetKey(fake, store), /not recognized/);
  }
  for (const fake of [
    { ...real },
    new Proxy(real, {}),
    { reserve: async () => ({ status: "allowed" }) },
  ]) {
    await assert.rejects(requirePasswordAdmission(fake, "person@example.com"), { status: 503 });
  }
  assert.equal(calls, 0);
  await requirePasswordAdmission(real, "person@example.com");
  assert.equal(calls, 1);
});

test("password admission preserves normalized supplementary and expanding identifiers", async () => {
  const prepared = await preparePasswordBudgetKey("installation-test", {
    policyEpoch: "1",
    keyProvider: { load: async () => ({ epoch: "key-1", bytes: keyBytes() }) },
  });
  const seen = [];
  const admitted = bindPasswordBudgetKey(prepared, {
    reserve: async (digest) => {
      seen.push(Buffer.from(digest));
      return { status: "allowed" };
    },
  });
  await requirePasswordAdmission(admitted, "🦊".repeat(160) + "@a.b");
  await requirePasswordAdmission(admitted, ("İ".repeat(316) + "@a.b").toLowerCase());
  assert.equal(seen.length, 2);
  assert.notDeepEqual(seen[0], seen[1]);
});
