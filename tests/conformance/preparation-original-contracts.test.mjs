import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digest, id, now, scope, until } from "../fixtures/runtime-authority-v1/vectors.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const contracts = createRequire(new URL("../../packages/contracts/package.json", import.meta.url));
const occ = createRequire(new URL("../../packages/occ/package.json", import.meta.url));
const { Check } = await import(contracts.resolve("typebox/value"));
const authority = await import(
  contracts.resolve("@openclaw-enterprise/contracts/credential-authority-v1")
);
const preparation = await import(
  contracts.resolve("@openclaw-enterprise/contracts/repository-preparation-v1")
);
// Account and storage operands stay internal to the contract owner.
const { AccountVersionVectorSchemaV1 } =
  await import("../../packages/contracts/src/account-authority-v1.ts");
const { CredentialSecretBindingSchemaV1, CredentialRepositoryGrantSchemaV1 } =
  await import("../../packages/contracts/src/credential-storage-v1.ts");

const versioned = (ref) => ({ ref, version: 1, digest });
const accountVersions = () => ({
  installation: 1,
  account: 2,
  credential: 3,
  grants: 4,
  iamPolicy: 5,
  semanticMapping: 6,
  driverSelection: 7,
});
const repositoryProfile = () => ({
  schemaVersion: 1,
  scope: { ...scope },
  profile: versioned("profile/repository"),
  providerId: "github",
  account: versioned("account/github"),
  transport: versioned("transport/github"),
  kind: "repository",
  mode: "native",
  providerInstallationRef: "installation/github",
  permissionProfile: versioned("permission/read"),
  credentialClass: "installation-token",
});
const modelProfile = () => ({
  schemaVersion: 1,
  scope: { ...scope },
  profile: versioned("profile/model"),
  providerId: "model-provider",
  account: versioned("account/model"),
  transport: versioned("transport/model"),
  kind: "model",
  mode: "mediated",
  modelProfile: versioned("model/selected"),
  credentialClass: "api-key",
});
const secretBinding = () => ({
  schemaVersion: 1,
  scope: { ...scope },
  bindingRef: "binding/credential",
  bindingVersion: 1,
  secretId: `sec_${id(17)}`,
  secretVersion: 1,
  providerId: "github",
  account: versioned("account/github"),
  driverId: "driver/secret",
  backendBindingRef: "backend/secret",
});
const repositoryGrant = () => ({
  providerInstallationRef: "installation/github",
  repositoryIds: ["123"],
  permissions: [{ name: "contents", access: "read" }],
  permissionProfile: versioned("permission/read"),
});
const originalBinding = () => ({
  schemaVersion: 1,
  scope: { ...scope },
  assignmentRef: { schemaVersion: 1, id: id(4) },
  revisionId: `rev_${id(5)}`,
  lifecycleGeneration: 1,
  runtimeGeneration: 1,
  turnRef: "turn/original",
  attemptRef: "attempt/original",
  reservationRef: "reservation/original",
  intentDigest: digest,
  conversationRef: "conversation/original",
  workspaceRef: "workspace/original",
  originalPrincipalRef: "principal/original",
  externalIdentity: versioned("identity/original"),
  receiptRef: "receipt/original",
  logicalMessageRef: "message/original",
  messageContentDigest: digest,
  commonGrant: versioned("grant/original"),
  route: versioned("route/original"),
  audience: versioned("audience/original"),
  policy: versioned("policy/original"),
  canonicalBindingDigest: digest,
  committedDispatchAt: now,
  turnNotAfter: until,
});
const originalObservation = () => ({
  schemaVersion: 1,
  original: originalBinding(),
  profile: repositoryProfile(),
  secretId: `sec_${id(17)}`,
  secretVersion: 1,
  leaseRef: "lease/original",
  leaseVersion: 1,
  leaseNotAfter: until,
  accountVersions: accountVersions(),
  decisionRef: "decision/original",
  authorityVersion: 1,
  invalidationVersion: 1,
  dispatchFenceRef: "fence/original",
  comparedAt: now,
  startNotAfter: until,
  requestId: `req_${id(18)}`,
  effect: "deliver-token",
});
const staging = () => ({
  schemaVersion: 1,
  scope: { ...scope },
  logicalStoreRef: "store/staging",
  bindingRef: "binding/staging",
  bindingVersion: 1,
});
const subject = () => ({
  schemaVersion: 1,
  purpose: "candidate-repository-preparation",
  scope: { ...scope },
  preparationRef: id(19),
  incarnationRef: "incarnation/job-1",
  revisionId: `rev_${id(5)}`,
  revisionDigest: digest,
  gate: {
    schemaVersion: 1,
    scope: { ...scope },
    intentRef: id(20),
    mode: "running",
    lifecycleGeneration: 1,
    requestedFenceEpoch: 1,
    responsibility: { responsibilityRef: id(21), responsibilityVersion: 1, kind: "preparation" },
    gateVersion: 1,
    planRef: "plan/preparation",
    planVersion: 1,
    planDigest: digest,
    admittedChildCutoff: 0,
  },
  authorizationGeneration: 1,
  admission: {
    operationRef: "operation/admission",
    requestDigest: digest,
    actorRef: "actor/original",
    requestId: `req_${id(18)}`,
  },
  grant: versioned("grant/preparation"),
  profile: repositoryProfile(),
  repositoryId: "123",
  commit: { algorithm: "sha1", oid: "b".repeat(40) },
  originProfile: versioned("origin/repository"),
  staging: staging(),
  createdAt: now,
  notAfter: until,
});
const preparationObservation = () => ({
  schemaVersion: 1,
  preparation: subject(),
  binding: secretBinding(),
  accountVersions: accountVersions(),
  leaseRef: "lease/preparation",
  leaseVersion: 1,
  leaseNotAfter: until,
  authorityVersion: 1,
  invalidationVersion: 1,
  decisionRef: "decision/preparation",
  comparedAt: now,
  startNotAfter: until,
  requestId: `req_${id(18)}`,
  effect: "deliver-token",
});
const request = () => ({
  schemaVersion: 1,
  preparation: subject(),
  operationRef: "operation/checkout",
  requestId: `req_${id(22)}`,
  effectRef: id(23),
  requestDigest: digest,
  createdAt: now,
  deadline: until,
});
const receipt = () => ({
  schemaVersion: 1,
  request: request(),
  receiptRef: "receipt/checkout",
  receiptVersion: 1,
  effectRef: id(23),
  effectRequestDigest: digest,
  incarnationRef: "incarnation/job-1",
  revisionId: `rev_${id(5)}`,
  actualCommit: { algorithm: "sha1", oid: "b".repeat(40) },
  staging: staging(),
  provenance: {
    producerRef: "producer/compute",
    producerServiceVersion: 1,
    producerProfileRef: "profile/compute",
    producerProfileDigest: digest,
    acceptedPortRef: "port/checkout",
    evidenceRef: "evidence/checkout",
    evidenceVersion: 1,
    clock: { sourceObservedAt: now, receivedAt: now, validUntil: until, uncertaintyMs: 0 },
  },
  outcome: "checkout-complete",
});

const selectedSchemas = () => [
  [AccountVersionVectorSchemaV1, accountVersions()],
  [authority.CredentialProfileSchemaV1, modelProfile()],
  [authority.CredentialProfileSchemaV1, repositoryProfile()],
  [authority.OriginalCredentialBindingSchemaV1, originalBinding()],
  [authority.CredentialAuthorityObservationSchemaV1, originalObservation()],
  [CredentialSecretBindingSchemaV1, secretBinding()],
  [CredentialRepositoryGrantSchemaV1, repositoryGrant()],
  [preparation.PreparationCommitSchemaV1, subject().commit],
  [preparation.PreparationRepositoryProfileSchemaV1, repositoryProfile()],
  [preparation.RepositoryPreparationSubjectSchemaV1, subject()],
  [preparation.PreparationCredentialAuthorityObservationSchemaV1, preparationObservation()],
  [
    preparation.RepositoryCredentialAuthorityObservationSchemaV1,
    { purpose: "original-turn-runtime", observation: originalObservation() },
  ],
  [
    preparation.RepositoryCredentialAuthorityObservationSchemaV1,
    { purpose: "candidate-repository-preparation", observation: preparationObservation() },
  ],
  [preparation.PreparationCheckoutRequestSchemaV1, request()],
  [preparation.PreparationCheckoutReceiptSchemaV1, receipt()],
  [preparation.PreparationReceiptDiagnosticSchemaV1, { status: "complete", receipt: receipt() }],
];

// Enumerate the realistic example's dictionaries, including array item dictionaries.
// Unknown-field rejection must survive every nested owner projection.
function dictionaries(value, path = []) {
  if (value === null || typeof value !== "object") return [];
  return [
    ...(Array.isArray(value) ? [] : [path]),
    ...Object.entries(value).flatMap(([key, child]) => dictionaries(child, [...path, key])),
  ];
}
function at(value, path) {
  return path.reduce((parent, key) => parent[key], value);
}
function rejects(schema, original, cases) {
  assert.equal(Check(schema, original), true, "complete selected DATA example");
  for (const [name, path, replacement] of cases) {
    const input = structuredClone(original);
    at(input, path.slice(0, -1))[path.at(-1)] = replacement;
    assert.equal(Check(schema, input), false, name);
  }
}

test("selected original preparation dictionaries require every field and stay closed", () => {
  for (const [schema, original] of selectedSchemas()) {
    assert.equal(Check(schema, original), true);
    for (const path of dictionaries(original)) {
      const extra = structuredClone(original);
      at(extra, path).unexpected = true;
      assert.equal(Check(schema, extra), false, `unknown field at ${path.join(".") || "root"}`);
      for (const key of Object.keys(at(original, path))) {
        const missing = structuredClone(original);
        delete at(missing, path)[key];
        assert.equal(Check(schema, missing), false, `required ${[...path, key].join(".")}`);
      }
    }
  }
});

test("original profiles and complete authority observations preserve every alternative and epoch", () => {
  for (const credentialClass of ["workload-federation", "trusted-login", "api-key"])
    assert.equal(
      Check(authority.CredentialProfileSchemaV1, { ...modelProfile(), credentialClass }),
      true,
    );
  for (const mode of ["native", "mediated", "history-isolated"])
    assert.equal(
      Check(authority.CredentialProfileSchemaV1, { ...repositoryProfile(), mode }),
      true,
    );
  for (const effect of ["model-use", "reserve-issuance", "mint-token", "deliver-token"])
    assert.equal(
      Check(authority.CredentialAuthorityObservationSchemaV1, { ...originalObservation(), effect }),
      true,
    );
  for (const effect of ["reserve-issuance", "mint-token", "deliver-token"])
    assert.equal(
      Check(preparation.PreparationCredentialAuthorityObservationSchemaV1, {
        ...preparationObservation(),
        effect,
      }),
      true,
    );
  rejects(preparation.PreparationCredentialAuthorityObservationSchemaV1, preparationObservation(), [
    ["preparation cannot use a model", ["effect"], "model-use"],
    ["original lease version", ["leaseVersion"], 0],
    ["authority epoch", ["authorityVersion"], 1.5],
    ["invalidation epoch", ["invalidationVersion"], Number.MAX_SAFE_INTEGER + 1],
    ["original cutoff", ["leaseNotAfter"], "2026-01-01T00:00:10Z"],
    ["start cutoff", ["startNotAfter"], "later"],
    ...Object.keys(accountVersions()).map((key) => [
      `account epoch ${key}`,
      ["accountVersions", key],
      0,
    ]),
  ]);
  rejects(authority.CredentialAuthorityObservationSchemaV1, originalObservation(), [
    ["original effect domain", ["effect"], "checkout"],
    ["original assignment identity", ["original", "assignmentRef", "id"], "assignment/copied"],
    ["original principal reference", ["original", "originalPrincipalRef"], ""],
    ["canonical binding digest", ["original", "canonicalBindingDigest"], "sha1:" + "a".repeat(40)],
    ["dispatch cutoff", ["original", "turnNotAfter"], "later"],
  ]);
  for (const [purpose, observation] of [
    ["original-turn-runtime", preparationObservation()],
    ["candidate-repository-preparation", originalObservation()],
  ])
    assert.equal(
      Check(preparation.RepositoryCredentialAuthorityObservationSchemaV1, { purpose, observation }),
      false,
    );
});

test("preparation subject and protected receipt retain purpose, full commit and bounded provenance", () => {
  rejects(preparation.RepositoryPreparationSubjectSchemaV1, subject(), [
    ["execution purpose", ["purpose"], "original-turn-runtime"],
    ["preparation UUID", ["preparationRef"], "preparation/copied"],
    ["empty incarnation", ["incarnationRef"], ""],
    ["oversize incarnation", ["incarnationRef"], "a".repeat(201)],
    ["invalid incarnation", ["incarnationRef"], "incarnation with space"],
    ["authorization generation", ["authorizationGeneration"], 0],
    ["exact admission digest", ["admission", "requestDigest"], "sha256:" + "a".repeat(63)],
    ["exact actor", ["admission", "actorRef"], ""],
    ["wrong repository profile", ["profile", "mode"], "mediated"],
    ["repository identity", ["repositoryId"], "0"],
    ["unsafe repository identity length", ["repositoryId"], "1".repeat(21)],
    ["commit algorithm", ["commit", "algorithm"], "sha256"],
    ["short commit", ["commit", "oid"], "a".repeat(39)],
    ["uppercase commit", ["commit", "oid"], "A".repeat(40)],
    ["staging version", ["staging", "bindingVersion"], 0],
    ["origin profile version", ["originProfile", "version"], 0],
    ["candidate cutoff", ["notAfter"], "2026-01-01T00:00:10Z"],
  ]);
  rejects(preparation.PreparationCheckoutRequestSchemaV1, request(), [
    ["effect UUID", ["effectRef"], "effect/copied"],
    ["operation bound", ["operationRef"], "a".repeat(201)],
    ["request digest", ["requestDigest"], "sha256:" + "A".repeat(64)],
    ["deadline format", ["deadline"], "later"],
  ]);
  rejects(preparation.PreparationCheckoutReceiptSchemaV1, receipt(), [
    ["receipt epoch", ["receiptVersion"], 0],
    ["actual commit algorithm", ["actualCommit", "algorithm"], "sha256"],
    ["actual commit length", ["actualCommit", "oid"], "b".repeat(41)],
    ["original effect UUID", ["effectRef"], "effect/copied"],
    ["original request digest", ["effectRequestDigest"], "sha256:" + "b".repeat(63)],
    ["original incarnation bound", ["incarnationRef"], "a".repeat(201)],
    ["original staging epoch", ["staging", "bindingVersion"], 0],
    ["receipt outcome", ["outcome"], "ready"],
    ["producer epoch", ["provenance", "producerServiceVersion"], 0],
    ["evidence epoch", ["provenance", "evidenceVersion"], 1.5],
    ["unqualified port", ["provenance", "acceptedPortRef"], ""],
    ["profile digest", ["provenance", "producerProfileDigest"], "sha256:" + "A".repeat(64)],
    ["source time", ["provenance", "clock", "sourceObservedAt"], "later"],
    ["negative uncertainty", ["provenance", "clock", "uncertaintyMs"], -1],
    ["unbounded uncertainty", ["provenance", "clock", "uncertaintyMs"], 2001],
    ["fractional uncertainty", ["provenance", "clock", "uncertaintyMs"], 0.5],
  ]);
  assert.equal(
    Check(preparation.PreparationCheckoutReceiptSchemaV1, {
      ...receipt(),
      provenance: {
        ...receipt().provenance,
        clock: { ...receipt().provenance.clock, uncertaintyMs: 2000 },
      },
    }),
    true,
  );
});

test("receipt diagnostics retain every nonpositive status, reason and exact recovery action", () => {
  const reasons = [
    "not-submitted",
    "provider-outcome-unknown",
    "cancelled",
    "deadline-exceeded",
    "replaced",
    "authority-unavailable",
    "authority-denied",
    "scope-mismatch",
    "commit-mismatch",
    "incarnation-mismatch",
    "storage-mismatch",
    "evidence-stale",
    "evidence-incomplete",
    "capability-unavailable",
    "operation-conflict",
  ];
  for (const status of ["incomplete", "unknown", "rejected", "cancelled", "stale", "conflict"]) {
    for (const reason of reasons) {
      const result = {
        status,
        request: request(),
        reason,
        nextAction: "exact-readback-or-scoped-cleanup",
      };
      assert.equal(
        Check(preparation.PreparationReceiptDiagnosticSchemaV1, result),
        true,
        `${status}/${reason}`,
      );
      assert.equal(
        Check(preparation.PreparationReceiptDiagnosticSchemaV1, { ...result, nextAction: "retry" }),
        false,
      );
      assert.equal(
        Check(preparation.PreparationReceiptDiagnosticSchemaV1, { ...result, receipt: receipt() }),
        false,
      );
    }
  }
  const schema = preparation.PreparationReceiptDiagnosticSchemaV1;
  assert.equal(Check(schema, { status: "not-visible" }), true);
  assert.equal(Check(schema, { status: "not-visible", request: request() }), false);
  assert.equal(Check(schema, { status: "complete", receipt: receipt(), handle: {} }), false);
  assert.equal(
    Check(schema, {
      status: "unknown",
      request: request(),
      reason: "invented",
      nextAction: "exact-readback-or-scoped-cleanup",
    }),
    false,
  );
});

const compilerImports = `
import {
  CredentialProfileSchemaV1, OriginalCredentialBindingSchemaV1, CredentialAuthorityObservationSchemaV1,
  type CredentialProfileV1, type OriginalCredentialBindingV1, type CredentialAuthorityObservationV1,
  type CurrentCredentialAuthorityHandleV1, type CurrentCredentialAuthorityV1,
  type CredentialMitigationHandleV1, type CredentialManagementHandleV1, type CredentialReadHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import {
  PreparationCommitSchemaV1, PreparationRepositoryProfileSchemaV1, RepositoryPreparationSubjectSchemaV1,
  PreparationCredentialAuthorityObservationSchemaV1, PreparationCheckoutRequestSchemaV1,
  PreparationCheckoutReceiptSchemaV1, PreparationReceiptDiagnosticSchemaV1,
  RepositoryCredentialAuthorityObservationSchemaV1,
  type PreparationCommitV1, type PreparationRepositoryProfileV1, type RepositoryPreparationSubjectV1,
  type PreparationCredentialAuthorityObservationV1, type CurrentPreparationCredentialAuthorityV1,
  type RepositoryCredentialAuthorityV1, type RepositoryCredentialAuthorityObservationV1,
  type PreparationCheckoutRequestV1, type PreparationCheckoutReceiptV1, type PreparationReceiptDiagnosticV1,
  type ProtectedPreparationReceiptHandleV1, type PreparationReceiptResultV1,
  type RepositoryPreparationReceiptPortV1, type AuthorityCallV1,
} from "@openclaw-enterprise/contracts/repository-preparation-v1";
import type { AuthorityCallV1 as OriginalCall } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { EphemeralTokenHandleV1 } from "@openclaw-enterprise/contracts";
`;
function compilerProducer() {
  return (
    compilerImports +
    `
import type { Static } from "typebox";
import { AccountVersionVectorSchemaV1, type AccountVersionVectorV1 } from "../src/account-authority-v1.ts";
import { CredentialSecretBindingSchemaV1, CredentialRepositoryGrantSchemaV1,
  type CredentialSecretBindingV1, type CredentialRepositoryGrantV1,
  type EphemeralTokenHandleV1 as StorageToken } from "../src/credential-storage-v1.ts";
const versions: AccountVersionVectorV1 = ${JSON.stringify(accountVersions())};
const model: CredentialProfileV1 = ${JSON.stringify(modelProfile())};
const profile: PreparationRepositoryProfileV1 = ${JSON.stringify(repositoryProfile())};
const binding: CredentialSecretBindingV1 = ${JSON.stringify(secretBinding())};
const grantData: Static<typeof CredentialRepositoryGrantSchemaV1> = ${JSON.stringify(repositoryGrant())};
const grant: CredentialRepositoryGrantV1 = grantData;
const original: OriginalCredentialBindingV1 = ${JSON.stringify(originalBinding())};
const runtimeObservation: CredentialAuthorityObservationV1 = ${JSON.stringify(originalObservation())};
const subject: RepositoryPreparationSubjectV1 = ${JSON.stringify(subject())};
const prepObservation: PreparationCredentialAuthorityObservationV1 = ${JSON.stringify(preparationObservation())};
const request: PreparationCheckoutRequestV1 = ${JSON.stringify(request())};
const receipt: PreparationCheckoutReceiptV1 = ${JSON.stringify(receipt())};
const commit: PreparationCommitV1 = subject.commit;
declare const originalHandle: CurrentCredentialAuthorityHandleV1;
declare const receiptHandle: ProtectedPreparationReceiptHandleV1;
declare const originalToken: StorageToken;
const token: EphemeralTokenHandleV1 = originalToken;
const storageToken: StorageToken = token;
const runtimeAuthority: CurrentCredentialAuthorityV1 = { handle: originalHandle, observation: runtimeObservation };
const prepAuthority: CurrentPreparationCredentialAuthorityV1 = { handle: runtimeAuthority.handle, observation: prepObservation };
const result: PreparationReceiptResultV1 = { status: "complete", receipt, handle: receiptHandle };
const completeDiagnostic: PreparationReceiptDiagnosticV1 = { status: "complete", receipt };
const diagnostics: PreparationReceiptDiagnosticV1[] = [
  completeDiagnostic, { status: "not-visible" },
  { status: "incomplete", request, reason: "not-submitted", nextAction: "exact-readback-or-scoped-cleanup" },
  { status: "unknown", request, reason: "provider-outcome-unknown", nextAction: "exact-readback-or-scoped-cleanup" },
  { status: "rejected", request, reason: "authority-denied", nextAction: "exact-readback-or-scoped-cleanup" },
  { status: "cancelled", request, reason: "cancelled", nextAction: "exact-readback-or-scoped-cleanup" },
  { status: "stale", request, reason: "evidence-stale", nextAction: "exact-readback-or-scoped-cleanup" },
  { status: "conflict", request, reason: "operation-conflict", nextAction: "exact-readback-or-scoped-cleanup" },
];
const observationUnion: RepositoryCredentialAuthorityObservationV1 = { purpose: "candidate-repository-preparation", observation: prepObservation };
const schemaValues: [Static<typeof AccountVersionVectorSchemaV1>, Static<typeof CredentialProfileSchemaV1>,
  Static<typeof OriginalCredentialBindingSchemaV1>, Static<typeof CredentialAuthorityObservationSchemaV1>,
  Static<typeof CredentialSecretBindingSchemaV1>, Static<typeof CredentialRepositoryGrantSchemaV1>,
  Static<typeof PreparationCommitSchemaV1>, Static<typeof PreparationRepositoryProfileSchemaV1>,
  Static<typeof RepositoryPreparationSubjectSchemaV1>, Static<typeof PreparationCredentialAuthorityObservationSchemaV1>,
  Static<typeof PreparationCheckoutRequestSchemaV1>, Static<typeof PreparationCheckoutReceiptSchemaV1>,
  Static<typeof PreparationReceiptDiagnosticSchemaV1>, Static<typeof RepositoryCredentialAuthorityObservationSchemaV1>] =
  [versions, model, original, runtimeObservation, binding, grantData, commit, profile, subject, prepObservation, request, receipt, completeDiagnostic, observationUnion];
void [schemaValues, grant, token, storageToken, prepAuthority, result];
`
  );
}
const compilerConsumer =
  compilerImports +
  `
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type OriginalCallIdentity = Assert<Equal<AuthorityCallV1, OriginalCall>>;
type ExactReadSignature = Assert<Equal<
  RepositoryPreparationReceiptPortV1["readReceiptV1"],
  (input: PreparationCheckoutRequestV1, call: OriginalCall) => Promise<PreparationReceiptResultV1>
>>;
type ExactAssertionSignature = Assert<Equal<
  RepositoryPreparationReceiptPortV1["assertCurrentReceiptV1"],
  (input: PreparationCheckoutRequestV1,
   complete: Extract<PreparationReceiptResultV1, { status: "complete" }>,
   call: OriginalCall) => Promise<PreparationReceiptDiagnosticV1>
>>;
declare const call: OriginalCall;
declare const port: RepositoryPreparationReceiptPortV1;
declare const request: PreparationCheckoutRequestV1;
declare const receipt: PreparationCheckoutReceiptV1;
declare const runtimeAuthority: CurrentCredentialAuthorityV1;
declare const prepAuthority: CurrentPreparationCredentialAuthorityV1;
declare const subject: RepositoryPreparationSubjectV1;
declare const token: EphemeralTokenHandleV1;
const originalCall: AuthorityCallV1 = call;
const handle: CurrentCredentialAuthorityHandleV1 = prepAuthority.handle;
const both: RepositoryCredentialAuthorityV1[] = [
  { purpose: "original-turn-runtime", authority: runtimeAuthority },
  { purpose: "candidate-repository-preparation", authority: prepAuthority },
];
function inspectAuthority(value: RepositoryCredentialAuthorityV1): string {
  switch (value.purpose) {
    case "original-turn-runtime": return value.authority.observation.original.turnRef;
    case "candidate-repository-preparation": return value.authority.observation.preparation.incarnationRef;
    default: { const exhaustive: never = value; return exhaustive; }
  }
}
async function consumeReceipt(): Promise<PreparationReceiptDiagnosticV1 | undefined> {
  const result: PreparationReceiptResultV1 = await port.readReceiptV1(request, originalCall);
  switch (result.status) {
    case "complete": {
      const protectedHandle: ProtectedPreparationReceiptHandleV1 = result.handle;
      const full: PreparationCheckoutReceiptV1 = result.receipt;
      void [protectedHandle, full];
      return port.assertCurrentReceiptV1(request, result, originalCall);
    }
    case "incomplete": case "unknown": case "rejected": case "cancelled": case "stale": case "conflict": {
      const retained: PreparationCheckoutRequestV1 = result.request;
      const recovery: "exact-readback-or-scoped-cleanup" = result.nextAction;
      void [retained, recovery, result.reason]; return result;
    }
    case "not-visible": return result;
    default: { const exhaustive: never = result; return exhaustive; }
  }
}
function inspectDiagnostic(value: PreparationReceiptDiagnosticV1): void {
  switch (value.status) {
    case "complete": { const full: PreparationCheckoutReceiptV1 = value.receipt; void full; break; }
    case "incomplete": case "unknown": case "rejected": case "cancelled": case "stale": case "conflict": void [value.request, value.reason, value.nextAction]; break;
    case "not-visible": break;
    default: { const exhaustive: never = value; void exhaustive; }
  }
}
void [originalCall, handle, both, inspectAuthority, consumeReceipt, inspectDiagnostic, token, subject, receipt];
`;

function compile(directory, source, emit = false) {
  writeFileSync(join(directory, "input.ts"), source);
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
        noEmit: !emit,
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
        declaration: emit,
        noEmitOnError: true,
        rootDir: root,
        outDir: join(directory, "output"),
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
      },
      files: ["input.ts"],
    }),
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_") || ["ENV", "BASH_ENV", "NODE_OPTIONS", "NODE_PATH"].includes(key))
      delete env[key];
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--project",
      join(directory, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 },
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

test("strict real package producers and consumers preserve sole handles and complete narrowing", async () => {
  for (const name of ["credential-authority-v1", "repository-preparation-v1"]) {
    assert.equal(
      realpathSync(occ.resolve(`@openclaw-enterprise/contracts/${name}`)),
      join(root, "packages/contracts/src", `${name}.ts`),
    );
    assert.equal(
      contracts.resolve(`@openclaw-enterprise/contracts/${name}`),
      occ.resolve(`@openclaw-enterprise/contracts/${name}`),
    );
  }
  const producer = mkdtempSync(join(root, "packages/contracts/.preparation-original-"));
  const consumer = mkdtempSync(join(root, "packages/occ/.preparation-original-"));
  try {
    for (const [directory, source] of [
      [producer, compilerProducer()],
      [consumer, compilerConsumer],
    ]) {
      const positive = compile(directory, source, directory === producer);
      assert.equal(positive.exitCode, 0, positive.output);
    }
    // Exercise emitted code too: no-emit fixtures alone miss extension-rewrite regressions.
    const output = join(producer, "output/packages/contracts/src");
    for (const name of [
      "account-authority-v1",
      "credential-authority-v1",
      "credential-storage-v1",
      "repository-preparation-v1",
    ]) {
      assert.ok(readFileSync(join(output, `${name}.d.ts`), "utf8").length > 0);
    }
    const emitted = await import(pathToFileURL(join(output, "repository-preparation-v1.js")).href);
    assert.equal(Check(emitted.PreparationCheckoutReceiptSchemaV1, receipt()), true);
    assert.equal(
      Check(emitted.RepositoryPreparationSubjectSchemaV1, {
        ...subject(),
        purpose: "original-turn-runtime",
      }),
      false,
    );
    const negatives = [
      [
        "preparation cannot satisfy runtime applicability",
        "const wrong: CurrentCredentialAuthorityV1 = prepAuthority;",
        /TS2322:.*CurrentPreparationCredentialAuthorityV1/,
        /original|dispatchFenceRef/,
      ],
      [
        "runtime cannot satisfy preparation applicability",
        "const wrong: CurrentPreparationCredentialAuthorityV1 = runtimeAuthority;",
        /TS2322:.*CurrentCredentialAuthorityV1/,
        /preparation|binding/,
      ],
      [
        "DATA is not an authority handle",
        "const wrong: CurrentCredentialAuthorityHandleV1 = {};",
        /TS2741:.*\[authorityBrand\]/,
      ],
      [
        "token cannot replace authority handle",
        "const wrong: CurrentCredentialAuthorityHandleV1 = token;",
        /TS2741:.*\[authorityBrand\]/,
      ],
      [
        "currentness cannot replace mitigation authority",
        "const wrong: CredentialMitigationHandleV1 = handle;",
        /TS2741:.*\[mitigationBrand\]/,
      ],
      [
        "currentness cannot replace management authority",
        "const wrong: CredentialManagementHandleV1 = handle;",
        /TS2741:.*\[managementBrand\]/,
      ],
      [
        "currentness cannot replace read authority",
        "const wrong: CredentialReadHandleV1 = handle;",
        /TS2741:.*\[readBrand\]/,
      ],
      [
        "authority cannot replace receipt handle",
        "const wrong: ProtectedPreparationReceiptHandleV1 = handle;",
        /TS2741:.*\[receiptHandleBrand\]/,
      ],
      [
        "receipt DATA cannot complete a protected result",
        'const wrong: PreparationReceiptResultV1 = { status: "complete", receipt };',
        /TS2322:/,
        /handle/,
      ],
      [
        "DATA cannot satisfy assertion input",
        'port.assertCurrentReceiptV1(request, { status: "complete", receipt }, originalCall);',
        /TS2345:/,
        /handle/,
      ],
      [
        "unknown cannot satisfy complete assertion",
        'port.assertCurrentReceiptV1(request, { status: "unknown", request, reason: "provider-outcome-unknown", nextAction: "exact-readback-or-scoped-cleanup" }, originalCall);',
        /TS2322:.*"unknown".*"complete"/,
      ],
      [
        "unprotected diagnostics have no handle",
        'declare const diagnostic: Extract<PreparationReceiptDiagnosticV1, { status: "complete" }>; diagnostic.handle;',
        /TS2339:.*handle/,
      ],
      [
        "immutable subject admission",
        'subject.admission.actorRef = "changed";',
        /TS2540:.*actorRef.*read-only/,
      ],
      [
        "immutable receipt provenance",
        'receipt.provenance.clock.sourceObservedAt = "changed";',
        /TS2540:.*sourceObservedAt.*read-only/,
      ],
      [
        "preparation cannot perform model use",
        'const wrong: PreparationCredentialAuthorityObservationV1 = { ...prepAuthority.observation, effect: "model-use" };',
        /TS2322:.*"model-use"/,
      ],
      [
        "unknown excludes positive payload",
        'function rejectUnknown(value: PreparationReceiptResultV1) { if (value.status === "unknown") value.receipt; }',
        /TS2339:.*receipt/,
      ],
      [
        "incomplete excludes positive handle",
        'function rejectIncomplete(value: PreparationReceiptResultV1) { if (value.status === "incomplete") value.handle; }',
        /TS2339:.*handle/,
      ],
    ];
    for (const [name, suffix, diagnostic, detail] of negatives) {
      const result = compile(consumer, compilerConsumer + suffix);
      assert.equal(result.exitCode, 1, `${name}: expected a compiler diagnostic\n${result.output}`);
      assert.match(result.output, diagnostic, name);
      if (detail) assert.match(result.output, detail, name);
      const diagnostics = result.output.split("\n").filter((line) => /error TS\d+:/.test(line));
      assert.equal(diagnostics.length, 1, result.output);
      assert.match(
        diagnostics[0],
        /input\.ts\(/,
        "the intended diagnostic belongs to the real consumer fixture",
      );
    }
  } finally {
    rmSync(producer, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
  }
});

test("CI catalog discovers and selects the preparation contract suite once", () => {
  const catalog = JSON.parse(readFileSync(join(root, "scripts/ci/test-suites.json"), "utf8"));
  const selections = Object.entries(catalog.lanes).flatMap(([lane, config]) =>
    config.files
      .filter((file) => file.path === "tests/conformance/preparation-original-contracts.test.mjs")
      .map(() => lane),
  );
  assert.deepEqual(selections, ["checks-baseline"]);
});
