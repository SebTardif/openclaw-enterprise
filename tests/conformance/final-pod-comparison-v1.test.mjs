import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FinalPodContainmentComparatorV1 } from "@openclaw-enterprise/occ/containment/final-pod-comparison-v1";
import {
  decodeContainmentAdmissionInputV1,
  decodeContainmentAdmissionExchangeV1,
  CONTAINMENT_ADMISSION_FIELD_PATHS_V1,
  CONTAINMENT_ADMISSION_DIAGNOSTIC_EXCLUSIONS_V1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";
import {
  candidate,
  observed,
  preallocated,
  unavailable,
  main,
  expectedMain,
  copy,
  digest,
} from "../fixtures/final-pod-comparison-v1/values.mjs";
import matrix from "../fixtures/final-pod-comparison-v1/rule-matrix.json" with { type: "json" };

const comparator = new FinalPodContainmentComparatorV1();
const invalid = { kind: "invalid", reasonCode: "invalid-input" };
const registered = new Set();
const boundaryRegistered = new Set();
function boundary(name, callback) {
  const id = name.split(":")[0];
  assert.ok(matrix.boundaryChecks.some((c) => c.id === id));
  assert.ok(!boundaryRegistered.has(id));
  boundaryRegistered.add(id);
  test(name, callback);
}
const listed = new Map(matrix.ruleFamilies.flatMap((r) => r.fixtures.map((f) => [f.id, f])));
const spec = (v) => v.actual.pod.spec;
const template = (v) => v.actual.controller.spec.template.spec;
const both = (v, change) => {
  change(v.actual);
  change(v.expectation.document);
};
const due = (v, key) => {
  const fact = v.binding.serverBindings[key];
  v.binding.serverBindings[key] = {
    status: "unavailable",
    owner: fact.owner,
    reasonCode: "stage-binding-unavailable",
  };
};
async function check(value, outcome) {
  assert.equal(
    decodeContainmentAdmissionInputV1(value).kind,
    "valid",
    "fixture must exercise evaluator, not malformed input rejection",
  );
  const result = await comparator.compare(value);
  assert.equal(result.outcome, outcome, JSON.stringify(result.findings));
  assert.equal(result.purpose, "comparison-only");
  assert.equal(decodeContainmentAdmissionExchangeV1(value, result).kind, "valid");
  assert.deepEqual(JSON.parse(JSON.stringify(result.binding)), value.binding);
  assert.ok(result.findings.length <= 64);
  assert.ok(
    result.findings.every((f) => CONTAINMENT_ADMISSION_FIELD_PATHS_V1.includes(f.fieldPath)),
  );
  if (outcome === "unknown")
    assert.ok(result.findings.some((f) => f.reasonCode.endsWith("unavailable")));
  if (outcome === "conforming") assert.deepEqual(result.findings, []);
  return result;
}
function behavior(id, change = () => {}, build = candidate, extra) {
  assert.ok(listed.has(id), id);
  assert.ok(!registered.has(id), id);
  registered.add(id);
  test(`${id}: ${listed.get(id).description}`, async () => {
    const value = build();
    await change(value);
    const result = await check(value, listed.get(id).outcome);
    if (extra) await extra(value, result);
  });
}
behavior("R01-complete");
behavior("R01-pinned-identity-preserved", (v) =>
  both(v, (d) => {
    for (const s of [d.pod.spec, d.controller.spec.template.spec])
      for (const c of [...s.containers, ...s.initContainers])
        c.image = `Fixture.invalid/agent@${digest(50)}`;
  }),
);
behavior("R01-main-image", (v) => {
  main(v).image = `fixture.invalid/agent@${digest(51)}`;
});
behavior("R01-init-pull", (v) => {
  spec(v).initContainers[0].imagePullPolicy = "Always";
});
behavior("R01-missing-actual-image", (v) => {
  delete main(v).image;
});
behavior("R01-template-image", (v) => {
  template(v).containers[0].image = `fixture.invalid/agent@${digest(52)}`;
});
behavior("R01-unknown-pull-enum", (v) => {
  main(v).imagePullPolicy = "Later";
});
behavior("R01-missing-expected-image", (v) => {
  delete expectedMain(v).image;
});
behavior("R01-mutable-expected-image", (v) => {
  expectedMain(v).image = "fixture.invalid/agent:latest";
});
behavior("R02-ordered");
behavior("R02-empty-args", (v) =>
  both(v, (d) => {
    d.pod.spec.containers[0].args = [];
    d.controller.spec.template.spec.containers[0].args = [];
  }),
);
behavior("R02-reordered", (v) => {
  main(v).args.reverse();
});
behavior("R02-command-path", (v) => {
  main(v).command = ["other-node"];
});
behavior("R02-null-vs-empty", (v) => {
  main(v).args = null;
});
behavior("R02-absent-vs-empty", (v) => {
  expectedMain(v).args = [];
  delete main(v).args;
});
behavior("R02-unresolved-inheritance", (v) => {
  delete expectedMain(v).command;
});
behavior("R03-complete");
behavior("R03-explicit-role-records", (v) =>
  both(v, (d) => {
    d.pod.spec.initContainers[0].env = [{ name: "FIXTURE_INIT", value: "explicit" }];
    d.controller.spec.template.spec.initContainers[0].env = [
      { name: "FIXTURE_INIT", value: "explicit" },
    ];
  }),
);
behavior("R03-sidecar", (v) => {
  spec(v).containers.push({ ...copy(main(v)), name: "sidecar" });
});
behavior("R03-init-addition", (v) => {
  spec(v).initContainers.push({ ...copy(spec(v).initContainers[0]), name: "extra-init" });
});
behavior("R03-ephemeral-addition", (v) => {
  spec(v).ephemeralContainers.push({ ...copy(main(v)), name: "debug" });
});
behavior("R03-duplicate-name", (v) => {
  spec(v).initContainers[0].name = "agent";
});
behavior("R03-missing-main", (v) => {
  spec(v).containers = [];
});
behavior("R03-missing-expected-role", (v) => {
  delete v.expectation.document.pod.spec.containers;
});
behavior("R04-no-hooks");
behavior("R04-explicit-hooks", (v) =>
  both(v, (d) => {
    for (const s of [d.pod.spec, d.controller.spec.template.spec])
      s.containers[0].lifecycle = { preStop: { exec: { command: ["node", "stop.js"] } } };
  }),
);
behavior("R04-exec-probe", (v) => {
  main(v).readinessProbe.exec.command[1] = "other.js";
});
behavior("R04-hook", (v) => {
  main(v).lifecycle = { postStart: { exec: { command: ["node", "other.js"] } } };
});
behavior("R04-timing", (v) => {
  main(v).readinessProbe.periodSeconds = 3;
});
behavior("R04-handler-union", (v) => {
  main(v).readinessProbe.httpGet = { port: 8080 };
});
behavior(
  "R04-header-secret",
  (v) => {
    main(v).readinessProbe = {
      httpGet: {
        port: 8080,
        httpHeaders: [{ name: "Authorization", value: "SENTINEL_SECRET_VALUE" }],
      },
    };
  },
  candidate,
  (_v, r) => assert.ok(!JSON.stringify(r).includes("SENTINEL_SECRET_VALUE")),
);
behavior("R04-unknown-nested", (v) => {
  main(v).readinessProbe.exec.unrecognized = true;
});
behavior("R05-literal");
behavior("R05-typed-source", (v) =>
  both(v, (d) => {
    d.pod.spec.containers[0].env[1].valueFrom.configMapKeyRef.optional = false;
    d.controller.spec.template.spec.containers[0].env[1].valueFrom.configMapKeyRef.optional = false;
  }),
);
behavior("R05-literal-change", (v) => {
  main(v).env[0].value = "changed";
});
behavior("R05-secret-source", (v) => {
  main(v).env[1].valueFrom = { secretKeyRef: { name: "different", key: "token" } };
});
behavior("R05-envfrom-addition", (v) => {
  main(v).envFrom.push({ configMapRef: { name: "extra" } });
});
behavior("R05-conflicting-source", (v) => {
  main(v).env[0].valueFrom = { fieldRef: { fieldPath: "metadata.name" } };
});
behavior("R05-duplicate-name", (v) => {
  main(v).env.push(copy(main(v).env[0]));
});
behavior(
  "R05-redaction",
  (v) => {
    main(v).env[0].value = "SENTINEL_SECRET_VALUE";
    main(v).env[0].SENTINEL_SECRET_KEY = "SENTINEL_SECRET_VALUE";
  },
  candidate,
  (_v, r) => assert.ok(!JSON.stringify(r).includes("SENTINEL_SECRET")),
);
behavior("R05-unresolved-source", (v) => {
  delete expectedMain(v).env;
});
behavior("R06-restricted-explicit");
behavior("R06-token-shape");
behavior("R06-uid", (v) => {
  spec(v).securityContext.runAsUser = 0;
});
behavior("R06-group", (v) => {
  spec(v).securityContext.supplementalGroups.push(0);
});
behavior("R06-capability", (v) => {
  main(v).securityContext.capabilities.add = ["NET_ADMIN"];
});
behavior("R06-privilege", (v) => {
  main(v).securityContext.privileged = true;
  main(v).securityContext.allowPrivilegeEscalation = true;
});
behavior("R06-seccomp", (v) => {
  spec(v).securityContext.seccompProfile.type = "Unconfined";
});
behavior("R06-host-namespace", (v) => {
  spec(v).hostPID = true;
});
behavior("R06-proc-sysctl-device", (v) => {
  main(v).volumeDevices = [{ name: "device", devicePath: "/dev/fixture" }];
  spec(v).securityContext.sysctls = [{ name: "kernel.fixture", value: "1" }];
});
behavior("R06-service-account", (v) => {
  spec(v).automountServiceAccountToken = true;
});
behavior("R06-interface", (v) => {
  main(v).ports[0].hostPort = 18790;
});
behavior("R06-missing-expected-identity", (v) => {
  delete v.expectation.document.pod.spec.securityContext.runAsGroup;
});
behavior("R07-directional");
behavior(
  "R07-init-home-only",
  () => {},
  candidate,
  (v) =>
    assert.deepEqual(
      spec(v).initContainers[0].volumeMounts.map((x) => x.name),
      ["runtime-state"],
    ),
);
behavior("R07-direction", (v) => {
  main(v).volumeMounts[3].readOnly = false;
});
behavior("R07-claim", (v) => {
  spec(v).volumes[2].persistentVolumeClaim.claimName = "other-agent";
});
behavior("R07-whole-claim", (v) => {
  delete main(v).volumeMounts[2].subPath;
});
behavior("R07-shadow", (v) => {
  main(v).volumeMounts.push({ name: "workspace", mountPath: "/home/node", readOnly: false });
});
behavior("R07-propagation", (v) => {
  main(v).volumeMounts[0].mountPropagation = "Bidirectional";
});
behavior("R07-private-state", (v) => {
  spec(v).volumes.push({ name: "private-host", hostPath: { path: "/fixture/private" } });
});
behavior("R07-projected-token", (v) => {
  spec(v).volumes[3].projected.sources[0].serviceAccountToken.audience = "other";
});
behavior("R07-unresolved-volume-name", (v) => {
  main(v).volumeMounts[0].name = "absent-volume";
});
behavior("R07-stores-due", (v) => due(v, "stores"));
behavior("R08-explicit-budgets");
behavior("R08-zero-vs-absent", (v) =>
  both(v, (d) => {
    d.pod.spec.overhead.cpu = "0";
    d.controller.spec.template.spec.overhead.cpu = "0";
  }),
);
behavior("R08-init-default", (v) => {
  delete spec(v).initContainers[0].resources.requests.cpu;
});
behavior("R08-ephemeral", (v) => {
  main(v).resources.limits["ephemeral-storage"] = "64Mi";
});
behavior("R08-pod-overhead", (v) => {
  spec(v).overhead.memory = "16Mi";
});
behavior("R08-quantity-spelling", (v) => {
  main(v).resources.limits.cpu = "1000m";
});
behavior("R08-unknown-dimension", (v) => {
  main(v).resources.requests["unselected-resource"] = "1";
});
behavior("R08-missing-expected-budget", (v) => {
  delete v.expectation.document.pod.spec.initContainers[0].resources.requests["ephemeral-storage"];
});
behavior("R08-unresolved-accounting-input", (v) => unavailable(v));
behavior("R09-explicit");
behavior("R09-resolver", (v) => {
  spec(v).dnsConfig.nameservers[0] = "192.0.2.99";
});
behavior("R09-search", (v) => {
  spec(v).dnsConfig.searches.push("other.invalid");
});
behavior("R09-hosts", (v) => {
  spec(v).hostAliases[0].ip = "192.0.2.99";
});
behavior("R09-service-links", (v) => {
  spec(v).enableServiceLinks = true;
});
behavior("R09-dns-enum", (v) => {
  spec(v).dnsPolicy = "Unselected";
});
behavior("R09-missing-expected-dns", (v) => {
  delete v.expectation.document.pod.spec.dnsConfig;
});
behavior("R10-explicit-defaults");
behavior("R10-restart", (v) => {
  spec(v).restartPolicy = "Never";
});
behavior("R10-termination", (v) => {
  spec(v).terminationGracePeriodSeconds = 60;
});
behavior("R10-strategy", (v) => {
  v.actual.controller.spec.strategy = { type: "Recreate" };
});
behavior("R10-replicas", (v) => {
  v.actual.controller.spec.replicas = 2;
});
behavior("R10-unknown-restart-rule", (v) => {
  main(v).restartPolicyRules = [];
});
behavior("R10-missing-expected-default", (v) => {
  delete v.expectation.document.pod.spec.restartPolicy;
});
behavior("R11-placement");
behavior("R11-runtime-class", (v) => {
  spec(v).runtimeClassName = "other-handler";
});
behavior("R11-node", (v) => {
  spec(v).nodeSelector["fixture.example/runtime"] = "other";
});
behavior("R11-affinity", (v) => {
  spec(
    v,
  ).affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator =
    "Exists";
});
behavior("R11-toleration", (v) => {
  spec(v).tolerations[0].operator = "Exists";
});
behavior("R11-scheduler-priority", (v) => {
  spec(v).schedulerName = "other-scheduler";
});
behavior("R11-unknown-feature", (v) => {
  spec(v).resourceClaims = [];
});
behavior("R11-missing-expected-runtime", (v) => {
  delete v.expectation.document.pod.spec.runtimeClassName;
});
behavior("R12-exact-set", (v) => {
  both(v, (d) => {
    d.pod.metadata.annotations["fixture.example/second"] = "explicit";
  });
  v.actual.pod.metadata.annotations = Object.fromEntries(
    Object.entries(v.actual.pod.metadata.annotations).reverse(),
  );
});
behavior("R12-unknown-key", (v) => {
  v.actual.pod.metadata.annotations["unselected.example/runtime"] = "other";
});
behavior("R12-override", (v) => {
  v.actual.pod.metadata.annotations["fixture.example/diagnostic"] = "different";
});
behavior("R12-template-only", (v) => {
  v.actual.controller.spec.template.metadata.annotations["unselected.example/runtime"] = "other";
});
behavior(
  "R12-secret-key-redaction",
  (v) => {
    v.actual.pod.metadata.annotations.SENTINEL_SECRET_KEY = "SENTINEL_SECRET_VALUE";
  },
  candidate,
  (_v, r) => assert.ok(!JSON.stringify(r).includes("SENTINEL_SECRET")),
);
behavior("R13-key-order", (v) => {
  v.actual = Object.fromEntries(Object.entries(v.actual).reverse());
  v.actual.pod.spec = Object.fromEntries(Object.entries(spec(v)).reverse());
});
behavior("R13-named-diagnostics", (v) => {
  v.binding.diagnosticExclusions = [...CONTAINMENT_ADMISSION_DIAGNOSTIC_EXCLUSIONS_V1];
  v.actual.pod.metadata.creationTimestamp = "2026-01-02T00:00:00Z";
  v.actual.pod.metadata.managedFields = [
    { manager: "synthetic", fields: { unknownDiagnosticContent: true } },
  ];
  v.actual.controller.metadata.creationTimestamp = null;
  v.actual.controller.metadata.managedFields = [];
});
behavior("R13-empty-exclusions", (v) =>
  both(v, (d) => {
    d.pod.metadata.managedFields = [{ manager: "synthetic" }];
  }),
);
behavior("R13-undeclared-diagnostic", (v) => {
  v.actual.pod.metadata.creationTimestamp = null;
});
behavior("R13-identity", (v) => {
  v.actual.pod.metadata.ownerReferences = [
    { apiVersion: "apps/v1", kind: "ReplicaSet", name: "other", uid: "other" },
  ];
});
behavior(
  "R13-status",
  (v) => {
    v.actual.pod.status.containerStatuses[0].imageID = digest(99);
  },
  observed,
);
behavior(
  "R13-unknown-actual",
  (v) => {
    spec(v).unselectedBehavior = true;
  },
  candidate,
  async () => {
    const paths = [];
    function visit(value, path) {
      if (!value || typeof value !== "object") return;
      if (!Array.isArray(value)) paths.push(path);
      for (const [k, x] of Object.entries(value)) visit(x, [...path, k]);
    }
    visit(candidate().actual.pod, ["pod"]);
    visit(candidate().actual.controller, ["controller"]);
    for (const path of paths) {
      const value = candidate();
      let object = value.actual;
      for (const key of path) object = object[key];
      object.unselectedBehavior = true;
      await check(value, "nonconforming");
    }
    assert.ok(paths.length > 100);
  },
);
behavior("R13-null-absence", (v) => {
  main(v).lifecycle = null;
});
behavior("R13-template-exclusion", (v) => {
  v.binding.diagnosticExclusions = ["pod.metadata.creationTimestamp"];
  v.actual.controller.spec.template.metadata.creationTimestamp = null;
});
behavior("R13-unknown-both", (v) =>
  both(v, (d) => {
    d.pod.spec.unselectedBehavior = true;
  }),
);
behavior("R13-unsupported-expected-enum", (v) =>
  both(v, (d) => {
    d.pod.spec.dnsPolicy = "UnknownPolicy";
  }),
);
behavior("R14-candidate-no-future-id");
behavior("R14-observed-bound", () => {}, observed);
behavior(
  "R14-observed-preallocated",
  () => {},
  () => preallocated("complete", true),
);
behavior(
  "R14-candidate-operations",
  () => {},
  candidate,
  async () => {
    for (const operation of ["create", "update", "patch", "ephemeral-containers"]) {
      const v = candidate();
      v.binding.subject.operation = operation;
      await check(v, "conforming");
    }
  },
);
behavior("R14-bound-field-mismatch", (v) => {
  main(v).args.push("unexpected");
});
behavior("R14-missing-static", (v) => unavailable(v));
behavior("R14-missing-profile-use", (v) => {
  unavailable(v);
  v.binding.profileUse = null;
});
behavior("R14-missing-expected-ref", (v) => {
  unavailable(v, "expectation-adapter-unavailable");
  v.binding.expectedContentRef = null;
});
behavior(
  "R14-common-due",
  (v) => due(v, "deploymentScope"),
  candidate,
  async () => {
    for (const key of ["deploymentScope", "configuration", "servicePrincipal", "stores"]) {
      const v = candidate();
      due(v, key);
      await check(v, "unknown");
    }
  },
);
behavior(
  "R14-observed-due",
  (v) => due(v, "providerObjects"),
  observed,
  async () => {
    const v = observed();
    due(v, "execution");
    await check(v, "unknown");
  },
);
behavior(
  "R14-noncomplete-observation",
  () => {},
  () => preallocated("unknown"),
  async () => {
    for (const status of ["incomplete", "ambiguous", "unknown"]) {
      await check(preallocated(status), "unknown");
      const v = observed();
      const input = v.binding.subject.observation.input;
      v.binding.subject.observation = {
        schemaVersion: 1,
        status,
        input,
        reasonCode: "unavailable",
      };
      await check(v, "unknown");
    }
  },
);
behavior("R14-unavailable-precedence", (v) => {
  due(v, "stores");
  main(v).image = "malformed";
});
behavior("R14-normalization-unavailable", (v) => {
  expectedMain(v).unknownNormalization = true;
});

const completenessRegistered = new Set();
function completeness(id, change, build = candidate) {
  assert.ok(matrix.completenessCases.some((c) => c.id === id));
  assert.ok(!completenessRegistered.has(id));
  completenessRegistered.add(id);
  test(`${id}: actual-only inconsistency denies`, async () => {
    const v = build();
    change(v.actual);
    await check(v, "nonconforming");
  });
  test(`${id}: same-on-both inconsistency stays unknown`, async () => {
    const v = build();
    both(v, change);
    await check(v, "unknown");
  });
}
completeness("C01-probe-defaults", (d) => {
  d.pod.spec.containers[0].readinessProbe = { exec: { command: ["node", "ready.js"] } };
});
completeness("C02-selector-labels", (d) => {
  d.controller.spec.selector.matchLabels = { different: "label" };
});
completeness(
  "C03-status-identity",
  (d) => {
    d.pod.status.containerStatuses[0].name = "absent-container";
  },
  observed,
);
completeness("C04-object-name", (d) => {
  delete d.pod.metadata.name;
  delete d.controller.metadata.name;
});
completeness("C05-object-namespace", (d) => {
  delete d.pod.metadata.namespace;
  delete d.controller.metadata.namespace;
});
completeness("C06-resource-source", (d) => {
  d.pod.spec.containers[0].env.push({
    name: "SOURCE",
    valueFrom: {
      resourceFieldRef: { containerName: "absent-container", resource: "limits.cpu", divisor: "1" },
    },
  });
});
completeness("C07-probe-port", (d) => {
  const p = d.pod.spec.containers[0].readinessProbe;
  delete p.exec;
  p.httpGet = { host: "", path: "/", port: "absent-port", scheme: "HTTP", httpHeaders: [] };
});
completeness("C08-downward-source", (d) => {
  d.pod.spec.volumes.push({
    name: "downward",
    downwardAPI: {
      defaultMode: 288,
      items: [
        {
          path: "cpu",
          resourceFieldRef: {
            containerName: "absent-container",
            resource: "limits.cpu",
            divisor: "1",
          },
        },
      ],
    },
  });
});
completeness(
  "C09-observed-name",
  (d) => {
    d.controller.metadata.name = "different-known-object";
  },
  observed,
);
completeness("C10-selector-expression", (d) => {
  d.controller.spec.selector.matchExpressions = [
    { key: "fixture", operator: "In", values: ["synthetic"] },
  ];
});
completeness("C11-duplicate-port-name", (d) => {
  const c = d.pod.spec.containers[0];
  c.ports.push({ name: "transport", containerPort: 18791, protocol: "TCP" });
  delete c.readinessProbe.exec;
  c.readinessProbe.httpGet = {
    host: "",
    path: "/",
    port: "transport",
    scheme: "HTTP",
    httpHeaders: [],
  };
});
completeness("C12-namespace-correspondence", (d) => {
  d.pod.metadata.namespace = "different-namespace";
});
test("explicit unnamed numeric ports remain supported", async () => {
  const v = candidate();
  both(v, (d) => {
    for (const s of [d.pod.spec, d.controller.spec.template.spec])
      s.containers[0].ports.push({ containerPort: 18791, protocol: "TCP" });
  });
  await check(v, "conforming");
});
test("complete candidate generateName needs no future identity", async () => {
  const v = candidate();
  both(v, (d) => {
    for (const object of [d.pod, d.controller]) {
      delete object.metadata.name;
      object.metadata.generateName = "fixture-agent-";
    }
  });
  await check(v, "conforming");
});
test("known named port and resource-field source remain supported", async () => {
  const v = candidate();
  both(v, (d) => {
    for (const s of [d.pod.spec, d.controller.spec.template.spec]) {
      const c = s.containers[0],
        p = c.readinessProbe;
      delete p.exec;
      p.httpGet = { host: "", path: "/", port: "transport", scheme: "HTTP", httpHeaders: [] };
      c.env.push({
        name: "SOURCE",
        valueFrom: {
          resourceFieldRef: { containerName: "agent", resource: "limits.cpu", divisor: "1" },
        },
      });
    }
  });
  await check(v, "conforming");
});
async function rejects(value) {
  await assert.rejects(
    () => comparator.compare(value),
    (error) =>
      error instanceof TypeError && error.message === "Invalid containment comparison input",
  );
}
boundary("B01-schema-version: all declared versions fail closed", async () => {
  for (const key of ["schemaVersion", "comparisonVersion", "normalizationVersion"]) {
    const v = candidate();
    v.binding[key] = 2;
    await rejects(v);
  }
});
boundary("B02-stage: no caller promotion of later bindings", async () => {
  const a = candidate();
  a.binding.serverBindings.providerObjects = {
    status: "supplied",
    owner: "runtime-observer",
    evidenceRef: "synthetic",
  };
  await rejects(a);
  const b = observed();
  b.binding.serverBindings.execution = { status: "not-due", owner: "runtime-observer" };
  await rejects(b);
});
boundary("B03-owner: wrong original authority denies", async () => {
  const v = candidate();
  v.binding.serverBindings.configuration.owner = "runtime-observer";
  await rejects(v);
});
boundary("B04-profile: original exact associations and Harness scope", async () => {
  for (const change of [
    (v) => {
      v.binding.selection.manifestDigest = digest(90);
    },
    (v) => {
      v.binding.profileUse.component = "gateway";
    },
    (v) => {
      v.binding.subject.observation.input.binding.profileDigests.identity = digest(90);
    },
    (v) => {
      v.binding.subject.observation.input.binding.admittedConfigurationDigest = digest(90);
    },
  ]) {
    const v = observed();
    change(v);
    await rejects(v);
  }
});
boundary("B05-target: request/result association stays exact", async () => {
  const v = candidate();
  const r = copy(await check(v, "conforming"));
  r.binding.subject.requestRef = "00000000-0000-4000-8000-000000000999";
  assert.deepEqual(decodeContainmentAdmissionExchangeV1(v, r), invalid);
  const b = observed();
  b.binding.target.agentId = "agt_00000000-0000-4000-8000-000000000999";
  await rejects(b);
});
boundary("B06-observed-identity: known identity/RV and original earlier RV", async () => {
  for (const key of [
    "clusterRef",
    "kubernetesNamespaceUid",
    "podUid",
    "podResourceVersion",
    "deploymentUid",
    "deploymentResourceVersion",
  ]) {
    const v = observed();
    v.binding.subject.objectIdentity[key] = "substituted";
    await rejects(v);
  }
  const v = preallocated("complete", true);
  await check(v, "conforming");
  assert.equal(
    v.binding.subject.observation.input.createEffect.expectedObject.resourceVersion,
    "older-version",
  );
});
boundary("B07-exchange: detached references/purpose cannot pass", async () => {
  const v = candidate();
  for (const key of ["comparisonRef", "actualContentRef", "expectedContentRef"]) {
    const r = copy(await check(v, "conforming"));
    r.binding[key] =
      key === "comparisonRef" ? "00000000-0000-4000-8000-000000000999" : "other/content";
    assert.deepEqual(decodeContainmentAdmissionExchangeV1(v, r), invalid);
  }
  const u = unavailable(candidate());
  const fake = {
    binding: copy(u.binding),
    purpose: "comparison-only",
    outcome: "conforming",
    findings: [],
  };
  assert.deepEqual(decodeContainmentAdmissionExchangeV1(u, fake), invalid);
});
boundary("B08-raw-kind: unsupported resource/API versions reject", async () => {
  for (const [field, change] of [
    ["pod", { kind: "ReplicaSet" }],
    ["pod", { apiVersion: "v2" }],
    ["controller", { kind: "StatefulSet" }],
  ]) {
    const v = candidate();
    Object.assign(v.actual[field], change);
    await rejects(v);
  }
});
boundary("B09-safe-input: no callbacks, reflection or hidden coercion", async () => {
  let invoked = false;
  const v = candidate();
  Object.defineProperty(v.actual.pod, "SENTINEL_SECRET", {
    enumerable: true,
    get() {
      invoked = true;
      throw new Error("SENTINEL_SECRET");
    },
  });
  await rejects(v);
  assert.equal(invoked, false);
  const p = new Proxy(candidate(), {
    get() {
      invoked = true;
      throw Error("SENTINEL_SECRET");
    },
  });
  await rejects(p);
  assert.equal(invoked, false);
  const c = candidate();
  c.actual.pod.cycle = c;
  await rejects(c);
  const large = candidate();
  large.actual.pod.opaque = "x".repeat(262144);
  await rejects(large);
});
boundary("B10-findings: deterministic, redacted and bounded denial", async () => {
  const v = candidate();
  for (const key of [
    "command",
    "args",
    "env",
    "envFrom",
    "securityContext",
    "resources",
    "volumeMounts",
  ])
    delete main(v)[key];
  for (let n = 0; n < 100; n++) spec(v)[`SENTINEL_SECRET_${n}`] = true;
  const a = await check(v, "nonconforming"),
    b = await check(copy(v), "nonconforming");
  assert.deepEqual(a, b);
  assert.ok(!JSON.stringify(a).includes("SENTINEL_SECRET"));
  due(v, "stores");
  const u = await check(v, "unknown");
  assert.ok(u.findings.some((f) => f.reasonCode === "stage-binding-unavailable"));
});
boundary("B11-input-immutability: snapshots and caller data retained", async () => {
  const v = observed(),
    before = copy(v);
  const r = await check(v, "conforming");
  assert.deepEqual(v, before);
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.binding.subject.observation));
  assert.notEqual(r.binding, v.binding);
  main(v).args.push("later-change");
  assert.deepEqual(copy(r.binding.subject.observation), before.binding.subject.observation);
});
boundary("B12-isolation: exact public leaf import and declared support only", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const leaf = fileURLToPath(
    import.meta.resolve("@openclaw-enterprise/occ/containment/final-pod-comparison-v1"),
  );
  assert.equal(
    realpathSync(leaf),
    `${root}packages/occ/src/containment/final-pod-comparison-v1.ts`,
  );
  const files = readdirSync(`${root}packages/occ/src/containment`).filter((f) => f.endsWith(".ts"));
  assert.deepEqual(files.sort(), ["final-pod-comparison-v1.ts", "final-pod-fields-v1.ts"]);
  for (const f of files) {
    const source = readFileSync(`${root}packages/occ/src/containment/${f}`, "utf8");
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g))
      assert.ok(
        [
          "@openclaw-enterprise/contracts/containment-admission-v1",
          "./final-pod-fields-v1.ts",
        ].includes(match[1]),
        match[1],
      );
  }
});
test("coverage inventory: every behavioral and boundary ID is unique and registered", () => {
  const ids = matrix.ruleFamilies.flatMap((r) => r.fixtures.map((f) => f.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...registered].sort(), ids.sort());
  assert.equal(matrix.ruleFamilies.length, 14);
  assert.equal(matrix.boundaryChecks.length, 12);
  assert.deepEqual([...boundaryRegistered].sort(), matrix.boundaryChecks.map((c) => c.id).sort());
  assert.equal(matrix.integrationOwnedCases.length, 3);
  assert.deepEqual(
    [...completenessRegistered].sort(),
    matrix.completenessCases.map((c) => c.id).sort(),
  );
});
for (const name of [
  "module",
  "producer",
  "candidate-consumer",
  "observed-consumer",
  "type-negatives",
]) {
  test(`strict separate ${name} compilation`, () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const child = spawnSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "--pretty",
        "false",
        "-p",
        `tests/fixtures/final-pod-comparison-v1/${name}.tsconfig.json`,
      ],
      { cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.equal(child.signal, null);
  });
}
