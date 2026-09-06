import assert from "node:assert/strict";
import test from "node:test";
import { createNamedCredentialCustodyV1 } from "@openclaw-enterprise/occ/credential-custody-v1/custody";
import { createBoundedCredentialMaterialCacheV1 } from "@openclaw-enterprise/occ/credential-custody-v1/cache";
import { CredentialCustodyErrorV1 } from "@openclaw-enterprise/occ/credential-custody-v1/ports";
import { syntheticBackend } from "../fixtures/credential-custody-v1/synthetic-backend.ts";
import {
  configuration,
  partition,
  request,
  rotation,
  epoch,
} from "../fixtures/credential-custody-v1/cases.ts";

const bounds = () => ({ signal: new AbortController().signal });
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(kind = "api-key", changes = {}) {
  const fixture = syntheticBackend(kind);
  const owner = createNamedCredentialCustodyV1({ ...fixture.dependencies, ...changes });
  let invocation = 0;
  const use = (
    input = request(kind, ++invocation),
    authority = fixture.authority,
    signal = bounds(),
  ) => owner.withNamedCredentialV1(input, authority, fixture.consume, signal);
  return { ...fixture, owner, use };
}
test("API-key and trusted-login handles are consumed only by their fixed synthetic owner", async () => {
  for (const kind of ["api-key", "trusted-login"]) {
    const f = setup(kind);
    assert.equal((await f.use()).kind, "used");
    assert.equal((await f.use()).kind, "used");
    assert.equal(f.state.reads, 1);
    assert.equal(f.state.authorityChecks, 2);
    assert.equal(f.state.accountReads, 4);
    f.owner.close();
    assert.equal(f.released.length, 1);
    assert.ok(f.released.every((bytes) => bytes.every((byte) => byte === 0)));
  }
});
test("unprovided protected custody and missing current owner stay unavailable", async () => {
  for (const changes of [
    { profile: configuration(false) },
    { custody: undefined },
    { useOwner: undefined },
  ]) {
    const f = setup("api-key", changes);
    assert.equal((await f.use()).kind, "unavailable");
    assert.equal(f.state.reads, 0);
    assert.equal(f.state.effects, 0);
  }
});
test("a warm material cache cannot retain revoked authority or accept fabricated handles", async () => {
  const f = setup();
  assert.equal((await f.use()).kind, "used");
  f.state.allow = false;
  assert.equal((await f.use()).kind, "denied");
  f.state.allow = true;
  assert.equal((await f.use(request(), {})).kind, "denied");
  assert.equal(f.state.effects, 1);
  f.owner.close();
});
test("unregistered callbacks never receive material", async () => {
  const f = setup();
  let invoked = false;
  const result = await f.owner.withNamedCredentialV1(
    request(),
    f.authority,
    async () => {
      invoked = true;
    },
    bounds(),
  );
  assert.equal(result.kind, "denied");
  assert.equal(invoked, false);
  assert.equal(f.state.reads, 0);
});
test("metadata store errors are sanitized, including on a warm cache", async () => {
  const f = setup();
  await f.use();
  f.state.deniedStore = true;
  const result = await f.use();
  assert.equal(result.kind, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /CANARY|credential-example/);
  assert.equal(f.state.effects, 1);
  f.owner.close();
});
test("exact owner, account, version and backend identity mismatch deny", async () => {
  for (const mutate of [
    (p) => {
      p.secret.namespaceId = "ns_00000000-0000-4000-8000-000000000099";
    },
    (p) => {
      p.secret.backendRef.uid = "foreign/example";
    },
    (p) => {
      p.secret.driverId = "foreign/example";
    },
    (p) => {
      p.accountKey.providerId = "foreign/example";
    },
    (p) => {
      p.accountLink.driverId = "foreign/example";
    },
    (p) => {
      p.namedSecret.immutableVersionRecord.version = 2;
    },
    (p) => {
      p.namedSecret.resourceVersion = "";
    },
    (p) => {
      p.partition.binding.secretVersion = 2;
    },
  ]) {
    const f = setup();
    const p = structuredClone(f.projection());
    mutate(p);
    f.replaceProjection(p);
    assert.equal((await f.use()).kind, "unavailable");
    assert.equal(f.state.effects, 0);
  }
});
test("material class cannot fall back from trusted login to API key", async () => {
  const f = setup("trusted-login");
  assert.equal((await f.use(request("api-key"))).kind, "unavailable");
  assert.equal(f.state.reads, 0);
});
test("expiry and clock uncertainty close access before the safety margin", async () => {
  for (const changes of [
    (f) => {
      f.state.expiresAtMs = epoch + 5000;
    },
    (f) => {
      f.clock.uncertaintyMs = 2001;
    },
    (f) => {
      f.clock.uncertaintyMs = Number.NaN;
    },
    (f) => {
      f.clock.wallMs = epoch + 5000;
    },
  ]) {
    const f = setup();
    changes(f);
    assert.notEqual((await f.use()).kind, "used");
    assert.equal(f.state.effects, 0);
  }
});
test("material size limits release rejected ownership", async () => {
  for (const size of [0, 32769]) {
    const f = setup();
    f.state.byteLength = size;
    assert.equal((await f.use()).kind, "unavailable");
    assert.equal(f.state.effects, 0);
    assert.ok(f.released.every((bytes) => bytes.every((byte) => byte === 0)));
  }
});
test("cache partitions include complete profile and credential class", async () => {
  const f = syntheticBackend();
  const cache = createBoundedCredentialMaterialCacheV1(f.dependencies.clock);
  let loads = 0;
  for (const p of [partition(), partition("api-key", 1), partition("trusted-login")])
    await cache.withMaterial(
      p,
      async () => {
        loads++;
        return f.lease(p);
      },
      async () => 1,
      bounds(),
    );
  assert.equal(loads, 3);
  assert.equal(cache.inspect().entries, 3);
  cache.close();
  assert.equal(f.released.length, 3);
});
test("capacity plus one is denied and exact-boundary age reclaims idle slots", async () => {
  const f = syntheticBackend();
  const cache = createBoundedCredentialMaterialCacheV1(f.dependencies.clock);
  for (let i = 0; i < 128; i++) {
    const p = partition("api-key", i);
    await cache.withMaterial(
      p,
      async () => f.lease(p),
      async () => 1,
      bounds(),
    );
  }
  const p = partition("api-key", 128);
  await assert.rejects(
    cache.withMaterial(
      p,
      async () => f.lease(p),
      async () => 1,
      bounds(),
    ),
    (error) => error.failure.kind === "capacity-exhausted",
  );
  assert.deepEqual(cache.inspect(), {
    entries: 128,
    reservedBytes: 4194304,
    busy: 0,
    closed: false,
  });
  f.clock.wallMs += 60000;
  f.clock.monotonicMs += 60000;
  await cache.withMaterial(
    p,
    async () => f.lease(p),
    async () => 1,
    bounds(),
  );
  assert.equal(f.released.length, 128);
  cache.close();
});
test("clock reversal and uncertainty flush cache and latch closed", async () => {
  for (const change of [
    (clock) => {
      clock.monotonicMs = -1;
    },
    (clock) => {
      clock.wallMs--;
    },
    (clock) => {
      clock.uncertaintyMs = 2001;
    },
    (clock) => {
      clock.wallMs += 10000;
    },
  ]) {
    const f = syntheticBackend();
    const p = partition();
    const cache = createBoundedCredentialMaterialCacheV1(f.dependencies.clock);
    await cache.withMaterial(
      p,
      async () => f.lease(p),
      async () => 1,
      bounds(),
    );
    change(f.clock);
    await assert.rejects(
      cache.withMaterial(
        p,
        async () => f.lease(p),
        async () => 1,
        bounds(),
      ),
    );
    assert.equal(cache.inspect().closed, true);
    assert.equal(f.released.length, 1);
  }
});
test("pending load reserves capacity and invalidation prevents its late callback", async () => {
  const f = syntheticBackend();
  const p = partition();
  const pause = deferred();
  const cache = createBoundedCredentialMaterialCacheV1(f.dependencies.clock);
  let invoked = 0;
  const first = cache.withMaterial(
    p,
    async () => {
      await pause.promise;
      return f.lease(p);
    },
    async () => ++invoked,
    bounds(),
  );
  await assert.rejects(
    cache.withMaterial(
      p,
      async () => f.lease(p),
      async () => ++invoked,
      bounds(),
    ),
    (error) => error.failure.kind === "capacity-exhausted",
  );
  cache.invalidate(p.binding);
  assert.equal(cache.inspect().entries, 1);
  pause.resolve();
  await assert.rejects(first);
  assert.equal(invoked, 0);
  assert.equal(cache.inspect().entries, 0);
  assert.equal(f.released.length, 1);
});
test("invalidation during authority await fences the eventual fixed callback", async () => {
  const f = setup();
  const pause = deferred();
  const entered = deferred();
  f.hooks.authority = async () => {
    entered.resolve();
    await pause.promise;
  };
  const use = f.use();
  await entered.promise;
  f.owner.invalidate(request().binding);
  pause.resolve();
  assert.notEqual((await use).kind, "used");
  assert.equal(f.state.effects, 0);
  assert.equal(f.owner.inspect().entries, 0);
});
test("abort before material arrives denies late callback and releases material", async () => {
  const f = setup();
  const pause = deferred();
  const entered = deferred();
  const controller = new AbortController();
  f.hooks.read = async () => {
    entered.resolve();
    await pause.promise;
  };
  const use = f.use(request(), f.authority, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  assert.equal((await use).kind, "denied");
  assert.equal(f.owner.inspect().calls, 1);
  pause.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.effects, 0);
  assert.equal(f.owner.inspect().calls, 0);
  assert.equal(f.released.length, 1);
});
test("abort or callback exception after invocation is effect-unknown", async () => {
  const f = setup();
  f.state.throwConsumer = true;
  const failed = await f.use();
  assert.equal(failed.kind, "effect-unknown");
  assert.doesNotMatch(JSON.stringify(failed), /CANARY/);
  const g = setup();
  const pause = deferred();
  const entered = deferred();
  const controller = new AbortController();
  g.hooks.consume = async () => {
    entered.resolve();
    await pause.promise;
  };
  const use = g.use(request(), g.authority, { signal: controller.signal });
  await entered.promise;
  controller.abort();
  assert.equal((await use).kind, "effect-unknown");
  assert.equal(g.owner.inspect().busy, 1);
  pause.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(g.owner.inspect().entries, 0);
});
test("rotation stages, commits binding+invalidation+scan and fences old material", async () => {
  const f = setup();
  await f.use();
  const result = await f.owner.rotateBindingV1(rotation(), f.management, bounds());
  assert.equal(result.kind, "rotated");
  assert.equal(result.invalidationVersion, 2);
  assert.equal(result.affectedScanRef, "scan/example");
  assert.equal(f.released.length, 1);
  assert.equal((await f.use()).kind, "unavailable");
  const old = request();
  const replacement = rotation().replacement;
  const fresh = {
    ...old,
    binding: replacement,
    modelBinding: { ...old.modelBinding, binding: replacement },
  };
  assert.equal((await f.use(fresh)).kind, "used");
  f.owner.close();
});
test("concurrent rotation has one CAS winner; stale and foreign management deny", async () => {
  const f = setup();
  const results = await Promise.all([
    f.owner.rotateBindingV1(rotation(), f.management, bounds()),
    f.owner.rotateBindingV1(
      { ...rotation(), operationRef: "rotate/other" },
      f.management,
      bounds(),
    ),
  ]);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["conflict", "rotated"]);
  const g = setup();
  assert.equal((await g.owner.rotateBindingV1(rotation(), {}, bounds())).kind, "denied");
  assert.equal(g.state.stagedChecks, 0);
  assert.equal(
    (
      await g.owner.rotateBindingV1(
        { ...rotation(), replacement: rotation().expectedBinding },
        g.management,
        bounds(),
      )
    ).kind,
    "denied",
  );
});
test("unknown rotation preserves exact operation digest and performs no blind retry", async () => {
  const f = setup();
  f.state.unknownCommit = true;
  await f.use();
  const result = await f.owner.rotateBindingV1(rotation(), f.management, bounds());
  assert.equal(result.kind, "commit-unknown");
  assert.equal(result.nextAction, "exact-readback-only");
  assert.equal(result.operationRef, rotation().operationRef);
  assert.match(result.intentDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(f.state.rotations, 1);
  assert.equal(f.released.length, 1);
  assert.equal((await f.use()).kind, "unavailable");
});
test("a new process-local cache starts empty and re-resolves its synthetic owner", async () => {
  const f = setup();
  await f.use();
  f.owner.close();
  const restarted = createNamedCredentialCustodyV1(f.dependencies);
  assert.equal(restarted.inspect().entries, 0);
  assert.equal(
    (await restarted.withNamedCredentialV1(request(), f.authority, f.consume, bounds())).kind,
    "used",
  );
  assert.equal(f.state.reads, 2);
  restarted.close();
});
test("repository mint is unavailable without real journal/current-owner composition", async () => {
  const f = setup();
  const use = request();
  const profile = {
    ...use.profile,
    kind: "repository",
    mode: "native",
    credentialClass: "installation-token",
    providerInstallationRef: "installation/example",
    permissionProfile: {
      ref: "permission/example",
      version: 1,
      digest: use.profile.account.digest,
    },
  };
  delete profile.modelProfile;
  const input = {
    ...use,
    purpose: "repository-mint",
    profile,
    issuance: {
      issuanceOperationRef: "issuance/example",
      recordRef: "record/example",
      intentDigest: use.original.intentDigest,
    },
    providerAttemptRef: "attempt/example",
    expectedInventoryVersion: 1,
    grant: {
      providerInstallationRef: profile.providerInstallationRef,
      repositoryIds: ["1"],
      permissions: [{ name: "contents", access: "read" }],
      permissionProfile: profile.permissionProfile,
    },
  };
  delete input.modelBinding;
  const result = await f.use(input);
  assert.deepEqual(result, { kind: "unavailable", reason: "inventory-unavailable" });
  assert.equal(f.state.effects, 0);
});

test("actual operation capabilities gate model and rotation independently", async () => {
  for (const name of [
    "auditCoupling",
    "durableCompareAndSet",
    "exactUnknownOperationReadback",
    "restartCompleteAffectedSnapshots",
  ]) {
    const profile = structuredClone(configuration());
    profile.capabilities[name] = { status: "unsupported", reason: "capability-unimplemented" };
    const f = setup("api-key", { profile });
    assert.equal((await f.use()).kind, name === "auditCoupling" ? "unavailable" : "used");
    assert.equal(
      (await f.owner.rotateBindingV1(rotation(), f.management, bounds())).kind,
      "unavailable",
    );
    assert.equal(f.state.rotations, 0);
    f.owner.close();
  }
});
test("same original operation cannot repeat after used, changed intent, unknown or new facade", async () => {
  const f = setup();
  const original = request();
  assert.equal((await f.use(original)).kind, "used");
  assert.equal((await f.use(original)).kind, "conflict");
  assert.equal(
    (await f.use({ ...original, callerServiceRef: "service/changed" })).kind,
    "conflict",
  );
  const restarted = createNamedCredentialCustodyV1(f.dependencies);
  assert.equal(
    (await restarted.withNamedCredentialV1(original, f.authority, f.consume, bounds())).kind,
    "conflict",
  );
  assert.equal(f.state.effects, 1);
  f.owner.close();
  restarted.close();
  const g = setup();
  g.state.throwConsumer = true;
  assert.equal((await g.use(original)).kind, "effect-unknown");
  g.state.throwConsumer = false;
  assert.equal((await g.use(original)).kind, "effect-unknown");
  assert.equal(g.state.effects, 1);
  g.owner.close();
});
test("typed failure and extra result canaries never escape closed diagnostics", async () => {
  const f = syntheticBackend();
  const fault = new CredentialCustodyErrorV1({
    kind: "denied",
    reason: "authority-denied",
    secret: "SYNTHETIC-CREDENTIAL-CANARY",
  });
  assert.doesNotMatch(JSON.stringify(fault.failure), /CANARY|secret"/);
  // Even a post-construction mutation of an exception must not bypass validation.
  fault.failure = {
    kind: "denied",
    reason: "authority-denied",
    extra: "SYNTHETIC-CREDENTIAL-CANARY",
  };
  const broken = createNamedCredentialCustodyV1({
    ...f.dependencies,
    useOwner: {
      withCurrentModelUse: async () => {
        throw fault;
      },
    },
  });
  const denied = await broken.withNamedCredentialV1(request(), f.authority, f.consume, bounds());
  assert.deepEqual(denied, { kind: "unavailable", reason: "secret-unavailable" });
  Object.defineProperty(fault, "failure", {
    get() {
      throw new Error("SYNTHETIC-CREDENTIAL-CANARY");
    },
  });
  assert.deepEqual(
    await broken.withNamedCredentialV1(request(), f.authority, f.consume, bounds()),
    { kind: "unavailable", reason: "secret-unavailable" },
  );
  const wrapped = createNamedCredentialCustodyV1({
    ...f.dependencies,
    useOwner: {
      withCurrentModelUse: async (input, authority, effect, limits) => {
        const result = await f.dependencies.useOwner.withCurrentModelUse(
          input,
          authority,
          effect,
          limits,
        );
        return {
          ...result,
          extra: "SYNTHETIC-CREDENTIAL-CANARY",
          value: "SYNTHETIC-CREDENTIAL-CANARY",
        };
      },
    },
  });
  const used = await wrapped.withNamedCredentialV1(
    request("api-key", 2),
    f.authority,
    f.consume,
    bounds(),
  );
  assert.equal(used.kind, "used");
  assert.equal(used.value, "synthetic-consumed");
  assert.doesNotMatch(JSON.stringify(used), /CANARY|extra/);
  broken.close();
  wrapped.close();
});
test("foreign effect-unknown diagnostics preserve the caller original operation only", async () => {
  const f = syntheticBackend();
  const owner = createNamedCredentialCustodyV1({
    ...f.dependencies,
    useOwner: {
      withCurrentModelUse: async () => ({
        kind: "effect-unknown",
        reason: "provider-outcome-unknown",
        operationRef: "foreign/operation",
        nextAction: "exact-readback-only",
        extra: "SYNTHETIC-CREDENTIAL-CANARY",
      }),
    },
  });
  const result = await owner.withNamedCredentialV1(request(), f.authority, f.consume, bounds());
  assert.equal(result.kind, "effect-unknown");
  assert.equal(result.operationRef, request().operationRef);
  assert.doesNotMatch(JSON.stringify(result), /CANARY|foreign/);
  owner.close();
});
test("rotation audit mismatch and foreign commit-unknown cannot be accepted or retargeted", async () => {
  for (const mutation of [
    (result) => ({
      ...result,
      audit: { ...result.audit, eventRef: "aud_00000000-0000-4000-8000-000000000099" },
    }),
    (result) => ({ ...result, audit: { ...result.audit, commitRef: "foreign/commit" } }),
    () => ({
      kind: "commit-unknown",
      operationRef: "foreign/operation",
      intentDigest: "sha256:" + "b".repeat(64),
      nextAction: "exact-readback-only",
    }),
  ]) {
    const f = syntheticBackend();
    const owner = createNamedCredentialCustodyV1({
      ...f.dependencies,
      rotationOwner: {
        ...f.dependencies.rotationOwner,
        commitStagedRotation: async (...args) =>
          mutation(await f.dependencies.rotationOwner.commitStagedRotation(...args)),
      },
    });
    const result = await owner.rotateBindingV1(rotation(), f.management, bounds());
    assert.equal(result.kind, "commit-unknown");
    assert.equal(result.operationRef, rotation().operationRef);
    assert.doesNotMatch(JSON.stringify(result), /foreign/);
    owner.close();
  }
});
test("a release failure during expiry sweep quarantines its charge and denies another load", async () => {
  const f = syntheticBackend();
  const cache = createBoundedCredentialMaterialCacheV1(f.dependencies.clock);
  const first = partition();
  let loaded = 0;
  await cache.withMaterial(
    first,
    async () => ({
      ...f.lease(first),
      release() {
        throw new Error("SYNTHETIC-CREDENTIAL-CANARY");
      },
    }),
    async () => 1,
    bounds(),
  );
  f.clock.wallMs += 60000;
  f.clock.monotonicMs += 60000;
  const next = partition("api-key", 1);
  await assert.rejects(
    cache.withMaterial(
      next,
      async () => {
        loaded++;
        return f.lease(next);
      },
      async () => 1,
      bounds(),
    ),
  );
  assert.equal(loaded, 0);
  assert.deepEqual(cache.inspect(), { entries: 1, reservedBytes: 32768, busy: 0, closed: true });
});
test("facade clock uncertainty, reversal and thrown observation flush warm material", async () => {
  for (const failure of [
    (f) => {
      f.clock.uncertaintyMs = 2001;
    },
    (f) => {
      f.clock.uncertaintyMs = Number.NaN;
    },
    (f) => {
      f.clock.wallMs--;
    },
    (f) => {
      f.dependencies.clock.read = () => null;
    },
    (f) => {
      f.dependencies.clock.read = () => {
        throw new Error("SYNTHETIC-CREDENTIAL-CANARY");
      };
    },
  ]) {
    const f = setup();
    await f.use();
    failure(f);
    assert.equal((await f.use()).kind, "denied");
    assert.equal(f.owner.inspect().closed, true);
    assert.equal(f.released.length, 1);
    assert.equal((await f.use()).kind, "unavailable");
  }
});
test("owner duplicate and late callbacks cannot invoke the fixed adapter twice", async () => {
  const f = syntheticBackend();
  let late;
  const owner = createNamedCredentialCustodyV1({
    ...f.dependencies,
    useOwner: {
      withCurrentModelUse: async (_input, _authority, effect) => {
        await effect();
        await effect();
        throw new Error("unreachable");
      },
    },
  });
  assert.equal(
    (await owner.withNamedCredentialV1(request(), f.authority, f.consume, bounds())).kind,
    "effect-unknown",
  );
  assert.equal(f.state.effects, 1);
  owner.close();
  const g = syntheticBackend();
  const inactive = createNamedCredentialCustodyV1({
    ...g.dependencies,
    useOwner: {
      withCurrentModelUse: async (_input, _authority, effect) => {
        late = effect;
        return { kind: "denied", reason: "authority-denied" };
      },
    },
  });
  assert.equal(
    (await inactive.withNamedCredentialV1(request(), g.authority, g.consume, bounds())).kind,
    "denied",
  );
  await assert.rejects(late());
  assert.equal(g.state.effects, 0);
  inactive.close();
});

import { readNamedCredentialMetadataV1 } from "@openclaw-enterprise/occ/credential-custody-v1/backend";
function metadataFixture() {
  const f = syntheticBackend();
  const p = f.projection();
  const selection = {
    secretId: p.secret.id,
    secretDriverId: p.secret.driverId,
    accountKey: { ...p.accountKey },
  };
  const rows = {
    secret: structuredClone(p.secret),
    account: {
      id: p.accountKey.serviceAccountId,
      namespaceId: p.accountKey.namespaceId,
      name: "example",
      credential: {
        kind: "api_key",
        secretRef: { name: "UNRELATED-NAME-CANARY", key: "UNRELATED-KEY-CANARY" },
      },
    },
    binding: {
      providerId: p.accountKey.providerId,
      driverId: p.accountKey.driverId,
      workspaceId: p.accountKey.workspaceId,
      credentialIssued: true,
    },
  };
  const lookups = [];
  const dependencies = {
    secrets: {
      findSecret: async (ns, id) => {
        lookups.push(["secret", ns, id]);
        return rows.secret;
      },
    },
    accounts: {
      findServiceAccount: async (ns, id) => {
        lookups.push(["account", ns, id]);
        return rows.account;
      },
      findServiceAccountProviderBinding: async (ns, id) => {
        lookups.push(["binding", ns, id]);
        return rows.binding;
      },
    },
    accountLinks: f.dependencies.accountLinks,
    secretDriver: f.dependencies.secretDriver,
  };
  const read = () => readNamedCredentialMetadataV1(dependencies, selection, bounds());
  return { ...f, selection, rows, lookups, metadataDependencies: dependencies, read };
}
test("canonical metadata readers preserve exact selection and explicit unsupported custody", async () => {
  const f = metadataFixture();
  f.rows.secret.extra = "SYNTHETIC-CREDENTIAL-CANARY";
  f.rows.account.extra = "SYNTHETIC-CREDENTIAL-CANARY";
  const result = await f.read();
  assert.equal(result.kind, "metadata-observed");
  assert.deepEqual(result.selection, f.selection);
  assert.deepEqual(f.lookups, [
    ["secret", f.selection.accountKey.namespaceId, f.selection.secretId],
    ["account", f.selection.accountKey.namespaceId, f.selection.accountKey.serviceAccountId],
    ["binding", f.selection.accountKey.namespaceId, f.selection.accountKey.serviceAccountId],
  ]);
  assert.deepEqual(result.namedCapabilities, {
    authenticatedExactNamedAccess: { status: "unsupported", reason: "capability-unimplemented" },
    versionedReadAndRotation: { status: "unsupported", reason: "capability-unimplemented" },
  });
  assert.deepEqual(result.custody, { kind: "unprovided" });
  assert.deepEqual(result.externalCustody, { status: "unsupported", reason: "adapter-unprovided" });
  assert.equal(result.credentialIssued, true);
  assert.equal("secretVersion" in result, false);
  assert.equal("binding" in result, false);
  assert.doesNotMatch(JSON.stringify(result), /CANARY/);
  assert.equal(f.state.reads, 0);
  assert.equal(f.state.effects, 0);
  assert.equal(Object.isFrozen(result.selection.accountKey), true);
  // This metadata result still supplies no protected capability to the facade.
  const owner = createNamedCredentialCustodyV1({
    ...f.dependencies,
    profile: configuration(false),
  });
  assert.equal(
    (await owner.withNamedCredentialV1(request(), f.authority, f.consume, bounds())).kind,
    "unavailable",
  );
  assert.equal(f.state.effects, 0);
});
test("missing, memory-undefined and foreign metadata ownership denies", async () => {
  for (const mutate of [
    (f) => {
      f.rows.secret = undefined;
    },
    (f) => {
      f.rows.account = undefined;
    },
    (f) => {
      f.rows.binding = undefined;
    },
    (f) => {
      f.rows.secret.id = "foreign";
    },
    (f) => {
      f.rows.secret.namespaceId = "foreign";
    },
    (f) => {
      f.rows.secret.driverId = "foreign";
    },
    (f) => {
      f.rows.account.id = "foreign";
    },
    (f) => {
      f.rows.account.namespaceId = "foreign";
    },
    (f) => {
      f.rows.binding.providerId = "foreign";
    },
    (f) => {
      f.rows.binding.driverId = "foreign";
    },
    (f) => {
      f.rows.binding.workspaceId = "foreign";
    },
    (f) => {
      f.selection.secretDriverId = "foreign";
    },
    (f) => {
      f.metadataDependencies.accountLinks = {
        run: async (work) => work({ find: async () => undefined }),
      };
    },
    (f) => {
      f.metadataDependencies.accountLinks = {
        run: async (work) =>
          work({ find: async () => ({ ...f.projection().accountLink, workspaceId: "foreign" }) }),
      };
    },
    (f) => {
      f.metadataDependencies.secretDriver = {
        ...f.dependencies.secretDriver,
        resolve: async () => ({ ...f.projection().secret.backendRef, uid: "foreign" }),
      };
    },
  ]) {
    const f = metadataFixture();
    mutate(f);
    assert.deepEqual(await f.read(), { kind: "unavailable", reason: "secret-unavailable" });
    assert.equal(f.state.reads, 0);
    assert.equal(f.state.effects, 0);
  }
});
test("account name hints cannot adopt a missing Secret and credentialIssued is only an observation", async () => {
  const f = metadataFixture();
  f.rows.account.credential.secretRef = {
    name: f.rows.secret.backendRef.name,
    key: f.rows.secret.backendRef.key,
  };
  f.rows.secret = undefined;
  assert.equal((await f.read()).kind, "unavailable");
  assert.equal(f.lookups.length, 1);
  assert.equal(f.state.resolves, 0);
  const g = metadataFixture();
  g.rows.binding.credentialIssued = false;
  const result = await g.read();
  assert.equal(result.kind, "metadata-observed");
  assert.equal(result.credentialIssued, false);
  assert.equal(result.custody.kind, "unprovided");
  await g.read();
  assert.equal(g.lookups.length, 6);
  assert.equal(g.state.resolves, 2);
});
test("metadata error and extra-field canaries are contained with abort fencing", async () => {
  const f = metadataFixture();
  f.metadataDependencies.accountLinks = {
    run: async (work) =>
      work({
        find: async () => ({ ...f.projection().accountLink, extra: "SYNTHETIC-CREDENTIAL-CANARY" }),
      }),
  };
  assert.doesNotMatch(JSON.stringify(await f.read()), /CANARY/);
  f.state.deniedStore = true;
  assert.deepEqual(await f.read(), { kind: "unavailable", reason: "secret-unavailable" });
  const g = metadataFixture();
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (
      await readNamedCredentialMetadataV1(g.metadataDependencies, g.selection, {
        signal: controller.signal,
      })
    ).kind,
    "unavailable",
  );
  assert.equal(g.lookups.length, 0);
  const h = metadataFixture();
  const during = new AbortController();
  h.metadataDependencies.secrets.findSecret = async () => {
    during.abort();
    return h.rows.secret;
  };
  assert.equal(
    (
      await readNamedCredentialMetadataV1(h.metadataDependencies, h.selection, {
        signal: during.signal,
      })
    ).kind,
    "unavailable",
  );
  assert.equal(h.lookups.length, 0);
  assert.equal(h.state.resolves, 0);
});
test("metadata selection is copied before asynchronous reads without inventing authority", async () => {
  const f = metadataFixture();
  const original = structuredClone(f.selection);
  const pause = deferred();
  f.metadataDependencies.secrets.findSecret = async (ns, id) => {
    assert.equal(ns, original.accountKey.namespaceId);
    assert.equal(id, original.secretId);
    await pause.promise;
    return f.rows.secret;
  };
  const pending = f.read();
  f.selection.secretId = "foreign";
  f.selection.accountKey.serviceAccountId = "foreign";
  pause.resolve();
  const result = await pending;
  assert.equal(result.kind, "metadata-observed");
  assert.deepEqual(result.selection, original);
  assert.equal(f.state.effects, 0);
});
