import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  initializeNativeOAuthProfile,
  nativeOAuthProfileId,
} from "../../apps/controller/src/providers/agent-oauth/native-profile.mjs";

const executable = process.env.OCC_TEST_WORKSPACE_OPENCLAW_PATH;
const native = {
  skip:
    executable === undefined
      ? "Set OCC_TEST_WORKSPACE_OPENCLAW_PATH to a qualified native runtime with its public provider-auth SDK."
      : false,
};
const helperUrl = new URL(
  "../../apps/controller/src/providers/agent-oauth/native-profile.mjs",
  import.meta.url,
).href;

function envelope(overrides = {}) {
  const binding = {
    provider: "openai",
    method: "device-code",
    connectionId: "aoc_00000000-0000-4000-8000-000000000001",
    generation: 1,
    ...overrides,
  };
  return {
    ...binding,
    profileId: nativeOAuthProfileId(binding),
    credential: {
      type: "oauth",
      provider: binding.provider,
      access: "fixture-access-private",
      refresh: "fixture-refresh-private",
      expires: 2_000_000_000_000,
      idToken: "fixture-id-token-private",
      accountId: "fixture-account",
      clientId: "fixture-client",
      authFlow: "device-code",
      email: "agent@example.test",
    },
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "oce-native-oauth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const agentDir = join(stateDir, "agents", "main", "agent");
  const sdkUrl = pathToFileURL(
    resolve(dirname(realpathSync(executable)), "dist/plugin-sdk/provider-auth.js"),
  ).href;
  const script = `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const input = JSON.parse(readFileSync(0, "utf8"));
    const sdk = await import(${JSON.stringify(sdkUrl)});
    const { initializeNativeOAuthProfile } = await import(${JSON.stringify(helperUrl)});
    try {
      let result;
      if (input.operation === "initialize") {
        let checks = 0;
        result = await initializeNativeOAuthProfile({
          sdk, envelope: input.envelope, agentDir: input.agentDir, stateDir: input.stateDir,
          assertCurrent() {
            checks += 1;
            if (checks === input.rejectAtCheck) {
              throw new Error(input.envelope.credential.refresh);
            }
          },
        });
      } else {
        let inspected = false;
        const store = await sdk.updateAuthProfileStoreWithLock({
          agentDir: input.agentDir, stateDir: input.stateDir,
          updater(store) {
            if (input.operation === "rotate") {
              assert.ok(store.profiles[input.envelope.profileId]);
              store.profiles[input.envelope.profileId] = input.expected;
            } else {
              assert.deepEqual(store.profiles[input.envelope.profileId], input.expected);
            }
            inspected = true;
            return input.operation === "rotate";
          },
        });
        assert.notEqual(store, null);
        assert.equal(inspected, true);
        result = { verified: true };
      }
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code ?? "NATIVE_FIXTURE_FAILED" }));
      process.exitCode = 1;
    }
  `;
  const run = (operation, delivery, extra = {}) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_AGENT_DIR: agentDir,
      },
      input: JSON.stringify({ operation, envelope: delivery, agentDir, stateDir, ...extra }),
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(result.error, undefined);
    const secrets = [delivery.credential, extra.expected]
      .filter(Boolean)
      .flatMap((credential) =>
        [credential.access, credential.refresh, credential.idToken].filter(Boolean),
      );
    for (const secret of secrets) {
      assert.equal((result.stdout + result.stderr).includes(secret), false);
    }
    return { status: result.status, output: JSON.parse(result.stdout) };
  };
  return { root, agentDir, run };
}

test("native OAuth initialization fails explicitly when the runtime SDK is unavailable", async () => {
  await assert.rejects(initializeNativeOAuthProfile({ envelope: envelope(), assertCurrent() {} }), {
    code: "NATIVE_OAUTH_RUNTIME_UNAVAILABLE",
  });
});

test(
  "native OAuth handoff persists full metadata and preserves rotations across process restarts",
  native,
  (t) => {
    const f = fixture(t);
    const delivery = envelope();
    const { credential, ...identity } = delivery;
    assert.deepEqual(f.run("initialize", delivery), {
      status: 0,
      output: { ...identity, status: "initialized" },
    });
    assert.deepEqual(f.run("read", delivery, { expected: credential }), {
      status: 0,
      output: { verified: true },
    });

    // Simulate the native refresh owner's persisted rotation through its real SDK.
    // A separate process retries the original delivery after losing its acknowledgement.
    const rotated = {
      ...credential,
      access: "fixture-rotated-access-private",
      refresh: "fixture-rotated-refresh-private",
      expires: credential.expires + 3_600_000,
    };
    assert.equal(f.run("rotate", delivery, { expected: rotated }).status, 0);
    assert.deepEqual(f.run("initialize", delivery), {
      status: 0,
      output: { ...identity, status: "existing" },
    });
    assert.equal(f.run("read", delivery, { expected: rotated }).status, 0);

    const otherConnection = envelope({ connectionId: "aoc_00000000-0000-4000-8000-000000000002" });
    assert.equal(f.run("read", otherConnection).status, 0);

    // An older native schema or damaged store must not turn a truncated import
    // into a successful acknowledgement on retry, nor reseed the original tokens.
    const { clientId: _clientId, ...incomplete } = rotated;
    assert.equal(f.run("rotate", delivery, { expected: incomplete }).status, 0);
    assert.deepEqual(f.run("initialize", delivery), {
      status: 1,
      output: { code: "NATIVE_OAUTH_HANDOFF_FAILED" },
    });
    assert.equal(f.run("read", delivery, { expected: incomplete }).status, 0);
  },
);

test(
  "native OAuth rejects stale authority before write and retries an uncertain committed handoff",
  native,
  (t) => {
    const f = fixture(t);
    const delivery = envelope();
    const { credential, ...identity } = delivery;
    assert.deepEqual(f.run("initialize", delivery, { rejectAtCheck: 2 }), {
      status: 1,
      output: { code: "NATIVE_OAUTH_HANDOFF_FAILED" },
    });
    assert.equal(f.run("read", delivery).status, 0);
    // Authority can close after commit but before acknowledgement. Keep staged
    // custody and let the next authorized invocation observe the committed profile.
    assert.deepEqual(f.run("initialize", delivery, { rejectAtCheck: 3 }), {
      status: 1,
      output: { code: "NATIVE_OAUTH_HANDOFF_FAILED" },
    });
    assert.equal(f.run("read", delivery, { expected: credential }).status, 0);
    assert.deepEqual(f.run("initialize", delivery), {
      status: 0,
      output: { ...identity, status: "existing" },
    });
  },
);

test(
  "native OAuth reports native persistence failure without acknowledging the handoff",
  native,
  (t) => {
    const f = fixture(t);
    // An unusable database path exercises the real SDK's nullable write failure.
    mkdirSync(join(f.agentDir, "openclaw-agent.sqlite"), { recursive: true });
    assert.deepEqual(f.run("initialize", envelope()), {
      status: 1,
      output: { code: "NATIVE_OAUTH_HANDOFF_FAILED" },
    });
  },
);
