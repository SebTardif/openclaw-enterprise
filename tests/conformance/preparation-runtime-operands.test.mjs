import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
// Resolve from the owning workspace package, whose ordinary dependencies and
// self-reference exports are available without adding root dependencies.
const contractRequire = createRequire(
  new URL("../../packages/contracts/package.json", import.meta.url),
);
const { Check } = await import(contractRequire.resolve("typebox/value"));
const { BindRuntimeSchemaV1, RUNTIME_AUTHORITY_LIMITS_V1, parseRuntimeAuthorityV1 } = await import(
  contractRequire.resolve("@openclaw-enterprise/contracts/runtime-authority-v1")
);
const {
  ExactEffectLocatorSchemaV1,
  RuntimeGateGuardSchemaV1,
  RuntimeEvidenceProvenanceSchemaV1,
  RUNTIME_EFFECT_LIMITS_V1,
} = await import(contractRequire.resolve("@openclaw-enterprise/contracts/runtime-effects-v1"));
const { StoreBindingRefSchemaV1 } = await import(
  contractRequire.resolve("@openclaw-enterprise/contracts/completed-state-v1")
);
import {
  bindRequest,
  digest,
  id,
  now,
  scope,
  target,
  until,
} from "../fixtures/runtime-authority-v1/vectors.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const responsibility = () => ({
  responsibilityRef: id(12),
  responsibilityVersion: 1,
  kind: "preparation",
});
const gate = () => ({
  schemaVersion: 1,
  scope: { ...scope },
  intentRef: id(13),
  mode: "running",
  lifecycleGeneration: 1,
  requestedFenceEpoch: 1,
  responsibility: responsibility(),
  gateVersion: 1,
  planRef: "plan/preparation",
  planVersion: 1,
  planDigest: digest,
  admittedChildCutoff: 0,
});
const provenance = () => ({
  producerRef: "producer/compute",
  producerServiceVersion: 1,
  producerProfileRef: "profile/compute",
  producerProfileDigest: digest,
  acceptedPortRef: "port/checkout",
  evidenceRef: "evidence/checkout",
  evidenceVersion: 1,
  clock: { sourceObservedAt: now, receivedAt: now, validUntil: until, uncertaintyMs: 0 },
});
const effect = () => ({
  schemaVersion: 1,
  target: target(),
  effectRef: id(14),
  effectKind: "materialize",
  responsibility: responsibility(),
  requestDigest: digest,
});
const store = () => ({
  schemaVersion: 1,
  scope: { ...scope },
  logicalStoreRef: "store/staging",
  bindingRef: "binding/staging",
  bindingVersion: 1,
});

function setField(path, value) {
  return (input) => {
    const fields = path.split(".");
    const key = fields.pop();
    const owner = fields.reduce((object, field) => object[field], input);
    owner[key] = value;
  };
}

function rejectsChanges(schema, original, changes) {
  assert.equal(Check(schema, original), true, "the selected original DATA example is valid");
  for (const [reason, change] of changes) {
    const input = structuredClone(original);
    change(input);
    assert.equal(Check(schema, input), false, reason);
  }
}

test("selected runtime operands reject unknown fields at every owning dictionary", () => {
  for (const [schema, original, paths] of [
    [RuntimeGateGuardSchemaV1, gate(), [[], ["scope"], ["responsibility"]]],
    [RuntimeEvidenceProvenanceSchemaV1, provenance(), [[], ["clock"]]],
    [
      ExactEffectLocatorSchemaV1,
      effect(),
      [[], ["target"], ["target", "assignmentRef"], ["responsibility"]],
    ],
    [StoreBindingRefSchemaV1, store(), [[], ["scope"]]],
  ]) {
    rejectsChanges(
      schema,
      original,
      paths.map((path) => [
        `unexpected field in ${path.join(".") || "root"}`,
        setField([...path, "unexpected"].join("."), true),
      ]),
    );
    for (const key of Object.keys(original)) {
      const input = structuredClone(original);
      delete input[key];
      assert.equal(Check(schema, input), false, `required selected field ${key}`);
    }
  }
});

test("gate and exact effect locators retain generations, UUIDs, scope and digest bounds", () => {
  rejectsChanges(RuntimeGateGuardSchemaV1, gate(), [
    ["schema version", setField("schemaVersion", 2)],
    ["scope identity", setField("scope.agentId", "agent/copied")],
    ["intent UUID", setField("intentRef", "intent/copied")],
    ["mode", setField("mode", "active")],
    ["zero lifecycle generation", setField("lifecycleGeneration", 0)],
    ["unsafe gate version", setField("gateVersion", Number.MAX_SAFE_INTEGER + 1)],
    ["fractional fence epoch", setField("requestedFenceEpoch", 1.5)],
    ["zero responsibility version", setField("responsibility.responsibilityVersion", 0)],
    ["responsibility kind", setField("responsibility.kind", "execution")],
    ["zero plan version", setField("planVersion", 0)],
    ["empty reference", setField("planRef", "")],
    ["oversize reference", setField("planRef", "a".repeat(201))],
    ["invalid reference characters", setField("planRef", "plan with space")],
    ["wrong digest algorithm", setField("planDigest", "sha1:" + "a".repeat(40))],
    ["negative child cutoff", setField("admittedChildCutoff", -1)],
    ["unsafe child cutoff", setField("admittedChildCutoff", Number.MAX_SAFE_INTEGER + 1)],
  ]);
  rejectsChanges(ExactEffectLocatorSchemaV1, effect(), [
    ["schema version", setField("schemaVersion", 2)],
    ["effect UUID", setField("effectRef", "effect/copied")],
    ["effect kind", setField("effectKind", "release-job")],
    ["target component", setField("target.component", "worker")],
    ["target generation", setField("target.runtimeGeneration", 0)],
    ["target assignment version", setField("target.assignmentRef.schemaVersion", 2)],
    ["target revision identity", setField("target.revisionId", id(5))],
    ["request digest case", setField("requestDigest", "sha256:" + "A".repeat(64))],
    ["responsibility UUID", setField("responsibility.responsibilityRef", "responsibility/copied")],
  ]);
  for (const mode of ["running", "stopped", "disabled"])
    assert.equal(Check(RuntimeGateGuardSchemaV1, { ...gate(), mode }), true);
  for (const kind of ["preparation", "protective-fence", "retained-stop"])
    assert.equal(
      Check(ExactEffectLocatorSchemaV1, {
        ...effect(),
        responsibility: { ...responsibility(), kind },
      }),
      true,
    );
  for (const effectKind of [
    "reserve-inert",
    "materialize",
    "route-active",
    "route-inactive",
    "seal",
    "remove-exact",
  ])
    assert.equal(Check(ExactEffectLocatorSchemaV1, { ...effect(), effectKind }), true);
  assert.equal(
    Check(RuntimeGateGuardSchemaV1, { ...gate(), admittedChildCutoff: Number.MAX_SAFE_INTEGER }),
    true,
  );
});

test("independent provenance retains every source clock and finite uncertainty bound", () => {
  rejectsChanges(RuntimeEvidenceProvenanceSchemaV1, provenance(), [
    ["producer version", setField("producerServiceVersion", 0)],
    ["evidence version", setField("evidenceVersion", 1.5)],
    ["profile digest length", setField("producerProfileDigest", "sha256:" + "a".repeat(63))],
    ...["producerRef", "producerProfileRef", "acceptedPortRef", "evidenceRef"].flatMap((field) => [
      [`empty ${field}`, setField(field, "")],
      [`oversize ${field}`, setField(field, "a".repeat(201))],
      [`invalid ${field}`, setField(field, "invalid reference")],
    ]),
    ...["sourceObservedAt", "receivedAt", "validUntil"].map((field) => [
      `noncanonical ${field}`,
      setField(`clock.${field}`, "2026-01-01T00:00:00Z"),
    ]),
    ...[
      ["missing source clock", "sourceObservedAt"],
      ["missing receive clock", "receivedAt"],
      ["missing cutoff", "validUntil"],
      ["missing uncertainty", "uncertaintyMs"],
    ].map(([reason, field]) => [
      reason,
      (input) => {
        delete input.clock[field];
      },
    ]),
    ["negative uncertainty", setField("clock.uncertaintyMs", -1)],
    ["uncertainty above ceiling", setField("clock.uncertaintyMs", 2001)],
    ["fractional uncertainty", setField("clock.uncertaintyMs", 0.5)],
  ]);
  assert.equal(
    Check(RuntimeEvidenceProvenanceSchemaV1, {
      ...provenance(),
      clock: { ...provenance().clock, uncertaintyMs: 2000 },
    }),
    true,
  );
});

test("store locator retains original scope, binding versions and bounded references", () => {
  rejectsChanges(StoreBindingRefSchemaV1, store(), [
    ["schema version", setField("schemaVersion", 2)],
    ...["installationId", "namespaceId", "agentId"].map((field) => [
      `original ${field} identity`,
      setField(`scope.${field}`, id(1)),
    ]),
    ["zero binding version", setField("bindingVersion", 0)],
    ["unsafe binding version", setField("bindingVersion", Number.MAX_SAFE_INTEGER + 1)],
    ["fractional binding version", setField("bindingVersion", 1.5)],
    ...["logicalStoreRef", "bindingRef"].flatMap((field) => [
      [`empty ${field}`, setField(field, "")],
      [`oversize ${field}`, setField(field, "a".repeat(201))],
      [`invalid ${field}`, setField(field, "store with space")],
    ]),
  ]);
  assert.equal(
    Check(StoreBindingRefSchemaV1, { ...store(), bindingVersion: Number.MAX_SAFE_INTEGER }),
    true,
  );
});

test("selected effect ceilings use the original authority limits and preserve parser behavior", () => {
  assert.deepEqual(RUNTIME_EFFECT_LIMITS_V1, {
    maxJsonBytes: 262_144,
    maxDepth: 32,
    providerRequestMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.providerRequestMaxMs,
    authorityReadMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.lookupMaxMs,
    observationMaxAgeMs: RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs,
    uncertaintyMaxMs: RUNTIME_AUTHORITY_LIMITS_V1.clockUncertaintyMaxMs,
  });
  assert.deepEqual(
    [
      RUNTIME_AUTHORITY_LIMITS_V1.lookupMaxMs,
      RUNTIME_AUTHORITY_LIMITS_V1.activeRecheckMaxMs,
      RUNTIME_AUTHORITY_LIMITS_V1.preparationMaxMs,
      RUNTIME_AUTHORITY_LIMITS_V1.providerRequestMaxMs,
    ],
    [3000, 5000, 900000, 10000],
  );
  assert.equal(Object.isFrozen(RUNTIME_EFFECT_LIMITS_V1), true);
  const decoded = parseRuntimeAuthorityV1("bind", bindRequest());
  assert.equal(Check(BindRuntimeSchemaV1, decoded), true);
  assert.equal(Object.isFrozen(decoded.observation), true);
});

// These are the runtime operands of the original preparation subject and checkout
// receipt, not substitute declarations for the downstream preparation package.
const compilerInput = `
import { Type, type Static } from "typebox";
import type {
  AuthorityCallV1, RuntimeAuthorityCallBoundsV1, RuntimeAuthorityTrustedContextV1
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  RuntimeGateGuardSchemaV1, RuntimeEvidenceProvenanceSchemaV1, ExactEffectLocatorSchemaV1,
  type RuntimeGateGuardV1, type RuntimeEvidenceProvenanceV1, type ExactEffectLocatorV1
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import { StoreBindingRefSchemaV1, type StoreBindingRefV1 } from "@openclaw-enterprise/contracts/completed-state-v1";
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const subjectSchema = Type.Object({
  gate: RuntimeGateGuardSchemaV1, staging: StoreBindingRefSchemaV1
}, { additionalProperties: false });
const receiptSchema = Type.Object({
  staging: StoreBindingRefSchemaV1,
  provenance: RuntimeEvidenceProvenanceSchemaV1
}, { additionalProperties: false });
type SubjectRuntimeOperands = Immutable<Static<typeof subjectSchema>>;
type ReceiptRuntimeOperands = Immutable<Static<typeof receiptSchema>>;
declare const originalContext: RuntimeAuthorityTrustedContextV1;
const bounds: RuntimeAuthorityCallBoundsV1 = {
  requestRef: "request/preparation", recipientRef: "recipient/compute",
  deadline: "2026-01-01T00:00:10.000Z", signal: new AbortController().signal,
};
const contextVersion: 1 = originalContext.schemaVersion;
declare const subject: SubjectRuntimeOperands;
declare const receipt: ReceiptRuntimeOperands;
declare const exactEffect: ExactEffectLocatorV1;
const call: AuthorityCallV1 = { ...bounds, context: originalContext };
const gate: RuntimeGateGuardV1 = subject.gate;
const staging: StoreBindingRefV1 = subject.staging;
const evidence: RuntimeEvidenceProvenanceV1 = receipt.provenance;
const exactTarget: Static<typeof ExactEffectLocatorSchemaV1>["target"] = exactEffect.target;
void [call, gate, staging, evidence, exactTarget, contextVersion];
`;

test("strict actual-package compilation preserves call identity and immutable preparation operands", () => {
  const directory = mkdtempSync(join(root, "packages/contracts/.preparation-runtime-"));
  try {
    const input = join(directory, "input.ts");
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
          noEmit: true,
          allowImportingTsExtensions: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          verbatimModuleSyntax: true,
        },
        files: ["input.ts"],
      }),
    );
    function compile(suffix) {
      writeFileSync(input, compilerInput + suffix);
      const result = spawnSync(
        process.execPath,
        [
          join(root, "node_modules/typescript/bin/tsc"),
          "--project",
          join(directory, "tsconfig.json"),
          "--pretty",
          "false",
        ],
        { cwd: root, encoding: "utf8", timeout: 60_000 },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      const output = result.stdout + result.stderr;
      assert.doesNotMatch(
        output,
        /TS(?:2307|2688|2792|7016)\b|Cannot find module|Cannot find type definition/,
      );
      return { status: result.status, output };
    }
    const positive = compile("");
    assert.equal(positive.status, 0, positive.output);
    for (const [name, suffix, diagnostic] of [
      [
        "copied DATA context",
        "const wrong: AuthorityCallV1 = { ...bounds, context: { schemaVersion: 1 } };",
        /TS2741:.*\[trustedRuntimeService\]/,
      ],
      [
        "foreign nominal context",
        "declare const foreignBrand: unique symbol; declare const foreign: { readonly [foreignBrand]: true; readonly schemaVersion: 1 }; const wrong: AuthorityCallV1 = { ...bounds, context: foreign };",
        /TS2741:.*\[trustedRuntimeService\]/,
      ],
      [
        "wrong target",
        'const wrong: ExactEffectLocatorV1 = { ...exactEffect, target: { ...exactEffect.target, component: "worker" } };',
        /TS2322:.*"worker".*"gateway" \| "harness"/,
      ],
      [
        "missing source clock",
        "const { sourceObservedAt, ...missingClock } = evidence.clock; const wrong: RuntimeEvidenceProvenanceV1 = { ...evidence, clock: missingClock };",
        /TS2741:.*sourceObservedAt/,
      ],
      [
        "immutable subject scope",
        'subject.gate.scope.agentId = "changed";',
        /TS2540:.*agentId.*read-only/,
      ],
      [
        "immutable receipt clock",
        'receipt.provenance.clock.receivedAt = "changed";',
        /TS2540:.*receivedAt.*read-only/,
      ],
    ]) {
      const negative = compile(suffix);
      assert.notEqual(negative.status, 0, `${name}: ${negative.output}`);
      assert.match(negative.output, diagnostic, name);
      const diagnostics = negative.output.split("\n").filter((line) => /error TS\d+:/.test(line));
      assert.equal(diagnostics.length, 1, negative.output);
      assert.match(diagnostics[0], /input\.ts\(/, "failure belongs to the test-owned operand");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
