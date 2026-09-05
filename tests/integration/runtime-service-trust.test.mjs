import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  RuntimeServiceTrustService,
  parseRuntimeServiceTrustRequest,
  parseRuntimeAuthoritySource,
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
    assert.equal((await f.trust.readCurrent(ref, signal())).serviceIdentityRef, ref);
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
