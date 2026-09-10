import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  RuntimeServiceTrustService,
  parseRuntimeAuthoritySource,
  parseRuntimeServiceNativeProfile,
  parseRuntimeServiceTrustRecord,
  runtimeServiceTrustDigest,
  ScopeViolationError,
} from "../../packages/occ/src/index.ts";
import { validateNativeRuntimeServiceProfile } from "../../apps/controller/src/admission/runtime-authority-profile.ts";
import {
  createRuntimeServiceTrustFixture,
  sourceRequest,
  serviceRequest,
  signal,
  technicalSource,
} from "../fixtures/runtime-service-trust.mjs";

const binaryPath = process.env.OCC_GITHUB_MEDIATION_TEST_BINARY;
const native = {
  skip: binaryPath ? false : "Select the actual GitHub mediation native validator binary.",
};
const deployment = {
  listenPath: "/servicepeer/github/mediation.sock",
  peerUid: process.getuid(),
  trustedAncestorUids: [...new Set([0, process.getuid()])],
};
const operationPolicy = "github-metadata-rpc-v2";
const transportProfileRef = "owned-child-stdio-github-metadata-v2";
const validate = (profile, callSignal, selected = { binaryPath, deployment }) =>
  // The missing legacy path proves that this profile selects the separate native parser.
  validateNativeRuntimeServiceProfile("/missing/runtime-authority", profile, callSignal, selected);

async function fixture(t) {
  const source = await technicalSource({ transportProfileRef }, binaryPath);
  const f = await createRuntimeServiceTrustFixture({ source, binaryPath });
  t.after(() => f.close());
  const trust = new RuntimeServiceTrustService({ ...f.options, validateProfile: validate });
  await trust.apply(sourceRequest(source.sourceRef), f.context, signal());
  return { ...f, trust };
}

test("GitHub metadata profile cannot cross any existing transport or operation pair", async () => {
  const source = await technicalSource({ transportProfileRef });
  const profile = {
    ...source,
    operationPolicy,
    sourceConfigurationDigest: runtimeServiceTrustDigest(source),
    peerSPIFFEId: "spiffe://example.test/independent-service",
  };
  assert.equal(parseRuntimeServiceNativeProfile(profile).operationPolicy, operationPolicy);
  for (const policy of [
    "read-operation-only-v1",
    "initial-harness-bind-v1",
    "runtime-observation-read-v1",
    "github-metadata-rpc-v2\n",
  ])
    assert.throws(() => parseRuntimeServiceNativeProfile({ ...profile, operationPolicy: policy }));
  for (const transport of [
    "owned-child-stdio-readback-v1",
    "owned-child-stdio-initial-harness-bind-v1",
    "owned-child-stdio-runtime-observation-v1",
  ]) {
    const other = parseRuntimeAuthoritySource({ ...source, transportProfileRef: transport });
    assert.throws(() =>
      parseRuntimeServiceNativeProfile({
        ...profile,
        ...other,
        sourceConfigurationDigest: runtimeServiceTrustDigest(other),
      }),
    );
  }
  assert.throws(() => parseRuntimeServiceNativeProfile({ ...profile, role: "repository-issuer" }));
});

test(
  "GitHub validation selects the actual eight-byte native parser and exact binary",
  native,
  async () => {
    const source = await technicalSource({ transportProfileRef }, binaryPath);
    const profile = {
      ...source,
      operationPolicy,
      sourceConfigurationDigest: runtimeServiceTrustDigest(source),
      peerSPIFFEId: "spiffe://example.test/independent-service",
    };
    await validate(profile, signal());
    await assert.rejects(validateNativeRuntimeServiceProfile(binaryPath, profile, signal()));
    await assert.rejects(
      validate(profile, signal(), { binaryPath, deployment: { ...deployment, peerUid: -1 } }),
    );
    const wrong = { ...source, nativeExecutableSha256: `sha256:${"0".repeat(64)}` };
    await assert.rejects(
      validate(
        { ...profile, ...wrong, sourceConfigurationDigest: runtimeServiceTrustDigest(wrong) },
        signal(),
      ),
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(validate(profile, cancelled.signal));
  },
);

test(
  "real registry admission binds GitHub role, original source and current installed map",
  native,
  async (t) => {
    const f = await fixture(t);
    const request = serviceRequest(f, { operationPolicy });
    // Omitting the new operation must never inherit repository authority from technical source.
    await assert.rejects(
      f.trust.apply(serviceRequest(f), f.context, signal()),
      ScopeViolationError,
    );
    const admitted = await f.trust.apply(request, f.context, signal());
    assert.equal(admitted.result, "applied");
    const record = admitted.record;
    assert.equal(record.configuration.role, "repository-issuer");
    assert.deepEqual(record.configuration.allowedScope, {
      kind: "agent",
      installationId: f.owner.installation.id,
      namespaceId: f.owner.namespace.id,
      agentId: f.owner.agent.id,
    });
    const current = await f.trust.readCurrentRecord(record.subjectRef, signal());
    assert.deepEqual(current.admission, record);
    assert.equal(current.sourceAdmission.operationRef, record.sourceOperationRef);
    assert.equal(current.sourceAdmission.recordVersion, record.sourceRecordVersion);
    assert.equal(
      (await f.trust.readCurrent(record.subjectRef, signal())).operationPolicy,
      operationPolicy,
    );
    assert.throws(() =>
      parseRuntimeServiceTrustRecord({
        ...record,
        configuration: { ...record.configuration, role: "lifecycle-authority" },
      }),
    );
    const audits = await f.state.transact((unit) => unit.audit.list());
    assert.equal(audits.filter((entry) => entry.id === record.auditId).length, 1);
    for (const sources of [[], [{ ...f.source, verifierProfileRef: "verifier/replaced" }]]) {
      const restarted = new RuntimeServiceTrustService({
        ...f.options,
        sources,
        validateProfile: validate,
      });
      assert.equal(await restarted.readCurrentRecord(record.subjectRef, signal()), undefined);
    }
  },
);

test(
  "source and service withdrawal retain history without restoring GitHub admission on replay",
  native,
  async (t) => {
    const f = await fixture(t);
    const request = serviceRequest(f, { operationPolicy });
    const first = await f.trust.apply(request, f.context, signal());
    const ref = first.record.subjectRef;
    await f.trust.apply(
      {
        schemaVersion: 1,
        kind: "source-withdraw",
        sourceRef: f.source.sourceRef,
        operationRef: randomUUID(),
        expectedVersion: 1,
      },
      f.context,
      signal(),
    );
    assert.equal(await f.trust.readCurrentRecord(ref, signal()), undefined);
    assert.deepEqual((await f.trust.apply(request, f.context, signal())).record, first.record);
    await f.trust.apply(sourceRequest(f.source.sourceRef, 2), f.context, signal());
    // Identical source bytes in a new admission are a different original source operation/version.
    assert.equal(await f.trust.readCurrentRecord(ref, signal()), undefined);
    const renewed = await f.trust.apply(
      serviceRequest(f, {
        operationPolicy,
        serviceIdentityRef: ref,
        expectedVersion: 1,
      }),
      f.context,
      signal(),
    );
    assert.equal(renewed.record.sourceRecordVersion, 3);
    assert.ok(await f.trust.readCurrentRecord(ref, signal()));
    await f.trust.apply(
      {
        schemaVersion: 1,
        kind: "service-withdraw",
        serviceIdentityRef: ref,
        operationRef: randomUUID(),
        expectedVersion: 2,
      },
      f.context,
      signal(),
    );
    assert.equal(await f.trust.readCurrentRecord(ref, signal()), undefined);
    assert.deepEqual(
      await f.trust.recover(request.operationRef, f.context, signal()),
      first.record,
    );
    assert.deepEqual((await f.trust.apply(request, f.context, signal())).record, first.record);
    assert.equal(await f.trust.readCurrentRecord(ref, signal()), undefined);
  },
);

test(
  "missing native GitHub configuration cannot commit service admission or its audit",
  native,
  async (t) => {
    const f = await fixture(t);
    const unconfigured = new RuntimeServiceTrustService({
      ...f.options,
      validateProfile: (profile, callSignal) =>
        validateNativeRuntimeServiceProfile(binaryPath, profile, callSignal),
    });
    const request = serviceRequest(f, { operationPolicy });
    await assert.rejects(unconfigured.apply(request, f.context, signal()));
    assert.equal(
      await f.state.read((view) =>
        view.runtimeServiceTrust.findOperation(f.owner.installation.id, request.operationRef),
      ),
      undefined,
    );
    assert.equal(
      (await f.state.transact((unit) => unit.audit.list())).filter(
        (entry) => entry.details?.operationRef === request.operationRef,
      ).length,
      0,
    );
  },
);
