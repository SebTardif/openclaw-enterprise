import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  RuntimeServiceTrustService,
  parseRuntimeAuthoritySource,
  parseRuntimeServiceNativeProfile,
  parseRuntimeServiceTrustRecord,
  runtimeServiceTrustDigest,
} from "../../packages/occ/src/index.ts";
import { validateNativeRuntimeServiceProfile } from "../../apps/controller/src/admission/runtime-authority-profile.ts";
import {
  createRuntimeServiceTrustFixture,
  sourceRequest,
  serviceRequest,
  signal,
  technicalSource,
} from "../fixtures/runtime-service-trust.mjs";

const operationPolicy = "github-git-read-rpc-v3";
const transportProfileRef = "owned-child-stdio-github-git-read-v3";
const binaryPath = process.env.OCC_GITHUB_GIT_READ_TEST_BINARY;
const metadataBinaryPath = process.env.OCE_GITHUB_MEDIATION_TEST_BINARY;
const actualNative = {
  skip: binaryPath ? false : "Select the actual Git read v3 native validator binary.",
};
const deployment = {
  listenPath: "/servicepeer/github/git-read.sock",
  peerUid: process.getuid(),
  trustedAncestorUids: [...new Set([0, process.getuid()])],
};
const validate = (profile, signal) =>
  validateNativeRuntimeServiceProfile("/missing/legacy-runtime-validator", profile, signal, {
    binaryPath,
    deployment,
  });

test("Git read source and native profile remain a fifth exact closed pair", async () => {
  const source = await technicalSource({ transportProfileRef });
  const profile = {
    ...source,
    operationPolicy,
    sourceConfigurationDigest: runtimeServiceTrustDigest(source),
    peerSPIFFEId: "spiffe://example.test/service/ds",
  };
  assert.equal(parseRuntimeServiceNativeProfile(profile).operationPolicy, operationPolicy);
  const pairs = [
    ["read-operation-only-v1", "owned-child-stdio-readback-v1"],
    ["initial-harness-bind-v1", "owned-child-stdio-initial-harness-bind-v1"],
    ["runtime-observation-read-v1", "owned-child-stdio-runtime-observation-v1"],
    ["github-metadata-rpc-v2", "owned-child-stdio-github-metadata-v2"],
    [operationPolicy, transportProfileRef],
  ];
  for (const [policy] of pairs)
    for (const [, transport] of pairs) {
      const selected = parseRuntimeAuthoritySource({ ...source, transportProfileRef: transport });
      const candidate = {
        ...profile,
        ...selected,
        operationPolicy: policy,
        sourceConfigurationDigest: runtimeServiceTrustDigest(selected),
      };
      if (pairs.some(([p, t]) => p === policy && t === transport))
        assert.equal(parseRuntimeServiceNativeProfile(candidate).operationPolicy, policy);
      else assert.throws(() => parseRuntimeServiceNativeProfile(candidate));
    }
  for (const change of [
    { operationPolicy: operationPolicy + "\n" },
    { transportProfileRef: transportProfileRef + "\n" },
    { alpn: "oce-github-git-read-v3" },
    { contentsPermission: "read" },
    { operationPolicy: "github-git-write-rpc-v3" },
  ])
    assert.throws(() => parseRuntimeServiceNativeProfile({ ...profile, ...change }));
});

test("unselected Git read validator cannot commit a service or service audit", async (t) => {
  const source = await technicalSource({ transportProfileRef });
  const f = await createRuntimeServiceTrustFixture({ source });
  t.after(() => f.close());
  const trust = new RuntimeServiceTrustService({
    ...f.options,
    validateProfile: (profile, signal) =>
      validateNativeRuntimeServiceProfile("/missing/native", profile, signal),
  });
  await trust.apply(sourceRequest(source.sourceRef), f.context, signal());
  const request = serviceRequest(f, { operationPolicy });
  await assert.rejects(trust.apply(request, f.context, signal()));
  const records = await f.state.read((view) =>
    view.runtimeServiceTrust.findOperation(f.owner.installation.id, request.operationRef),
  );
  assert.equal(records, undefined);
  assert.equal(
    (await f.state.transact((unit) => unit.audit.list())).filter(
      (entry) => entry.details?.operationRef === request.operationRef,
    ).length,
    0,
  );
});

test(
  "selected metadata-only native validator cannot grant Git read v3 authority",
  {
    skip: metadataBinaryPath ? false : "Select the retained metadata-only native validator binary.",
  },
  async (t) => {
    const source = await technicalSource({ transportProfileRef }, metadataBinaryPath);
    const f = await createRuntimeServiceTrustFixture({ source, binaryPath: metadataBinaryPath });
    t.after(() => f.close());
    const trust = new RuntimeServiceTrustService({
      ...f.options,
      validateProfile: (profile, signal) =>
        validateNativeRuntimeServiceProfile("/missing/legacy-runtime-validator", profile, signal, {
          binaryPath: metadataBinaryPath,
          deployment,
        }),
    });
    await trust.apply(sourceRequest(source.sourceRef), f.context, signal());
    const request = serviceRequest(f, { operationPolicy });
    await assert.rejects(trust.apply(request, f.context, signal()));
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

test(
  "actual Git read native validator admits repository-issuer through the original current registry",
  actualNative,
  async (t) => {
    const source = await technicalSource({ transportProfileRef }, binaryPath);
    const f = await createRuntimeServiceTrustFixture({ source, binaryPath });
    t.after(() => f.close());
    const trust = new RuntimeServiceTrustService({ ...f.options, validateProfile: validate });
    await trust.apply(sourceRequest(source.sourceRef), f.context, signal());
    const admitted = await trust.apply(serviceRequest(f, { operationPolicy }), f.context, signal());
    assert.equal(admitted.result, "applied");
    const record = admitted.record;
    assert.equal(record.configuration.role, "repository-issuer");
    assert.equal(record.profile.operationPolicy, operationPolicy);
    assert.equal(record.profile.transportProfileRef, transportProfileRef);
    const current = await trust.readCurrentRecord(record.subjectRef, signal());
    assert.deepEqual(current.admission, record);
    assert.equal(current.sourceAdmission.operationRef, record.sourceOperationRef);
    assert.throws(() =>
      parseRuntimeServiceTrustRecord({
        ...record,
        configuration: { ...record.configuration, role: "lifecycle-authority" },
      }),
    );
    const changed = new RuntimeServiceTrustService({
      ...f.options,
      sources: [{ ...source, verifierProfileRef: "verifier/changed" }],
      validateProfile: validate,
    });
    assert.equal(await changed.readCurrentRecord(record.subjectRef, signal()), undefined);
    const withdrawal = await trust.apply(
      {
        schemaVersion: 1,
        kind: "service-withdraw",
        operationRef: randomUUID(),
        expectedVersion: record.recordVersion,
        serviceIdentityRef: record.subjectRef,
      },
      f.context,
      signal(),
    );
    assert.equal(withdrawal.result, "applied");
    assert.equal(await trust.readCurrentRecord(record.subjectRef, signal()), undefined);
  },
);
