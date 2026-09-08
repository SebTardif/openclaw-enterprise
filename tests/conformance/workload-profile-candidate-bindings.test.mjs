import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createWorkloadProfileCandidateBindingsSourceV2 } from "../../packages/occ/src/workload-profiles/admitted-use.ts";
import { deriveWorkloadProfileManifestV2 } from "../../packages/occ/src/workload-profiles/projections.ts";
import {
  workloadProfileAdmissionFixture,
  profileAcceptedAt,
} from "../fixtures/workload-profile-admission-v2.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { admitLoggingConfiguration } from "../../packages/contracts/src/logging.ts";

// Actual fixed binding composition and canonical comparisons. Record/qualifier
// issuers are controlled boundary peers; they prove no production enrollment,
// native semantics, credential issuance, policy authenticity or SQL locking.
const copy = structuredClone;
const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function nullObjects(value) {
  if (Array.isArray(value)) return value.map(nullObjects);
  if (value && typeof value === "object")
    return Object.assign(
      Object.create(null),
      Object.fromEntries(Object.entries(value).map(([k, v]) => [k, nullObjects(v)])),
    );
  return value;
}
function fixture(options = {}) {
  const profile = workloadProfileAdmissionFixture();
  const manifest = deriveWorkloadProfileManifestV2(
    new TextEncoder().encode(profile.head.canonicalManifest),
  ).content;
  const request = {
    schemaVersion: 2,
    installationId: profile.installationId,
    namespaceId: profile.namespaceId,
    agentId: `agt_${randomUUID()}`,
    revisionId: `rev_${randomUUID()}`,
    configurationRef: `cfg_${randomUUID()}`,
    configurationVersion: 1,
    selection: profile.head.selection,
  };
  const candidate = {
    id: request.revisionId,
    namespaceId: request.namespaceId,
    agentId: request.agentId,
    revision: 1,
    providerId: null,
    configurationId: request.configurationRef,
    configurationGeneration: 1,
    configurationKind: "agent",
    configuration: copy(
      admitLoggingConfiguration(createHarnessConfiguration("codex", "gpt-test"), "info"),
    ),
    secretBindings: {},
    servicePrincipalId: `prn_${randomUUID()}`,
    serviceAccount: {
      id: `sa_${randomUUID()}`,
      credential: { kind: "api_key", secretRef: { name: "model-source", key: "value" } },
    },
    compute: { id: "controlled-compute", implementation: "controlled" },
    harness: { id: "codex", version: "controlled", mode: "dedicated" },
    createdAt: profileAcceptedAt,
  };
  const record = {
    configuration: {
      configurationRef: request.configurationRef,
      configurationGeneration: 1,
      immutableConfigurationContent: {
        kind: "agent",
        values: candidate.configuration,
        secretBindings: candidate.secretBindings,
      },
    },
    agent: {
      id: request.agentId,
      namespaceId: request.namespaceId,
      servicePrincipalId: candidate.servicePrincipalId,
      serviceAccountId: candidate.serviceAccount.id,
      providerId: null,
    },
    serviceAccount: {
      ...copy(candidate.serviceAccount),
      namespaceId: request.namespaceId,
      name: "controlled",
    },
    providerBinding: undefined,
    secrets: [],
    head: profile.head,
  };
  options.record?.(record, candidate);
  const events = [],
    revoked = new Set(),
    issued = new Set();
  const abort = new AbortController();
  let ioActive = true;
  const unit = {
    kind: "deployment",
    installationId: request.installationId,
    namespaceId: request.namespaceId,
    agentId: request.agentId,
    operationRef: randomUUID(),
    platform: {},
    signal: abort.signal,
    retain() {
      throw new Error("factory must return caller-owned lease");
    },
  };
  const io = {
    assertActive() {
      if (!ioActive) throw new Error("acquisition-ended");
    },
    poison(error) {
      events.push(["poison", error]);
      options.poison?.(error);
    },
  };
  function lease(name) {
    let released = false;
    return {
      assertCurrent() {
        if (released || revoked.has(name)) throw new Error(`${name}-expired`);
        return options.fence?.(name);
      },
      async release() {
        assert.equal(released, false, `${name} released twice`);
        released = true;
        events.push(["release", name]);
        await options.release?.(name);
      },
    };
  }
  const reader = {
    async readLocked(r, c, u, x) {
      events.push(["read"]);
      if (u !== unit || x !== io) throw new Error("foreign-private-record-unit");
      io.assertActive();
      const sourceIdentity = Object.freeze({ observation: randomUUID() });
      const value = { ...lease("records"), sourceIdentity, records: record };
      issued.add(sourceIdentity);
      options.returned?.("records", value);
      return value;
    },
  };
  function qualify(name, value) {
    return async (input, original, u, x) => {
      events.push(["qualify", name]);
      assert.equal(
        issued.has(original.sourceIdentity),
        true,
        "qualifier needs original private record identity",
      );
      assert.equal(
        "release" in original,
        false,
        "qualifier receives guarded borrowed custody only",
      );
      assert.strictEqual(u, unit);
      assert.strictEqual(x, io);
      original.assertCurrent();
      assert.equal(Object.isFrozen(input.records.configuration), true);
      const result = { ...lease(name), ...copy(value) };
      options.returned?.(name, result);
      try {
        if (options.qualify) await options.qualify(name, input, result, original);
      } catch (error) {
        try {
          await result.release();
        } catch {
          /* refusing supplier retains the original failure */
        }
        throw error;
      }
      return result;
    };
  }
  const qualifiers = {
    native: { qualifyLocked: qualify("native", {}) },
    credentials: {
      resolveLocked: qualify("credentials", {
        association: {
          servicePrincipalId: candidate.servicePrincipalId,
          serviceAccount: copy(candidate.serviceAccount),
        },
      }),
    },
    storage: {
      resolveLocked: qualify("storage", {
        bindings: ["gateway", "harness"].flatMap((component) =>
          manifest.launchConfiguration[component].mounts.map((mount) => ({ component, ...mount })),
        ),
      }),
    },
    roles: { resolveLocked: qualify("roles", { bindings: profile.head.profileRefs }) },
  };
  const source = createWorkloadProfileCandidateBindingsSourceV2(reader, qualifiers);
  const run = (r = request, c = candidate, m = manifest, u = unit, x = io) =>
    source.resolveLocked(r, c, m, u, x);
  return {
    profile,
    request,
    candidate,
    manifest,
    record,
    reader,
    qualifiers,
    source,
    unit,
    io,
    events,
    revoked,
    abort,
    run,
    closeIO() {
      ioActive = false;
    },
    releases() {
      return events.filter((e) => e[0] === "release").map((e) => e[1]);
    },
  };
}

for (const prototypes of [false, true])
  test(`fixed binding factory returns detached original fields with null prototypes=${prototypes}`, async () => {
    const f = fixture();
    const held = await f.run(
      prototypes ? nullObjects(f.request) : copy(f.request),
      prototypes ? nullObjects(f.candidate) : copy(f.candidate),
    );
    assert.deepEqual(Object.keys(held.bindings).sort(), [
      "roleBindings",
      "serviceAccountAssociation",
      "storePolicyBindings",
    ]);
    assert.deepEqual(copy(held.bindings.serviceAccountAssociation), {
      servicePrincipalId: f.candidate.servicePrincipalId,
      serviceAccount: f.candidate.serviceAccount,
    });
    assert.equal(held.bindings.roleBindings.runtime.ref, f.profile.head.profileRefs.runtime.ref);
    assert.equal(held.bindings.storePolicyBindings.length, 2);
    assert.equal(Object.isFrozen(held.bindings.roleBindings), true);
    assert.deepEqual(
      f.events.filter((e) => e[0] === "qualify").map((e) => e[1]),
      ["native", "credentials", "storage", "roles"],
    );
    f.closeIO();
    held.assertCurrent(); // Retained currentness must outlive acquisition IO.
    const close = held.release();
    assert.strictEqual(held.release(), close);
    await close;
    assert.deepEqual(f.releases(), ["roles", "storage", "credentials", "native", "records"]);
    assert.throws(held.assertCurrent);
  });

for (const missing of ["native", "credentials", "storage", "roles"])
  test(`missing ${missing} refuses before record acquisition`, async () => {
    const f = fixture();
    const peers = { ...f.qualifiers, [missing]: undefined };
    const source = createWorkloadProfileCandidateBindingsSourceV2(f.reader, peers);
    await assert.rejects(
      source.resolveLocked(f.request, f.candidate, f.manifest, f.unit, f.io),
      (e) => e.code === "unavailable",
    );
    assert.deepEqual(f.events, []);
  });

for (const [name, change] of [
  ["configuration generation", (r) => r.configuration.configurationGeneration++],
  [
    "ServiceAccount backend reference",
    (r) => {
      r.serviceAccount.credential.secretRef.name = "foreign";
    },
  ],
  [
    "service principal",
    (r) => {
      r.agent.servicePrincipalId = "foreign";
    },
  ],
  [
    "original admission scope",
    (r) => {
      r.head = { ...r.head, scope: { ...r.head.scope, namespaceId: `ns_${randomUUID()}` } };
    },
  ],
])
  test(`captured ${name} mismatch refuses before any qualifier`, async () => {
    const f = fixture({ record: change });
    await assert.rejects(f.run());
    assert.equal(
      f.events.some((e) => e[0] === "qualify"),
      false,
    );
    assert.deepEqual(f.releases(), ["records"]);
  });

test("copied unit reaches no controlled private record or qualifier", async () => {
  const f = fixture();
  await assert.rejects(
    f.run(f.request, f.candidate, f.manifest, { ...f.unit }),
    /foreign-private-record-unit/,
  );
  assert.equal(
    f.events.some((e) => e[0] === "qualify"),
    false,
  );
});

for (const [name, field, change] of [
  [
    "credentials",
    "association",
    (x) => {
      x.serviceAccount.credential.secretRef.key = "foreign";
    },
  ],
  [
    "storage",
    "bindings",
    (x) => {
      x[0].path = "/different";
    },
  ],
  [
    "roles",
    "bindings",
    (x) => {
      x.runtime.version++;
    },
  ],
])
  test(`independent ${name} output mismatch cannot become accepted binding`, async () => {
    const f = fixture({
      qualify(peer, input, result) {
        if (peer === name) change(result[field]);
      },
    });
    await assert.rejects(f.run());
    assert.deepEqual(f.releases(), ["roles", "storage", "credentials", "native", "records"]);
  });

for (const [name, field] of [
  ["records", "records"],
  ["credentials", "association"],
  ["storage", "bindings"],
  ["roles", "bindings"],
])
  test(`${name} result getter failure joins acquired cleanup and preserves first error`, async () => {
    const original = new Error(`${name}-getter`),
      cleanup = new Error("cleanup");
    const f = fixture({
      returned(peer, value) {
        if (peer === name)
          Object.defineProperty(value, field, {
            enumerable: true,
            get() {
              throw original;
            },
          });
      },
      poison() {
        throw new Error("poison");
      },
      release() {
        throw cleanup;
      },
    });
    await assert.rejects(f.run(), (e) => e === original);
    assert.equal(f.releases()[0], name);
    assert.equal(f.releases().at(-1), "records");
    assert.equal(new Set(f.releases()).size, f.releases().length);
  });

test("qualifier refusal is primary and all previously acquired sources close", async () => {
  const original = new Error("original-native-refusal");
  const f = fixture({
    qualify(name) {
      if (name === "native") throw original;
    },
  });
  await assert.rejects(f.run(), (e) => e === original);
  // The refusing peer closes native; the factory closes its returned record observation.
  assert.deepEqual(f.releases(), ["native", "records"]);
  assert.equal(
    f.events.some((e) => e[1] === "credentials"),
    false,
  );
});

test("abort during a qualifier wait captures its late lease before cleanup", async () => {
  const gate = deferred(),
    entered = deferred();
  const f = fixture({
    async qualify(name) {
      if (name === "storage") {
        entered.resolve();
        await gate.promise;
      }
    },
  });
  const pending = f.run();
  const observed = pending.then(
    () => undefined,
    (error) => error,
  );
  await entered.promise;
  f.abort.abort();
  gate.resolve();
  assert.ok(await observed);
  assert.deepEqual(f.releases(), ["storage", "credentials", "native", "records"]);
  assert.equal(
    f.events.some((e) => e[0] === "qualify" && e[1] === "roles"),
    false,
  );
});

test("invalid asynchronous supplier currentness drains before any cleanup", async () => {
  const gate = deferred(),
    entered = deferred();
  const f = fixture({
    fence(name) {
      if (name === "native") {
        entered.resolve();
        return gate.promise;
      }
    },
  });
  const pending = f.run();
  const observed = pending.then(
    () => undefined,
    (error) => error,
  );
  await entered.promise;
  await tick();
  assert.deepEqual(f.releases(), []);
  gate.resolve();
  assert.ok(await observed);
  assert.deepEqual(f.releases(), ["native", "records"]);
});

test("input mutation during native qualification cannot change later supplied data", async () => {
  const gate = deferred(),
    entered = deferred();
  let seen;
  const f = fixture({
    async qualify(name, input) {
      if (name === "native") {
        entered.resolve();
        await gate.promise;
      }
      if (name === "credentials") seen = input.candidate.configuration.agents.defaults.model;
    },
  });
  const pending = f.run();
  await entered.promise;
  f.candidate.configuration.agents.defaults.model = "codex/foreign";
  gate.resolve();
  const held = await pending;
  assert.equal(seen, "codex/gpt-test");
  await held.release();
});

test("revocation after acquisition poisons retained result without using closed IO", async () => {
  const f = fixture();
  const held = await f.run();
  f.closeIO();
  f.revoked.add("credentials");
  assert.throws(held.assertCurrent, /credentials-expired/);
  await held.release();
  assert.deepEqual(f.releases(), ["roles", "storage", "credentials", "native", "records"]);
});

test("cleanup reentry observes one published terminal promise", async () => {
  let held, nested;
  const f = fixture({
    release(name) {
      if (name === "roles") nested = held.release();
    },
  });
  held = await f.run();
  const close = held.release();
  await close;
  assert.strictEqual(nested, close);
  assert.equal(f.releases().length, 5);
});

test("qualifier direct deferred record fence is latched and raw record cleanup waits for settlement", async () => {
  const gate = deferred(),
    entered = deferred();
  let fire = false;
  const f = fixture({
    fence(name) {
      if (name === "records" && fire) {
        fire = false;
        entered.resolve();
        return gate.promise;
      }
    },
    qualify(name, input, result, view) {
      if (name === "native") {
        fire = true;
        assert.throws(view.assertCurrent);
      }
    },
  });
  const pending = f.run();
  const result = pending.then(
    () => undefined,
    (error) => error,
  );
  await entered.promise;
  await tick();
  assert.equal(
    f.releases().includes("records"),
    false,
    "hidden deferred record work still owns its lease",
  );
  gate.resolve();
  assert.ok(await result);
  assert.equal(
    f.events.some((e) => e[0] === "qualify" && e[1] === "credentials"),
    false,
  );
  assert.deepEqual(f.releases(), ["native", "records"]);
});

test("qualifier cannot swallow a one-shot direct record assertion failure and obtain bindings", async () => {
  const original = new Error("one-shot-record-failure");
  let fire = false;
  const f = fixture({
    fence(name) {
      if (name === "records" && fire) {
        fire = false;
        throw original;
      }
    },
    qualify(name, input, result, view) {
      if (name === "native") {
        fire = true;
        assert.throws(view.assertCurrent, (error) => error === original);
      }
    },
  });
  await assert.rejects(f.run(), (error) => error === original);
  assert.equal(
    f.events.some((e) => e[0] === "qualify" && e[1] === "credentials"),
    false,
  );
  assert.deepEqual(f.releases(), ["native", "records"]);
});
