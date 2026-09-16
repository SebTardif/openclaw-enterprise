import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digest, id, now, scope, until } from "../fixtures/runtime-authority-v1/vectors.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const contracts = createRequire(join(root, "packages/contracts/package.json"));
const occ = createRequire(join(root, "packages/occ/package.json"));
const controller = createRequire(join(root, "apps/controller/package.json"));
const { Check } = await import(contracts.resolve("typebox/value"));
const job = await import(contracts.resolve("@openclaw-enterprise/contracts/preparation-job-v1"));

const versioned = (ref) => ({ ref, version: 1, digest });
const staging = () => ({
  schemaVersion: 1,
  scope: { ...scope },
  logicalStoreRef: "store/candidate",
  bindingRef: "binding/candidate",
  bindingVersion: 1,
});
const gate = () => ({
  schemaVersion: 1,
  scope: { ...scope },
  intentRef: id(30),
  mode: "running",
  lifecycleGeneration: 1,
  requestedFenceEpoch: 1,
  responsibility: { responsibilityRef: id(31), responsibilityVersion: 1, kind: "preparation" },
  gateVersion: 1,
  planRef: "plan/job",
  planVersion: 1,
  planDigest: digest,
  admittedChildCutoff: 1,
});
const evidence = (producer) => ({
  producerRef: `producer/${producer}`,
  producerServiceVersion: 1,
  producerProfileRef: `profile/${producer}`,
  producerProfileDigest: digest,
  acceptedPortRef: `port/${producer}`,
  evidenceRef: `evidence/${producer}`,
  evidenceVersion: 1,
  clock: { sourceObservedAt: now, receivedAt: now, validUntil: until, uncertaintyMs: 0 },
});
const subject = () => ({
  schemaVersion: 1,
  purpose: "candidate-repository-preparation",
  scope: { ...scope },
  preparationRef: id(32),
  incarnationRef: "incarnation/candidate",
  revisionId: `rev_${id(33)}`,
  revisionDigest: digest,
  gate: gate(),
  authorizationGeneration: 1,
  admission: {
    operationRef: "operation/admission",
    requestDigest: digest,
    actorRef: "actor/candidate",
    requestId: `req_${id(34)}`,
  },
  grant: versioned("grant/checkout"),
  profile: {
    schemaVersion: 1,
    scope: { ...scope },
    profile: versioned("profile/repository"),
    providerId: "github",
    account: versioned("account/repository"),
    transport: versioned("transport/repository"),
    kind: "repository",
    mode: "native",
    providerInstallationRef: "installation/provider",
    permissionProfile: versioned("permission/read"),
    credentialClass: "installation-token",
  },
  repositoryId: "123",
  commit: { algorithm: "sha1", oid: "c".repeat(40) },
  originProfile: versioned("origin/repository"),
  staging: staging(),
  createdAt: now,
  notAfter: until,
});
const checkout = () => ({
  schemaVersion: 1,
  preparation: subject(),
  operationRef: "operation/checkout",
  requestId: `req_${id(35)}`,
  effectRef: id(37),
  requestDigest: digest,
  createdAt: now,
  deadline: until,
});
const target = () => ({
  schemaVersion: 1,
  purpose: "candidate-repository-preparation",
  preparation: subject(),
  clusterRef: "cluster/selected",
  kubernetesNamespace: "candidate",
  kubernetesNamespaceUid: "namespace/selected",
  apiVersion: "batch/v1",
  apiKind: "Job",
  name: "prepare-candidate",
  reservationRef: id(38),
  retention: "permanent-inert-reservation",
});
const kinds = ["job-controller", "node-runtime", "staging-writers"];
const plan = () => ({
  schemaVersion: 1,
  planRef: "plan/job",
  planVersion: 1,
  planDigest: digest,
  target: target(),
  jobSpecDigest: digest,
  podTemplateDigest: digest,
  profile: {
    initialSuspend: true,
    parallelism: 1,
    completions: 1,
    completionMode: "NonIndexed",
    backoffLimit: 0,
    restartPolicy: "Never",
    automaticRootDeletion: false,
    runtimeHandler: "runsc",
    platform: "systrap",
    isolationPolicy: "STRICT",
    runscExecutableDigest: digest,
    runtimeProfileDigest: digest,
    containmentProfileDigest: digest,
    mountPolicyDigest: digest,
    resourceEnvelopeDigest: digest,
    identityProfileRef: "identity/job",
    identityProfileDigest: digest,
    admittedExecutionNotAfter: until,
  },
  producerDomains: kinds.map((kind) => ({
    domainRef: `domain/${kind}`,
    kind,
    requiredProducerRef: `producer/${kind}`,
    requiredCapabilityRef: `capability/${kind}`,
    profileDigest: digest,
  })),
  reservationRetention: "permanent",
});
const operation = (number) => ({
  schemaVersion: 1,
  effectRef: id(number),
  requestDigest: digest,
  requestId: `req_${id(35)}`,
  createdAt: now,
  deadline: until,
});
const reserve = () => ({
  ...operation(36),
  method: "reserve-job",
  target: target(),
  plan: plan(),
  checkout: checkout(),
  releaseEffectRef: id(37),
  gate: gate(),
  predicate: { kind: "expected-absent", retention: "permanent-inert-reservation" },
});
const predicate = () => ({
  kind: "expected-job",
  jobUid: "job/original",
  resourceVersion: "rv/1",
  namespaceUid: "namespace/selected",
  ownerPreparationRef: id(32),
  ownerIncarnationRef: "incarnation/candidate",
  ownerReserveEffectRef: id(36),
  fenceEpoch: 1,
});
const release = () => ({
  ...operation(37),
  method: "release-job",
  original: reserve(),
  gate: gate(),
  predicate: predicate(),
});
const cleanupBinding = () => ({
  reserveEffectRef: id(36),
  reserveRequestDigest: digest,
  targetPlanRef: "plan/job",
  targetPlanVersion: 1,
  targetPlanDigest: digest,
  responsibility: gate().responsibility,
});
const seal = () => ({
  ...operation(39),
  method: "seal-job",
  original: reserve(),
  gate: gate(),
  cleanupBinding: cleanupBinding(),
  predicate: predicate(),
  closeAdmittedChildCutoff: 1,
});
const pod = () => ({
  namespaceUid: "namespace/selected",
  jobUid: "job/original",
  controllerKind: "Job",
  controllerUid: "job/original",
  podUid: "pod/original",
  resourceVersion: "rv/pod-1",
});
const execution = (containerKind = "main") => ({
  executionRef: "execution/original",
  executionGeneration: 1,
  podUid: "pod/original",
  nodeUid: "node/selected",
  sandboxId: "sandbox/original",
  containerName: "checkout",
  containerKind,
  runtimeHandler: "runsc",
  platform: "systrap",
  isolationPolicy: "STRICT",
  runscExecutableDigest: digest,
  runtimeProfileDigest: digest,
  identityProfileRef: "identity/job",
  identityProfileDigest: digest,
});
const terminate = (kind = "runtime-execution") => ({
  ...operation(40),
  method: "terminate-exact",
  original: reserve(),
  gate: gate(),
  cleanupBinding: cleanupBinding(),
  predicate: predicate(),
  terminationTarget:
    kind === "pod" ? { kind, pod: pod() } : { kind, pod: pod(), execution: execution() },
});
const identity = () => ({
  schemaVersion: 1,
  purpose: "candidate-repository-preparation",
  target: target(),
  reserveEffectRef: id(36),
  reserveRequestDigest: digest,
  releaseEffectRef: id(37),
  authorizationGeneration: 1,
  lifecycleGeneration: 1,
  fenceEpoch: 1,
  pod: pod(),
  execution: execution(),
  controlPlane: evidence("control"),
  runtime: evidence("runtime"),
});
const member = () => ({
  attemptRef: "attempt/release",
  effectRef: id(37),
  requestDigest: digest,
  domainRef: "domain/node-runtime",
  admittedSequence: 1,
});
const snapshot = () => ({
  schemaVersion: 1,
  snapshotRef: "snapshot/admission",
  snapshotVersion: 1,
  original: reserve(),
  gate: gate(),
  closedChildCutoff: 1,
  admissionSealVersion: 1,
  targetPlanDigest: digest,
  admission: "closed",
  members: [member()],
  manifestDigest: digest,
  provenance: evidence("admission"),
});
const read = (method = "discover-job") => ({
  schemaVersion: 1,
  original: reserve(),
  gate: gate(),
  requestId: `req_${id(41)}`,
  createdAt: now,
  deadline: until,
  method,
  ...(method === "read-closure" ? { admission: snapshot() } : {}),
});
const rootJob = () => {
  const { kind, jobUid, ...owner } = predicate();
  return { ...owner, uid: jobUid, suspended: true };
};
const observation = () => ({
  schemaVersion: 1,
  original: reserve(),
  gate: gate(),
  job: rootJob(),
  pods: [pod()],
  executions: [execution()],
  collection: {
    state: "complete",
    snapshotRef: "snapshot/observation",
    sourceResourceVersion: "rv/list-1",
    observedChildCutoff: 1,
  },
  controlPlane: evidence("control"),
  runtime: evidence("runtime"),
});
const attempts = () => [
  {
    ...member(),
    resolutionEvidenceRef: "resolution/excluded",
    outcome: "executions-excluded",
    originalEffectOutcome: "unknown",
  },
  {
    ...member(),
    resolutionEvidenceRef: "resolution/inert",
    outcome: "inert-root",
    rootUid: "job/original",
    rootResourceVersion: "rv/1",
  },
  {
    ...member(),
    resolutionEvidenceRef: "resolution/prevented",
    outcome: "prevented",
    prevention: "sealed-admission",
  },
  {
    ...member(),
    resolutionEvidenceRef: "resolution/terminated",
    outcome: "terminated",
    pod: pod(),
    execution: execution(),
    finalState: "execution-terminated",
  },
];
const closure = () => ({
  schemaVersion: 1,
  original: reserve(),
  gate: gate(),
  cleanupBinding: cleanupBinding(),
  root: rootJob(),
  admission: snapshot(),
  targetPlanDigest: digest,
  closedChildCutoff: 1,
  admissionSealVersion: 1,
  attemptManifestDigest: digest,
  attempts: [attempts()[0]],
  producerDomains: kinds.map((kind) => ({
    domainRef: `domain/${kind}`,
    kind,
    capabilityRef: `capability/${kind}`,
    originalReserveEffectRef: id(36),
    targetPlanDigest: digest,
    closedChildCutoff: 1,
    sealVersion: 1,
    futureStarts: "closed",
    unresolvedAttempts: 0,
    unresolvedWriters: 0,
    provenance: evidence(kind),
  })),
  staging: staging(),
  storeEvidence: {
    staging: staging(),
    closedChildCutoff: 1,
    targetPlanDigest: digest,
    writerState: "no-writers",
    provenance: evidence("store"),
  },
  outcome: "original-writers-excluded",
});
const receipt = () => ({
  schemaVersion: 1,
  request: checkout(),
  receiptRef: "receipt/checkout",
  receiptVersion: 1,
  effectRef: id(37),
  effectRequestDigest: digest,
  incarnationRef: "incarnation/candidate",
  revisionId: `rev_${id(33)}`,
  actualCommit: subject().commit,
  staging: staging(),
  provenance: evidence("checkout"),
  outcome: "checkout-complete",
});
const pair = () => ({
  schemaVersion: 1,
  release: release(),
  identity: identity(),
  receipt: receipt(),
});
const acknowledged = () => ({
  status: "acknowledged",
  original: reserve(),
  providerReceiptRef: "receipt/provider",
  physicalOutcome: "unproven",
  provenance: evidence("provider"),
});
const failed = () => ({
  status: "unknown",
  original: reserve(),
  reason: "provider-outcome-unknown",
  nextAction: "retain-original-and-readback",
});
const examples = () => ({
  target: target(),
  plan: plan(),
  reserve: reserve(),
  release: release(),
  seal: seal(),
  terminate: terminate(),
  mutation: reserve(),
  identity: identity(),
  observation: observation(),
  closure: closure(),
  admissionRead: read("read-admission"),
  admissionSnapshot: snapshot(),
  admissionResult: { status: "admitted", snapshot: snapshot() },
  read: read(),
  readResult: { status: "observed", original: reserve(), observation: observation() },
  mutationResult: acknowledged(),
  closureResult: { status: "closed", closure: closure() },
  receiptPair: pair(),
});
const names = {
  target: "Target",
  plan: "Plan",
  reserve: "Reserve",
  release: "Release",
  seal: "Seal",
  terminate: "Terminate",
  mutation: "Mutation",
  identity: "Identity",
  observation: "Observation",
  closure: "Closure",
  admissionRead: "AdmissionRead",
  admissionSnapshot: "AdmissionSnapshot",
  admissionResult: "AdmissionResult",
  read: "Read",
  readResult: "ReadResult",
  mutationResult: "MutationResult",
  closureResult: "ClosureResult",
  receiptPair: "ReceiptPair",
};
const at = (value, path) => path.reduce((parent, key) => parent[key], value);
function dictionaries(value, path = []) {
  if (value === null || typeof value !== "object") return [];
  return [
    ...(Array.isArray(value) ? [] : [path]),
    ...Object.entries(value).flatMap(([key, child]) => dictionaries(child, [...path, key])),
  ];
}
function reject(schema, data, cases) {
  assert.equal(Check(schema, data), true);
  for (const [label, path, replacement] of cases) {
    const candidate = structuredClone(data);
    at(candidate, path.slice(0, -1))[path.at(-1)] = replacement;
    assert.equal(Check(schema, candidate), false, label);
  }
}
function checkExamples(module) {
  const selected = examples();
  assert.deepEqual(Object.keys(module.PreparationJobSchemasV1).sort(), Object.keys(names).sort());
  for (const [key, suffix] of Object.entries(names)) {
    const schema = module[`PreparationJob${suffix}SchemaV1`];
    assert.equal(module.PreparationJobSchemasV1[key], schema, key);
    assert.equal(Check(schema, selected[key]), true, key);
  }
}

test("all eighteen exported Job schemas accept selected DATA and reject missing or extra nested fields", () => {
  checkExamples(job);
  const alternatives = [
    ...Object.entries(examples()),
    ...[release(), seal(), terminate("pod"), terminate()].map((data) => ["mutation", data]),
    ["terminate", terminate("pod")],
    ...["observe-job", "read-original-effect", "read-closure"].map((method) => [
      "read",
      read(method),
    ]),
    ...attempts()
      .slice(1)
      .map((attempt) => ["closure", { ...closure(), attempts: [attempt] }]),
    ...["admissionResult", "mutationResult", "readResult", "closureResult"].map((name) => [
      name,
      failed(),
    ]),
    [
      "readResult",
      {
        status: "effect-record",
        original: reserve(),
        result: acknowledged(),
        provenance: evidence("readback"),
      },
    ],
    [
      "readResult",
      {
        status: "effect-record",
        original: reserve(),
        result: failed(),
        provenance: evidence("readback"),
      },
    ],
  ];
  for (const [name, value] of alternatives) {
    const schema = job.PreparationJobSchemasV1[name];
    for (const path of dictionaries(value)) {
      const extra = structuredClone(value);
      at(extra, path).unexpected = true;
      assert.equal(Check(schema, extra), false, `${name}: unknown field ${path.join(".")}`);
      for (const field of Object.keys(at(value, path))) {
        const missing = structuredClone(value);
        delete at(missing, path)[field];
        assert.equal(
          Check(schema, missing),
          false,
          `${name}: required ${[...path, field].join(".")}`,
        );
      }
    }
  }
});

test("Job applicability, inert reservation and fixed execution profile stay closed", () => {
  reject(job.PreparationJobTargetSchemaV1, target(), [
    ["wrong kind", ["apiKind"], "Deployment"],
    ["wrong version", ["apiVersion"], "apps/v1"],
    ["wrong purpose", ["purpose"], "original-turn-runtime"],
    ["nested purpose", ["preparation", "purpose"], "original-turn-runtime"],
    ["temporary reservation", ["retention"], "ttl"],
    ["UUID", ["reservationRef"], "reservation/copied"],
    ["invalid name", ["name"], "Upper"],
    ["namespace bound", ["kubernetesNamespace"], "a".repeat(64)],
    ["cluster identity", ["clusterRef"], ""],
    ["namespace UID", ["kubernetesNamespaceUid"], ""],
  ]);
  reject(job.PreparationJobPlanSchemaV1, plan(), [
    ...[
      ["initialSuspend", false],
      ["parallelism", 2],
      ["completions", 2],
      ["completionMode", "Indexed"],
      ["backoffLimit", 1],
      ["restartPolicy", "OnFailure"],
      ["automaticRootDeletion", true],
      ["runtimeHandler", "runc"],
      ["platform", "kvm"],
      ["isolationPolicy", "PERMISSIVE"],
    ].map(([key, value]) => [key, ["profile", key], value]),
    ["fewer domains", ["producerDomains"], plan().producerDomains.slice(1)],
    ["extra domain", ["producerDomains"], [...plan().producerDomains, plan().producerDomains[0]]],
    ["temporary plan", ["reservationRetention"], "temporary"],
    ["execution cutoff", ["profile", "admittedExecutionNotAfter"], "later"],
    ["bad plan digest", ["planDigest"], "sha256:" + "A".repeat(64)],
    ["unknown domain", ["producerDomains", "0", "kind"], "other"],
  ]);
  for (const value of [reserve(), release(), seal(), terminate("pod"), terminate()])
    assert.equal(Check(job.PreparationJobMutationSchemaV1, value), true);
  reject(job.PreparationJobReserveSchemaV1, reserve(), [
    ["wrong reserve method", ["method"], "release-job"],
    ["reserve predicate", ["predicate", "kind"], "expected-job"],
    ["bad effect", ["effectRef"], "effect/copied"],
    ["request digest", ["requestDigest"], "sha256:" + "a".repeat(63)],
    ["deadline", ["deadline"], "later"],
  ]);
  for (const method of ["discover-job", "observe-job", "read-original-effect", "read-closure"])
    assert.equal(Check(job.PreparationJobReadSchemaV1, read(method)), true);
  reject(job.PreparationJobReadSchemaV1, read(), [
    ["unknown method", ["method"], "read-admission"],
  ]);
  const missing = read("read-closure");
  delete missing.admission;
  assert.equal(Check(job.PreparationJobReadSchemaV1, missing), false);
});

test("identity, cutoffs, generations, provenance and finite collection domains remain required", () => {
  for (const kind of ["init", "main"])
    assert.equal(
      Check(job.PreparationJobIdentitySchemaV1, { ...identity(), execution: execution(kind) }),
      true,
    );
  reject(job.PreparationJobIdentitySchemaV1, identity(), [
    ["controller", ["pod", "controllerKind"], "Deployment"],
    ["controller UID", ["pod", "controllerUid"], ""],
    ["Pod UID", ["execution", "podUid"], ""],
    ["node UID", ["execution", "nodeUid"], ""],
    ["execution kind", ["execution", "containerKind"], "sidecar"],
    ["runtime", ["execution", "runtimeHandler"], "runc"],
    ["profile digest", ["execution", "runtimeProfileDigest"], "sha1:" + "a".repeat(40)],
    ["evidence clock", ["runtime", "clock", "sourceObservedAt"], "later"],
    ["uncertainty", ["controlPlane", "clock", "uncertaintyMs"], 2001],
  ]);
  for (const [schema, data, paths] of [
    [
      job.PreparationJobIdentitySchemaV1,
      identity(),
      [
        ["authorizationGeneration"],
        ["lifecycleGeneration"],
        ["fenceEpoch"],
        ["execution", "executionGeneration"],
      ],
    ],
    [
      job.PreparationJobAdmissionSnapshotSchemaV1,
      snapshot(),
      [["snapshotVersion"], ["admissionSealVersion"]],
    ],
    [
      job.PreparationJobSealSchemaV1,
      seal(),
      [
        ["cleanupBinding", "targetPlanVersion"],
        ["predicate", "fenceEpoch"],
        ["gate", "gateVersion"],
        ["gate", "responsibility", "responsibilityVersion"],
      ],
    ],
    [job.PreparationJobPlanSchemaV1, plan(), [["planVersion"]]],
  ]) {
    for (const path of paths) {
      reject(
        schema,
        data,
        [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((value) => [path.join("."), path, value]),
      );
      for (const valid of [1, 2, Number.MAX_SAFE_INTEGER]) {
        const value = structuredClone(data);
        at(value, path.slice(0, -1))[path.at(-1)] = valid;
        assert.equal(
          Check(schema, value),
          true,
          "numeric shape does not prove relational currentness",
        );
      }
    }
  }
  reject(job.PreparationJobObservationSchemaV1, observation(), [
    ["Pod count", ["pods"], Array.from({ length: 65 }, pod)],
    ["execution count", ["executions"], Array.from({ length: 129 }, () => execution())],
    ["unsafe cutoff", ["collection", "observedChildCutoff"], Number.MAX_SAFE_INTEGER + 1],
    ["negative cutoff", ["collection", "observedChildCutoff"], -1],
    ["collection state", ["collection", "state"], "truncated"],
  ]);
  assert.equal(
    Check(job.PreparationJobObservationSchemaV1, {
      ...observation(),
      pods: Array.from({ length: 64 }, pod),
      executions: Array.from({ length: 128 }, () => execution()),
      collection: { ...observation().collection, state: "incomplete" },
    }),
    true,
  );
  reject(job.PreparationJobAdmissionSnapshotSchemaV1, snapshot(), [
    ["empty membership", ["members"], []],
    ["member count", ["members"], Array.from({ length: 129 }, member)],
    ["open admission", ["admission"], "open"],
    ["fractional sequence", ["members", "0", "admittedSequence"], 1.5],
  ]);
});

test("closure preserves each resolved attempt and requires complete structural exclusion fields", () => {
  for (const attempt of attempts())
    assert.equal(
      Check(job.PreparationJobClosureSchemaV1, { ...closure(), attempts: [attempt] }),
      true,
    );
  for (const prevention of ["sealed-admission", "before-provider-acceptance"])
    assert.equal(
      Check(job.PreparationJobClosureSchemaV1, {
        ...closure(),
        attempts: [{ ...attempts()[2], prevention }],
      }),
      true,
    );
  for (const originalEffectOutcome of ["applied", "unknown"])
    assert.equal(
      Check(job.PreparationJobClosureSchemaV1, {
        ...closure(),
        attempts: [{ ...attempts()[0], originalEffectOutcome }],
      }),
      true,
    );
  reject(job.PreparationJobClosureSchemaV1, closure(), [
    ["unsealed root", ["root", "suspended"], false],
    ["empty attempts", ["attempts"], []],
    ["too many attempts", ["attempts"], Array.from({ length: 129 }, () => attempts()[0])],
    ["omitted domain structure", ["producerDomains"], closure().producerDomains.slice(1)],
    [
      "too many domains",
      ["producerDomains"],
      [...closure().producerDomains, closure().producerDomains[0]],
    ],
    ["future starts", ["producerDomains", "0", "futureStarts"], "open"],
    ["unresolved attempt", ["producerDomains", "0", "unresolvedAttempts"], 1],
    ["unresolved writer", ["producerDomains", "1", "unresolvedWriters"], 1],
    ["store writer", ["storeEvidence", "writerState"], "writers"],
    ["wrong closure outcome", ["outcome"], "ready"],
    ["unknown attempt", ["attempts", "0", "outcome"], "cancelled"],
    ["closure cutoff", ["closedChildCutoff"], -1],
  ]);
  assert.equal(
    Check(job.PreparationJobClosureSchemaV1, {
      ...closure(),
      attempts: Array.from({ length: 128 }, () => attempts()[0]),
    }),
    true,
    "shape cardinality supplies no authenticated membership proof",
  );
  const missingReceipt = pair();
  delete missingReceipt.receipt;
  assert.equal(Check(job.PreparationJobReceiptPairSchemaV1, missingReceipt), false);
  reject(job.PreparationJobReceiptPairSchemaV1, pair(), [
    ["receipt cannot mean ready", ["receipt", "outcome"], "ready"],
    ["full commit", ["receipt", "actualCommit", "oid"], "c".repeat(39)],
  ]);
});

test("all closed failure arms retain original effect and prohibit replay or positive payload", () => {
  const reasons = [
    "authority-unavailable",
    "authority-lost",
    "capability-unavailable",
    "not-visible",
    "provider-outcome-unknown",
    "identity-mismatch",
    "precondition-failed",
    "gate-changed",
    "evidence-incomplete",
    "evidence-stale",
    "writer-unresolved",
    "cancelled",
    "deadline-exceeded",
  ];
  for (const name of ["admissionResult", "mutationResult", "readResult", "closureResult"]) {
    const schema = job.PreparationJobSchemasV1[name];
    for (const status of [
      "unsupported",
      "incomplete",
      "ambiguous",
      "unknown",
      "conflict",
      "denied",
    ])
      for (const reason of reasons)
        for (const nextAction of ["retain-original-and-readback", "retain-original-and-fence"]) {
          const value = { ...failed(), status, reason, nextAction };
          assert.equal(Check(schema, value), true, `${name}/${status}/${reason}/${nextAction}`);
          assert.equal(Check(schema, { ...value, nextAction: "retry" }), false);
          for (const key of ["snapshot", "providerReceiptRef", "observation", "closure", "receipt"])
            assert.equal(
              Check(schema, { ...value, [key]: examples()[name] }),
              false,
              `${status} excludes ${key}`,
            );
        }
    assert.equal(Check(schema, { ...failed(), status: "success" }), false);
    assert.equal(Check(schema, { ...failed(), reason: "invented" }), false);
  }
  reject(job.PreparationJobMutationResultSchemaV1, acknowledged(), [
    ["ACK cannot prove stop", ["physicalOutcome"], "stopped"],
  ]);
  assert.equal(
    Check(job.PreparationJobReadResultSchemaV1, {
      status: "effect-record",
      original: reserve(),
      result: acknowledged(),
      provenance: evidence("readback"),
    }),
    true,
  );
  assert.equal(
    Check(job.PreparationJobReadResultSchemaV1, {
      status: "effect-record",
      original: reserve(),
      result: failed(),
      provenance: evidence("readback"),
    }),
    true,
  );
});

test("published finite ceilings and CI enrollment preserve the selected boundary", () => {
  assert.deepEqual(job.PREPARATION_JOB_LIMITS_V1, {
    maxJsonBytes: 262144,
    maxDepth: 32,
    maxChildren: 64,
    maxExecutions: 128,
    maxProducerDomains: 16,
    callMaxMs: 10000,
    readMaxMs: 3000,
    observationMaxAgeMs: 15000,
    uncertaintyMaxMs: 2000,
  });
  assert.equal(Object.isFrozen(job.PREPARATION_JOB_LIMITS_V1), true);
  assert.equal(Object.isFrozen(job.PreparationJobSchemasV1), true);
  const catalog = JSON.parse(readFileSync(join(root, "scripts/ci/test-suites.json"), "utf8"));
  const selected = Object.entries(catalog.lanes).flatMap(([lane, config]) =>
    config.files
      .filter((file) => file.path === "tests/conformance/preparation-job-package-contract.test.mjs")
      .map(() => lane),
  );
  assert.deepEqual(selected, ["checks-baseline"]);
});

const packageName = "@openclaw-enterprise/contracts/preparation-job-v1";
const schemaImports = Object.values(names)
  .map((suffix) => `PreparationJob${suffix}SchemaV1, type PreparationJob${suffix}V1`)
  .join(",\n");
const compilerImports = `
import { ${schemaImports}, PreparationJobSchemasV1, PREPARATION_JOB_LIMITS_V1,
  type PreparationJobAdmissionPortV1, type PreparationJobEffectsV1,
  type PreparationJobReceiptConsumerV1, type PreparationJobSchemaNameV1, type PreparationJobValueV1
} from "${packageName}";
import type { AuthorityCallV1, PreparationCheckoutRequestV1, PreparationCheckoutReceiptV1,
  PreparationReceiptResultV1, PreparationReceiptDiagnosticV1, ProtectedPreparationReceiptHandleV1,
  RepositoryPreparationReceiptPortV1
} from "@openclaw-enterprise/contracts/repository-preparation-v1";
import type { AuthorityCallV1 as OriginalCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { CurrentCredentialAuthorityHandleV1 } from "@openclaw-enterprise/contracts/credential-authority-v1";
`;
const declaredInputs = `
declare const call: OriginalCallV1;
declare const effects: PreparationJobEffectsV1;
declare const admission: PreparationJobAdmissionPortV1;
declare const receiptConsumer: PreparationJobReceiptConsumerV1;
declare const target: PreparationJobTargetV1;
declare const reserve: PreparationJobReserveV1;
declare const release: PreparationJobReleaseV1;
declare const seal: PreparationJobSealV1;
declare const terminate: PreparationJobTerminateV1;
declare const admissionRead: PreparationJobAdmissionReadV1;
declare const snapshot: PreparationJobAdmissionSnapshotV1;
declare const read: PreparationJobReadV1;
declare const receipt: PreparationCheckoutReceiptV1;
declare const checkout: PreparationCheckoutRequestV1;
declare const authorityHandle: CurrentCredentialAuthorityHandleV1;
declare const completeReceipt: Extract<PreparationReceiptResultV1, { status: "complete" }>;
`;
const expectedSignatures = [
  [
    "PreparationJobAdmissionPortV1",
    "readAdmission",
    "input: PreparationJobAdmissionReadV1, call: OriginalCallV1",
    "PreparationJobAdmissionResultV1",
  ],
  [
    "PreparationJobAdmissionPortV1",
    "assertCurrentAdmission",
    "input: PreparationJobAdmissionReadV1, originalSnapshot: PreparationJobAdmissionSnapshotV1, call: OriginalCallV1",
    "PreparationJobAdmissionResultV1",
  ],
  ...["reserve", "release", "seal", "terminate"].map((method) => [
    "PreparationJobEffectsV1",
    method,
    `input: PreparationJob${method[0].toUpperCase() + method.slice(1)}V1, call: OriginalCallV1`,
    "PreparationJobMutationResultV1",
  ]),
  ...[
    ["discover", "discover-job"],
    ["observe", "observe-job"],
    ["readback", "read-original-effect"],
    ["readClosure", "read-closure"],
  ].map(([method, literal]) => [
    "PreparationJobEffectsV1",
    method,
    `input: PreparationJobReadV1 & { readonly method: "${literal}" }, call: OriginalCallV1`,
    method === "readClosure" ? "PreparationJobClosureResultV1" : "PreparationJobReadResultV1",
  ]),
];
const typeAssertions = `
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type OriginalCallIdentity = Assert<Equal<AuthorityCallV1, OriginalCallV1>>;
type OriginalReceiptPort = Assert<Equal<PreparationJobReceiptConsumerV1["receipts"], RepositoryPreparationReceiptPortV1>>;
type OriginalEffectsPort = Assert<Equal<PreparationJobReceiptConsumerV1["effects"], PreparationJobEffectsV1>>;
${expectedSignatures.map(([port, method, parameters, result], index) => `type Signature${index} = Assert<Equal<${port}["${method}"], (${parameters}) => Promise<${result}>>>;`).join("\n")}
${Object.entries(names)
  .map(
    ([key, suffix], index) =>
      `type SelectedData${index} = Assert<Equal<PreparationJobValueV1<"${key}">, PreparationJob${suffix}V1>>;`,
  )
  .join("\n")}
`;
const compilerConsumer =
  compilerImports +
  declaredInputs +
  typeAssertions +
  `
const originalCall: AuthorityCallV1 = call;
async function consume(): Promise<void> {
  const admitted: PreparationJobAdmissionResultV1 = await admission.readAdmission(admissionRead, call);
  const current: PreparationJobAdmissionResultV1 = await admission.assertCurrentAdmission(admissionRead, snapshot, call);
  const reserved: PreparationJobMutationResultV1 = await effects.reserve(reserve, call);
  const released: PreparationJobMutationResultV1 = await effects.release(release, call);
  const sealed: PreparationJobMutationResultV1 = await effects.seal(seal, call);
  const terminated: PreparationJobMutationResultV1 = await effects.terminate(terminate, call);
  const discovered: PreparationJobReadResultV1 = await effects.discover({ ...read, method: "discover-job" }, call);
  const observed: PreparationJobReadResultV1 = await effects.observe({ ...read, method: "observe-job" }, call);
  const recorded: PreparationJobReadResultV1 = await effects.readback({ ...read, method: "read-original-effect" }, call);
  const closed: PreparationJobClosureResultV1 = await effects.readClosure({ ...read, method: "read-closure", admission: snapshot }, call);
  const result: PreparationReceiptResultV1 = await receiptConsumer.receipts.readReceiptV1(checkout, call);
  if (result.status === "complete") {
    const originalHandle: ProtectedPreparationReceiptHandleV1 = result.handle;
    const asserted: PreparationReceiptDiagnosticV1 = await receiptConsumer.receipts.assertCurrentReceiptV1(checkout, result, call);
    void [originalHandle, asserted];
  }
  void [admitted, current, reserved, released, sealed, terminated, discovered, observed, recorded, closed];
}
function inspect(value: PreparationJobAdmissionResultV1 | PreparationJobMutationResultV1 | PreparationJobReadResultV1 | PreparationJobClosureResultV1): void {
  switch (value.status) {
    case "admitted": { const snapshot: PreparationJobAdmissionSnapshotV1 = value.snapshot; void snapshot; break; }
    case "acknowledged": { const unproven: "unproven" = value.physicalOutcome; void [unproven, value.original, value.provenance]; break; }
    case "observed": { const observation: PreparationJobObservationV1 = value.observation; void observation; break; }
    case "effect-record": { const original: PreparationJobMutationResultV1 = value.result; void [original, value.provenance]; break; }
    case "closed": { const closure: PreparationJobClosureV1 = value.closure; void closure; break; }
    case "unsupported": case "incomplete": case "ambiguous": case "unknown": case "conflict": case "denied": {
      const action: "retain-original-and-readback" | "retain-original-and-fence" = value.nextAction;
      const original: PreparationJobMutationV1 = value.original; void [original, action, value.reason]; break;
    }
    default: { const exhaustive: never = value; void exhaustive; }
  }
}
void [originalCall, consume, inspect, PreparationJobSchemasV1, PREPARATION_JOB_LIMITS_V1];
`;
function producerInput() {
  return (
    compilerImports +
    typeAssertions +
    Object.entries(examples())
      .map(
        ([key, data]) =>
          `export const ${key}: PreparationJob${names[key]}V1 = ${JSON.stringify(data)};`,
      )
      .join("\n")
  );
}
const negatives = [
  ["method-specific-read", "effects.discover(read, call);", 2345, /method|discover-job/],
  [
    "wrong-target",
    'const wrong: PreparationJobTargetV1 = { ...target, apiKind: "Deployment" };',
    2322,
    /"Deployment".*"Job"/,
  ],
  [
    "wrong-purpose",
    'const wrong: PreparationJobTargetV1 = { ...target, purpose: "original-turn-runtime" };',
    2322,
    /"original-turn-runtime".*"candidate-repository-preparation"/,
  ],
  [
    "reserve-release",
    "effects.reserve({ ...reserve, method: release.method }, call);",
    2322,
    /release-job.*reserve-job/,
  ],
  [
    "release-reserve",
    "effects.release({ ...release, method: reserve.method }, call);",
    2322,
    /reserve-job.*release-job/,
  ],
  [
    "seal-release",
    "effects.seal({ ...seal, method: release.method }, call);",
    2322,
    /release-job.*seal-job/,
  ],
  [
    "terminate-seal",
    "effects.terminate({ ...terminate, method: seal.method }, call);",
    2322,
    /seal-job.*terminate-exact/,
  ],
  [
    "discover-observe",
    'effects.discover({ ...read, method: "observe-job" }, call);',
    2322,
    /"observe-job".*"discover-job"/,
  ],
  [
    "observe-discover",
    'effects.observe({ ...read, method: "discover-job" }, call);',
    2322,
    /"discover-job".*"observe-job"/,
  ],
  [
    "readback-closure",
    'effects.readback({ ...read, method: "read-closure" }, call);',
    2322,
    /"read-closure".*"read-original-effect"/,
  ],
  [
    "closure-snapshot",
    'declare const missingAdmission: Omit<Extract<PreparationJobReadV1, { method: "read-closure" }>, "admission">; effects.readClosure(missingAdmission, call);',
    2741,
    /admission/,
  ],
  [
    "admission-read",
    "admission.readAdmission({ ...admissionRead, method: reserve.method }, call);",
    2322,
    /reserve-job.*read-admission/,
  ],
  [
    "admission-assert",
    "declare const closureResult: PreparationJobClosureResultV1; admission.assertCurrentAdmission(admissionRead, closureResult, call);",
    2345,
    /snapshotRef|snapshotVersion/,
  ],
  [
    "mutation-result",
    "const wrong: Promise<PreparationJobClosureResultV1> = effects.reserve(reserve, call);",
    2322,
    /acknowledged|closed|closure/,
  ],
  [
    "read-result",
    'const wrong: Promise<PreparationJobMutationResultV1> = effects.observe({ ...read, method: "observe-job" }, call);',
    2322,
    /observed|acknowledged/,
  ],
  [
    "closure-result",
    'const wrong: Promise<PreparationJobReadResultV1> = effects.readClosure({ ...read, method: "read-closure", admission: snapshot }, call);',
    2322,
    /closed|observed/,
  ],
  [
    "admission-result",
    "const wrong: Promise<PreparationJobMutationResultV1> = admission.readAdmission(admissionRead, call);",
    2322,
    /admitted|acknowledged/,
  ],
  [
    "ack-stop",
    'declare const ack: Extract<PreparationJobMutationResultV1, { status: "acknowledged" }>; const wrong: "stopped" = ack.physicalOutcome;',
    2322,
    /"unproven".*"stopped"/,
  ],
  [
    "failure-positive",
    'function invalid(value: PreparationJobClosureResultV1) { if (value.status === "unknown") value.closure; }',
    2339,
    /closure/,
  ],
  [
    "replay-action",
    'function invalid(value: PreparationJobMutationResultV1) { if (value.status === "unknown") { const wrong: "retry" = value.nextAction; } }',
    2322,
    /retain-original/,
  ],
  [
    "receipt-data",
    'const wrong: PreparationReceiptResultV1 = { status: "complete", receipt };',
    2322,
    /handle/,
  ],
  [
    "receipt-handle",
    "const wrong: ProtectedPreparationReceiptHandleV1 = {};",
    2741,
    /receiptHandleBrand/,
  ],
  [
    "foreign-handle",
    "const wrong: ProtectedPreparationReceiptHandleV1 = authorityHandle;",
    2741,
    /receiptHandleBrand/,
  ],
  [
    "receipt-assert",
    'receiptConsumer.receipts.assertCurrentReceiptV1(checkout, { status: "complete", receipt }, call);',
    2345,
    /handle/,
  ],
  [
    "forged-complete",
    'const wrong: PreparationReceiptResultV1 = { status: "complete", receipt, handle: {} };',
    2741,
    /receiptHandleBrand/,
  ],
  ["receipt-original", "completeReceipt.handle = authorityHandle;", 2540, /handle.*read-only/],
  [
    "readonly-lineage",
    'reserve.target.preparation.incarnationRef = "replacement";',
    2540,
    /incarnationRef.*read-only/,
  ],
  [
    "readonly-clock",
    'snapshot.provenance.clock.sourceObservedAt = "replacement";',
    2540,
    /sourceObservedAt.*read-only/,
  ],
  [
    "readonly-port",
    "receiptConsumer.receipts = receiptConsumer.receipts;",
    2540,
    /receipts.*read-only/,
  ],
];
function sanitizedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("GIT_") && !["ENV", "BASH_ENV", "NODE_OPTIONS", "NODE_PATH"].includes(key),
    ),
  );
}
function compile(directory, files, options = {}) {
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM"],
        types: ["node"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: false,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        noEmit: true,
        rewriteRelativeImportExtensions: true,
        noEmitOnError: true,
        ...options,
      },
      files,
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--project",
      join(directory, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    {
      cwd: root,
      env: sanitizedEnvironment(),
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(Number.isInteger(result.status), true);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(
    output,
    /TS(?:2307|2688|2792|7016)\b|Cannot find module|Cannot find type definition/,
  );
  return { exitCode: result.status, output };
}
function compilePositive(directory, source, options = {}) {
  writeFileSync(join(directory, "input.ts"), source);
  const result = compile(directory, ["input.ts"], options);
  assert.equal(result.exitCode, 0, result.output);
  return result;
}
function compileNegatives(directory) {
  const prefix = compilerImports + declaredInputs;
  for (const [name, source] of negatives)
    writeFileSync(join(directory, `${name}.ts`), prefix + "\n" + source + "\n");
  const result = compile(
    directory,
    negatives.map(([name]) => `${name}.ts`),
  );
  assert.equal(result.exitCode, 1, result.output);
  const diagnosticLines = result.output.split("\n").filter((line) => /error TS\d+:/.test(line));
  assert.equal(diagnosticLines.length, negatives.length, result.output);
  for (const [name, source, code, diagnostic] of negatives) {
    const lines = diagnosticLines.filter((line) => line.includes(`${name}.ts(`));
    assert.equal(lines.length, 1, `${name}: ${result.output}`);
    const expectedLine = (prefix + "\n").split("\n").length + source.split("\n").length - 1;
    assert.ok(
      lines[0].includes(`${name}.ts(${expectedLine},`),
      `${name}: intended input line: ${lines[0]}`,
    );
    assert.match(lines[0], new RegExp(`error TS${code}:`), `${name}: ${result.output}`);
    const start = result.output.indexOf(lines[0]);
    const end = result.output.indexOf("\n" + relative(root, directory), start + lines[0].length);
    const detail = result.output.slice(start, end < 0 ? undefined : end);
    assert.match(detail, diagnostic, name);
  }
}

// These temporary projects exercise exports used by real workspace owners. Their
// declared ports supply type proof only; no fake admission/receipt producer runs.
test("strict real-package producers and OCC/Controller consumers preserve all signatures and original receipt identity", async () => {
  for (const name of [
    "preparation-job-v1",
    "repository-preparation-v1",
    "runtime-authority-v1",
    "runtime-effects-v1",
    "completed-state-v1",
    "credential-authority-v1",
  ]) {
    const specifier = `@openclaw-enterprise/contracts/${name}`;
    const expected = realpathSync(join(root, "packages/contracts/src", `${name}.ts`));
    for (const owner of [contracts, occ, controller])
      assert.equal(realpathSync(owner.resolve(specifier)), expected);
  }
  const producer = mkdtempSync(join(root, "packages/contracts/.preparation-job-producer-"));
  const consumer = mkdtempSync(join(root, "packages/occ/.preparation-job-consumer-"));
  const controllerConsumer = mkdtempSync(join(root, "apps/controller/.preparation-job-consumer-"));
  try {
    compilePositive(producer, producerInput(), {
      noEmit: false,
      declaration: true,
      rootDir: root,
      outDir: join(producer, "output"),
    });
    compilePositive(consumer, compilerConsumer);
    compilePositive(controllerConsumer, compilerConsumer);
    compileNegatives(consumer);
    const emittedRoot = join(producer, "output");
    const emittedContracts = join(emittedRoot, "packages/contracts");
    for (const name of [
      "preparation-job-v1",
      "repository-preparation-v1",
      "runtime-authority-v1",
      "runtime-effects-v1",
      "completed-state-v1",
      "credential-authority-v1",
    ]) {
      assert.ok(readFileSync(join(emittedContracts, "src", `${name}.d.ts`), "utf8").length > 0);
      assert.ok(readFileSync(join(emittedContracts, "src", `${name}.js`), "utf8").length > 0);
    }
    // Project the real export map onto its compiler outputs. No source alias or
    // fixture declaration replaces the emitted owner modules or protected brand.
    const actualManifest = JSON.parse(
      readFileSync(join(root, "packages/contracts/package.json"), "utf8"),
    );
    const emittedManifest = {
      ...actualManifest,
      types: actualManifest.types.replace(/\.ts$/, ".d.ts"),
      exports: Object.fromEntries(
        Object.entries(actualManifest.exports).map(([key, value]) => [
          key,
          { types: value.replace(/\.ts$/, ".d.ts"), default: value.replace(/\.ts$/, ".js") },
        ]),
      ),
    };
    writeFileSync(join(emittedContracts, "package.json"), JSON.stringify(emittedManifest));
    const modules = join(emittedRoot, "node_modules");
    mkdirSync(join(modules, "@openclaw-enterprise"), { recursive: true });
    symlinkSync(emittedContracts, join(modules, "@openclaw-enterprise/contracts"), "dir");
    symlinkSync(
      realpathSync(join(root, "packages/contracts/node_modules/typebox")),
      join(modules, "typebox"),
      "dir",
    );
    symlinkSync(realpathSync(join(root, "node_modules/@types")), join(modules, "@types"), "dir");
    const emittedConsumer = join(emittedRoot, "packages/occ/emitted-consumer");
    mkdirSync(emittedConsumer, { recursive: true });
    writeFileSync(
      join(emittedRoot, "packages/occ/package.json"),
      JSON.stringify({ name: "@openclaw-enterprise/occ", type: "module" }),
    );
    const emittedRequire = createRequire(join(emittedConsumer, "package.json"));
    assert.equal(
      realpathSync(emittedRequire.resolve(packageName)),
      realpathSync(join(emittedContracts, "src/preparation-job-v1.js")),
    );
    const emitted = await import(pathToFileURL(emittedRequire.resolve(packageName)).href);
    checkExamples(emitted);
    assert.equal(
      Check(emitted.PreparationJobTargetSchemaV1, { ...target(), apiKind: "Deployment" }),
      false,
    );
    const listed = compilePositive(emittedConsumer, compilerConsumer, {
      rewriteRelativeImportExtensions: false,
      listFiles: true,
    });
    assert.ok(
      listed.output.includes(join(emittedContracts, "src/preparation-job-v1.d.ts")),
      listed.output,
    );
    assert.ok(
      listed.output.includes(join(emittedContracts, "src/repository-preparation-v1.d.ts")),
      listed.output,
    );
    assert.ok(
      listed.output.includes(join(emittedContracts, "src/runtime-authority-v1.d.ts")),
      listed.output,
    );
    assert.doesNotMatch(
      listed.output,
      new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}packages/contracts/src/.*\\.ts`),
    );
    compileNegatives(emittedConsumer);
  } finally {
    rmSync(producer, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
    rmSync(controllerConsumer, { recursive: true, force: true });
  }
});
