import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CONTAINMENT_CONTROLS_LIMITS_V1 as limits } from "@openclaw-enterprise/contracts/containment-controls-v1";
import {
  decodeContainmentControlInputV1 as input,
  decodeContainmentControlResultV1 as output,
  decodeContainmentControlExchangeV1 as exchange,
} from "@openclaw-enterprise/contracts/containment-controls-codec-v1";
import { runtimeEffectEvidenceFreshV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";
import {
  request,
  response,
  unavailable,
  copy,
  digest,
} from "../fixtures/containment-controls-v1/values.mjs";

const invalid = { kind: "invalid", reasonCode: "invalid-input" };
const valid = (result) => {
  assert.equal(result.kind, "valid");
  return result.value;
};
const plain = (value) => JSON.parse(JSON.stringify(value));

test("independent complete record roundtrips with original Runtime stages and no identity grant", () => {
  const original = response();
  const result = valid(exchange(original.input, original));
  assert.deepEqual(plain(result), original);
  assert.equal(result.eligibility, "observation-only");
  assert.equal(result.runtimeObservation.identityEvidence, null);
  assert.equal(result.runtimeObservation.profile.desired.version, 4);
  assert.equal(result.runtimeObservation.profile.delivered.version, 3);
  assert.equal(result.runtimeObservation.profile.effective.version, 2);
});
test("control results may arrive in a different array order without losing exact set coverage", () => {
  const value = response();
  value.controls.reverse();
  valid(exchange(value.input, value));
});
for (const status of ["unknown", "unavailable", "cancelled", "deadline-exceeded"]) {
  test(`${status} is finite, explicitly non-authoritative and correlated to exact read`, () => {
    const value = unavailable(
      request(),
      status,
      status === "unknown" ? "evidence-incomplete" : status,
    );
    valid(exchange(value.input, value));
    const different = request();
    different.requestRef = different.runtime.target.createEffectRef;
    assert.deepEqual(exchange(different, value), invalid);
  });
}
for (const status of ["incomplete", "ambiguous", "unknown"]) {
  test(`${status} original runtime observation remains visible and cannot acquire identity`, () => {
    const value = response();
    value.runtimeObservation = {
      schemaVersion: 1,
      status,
      input: copy(value.input.runtime),
      reasonCode: "evidence-incomplete",
    };
    const decoded = valid(output(value));
    assert.equal(decoded.runtimeObservation.status, status);
    assert.equal(decoded.eligibility, "observation-only");
    value.runtimeObservation.input.binding.protectedRestartDiscriminator = "other-execution";
    assert.deepEqual(output(value), invalid);
  });
}
test("missing delivered/effective controls remain unknown with original desired and source", () => {
  const value = response(),
    entry = value.controls[0];
  entry.delivered = null;
  entry.effective = null;
  entry.outcome = "unknown";
  entry.reasonCode = "evidence-incomplete";
  assert.equal(valid(output(value)).controls[0].outcome, "unknown");
});
test("a known policy mismatch is retained as ineffective", () => {
  const value = response(),
    entry = value.controls[0];
  entry.effective.version--;
  entry.effective.digest = digest(99);
  entry.outcome = "ineffective";
  entry.reasonCode = "precondition-failed";
  const decoded = valid(output(value));
  assert.notEqual(decoded.controls[0].effective.digest, decoded.controls[0].desired.digest);
});
for (const [name, mutate] of [
  [
    "schema version",
    (v) => {
      v.schemaVersion = 2;
    },
  ],
  [
    "projection version",
    (v) => {
      v.projectionVersion = 2;
    },
  ],
  [
    "missing original binding",
    (v) => {
      delete v.runtime.binding;
    },
  ],
  [
    "unsupported provider",
    (v) => {
      v.runtime.binding.provider = "ordinary-container";
    },
  ],
  [
    "unbound candidate",
    (v) => {
      v.runtime.kind = "preallocated-candidate";
    },
  ],
  [
    "assignment-only execution",
    (v) => {
      delete v.runtime.binding.protectedRestartDiscriminator;
    },
  ],
  [
    "no required controls",
    (v) => {
      v.requiredControls = [];
    },
  ],
  [
    "duplicate required controls",
    (v) => {
      v.requiredControls.push(copy(v.requiredControls[0]));
    },
  ],
  [
    "unknown control",
    (v) => {
      v.requiredControls[0].control = "everything-safe";
    },
  ],
  [
    "missing admitted containment profile",
    (v) => {
      delete v.containmentProfile;
    },
  ],
  [
    "missing producer epoch",
    (v) => {
      v.after = {
        producerRef: "fixture-projection",
        evidenceVersion: 1,
        sourceObservedAt: "2026-01-01T00:00:00.000Z",
      };
    },
  ],
  [
    "looser age purpose",
    (v) => {
      v.maxAgeMs = 15001;
    },
  ],
  [
    "looser uncertainty purpose",
    (v) => {
      v.maxUncertaintyMs = 2001;
    },
  ],
  [
    "negative age",
    (v) => {
      v.maxAgeMs = -1;
    },
  ],
  [
    "fractional bound",
    (v) => {
      v.maxAgeMs = 1.5;
    },
  ],
  [
    "caller context",
    (v) => {
      v.context = { schemaVersion: 1 };
    },
  ],
]) {
  test(`input rejects ${name}`, () => {
    const value = request();
    mutate(value);
    assert.deepEqual(input(value), invalid);
  });
}
for (const [name, mutate] of [
  [
    "substituted original assignment",
    (v) => {
      v.runtimeObservation.input.target.runtimeGeneration++;
    },
  ],
  [
    "substituted original execution",
    (v) => {
      v.runtimeObservation.binding.protectedRestartDiscriminator = "different";
    },
  ],
  [
    "substituted control desired",
    (v) => {
      v.controls[0].desired.digest = digest(99);
    },
  ],
  [
    "missing required control",
    (v) => {
      v.controls.pop();
    },
  ],
  [
    "duplicate control",
    (v) => {
      v.controls[1] = copy(v.controls[0]);
    },
  ],
  [
    "missing effective positive evidence",
    (v) => {
      v.controls[0].effective = null;
    },
  ],
  [
    "missing delivered positive evidence",
    (v) => {
      v.controls[0].delivered = null;
    },
  ],
  [
    "claimed effective policy mismatch",
    (v) => {
      v.controls[0].effective.version--;
    },
  ],
  [
    "claimed delivered policy mismatch",
    (v) => {
      v.controls[0].delivered.digest = digest(99);
    },
  ],
  [
    "effective with a denial reason",
    (v) => {
      v.controls[0].reasonCode = "denied";
    },
  ],
  [
    "unknown without bounded reason",
    (v) => {
      v.controls[0].outcome = "unknown";
    },
  ],
  [
    "missing source provenance",
    (v) => {
      delete v.controls[0].source;
    },
  ],
  [
    "missing source epoch",
    (v) => {
      delete v.controls[0].sourceEpoch;
    },
  ],
  [
    "zero source epoch",
    (v) => {
      v.controls[0].sourceEpoch.epochVersion = 0;
    },
  ],
  [
    "source epoch overflow",
    (v) => {
      v.controls[0].sourceEpoch.epochVersion = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "substituted stage producer",
    (v) => {
      v.controls[0].effective.evidence.producerRef = "other";
    },
  ],
  [
    "substituted stage port",
    (v) => {
      v.controls[0].effective.evidence.acceptedPortRef = "other";
    },
  ],
  [
    "stage version newer than source",
    (v) => {
      v.controls[0].effective.evidence.evidenceVersion++;
    },
  ],
  [
    "source later than projection",
    (v) => {
      v.controls[0].source.clock.sourceObservedAt = "2026-01-01T00:00:02.000Z";
      v.controls[0].source.clock.receivedAt = "2026-01-01T00:00:02.100Z";
    },
  ],
  [
    "zero projection epoch",
    (v) => {
      v.cursor.epochVersion = 0;
    },
  ],
  [
    "missing projection epoch ref",
    (v) => {
      delete v.cursor.epochRef;
    },
  ],
  [
    "projection cursor producer mismatch",
    (v) => {
      v.cursor.producerRef = "other";
    },
  ],
  [
    "projection cursor evidence mismatch",
    (v) => {
      v.cursor.evidenceVersion++;
    },
  ],
  [
    "projection cursor time mismatch",
    (v) => {
      v.cursor.sourceObservedAt = "2026-01-01T00:00:02.000Z";
    },
  ],
  [
    "invalid calendar time",
    (v) => {
      v.controls[0].source.clock.receivedAt = "2026-02-30T00:00:00.000Z";
    },
  ],
  [
    "oversized original validity",
    (v) => {
      v.controls[0].source.clock.validUntil = "2026-01-01T00:00:16.001Z";
    },
  ],
  [
    "oversized original uncertainty",
    (v) => {
      v.controls[0].source.clock.uncertaintyMs = 2001;
    },
  ],
  [
    "unknown control outcome",
    (v) => {
      v.controls[0].outcome = "safe";
    },
  ],
  [
    "serialized authentication grant",
    (v) => {
      v.authenticated = true;
    },
  ],
  [
    "activation claim",
    (v) => {
      v.eligibility = "eligible";
    },
  ],
  [
    "secret-bearing provider error",
    (v) => {
      v.error = "SYNTHETIC_SENSITIVE_VALUE";
    },
  ],
]) {
  test(`result rejects ${name}`, () => {
    const value = response();
    mutate(value);
    assert.deepEqual(output(value), invalid);
  });
}
test("strictly newer evidence in the same epoch is ordered", () => {
  const value = response();
  value.input.after = { ...value.cursor, evidenceVersion: 1 };
  valid(output(value));
});
for (const [name, previous] of [
  ["duplicate", (cursor) => ({ ...cursor })],
  ["reordered version", (cursor) => ({ ...cursor, evidenceVersion: 3 })],
  ["old epoch", (cursor) => ({ ...cursor, epochVersion: 2 })],
  [
    "changed ref in same epoch",
    (cursor) => ({ ...cursor, epochRef: "different", evidenceVersion: 1 }),
  ],
  ["changed producer", (cursor) => ({ ...cursor, producerRef: "different", evidenceVersion: 1 })],
  [
    "original time rollback",
    (cursor) => ({ ...cursor, evidenceVersion: 1, sourceObservedAt: "2026-01-01T00:00:02.000Z" }),
  ],
]) {
  test(`read advancement rejects ${name}`, () => {
    const value = response();
    value.input.after = previous(value.cursor);
    assert.deepEqual(output(value), invalid);
  });
}
test("new protected producer epoch can restart evidence numbering but cannot reuse its epoch ref", () => {
  const value = response();
  value.input.after = { ...value.cursor, evidenceVersion: 99 };
  value.cursor.epochVersion = 2;
  value.cursor.epochRef = "fixture-projection-epoch-2";
  valid(output(value));
  value.cursor.epochRef = value.input.after.epochRef;
  assert.deepEqual(output(value), invalid);
});
test("historical exact readback preserves original cursor without claiming new evidence", () => {
  const value = response();
  valid(exchange(value.input, value));
  valid(exchange(value.input, copy(value)));
  const next = copy(value.input);
  next.after = copy(value.cursor);
  assert.deepEqual(exchange(next, value), invalid);
  valid(exchange(next, unavailable(next, "unknown", "evidence-stale")));
});
test("receipt and reconnect do not freshen original source evidence; stricter purposes prevail", () => {
  const value = response(),
    source = value.controls[0].effective.evidence;
  source.clock.receivedAt = "2026-01-01T00:01:00.000Z";
  valid(output(value)); // Structural validity still does not claim current evidence.
  assert.equal(runtimeEffectEvidenceFreshV1(source, "2026-01-01T00:01:00.000Z", null), false);
  assert.equal(runtimeEffectEvidenceFreshV1(source, "2026-01-01T00:00:02.000Z", null, 1000), false);
  assert.equal(runtimeEffectEvidenceFreshV1(source, "2026-01-01T00:00:02.000Z", null, 1100), true);
  assert.equal(runtimeEffectEvidenceFreshV1(source, "2026-01-01T00:00:16.000Z", null), false);
});
test("original timing ceilings are reused exactly", () => {
  assert.deepEqual(
    [
      limits.observationMaxAgeMs,
      limits.uncertaintyMaxMs,
      limits.providerRequestMaxMs,
      limits.authorityReadMaxMs,
    ],
    [15000, 2000, 10000, 3000],
  );
  const value = request();
  value.maxAgeMs = 0;
  value.maxUncertaintyMs = 0;
  valid(input(value));
});
test("caller mutation cannot alter a decoded observation", () => {
  const value = response(),
    decoded = valid(output(value));
  value.controls[0].source.evidenceVersion = 99;
  assert.equal(decoded.controls[0].source.evidenceVersion, 2);
  assert.throws(() => {
    decoded.input.runtime.binding.imageDigests.push({});
  }, TypeError);
});
test("accessors, proxies and serialization hooks are not invoked", () => {
  let calls = 0;
  const value = request();
  Object.defineProperty(value, "trap", {
    enumerable: true,
    get() {
      calls++;
      return "secret";
    },
  });
  assert.deepEqual(input(value), invalid);
  assert.deepEqual(
    input(
      new Proxy(request(), {
        ownKeys() {
          calls++;
          throw Error("secret");
        },
      }),
    ),
    invalid,
  );
  const hook = request();
  hook.toJSON = () => {
    calls++;
    return {};
  };
  assert.deepEqual(input(hook), invalid);
  assert.equal(calls, 0);
});
for (const [name, mutate] of [
  [
    "cycle",
    (v) => {
      v.extra = v;
    },
  ],
  [
    "shared mutable reference",
    (v) => {
      v.extra = v.runtime;
    },
  ],
  [
    "sparse array",
    (v) => {
      v.requiredControls = new Array(2);
    },
  ],
  [
    "array properties",
    (v) => {
      v.requiredControls.extra = 1;
    },
  ],
  [
    "symbol properties",
    (v) => {
      v[Symbol("secret")] = 1;
    },
  ],
  [
    "hidden properties",
    (v) => {
      Object.defineProperty(v, "secret", { value: 1 });
    },
  ],
  [
    "non-JSON instance",
    (v) => {
      v.extra = new Date();
    },
  ],
  [
    "negative zero",
    (v) => {
      v.maxAgeMs = -0;
    },
  ],
  [
    "non-finite",
    (v) => {
      v.maxAgeMs = Infinity;
    },
  ],
  [
    "unpaired surrogate",
    (v) => {
      v.extra = "\ud800";
    },
  ],
  [
    "container entry bound",
    (v) => {
      v.extra = Array.from({ length: limits.maxContainerEntries + 1 }, () => null);
    },
  ],
  [
    "depth bound",
    (v) => {
      let p = v;
      for (let i = 0; i <= limits.maxDepth; i++) p = p.extra = {};
    },
  ],
  [
    "aggregate byte bound",
    (v) => {
      v.extra = "💠".repeat(limits.maxInputBytes / 4);
    },
  ],
]) {
  test(`bounded decoder rejects ${name}`, () => {
    const value = request();
    mutate(value);
    assert.deepEqual(input(value), invalid);
  });
}
for (const name of ["module", "observer", "evaluator", "type-negatives"]) {
  test(`independent strict ${name} public-subpath compilation`, () => {
    const child = spawnSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "--pretty",
        "false",
        "-p",
        `tests/fixtures/containment-controls-v1/${name}.tsconfig.json`,
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 1048576,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.equal(child.signal, null);
  });
}
