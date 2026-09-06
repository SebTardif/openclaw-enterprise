import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CONTAINMENT_ADMISSION_DIAGNOSTIC_EXCLUSIONS_V1 as exclusions,
  CONTAINMENT_ADMISSION_LIMITS_V1 as limits,
  decodeContainmentAdmissionInputV1 as input,
  decodeContainmentAdmissionResultV1 as output,
  decodeContainmentAdmissionExchangeV1 as exchange,
} from "@openclaw-enterprise/contracts/containment-admission-v1";
import {
  candidate,
  observed,
  observedPreallocated,
  unavailableCandidate,
  copy,
  id,
  digest,
  result,
} from "../fixtures/containment-admission-v1/values.mjs";

const invalid = { kind: "invalid", reasonCode: "invalid-input" };
const valid = (decoded) => {
  assert.equal(decoded.kind, "valid");
  return decoded.value;
};
const roundtrip = (value) => JSON.parse(JSON.stringify(value));

for (const [name, build] of [
  ["candidate", candidate],
  ["observed", observed],
  ["unavailable candidate", unavailableCandidate],
]) {
  test(`${name} input survives lossless JSON-value roundtrip`, () => {
    const supplied = build(),
      decoded = valid(input(supplied));
    assert.deepEqual(roundtrip(decoded), supplied);
    assert.deepEqual(roundtrip(valid(input(roundtrip(decoded)))), supplied);
  });
}
test("candidate create needs no future Pod, runsc or target SVID", () => {
  const value = valid(input(candidate()));
  assert.deepEqual(Object.keys(value.binding.subject).sort(), ["operation", "requestRef", "stage"]);
  assert.equal(value.binding.serverBindings.providerObjects.status, "not-due");
  assert.equal(value.binding.serverBindings.execution.status, "not-due");
  assert.equal(valid(exchange(value, result(value))).purpose, "comparison-only");
});
for (const operation of ["create", "update", "patch", "ephemeral-containers"]) {
  test(`candidate operation ${operation} is preserved`, () => {
    const value = candidate();
    value.binding.subject.operation = operation;
    assert.equal(valid(input(value)).binding.subject.operation, operation);
  });
}
for (const [name, mutate] of [
  [
    "future candidate identity",
    (v) => {
      v.binding.subject.podUid = "future";
    },
  ],
  [
    "candidate observed evidence",
    (v) => {
      v.binding.subject.observation = observed().binding.subject.observation;
    },
  ],
  [
    "candidate later binding supplied",
    (v) => {
      v.binding.serverBindings.execution = {
        status: "supplied",
        owner: "runtime-observer",
        evidenceRef: "fixture/future",
      };
    },
  ],
  [
    "unknown schema version",
    (v) => {
      v.binding.schemaVersion = 2;
    },
  ],
  [
    "unknown comparison version",
    (v) => {
      v.binding.comparisonVersion = 2;
    },
  ],
  [
    "unknown normalization version",
    (v) => {
      v.binding.normalizationVersion = 2;
    },
  ],
  [
    "wrong profile domain",
    (v) => {
      v.binding.profileContentDomain = "imageSetDigest";
    },
  ],
  [
    "closed outer fields",
    (v) => {
      v.trusted = true;
    },
  ],
  [
    "closed binding fields",
    (v) => {
      v.binding.admitted = true;
    },
  ],
  [
    "wrong deployment binding owner",
    (v) => {
      v.binding.serverBindings.deploymentScope.owner = "caller";
    },
  ],
  [
    "missing due binding descriptor",
    (v) => {
      delete v.binding.serverBindings.stores;
    },
  ],
  [
    "not-due deployment scope",
    (v) => {
      v.binding.serverBindings.deploymentScope = {
        status: "not-due",
        owner: "deployment-authority",
      };
    },
  ],
  [
    "wrong use scope",
    (v) => {
      v.binding.profileUse.namespaceId = `ns_${id(99)}`;
    },
  ],
  [
    "Gateway profile use",
    (v) => {
      v.binding.profileUse.component = "gateway";
    },
  ],
  [
    "missing role association",
    (v) => {
      delete v.binding.profileUse.profileRefs.storage;
    },
  ],
  [
    "duplicated role identity",
    (v) => {
      v.binding.profileUse.profileRefs.storage.ref =
        v.binding.profileUse.profileRefs.containment.ref;
    },
  ],
  [
    "substituted manifest",
    (v) => {
      v.binding.selection.manifestDigest = digest(99);
    },
  ],
  [
    "substituted admission version",
    (v) => {
      v.binding.selection.admissionVersion = 2;
    },
  ],
  [
    "wrong canonical format",
    (v) => {
      v.binding.profileUse.canonicalFormat = "json";
    },
  ],
  [
    "complete expectation missing use",
    (v) => {
      v.binding.profileUse = null;
    },
  ],
  [
    "complete expectation missing content locator",
    (v) => {
      v.binding.expectedContentRef = null;
    },
  ],
  [
    "missing static field-group declaration",
    (v) => {
      v.expectation.fieldGroups.pop();
    },
  ],
  [
    "duplicate static field-group declaration",
    (v) => {
      v.expectation.fieldGroups[0] = v.expectation.fieldGroups[1];
    },
  ],
  [
    "unknown static field-group declaration",
    (v) => {
      v.expectation.fieldGroups[0] = "anything";
    },
  ],
  [
    "whole metadata exclusion",
    (v) => {
      v.binding.diagnosticExclusions = ["pod.metadata"];
    },
  ],
  [
    "whole status exclusion",
    (v) => {
      v.binding.diagnosticExclusions = ["pod.status"];
    },
  ],
  [
    "UID exclusion",
    (v) => {
      v.binding.diagnosticExclusions = ["pod.metadata.uid"];
    },
  ],
  [
    "duplicate exclusion",
    (v) => {
      v.binding.diagnosticExclusions = [exclusions[0], exclusions[0]];
    },
  ],
  [
    "unknown Pod API version",
    (v) => {
      v.actual.pod.apiVersion = "v2";
    },
  ],
  [
    "wrong raw controller kind",
    (v) => {
      v.actual.controller.kind = "Job";
    },
  ],
]) {
  test(`rejects ${name}`, () => {
    const value = candidate();
    mutate(value);
    assert.deepEqual(input(value), invalid);
  });
}
test("each named diagnostic exclusion remains explicit and raw metadata remains present", () => {
  const value = observed();
  value.binding.diagnosticExclusions = [...exclusions];
  for (const object of [value.actual.pod, value.actual.controller]) {
    object.metadata.creationTimestamp = "2026-01-01T00:00:00Z";
    object.metadata.managedFields = [{ manager: "fixture", fieldsV1: { "f:spec": {} } }];
  }
  const decoded = valid(input(value));
  assert.deepEqual(roundtrip(decoded.actual), value.actual);
  assert.deepEqual([...decoded.binding.diagnosticExclusions], [...exclusions]);
});
test("whole raw executable presence, null, empties, unknown keys and order survive", () => {
  const value = candidate();
  value.actual.pod.spec.futureExecutableField = {
    empty: [],
    null: null,
    value: false,
    fractional: 0.5,
  };
  value.actual.pod.spec.containers[0].unknownSource = JSON.parse(
    '{"toJSON":"ordinary JSON data","__proto__":null}',
  );
  value.actual.pod.spec.containers[0].args.reverse();
  value.actual.controller.spec.template.spec.futureExecutableField = {
    "secret-looking-field": "SYNTHETIC_VALUE_DO_NOT_REFLECT",
  };
  delete value.actual.pod.spec.containers[0].livenessProbe;
  const decoded = valid(input(value));
  assert.deepEqual(roundtrip(decoded.actual), value.actual);
  assert.equal(Object.hasOwn(decoded.actual.pod.spec.containers[0], "livenessProbe"), false);
  assert.equal(decoded.actual.pod.spec.containers[0].startupProbe, null);
  // Structural decoding does not decide whether these supplied fields conform.
  assert.equal(Object.hasOwn(decoded, "outcome"), false);
});
for (const field of ["deploymentScope", "configuration", "servicePrincipal", "stores"]) {
  test(`due but unavailable ${field} requires unknown outcome`, () => {
    const value = candidate();
    value.binding.serverBindings[field] = {
      status: "unavailable",
      owner: value.binding.serverBindings[field].owner,
      reasonCode: "stage-binding-unavailable",
    };
    valid(input(value));
    assert.deepEqual(exchange(value, result(value)), invalid);
    assert.deepEqual(exchange(value, result(value, "nonconforming")), invalid);
    assert.equal(valid(exchange(value, result(value, "unknown"))).outcome, "unknown");
  });
}
test("actual unresolved adapter inputs stay unavailable and unknown", () => {
  const value = unavailableCandidate();
  assert.deepEqual(exchange(value, result(value)), invalid);
  assert.deepEqual(exchange(value, result(value, "nonconforming")), invalid);
  assert.equal(
    valid(exchange(value, result(value, "unknown", "expectation-adapter-unavailable"))).outcome,
    "unknown",
  );
});
test("an explicitly missing static group requires at least one exact group name", () => {
  const value = unavailableCandidate();
  value.expectation.reasonCode = "static-input-unavailable";
  value.expectation.missingFieldGroups = [];
  assert.deepEqual(input(value), invalid);
  value.expectation.missingFieldGroups = ["resources-overhead-and-defaults"];
  valid(input(value));
  value.expectation.missingFieldGroups.push(value.expectation.missingFieldGroups[0]);
  assert.deepEqual(input(value), invalid);
});
test("unavailable expectation independently prevents a claimed conforming result", () => {
  const value = candidate();
  value.expectation = {
    status: "unavailable",
    reasonCode: "normalization-unavailable",
    missingFieldGroups: [],
  };
  valid(input(value));
  assert.deepEqual(exchange(value, result(value)), invalid);
  valid(exchange(value, result(value, "unknown", "normalization-unavailable")));
});
for (const [name, mutate] of [
  [
    "observed provider binding marked not due",
    (v) => {
      v.binding.serverBindings.providerObjects = { status: "not-due", owner: "runtime-observer" };
    },
  ],
  [
    "raw Pod UID substitution",
    (v) => {
      v.actual.pod.metadata.uid = "other";
    },
  ],
  [
    "raw Pod version substitution",
    (v) => {
      v.actual.pod.metadata.resourceVersion = "other";
    },
  ],
  [
    "raw Deployment UID substitution",
    (v) => {
      v.actual.controller.metadata.uid = "other";
    },
  ],
  [
    "raw Deployment version substitution",
    (v) => {
      v.actual.controller.metadata.resourceVersion = "other";
    },
  ],
  [
    "observation Pod identity substitution",
    (v) => {
      v.binding.subject.objectIdentity.podUid = "other";
      v.actual.pod.metadata.uid = "other";
    },
  ],
  [
    "observation Deployment version substitution",
    (v) => {
      v.binding.subject.objectIdentity.deploymentResourceVersion = "other";
      v.actual.controller.metadata.resourceVersion = "other";
    },
  ],
  [
    "observation request revision substitution",
    (v) => {
      v.binding.subject.observation.input.target.revisionId = `rev_${id(99)}`;
    },
  ],
  [
    "observation configuration substitution",
    (v) => {
      for (const b of [
        v.binding.subject.observation.binding,
        v.binding.subject.observation.input.binding,
      ])
        b.admittedConfigurationDigest = digest(99);
    },
  ],
  [
    "observation runtime profile substitution",
    (v) => {
      for (const b of [
        v.binding.subject.observation.binding,
        v.binding.subject.observation.input.binding,
      ])
        b.profileDigests.runtime = digest(99);
    },
  ],
  [
    "original observation result-instance mismatch",
    (v) => {
      v.binding.subject.observation.binding.protectedRestartDiscriminator = "other";
    },
  ],
  [
    "original observation evidence ordering violation",
    (v) => {
      v.binding.subject.observation.input.expectedEvidenceVersion = 2;
    },
  ],
]) {
  test(`rejects ${name}`, () => {
    const value = observed();
    mutate(value);
    assert.deepEqual(input(value), invalid);
  });
}
test("observed comparison preserves original observation and all three policy stages", () => {
  const value = observed(),
    decoded = valid(input(value));
  assert.deepEqual(
    roundtrip(decoded.binding.subject.observation),
    value.binding.subject.observation,
  );
  assert.equal(decoded.binding.subject.observation.eligibility, "observation-only");
  assert.equal(decoded.binding.subject.observation.profile.desired.version, 3);
  assert.equal(decoded.binding.subject.observation.profile.delivered.version, 2);
  assert.equal(decoded.binding.subject.observation.profile.effective.version, 1);
  assert.equal(valid(exchange(value, result(value))).purpose, "comparison-only");
});
test("incomplete actual observation remains unknown and denies comparison success", () => {
  const value = observed(),
    original = value.binding.subject.observation;
  value.binding.subject.observation = {
    schemaVersion: 1,
    status: "unknown",
    input: original.input,
    reasonCode: "unavailable",
  };
  valid(input(value));
  assert.deepEqual(exchange(value, result(value)), invalid);
  valid(exchange(value, result(value, "unknown", "observation-unavailable")));
});
for (const status of ["incomplete", "ambiguous", "unknown"]) {
  test(`known instance correspondence remains required for ${status} observation`, () => {
    const value = observed();
    const retainedInput = value.binding.subject.observation.input;
    value.binding.subject.observation = {
      schemaVersion: 1,
      status,
      input: retainedInput,
      reasonCode: "unavailable",
    };
    valid(input(value));
    valid(exchange(value, result(value, "unknown", "observation-unavailable")));
    const otherPod = copy(value);
    otherPod.binding.subject.objectIdentity.podUid = "different-known-pod";
    otherPod.actual.pod.metadata.uid = "different-known-pod";
    assert.deepEqual(input(otherPod), invalid);
    const otherProfile = copy(value);
    otherProfile.binding.subject.observation.input.binding.profileDigests.runtime = digest(99);
    assert.deepEqual(input(otherProfile), invalid);
    const otherConfiguration = copy(value);
    otherConfiguration.binding.subject.observation.input.binding.admittedConfigurationDigest =
      digest(99);
    assert.deepEqual(input(otherConfiguration), invalid);
  });
}
for (const status of ["complete", "incomplete", "ambiguous", "unknown"]) {
  test(`actual preallocated-candidate ${status} retains known provider correspondence`, () => {
    for (const expectedObject of [false, true]) {
      const value = observedPreallocated(status, expectedObject);
      const decoded = valid(input(value));
      assert.equal(decoded.binding.subject.stage, "observed");
      assert.equal(decoded.binding.subject.observation.input.kind, "preallocated-candidate");
      valid(
        exchange(
          value,
          result(
            value,
            status === "complete" ? "conforming" : "unknown",
            "observation-unavailable",
          ),
        ),
      );
      for (const key of ["clusterRef", "kubernetesNamespaceUid"]) {
        const mismatch = copy(value);
        mismatch.binding.subject.objectIdentity[key] = "different-known-value";
        assert.deepEqual(input(mismatch), invalid);
      }
      if (expectedObject) {
        // Original expectedObject is allowed to carry an older resourceVersion.
        assert.equal(
          decoded.binding.subject.observation.input.createEffect.expectedObject.resourceVersion,
          "older-version",
        );
        const mismatch = copy(value);
        mismatch.binding.subject.objectIdentity.deploymentUid = "different-known-deployment";
        mismatch.actual.controller.metadata.uid = "different-known-deployment";
        assert.deepEqual(input(mismatch), invalid);
      }
    }
  });
}
for (const key of ["comparisonRef", "actualContentRef", "expectedContentRef"]) {
  test(`detached result with changed ${key} is rejected`, () => {
    const value = candidate(),
      response = result(value);
    response.binding[key] = key === "comparisonRef" ? id(99) : "fixture/other";
    valid(output(response));
    assert.deepEqual(exchange(value, response), invalid);
  });
}
test("result is bound to exact candidate request", () => {
  const value = candidate(),
    response = result(value);
  response.binding.subject.requestRef = id(99);
  valid(output(response));
  assert.deepEqual(exchange(value, response), invalid);
});
test("result is bound to complete original observation, including source times", () => {
  const value = observed(),
    response = result(value);
  response.binding.subject.observation.observation.clock.sourceObservedAt =
    "2026-01-01T00:00:00.001Z";
  valid(output(response));
  assert.deepEqual(exchange(value, response), invalid);
});
for (const [name, mutate] of [
  [
    "conforming with findings",
    (v) => {
      v.findings = [{ reasonCode: "field-mismatch", fieldPath: "$" }];
    },
  ],
  [
    "nonconforming without findings",
    (v) => {
      v.outcome = "nonconforming";
    },
  ],
  [
    "unknown without unavailable reason",
    (v) => {
      v.outcome = "unknown";
      v.findings = [{ reasonCode: "field-mismatch", fieldPath: "$" }];
    },
  ],
  [
    "unavailable promoted to mismatch",
    (v) => {
      v.outcome = "nonconforming";
      v.findings = [{ reasonCode: "stage-binding-unavailable", fieldPath: "$" }];
    },
  ],
  [
    "live eligibility claim",
    (v) => {
      v.purpose = "admission";
    },
  ],
  [
    "unsupported outcome",
    (v) => {
      v.outcome = "pass";
    },
  ],
  [
    "raw field-name reflection",
    (v) => {
      v.outcome = "nonconforming";
      v.findings = [
        { reasonCode: "field-mismatch", fieldPath: "pod.spec.containers[0].env.SYNTHETIC_SECRET" },
      ];
    },
  ],
  [
    "raw value reflection",
    (v) => {
      v.outcome = "nonconforming";
      v.findings = [{ reasonCode: "field-mismatch", fieldPath: "$", actual: "SYNTHETIC_SECRET" }];
    },
  ],
  [
    "provider error reflection",
    (v) => {
      v.error = "SYNTHETIC_SECRET";
    },
  ],
  [
    "excess findings",
    (v) => {
      v.outcome = "nonconforming";
      v.findings = Array.from({ length: limits.maxFindings + 1 }, () => ({
        reasonCode: "field-mismatch",
        fieldPath: "$",
      }));
    },
  ],
]) {
  test(`result rejects ${name} without reflecting supplied data`, () => {
    const value = result(candidate());
    mutate(value);
    assert.deepEqual(output(value), invalid);
    assert.equal(JSON.stringify(output(value)).includes("SYNTHETIC_SECRET"), false);
  });
}
test("valid mismatches expose only closed reason codes and field paths", () => {
  const value = candidate(),
    response = result(value, "nonconforming");
  response.findings = [
    { reasonCode: "unsupported-field", fieldPath: "unknown-field" },
    { reasonCode: "field-mismatch", fieldPath: "pod.spec.containers[*].image" },
  ];
  assert.deepEqual(roundtrip(valid(exchange(value, response))).findings, response.findings);
});
test("decoded input and nested original records are detached and frozen", () => {
  const value = observed(),
    decoded = valid(input(value));
  value.actual.pod.spec.containers[0].args[0] = "changed";
  value.binding.profileUse.profileRefs.storage.contentDigest = digest(99);
  assert.equal(decoded.actual.pod.spec.containers[0].args[0], "entrypoint.js");
  assert.equal(decoded.binding.profileUse.profileRefs.storage.contentDigest, digest(34));
  assert.throws(() => {
    decoded.actual.pod.spec.containers.push({});
  }, TypeError);
  assert.throws(() => {
    decoded.binding.subject.observation.profile.desired.version = 99;
  }, TypeError);
});
test("accessors, proxies and caller serialization hooks are never invoked", () => {
  let calls = 0;
  const getter = candidate();
  Object.defineProperty(getter.actual.pod, "trap", {
    enumerable: true,
    get() {
      calls++;
      return "secret";
    },
  });
  assert.deepEqual(input(getter), invalid);
  const proxy = new Proxy(candidate(), {
    ownKeys() {
      calls++;
      throw Error("secret");
    },
  });
  assert.deepEqual(input(proxy), invalid);
  const hook = candidate();
  hook.actual.pod.toJSON = () => {
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
      v.actual.pod.loop = v.actual.pod;
    },
  ],
  [
    "shared mutable aliases",
    (v) => {
      v.actual = v.expectation.document;
    },
  ],
  [
    "sparse array",
    (v) => {
      v.actual.pod.spec.containers[0].args = new Array(2);
    },
  ],
  [
    "extra array key",
    (v) => {
      v.actual.pod.spec.containers.extra = true;
    },
  ],
  [
    "symbol property",
    (v) => {
      v.actual.pod[Symbol("secret")] = true;
    },
  ],
  [
    "hidden property",
    (v) => {
      Object.defineProperty(v.actual.pod, "secret", { value: "secret", enumerable: false });
    },
  ],
  [
    "non-JSON instance",
    (v) => {
      v.actual.pod.date = new Date();
    },
  ],
  [
    "undefined raw value",
    (v) => {
      v.actual.pod.optional = undefined;
    },
  ],
  [
    "negative zero",
    (v) => {
      v.actual.pod.number = -0;
    },
  ],
  [
    "nonfinite number",
    (v) => {
      v.actual.pod.number = Infinity;
    },
  ],
  [
    "unsafe numeric magnitude",
    (v) => {
      v.actual.pod.number = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "invalid Unicode",
    (v) => {
      v.actual.pod.value = "\ud800";
    },
  ],
  [
    "too many object members",
    (v) => {
      v.actual.pod.extra = Object.fromEntries(
        Array.from({ length: limits.maxContainerEntries + 1 }, (_, i) => [String(i), null]),
      );
    },
  ],
  [
    "too many array members",
    (v) => {
      v.actual.pod.extra = Array.from({ length: limits.maxContainerEntries + 1 }, () => null);
    },
  ],
  [
    "depth bound",
    (v) => {
      let p = {};
      v.actual.pod.extra = p;
      for (let i = 0; i <= limits.maxDepth; i++) p = p.child = {};
    },
  ],
  [
    "aggregate byte bound",
    (v) => {
      v.actual.pod.extra = Array.from({ length: 9 }, () => "x".repeat(32768));
    },
  ],
  [
    "UTF-8 byte bound",
    (v) => {
      v.actual.pod.extra = "💠".repeat(limits.maxInputBytes / 4);
    },
  ],
]) {
  test(`bounded data decoder rejects ${name}`, () => {
    const value = candidate();
    mutate(value);
    assert.deepEqual(input(value), invalid);
  });
}
for (const name of [
  "module",
  "producer",
  "candidate-consumer",
  "observed-consumer",
  "type-negatives",
]) {
  test(`independent strict ${name} compilation through public contract subpaths`, () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const child = spawnSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "--pretty",
        "false",
        "-p",
        `tests/fixtures/containment-admission-v1/${name}.tsconfig.json`,
      ],
      { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.equal(child.signal, null);
  });
}
