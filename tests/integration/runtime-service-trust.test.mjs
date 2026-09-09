import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  RuntimeServiceTrustService,
  parseRuntimeServiceTrustRequest,
  parseRuntimeAuthoritySource,
  parseRuntimeServiceNativeProfile,
  runtimeServiceTrustDigest,
  ScopeViolationError,
  ResourceConflictError,
} from "../../packages/occ/src/index.ts";
import {
  createRuntimeServiceTrustFixture,
  sourceRequest,
  serviceRequest,
  signal,
  technicalSource,
} from "../fixtures/runtime-service-trust.mjs";

test("initial bind profile selection is explicit and cannot cross the legacy source pair", async () => {
  const legacy = await technicalSource();
  const binding = parseRuntimeAuthoritySource({
    ...legacy,
    transportProfileRef: "owned-child-stdio-initial-harness-bind-v1",
  });
  for (const [source, operationPolicy] of [
    [legacy, "read-operation-only-v1"],
    [binding, "initial-harness-bind-v1"],
  ]) {
    const profile = {
      ...source,
      operationPolicy,
      peerSPIFFEId: "spiffe://example.test/independent-service",
      sourceConfigurationDigest: runtimeServiceTrustDigest(source),
    };
    assert.equal(parseRuntimeServiceNativeProfile(profile).operationPolicy, operationPolicy);
    for (const other of [
      "unknown",
      operationPolicy === "initial-harness-bind-v1"
        ? "read-operation-only-v1"
        : "initial-harness-bind-v1",
    ])
      assert.throws(() => parseRuntimeServiceNativeProfile({ ...profile, operationPolicy: other }));
  }
  const f = {
    source: binding,
    owner: { namespace: { id: `ns_${randomUUID()}` }, agent: { id: `agt_${randomUUID()}` } },
  };
  const original = serviceRequest(f);
  assert.equal(Object.hasOwn(parseRuntimeServiceTrustRequest(original), "operationPolicy"), false);
  assert.equal(
    parseRuntimeServiceTrustRequest({ ...original, operationPolicy: "initial-harness-bind-v1" })
      .operationPolicy,
    "initial-harness-bind-v1",
  );
  for (const policy of ["read-operation-only-v1", "bind", "initial-harness-bind-v1\n", null])
    assert.throws(() => parseRuntimeServiceTrustRequest({ ...original, operationPolicy: policy }));
});

test("runtime observation admission uses its own exact source and operation pair", async () => {
  const source = await technicalSource({
    transportProfileRef: "owned-child-stdio-runtime-observation-v1",
  });
  const profile = {
    ...source,
    operationPolicy: "runtime-observation-read-v1",
    peerSPIFFEId: "spiffe://example.test/observer",
    sourceConfigurationDigest: runtimeServiceTrustDigest(source),
  };
  assert.equal(
    parseRuntimeServiceNativeProfile(profile).operationPolicy,
    "runtime-observation-read-v1",
  );
  for (const operationPolicy of ["read-operation-only-v1", "initial-harness-bind-v1", "unknown"])
    assert.throws(() => parseRuntimeServiceNativeProfile({ ...profile, operationPolicy }));
  const f = {
    source,
    owner: { namespace: { id: `ns_${randomUUID()}` }, agent: { id: `agt_${randomUUID()}` } },
  };
  assert.equal(
    parseRuntimeServiceTrustRequest(
      serviceRequest(f, { operationPolicy: "runtime-observation-read-v1" }),
    ).operationPolicy,
    "runtime-observation-read-v1",
  );
});

test("real source admission cannot implicitly admit an initial bind service", async (t) => {
  const f = await createRuntimeServiceTrustFixture({
    sourceOverrides: {
      transportProfileRef: "owned-child-stdio-initial-harness-bind-v1",
    },
  });
  t.after(() => f.close());
  await f.trust.apply(sourceRequest(f.source.sourceRef), f.context, signal());
  const request = serviceRequest(f);
  // The old request shape selects readback only; it cannot inherit the source's bind policy.
  await assert.rejects(f.trust.apply(request, f.context, signal()), ScopeViolationError);
  assert.equal(
    await f.state.read((view) =>
      view.runtimeServiceTrust.findOperation(f.owner.installation.id, request.operationRef),
    ),
    undefined,
  );
  assert.equal(
    (await f.state.transact((unit) => unit.audit.list())).filter(
      (event) => event.details?.operationRef === request.operationRef,
    ).length,
    0,
  );
});

test(
  "native-validated initial bind admission exposes only its exact current registry policy",
  {
    skip: process.env.OCC_RUNTIME_AUTHORITY_TEST_BINARY
      ? false
      : "Select the actual native validator supporting both admitted profiles.",
  },
  async (t) => {
    const f = await createRuntimeServiceTrustFixture({
      sourceOverrides: {
        transportProfileRef: "owned-child-stdio-initial-harness-bind-v1",
      },
    });
    t.after(() => f.close());
    await f.trust.apply(sourceRequest(f.source.sourceRef), f.context, signal());
    const request = serviceRequest(f, { operationPolicy: "initial-harness-bind-v1" });
    const admitted = await f.trust.apply(request, f.context, signal());
    const ref = admitted.record.subjectRef;
    const current = await f.trust.readCurrent(ref, signal());
    assert.deepEqual(current.configuration, admitted.record.configuration);
    assert.equal(current.operationPolicy, "initial-harness-bind-v1");
    assert.equal(current.configuration.role, "lifecycle-authority");
    assert.equal(current.configuration.allowedScope.kind, "agent");
    await f.trust.apply(
      {
        schemaVersion: 1,
        kind: "service-withdraw",
        serviceIdentityRef: ref,
        expectedVersion: 1,
        operationRef: randomUUID(),
      },
      f.context,
      signal(),
    );
    assert.equal(await f.trust.readCurrent(ref, signal()), undefined);
    const replay = await f.trust.apply(request, f.context, signal());
    assert.equal(replay.result, "exact-replay");
    assert.deepEqual(replay.record, admitted.record);
    assert.equal(await f.trust.readCurrent(ref, signal()), undefined);
    await assert.rejects(
      f.trust.apply({ ...request, operationPolicy: undefined }, f.context, signal()),
      ScopeViolationError,
    );
  },
);

test("runtime trust schemas reject authority fields, fractional counters and accessors", async () => {
  const source = await technicalSource();
  for (const extra of [
    { role: "lifecycle-authority" },
    { allowedScope: { kind: "installation" } },
    { workloadApiSocketPath: "/wrong" },
  ])
    assert.throws(() =>
      parseRuntimeServiceTrustRequest({ ...sourceRequest(source.sourceRef), ...extra }),
    );
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() =>
      parseRuntimeServiceTrustRequest({
        ...sourceRequest(source.sourceRef),
        expectedVersion: value,
      }),
    );
  assert.throws(() =>
    parseRuntimeAuthoritySource({ ...source, recipientSPIFFEId: "spiffe://example.test/foreign" }),
  );
  for (const field of ["operationRef", "sourceRef"]) {
    const request = sourceRequest(source.sourceRef);
    assert.throws(() =>
      parseRuntimeServiceTrustRequest({ ...request, [field]: request[field] + "\n" }),
    );
  }
  const getter = { ...source };
  Object.defineProperty(getter, "sourceRef", {
    enumerable: true,
    get() {
      throw new Error("Getter invoked");
    },
  });
  assert.throws(() => parseRuntimeAuthoritySource(getter), ScopeViolationError);
});

test("actual memory registry atomically retains source audit, exact replay and withdrawal history", async (t) => {
  const f = await createRuntimeServiceTrustFixture();
  t.after(() => f.close());
  const request = sourceRequest(f.source.sourceRef);
  const first = await f.trust.apply(request, f.context, signal());
  assert.equal(first.result, "applied");
  const audits = await f.state.transact((unit) => unit.audit.list());
  assert.equal(audits.filter((a) => a.id === first.record.auditId).length, 1);
  const replay = await f.trust.apply(request, f.context, signal());
  assert.equal(replay.result, "exact-replay");
  assert.deepEqual(replay.record, first.record);
  await assert.rejects(
    f.trust.apply({ ...request, expectedVersion: 1 }, f.context, signal()),
    ResourceConflictError,
  );
  const withdrawal = {
    schemaVersion: 1,
    kind: "source-withdraw",
    sourceRef: f.source.sourceRef,
    operationRef: randomUUID(),
    expectedVersion: 1,
  };
  const stopped = await f.trust.apply(withdrawal, f.context, signal());
  assert.equal(stopped.record.recordVersion, 2);
  // Replaying retained input must not resolve changed deployment bytes or reactivate head.
  const restarted = new RuntimeServiceTrustService({ ...f.options, sources: [] });
  assert.deepEqual((await restarted.apply(request, f.context, signal())).record, first.record);
  const current = await f.state.read((unit) =>
    unit.runtimeServiceTrust.latest(f.owner.installation.id, "source", f.source.sourceRef),
  );
  assert.equal(current.kind, "source-withdraw");
  assert.deepEqual(
    await restarted.recover(request.operationRef, f.context, signal()),
    first.record,
  );
});

test("caught invalid registry admission poisons the real enclosing memory unit", async (t) => {
  const f = await createRuntimeServiceTrustFixture();
  t.after(() => f.close());
  const request = sourceRequest(f.source.sourceRef);
  await assert.rejects(
    f.state.transact(async (unit) => {
      await f.trust.applyInTransaction(unit, request, f.context, signal());
      await assert.rejects(
        f.trust.applyInTransaction(
          unit,
          { ...sourceRequest(f.source.sourceRef), actorId: f.context.actorId },
          f.context,
          signal(),
        ),
      );
    }),
  );
  assert.equal(
    await f.state.read((unit) =>
      unit.runtimeServiceTrust.findOperation(f.owner.installation.id, request.operationRef),
    ),
    undefined,
  );
  assert.equal((await f.state.transact((unit) => unit.audit.list())).length, 0);
});

test(
  "actual current trust requires native-validated admission, exact source incarnation and live service head",
  {
    skip: process.env.OCC_RUNTIME_AUTHORITY_TEST_BINARY
      ? false
      : "Select the actual native validator binary for positive service admission.",
  },
  async (t) => {
    const f = await createRuntimeServiceTrustFixture();
    t.after(() => f.close());
    await f.trust.apply(sourceRequest(f.source.sourceRef), f.context, signal());
    const request = serviceRequest(f);
    const admitted = await f.trust.apply(request, f.context, signal());
    const ref = admitted.record.subjectRef;
    assert.equal((await f.trust.readCurrent(ref, signal())).configuration.serviceIdentityRef, ref);
    const changed = new RuntimeServiceTrustService({
      ...f.options,
      sources: [{ ...f.source, verifierProfileRef: "verifier/replaced" }],
    });
    assert.equal(await changed.readCurrent(ref, signal()), undefined);
    const withdrawal = {
      schemaVersion: 1,
      kind: "service-withdraw",
      serviceIdentityRef: ref,
      expectedVersion: 1,
      operationRef: randomUUID(),
    };
    await f.trust.apply(withdrawal, f.context, signal());
    assert.equal(await f.trust.readCurrent(ref, signal()), undefined);
    assert.equal((await f.trust.apply(request, f.context, signal())).record.subjectRef, ref);
    assert.equal(await f.trust.readCurrent(ref, signal()), undefined);
    const resumed = await f.trust.apply(
      serviceRequest(f, { serviceIdentityRef: ref, expectedVersion: 2 }),
      f.context,
      signal(),
    );
    assert.equal(resumed.record.configuration.configurationVersion, 3);
    await f.trust.apply(sourceRequest(f.source.sourceRef, 1), f.context, signal());
    assert.equal(await f.trust.readCurrent(ref, signal()), undefined);
  },
);

test(
  "actual native validator failure cannot commit a service or its audit",
  {
    skip: process.env.OCC_RUNTIME_AUTHORITY_TEST_BINARY
      ? false
      : "Select actual native validator binary.",
  },
  async (t) => {
    const f = await createRuntimeServiceTrustFixture({
      sourceOverrides: { nativeExecutableSha256: `sha256:${"9".repeat(64)}` },
    });
    t.after(() => f.close());
    assert.equal(
      (
        await f.request(
          "POST",
          "/v1/runtime-service-trust/operations",
          sourceRequest(f.source.sourceRef),
        )
      ).status,
      200,
    );
    const request = serviceRequest(f);
    const result = await f.request("POST", "/v1/runtime-service-trust/operations", request);
    assert.equal(result.status, 503, JSON.stringify(result));
    assert.equal(
      await f.state.read((unit) =>
        unit.runtimeServiceTrust.findOperation(f.owner.installation.id, request.operationRef),
      ),
      undefined,
    );
    assert.equal(
      (await f.state.transact((unit) => unit.audit.list())).filter(
        (a) => a.details?.operationRef === request.operationRef,
      ).length,
      0,
    );
  },
);
