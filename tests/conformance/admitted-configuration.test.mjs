import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { admitLoggingConfiguration } from "../../packages/contracts/src/logging.ts";
import { frozenValues } from "../../packages/occ/src/services/deployment/configuration.ts";
import {
  AdmittedConfigurationError,
  decodeAdmittedConfigurationV1,
  deriveAdmittedConfigurationV1,
} from "../../packages/occ/src/workload-profiles/admitted-configuration.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const id = (prefix, n) => `${prefix}_${uuid(n)}`;
const digest = (n) => `sha256:${n.repeat(64)}`;
const copy = (value) => structuredClone(value);
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value));

function fixture() {
  // Exercise the maintained configuration fixture and the actual normalizers
  // used by DeploymentService. This does not execute a native Driver or create.
  const native = createHarnessConfiguration("codex", "gpt-4.1");
  const values = frozenValues(admitLoggingConfiguration(frozenValues(native), "info"));
  return {
    manifestDigest: digest("a"),
    configurationRef: id("cfg", 1),
    configurationGeneration: 3,
    immutableConfigurationContent: {
      kind: "agent",
      values,
      secretBindings: {
        DATA_TOKEN: {
          source: { kind: "secret", namespaceId: id("ns", 2), id: id("sec", 3) },
        },
      },
    },
    resolvedProfileBindingParameters: {
      installationId: id("ins", 4),
      namespaceId: id("ns", 2),
      agentId: id("agt", 5),
      serviceAccountAssociation: {
        servicePrincipalId: id("prn", 6),
        serviceAccount: {
          id: id("sa", 7),
          credential: { kind: "api_key", secretRef: { name: "model-credential", key: "api-key" } },
        },
      },
      storePolicyBindings: [
        {
          component: "harness",
          name: "state",
          path: "/state/harness",
          store: { ref: "harness-state-policy", version: 2, contentDigest: digest("b") },
          access: "read-write",
        },
        {
          component: "gateway",
          name: "state",
          path: "/state/gateway",
          store: { ref: "gateway-state-policy", version: 1, contentDigest: digest("c") },
          access: "read-write",
        },
      ],
      roleBindings: Object.fromEntries(
        ["provider", "runtime", "identity", "containment", "storage"].map((name, index) => [
          name,
          { ref: uuid(20 + index), version: index + 1, contentDigest: digest(String(index + 1)) },
        ]),
      ),
    },
  };
}
function rejects(change) {
  const value = copy(fixture());
  change(value);
  assert.throws(() => deriveAdmittedConfigurationV1(value), AdmittedConfigurationError);
}

test("actual maintained admission normalization feeds the exact configuration domain", () => {
  const input = fixture();
  const result = deriveAdmittedConfigurationV1(input);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.projection.immutableConfigurationContent.values)),
    JSON.parse(JSON.stringify(input.immutableConfigurationContent.values)),
  );
  assert.equal(result.projection.configurationGeneration, 3);
  assert.equal(result.projection.immutableConfigurationContent.values.logging.consoleStyle, "json");
  assert.equal(
    Object.hasOwn(
      result.projection.immutableConfigurationContent.values.logging,
      "redactSensitive",
    ),
    false,
  );
  assert.equal(result.projection.immutableConfigurationContent.values.diagnostics.otel.logs, false);
  assert.equal(
    result.projection.resolvedProfileBindingParameters.storePolicyBindings[0].component,
    "gateway",
  );
  assert.equal(
    result.projection.immutableConfigurationContent.secretBindings.DATA_TOKEN.delivery.type,
    "env",
  );
  assert.equal(
    result.admittedConfigurationDigest,
    `sha256:${createHash("sha256")
      .update("oce.workload-profile.admitted-configuration.v1\n", "utf8")
      .update(result.canonicalBytes)
      .digest("hex")}`,
  );
  assert.notEqual(result.admittedConfigurationDigest, input.manifestDigest);
  assert.deepEqual(
    decodeAdmittedConfigurationV1(result.canonicalBytes).projection,
    result.projection,
  );
});

test("configuration and binding snapshots remain immutable independently of output bytes", () => {
  const input = copy(fixture());
  const result = deriveAdmittedConfigurationV1(input);
  input.immutableConfigurationContent.values.logging.level = "error";
  input.resolvedProfileBindingParameters.roleBindings.storage.version++;
  result.canonicalBytes.fill(0);
  assert.equal(result.projection.immutableConfigurationContent.values.logging.level, "info");
  assert.equal(result.projection.resolvedProfileBindingParameters.roleBindings.storage.version, 5);
  assert.throws(() => {
    result.projection.resolvedProfileBindingParameters.roleBindings.storage.version++;
  }, TypeError);
  assert.throws(() => {
    result.projection.immutableConfigurationContent.values.agents.defaults.model = "changed";
  }, TypeError);
});

test("only declared store set and Secret delivery normalization are order insensitive", () => {
  const input = copy(fixture());
  const original = deriveAdmittedConfigurationV1(input);
  input.resolvedProfileBindingParameters.storePolicyBindings.reverse();
  input.immutableConfigurationContent.secretBindings.DATA_TOKEN.delivery = { type: "env" };
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(
    deriveAdmittedConfigurationV1(reordered).admittedConfigurationDigest,
    original.admittedConfigurationDigest,
  );
});

test("every retained deployment identity and configuration generation contributes", () => {
  const original = deriveAdmittedConfigurationV1(fixture()).admittedConfigurationDigest;
  const changes = [
    (v) => {
      v.manifestDigest = digest("f");
    },
    (v) => {
      v.configurationRef = id("cfg", 99);
    },
    (v) => {
      v.configurationGeneration++;
    },
    (v) => {
      v.resolvedProfileBindingParameters.installationId = id("ins", 99);
    },
    (v) => {
      v.resolvedProfileBindingParameters.agentId = id("agt", 99);
    },
    (v) => {
      v.resolvedProfileBindingParameters.namespaceId = id("ns", 99);
      v.immutableConfigurationContent.secretBindings.DATA_TOKEN.source.namespaceId = id("ns", 99);
    },
    (v) => {
      v.resolvedProfileBindingParameters.serviceAccountAssociation.servicePrincipalId = id(
        "prn",
        99,
      );
    },
    (v) => {
      v.resolvedProfileBindingParameters.serviceAccountAssociation.serviceAccount.id = id("sa", 99);
    },
    (v) => {
      v.resolvedProfileBindingParameters.serviceAccountAssociation.serviceAccount.credential.secretRef.key =
        "other-key";
    },
    (v) => {
      v.immutableConfigurationContent.secretBindings.DATA_TOKEN.source.id = id("sec", 99);
    },
  ];
  for (const change of changes) {
    const value = copy(fixture());
    change(value);
    assert.notEqual(deriveAdmittedConfigurationV1(value).admittedConfigurationDigest, original);
  }
});

test("all five exact role records and every logical store member are digest inputs", () => {
  const original = deriveAdmittedConfigurationV1(fixture()).admittedConfigurationDigest;
  for (const role of ["provider", "runtime", "identity", "containment", "storage"]) {
    for (const field of ["ref", "version", "contentDigest"]) {
      const value = copy(fixture());
      value.resolvedProfileBindingParameters.roleBindings[role][field] =
        field === "ref" ? uuid(99) : field === "version" ? 88 : digest("e");
      assert.notEqual(deriveAdmittedConfigurationV1(value).admittedConfigurationDigest, original);
    }
  }
  for (const change of [
    (s) => {
      s.store.ref += "-next";
    },
    (s) => {
      s.store.version++;
    },
    (s) => {
      s.store.contentDigest = digest("e");
    },
    (s) => {
      s.name = "other";
    },
    (s) => {
      s.path = "/other/state";
    },
    (s) => {
      s.access = "read-only";
    },
  ]) {
    const value = copy(fixture());
    change(value.resolvedProfileBindingParameters.storePolicyBindings[0]);
    assert.notEqual(deriveAdmittedConfigurationV1(value).admittedConfigurationDigest, original);
  }
});

test("actual normalized logging and native model data are retained, not metadata aliases", () => {
  const value = copy(fixture());
  const original = deriveAdmittedConfigurationV1(value).admittedConfigurationDigest;
  value.immutableConfigurationContent.values = frozenValues(
    admitLoggingConfiguration(createHarnessConfiguration("codex", "gpt-4.1-mini"), "warn"),
  );
  const changed = deriveAdmittedConfigurationV1(value);
  assert.notEqual(changed.admittedConfigurationDigest, original);
  assert.equal(changed.projection.immutableConfigurationContent.values.logging.level, "warn");
});

test("the supported native env Secret reference is retained without resolved material", () => {
  const value = copy(fixture());
  const native = createHarnessConfiguration("openclaw", "gpt-4.1");
  native.secrets = { providers: { model: { source: "env", allowlist: ["MODEL_KEY"] } } };
  native.models.providers.openai.apiKey = { source: "env", provider: "model", id: "MODEL_KEY" };
  value.immutableConfigurationContent.values = frozenValues(
    admitLoggingConfiguration(native, "info"),
  );
  value.immutableConfigurationContent.secretBindings.MODEL_KEY =
    value.immutableConfigurationContent.secretBindings.DATA_TOKEN;
  const result = deriveAdmittedConfigurationV1(value);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        result.projection.immutableConfigurationContent.values.models.providers.openai.apiKey,
      ),
    ),
    { source: "env", provider: "model", id: "MODEL_KEY" },
  );
  value.immutableConfigurationContent.values = copy(value.immutableConfigurationContent.values);
  value.immutableConfigurationContent.values.models.providers.openai.apiKey = "inline-secret";
  assert.throws(() => deriveAdmittedConfigurationV1(value), AdmittedConfigurationError);
});

test("unsupported native fields and unnormalized admitted logging reject", () => {
  for (const change of [
    (v) => {
      v.immutableConfigurationContent.values.arbitraryPlugin = {};
    },
    (v) => {
      v.immutableConfigurationContent.values.agents.defaults.temperature = 1;
    },
    (v) => {
      v.immutableConfigurationContent.values.plugins.entries.codex.config.appServer.extra = true;
    },
    (v) => {
      delete v.immutableConfigurationContent.values.logging;
    },
    (v) => {
      v.immutableConfigurationContent.values.logging.consoleLevel = "error";
    },
    (v) => {
      // Native redaction owns this retired setting; admitted snapshots must omit it.
      v.immutableConfigurationContent.values.logging.redactSensitive = "tools";
    },
    (v) => {
      v.immutableConfigurationContent.values.diagnostics.otel.logs = true;
    },
    (v) => {
      v.immutableConfigurationContent.values.gateway.auth.token = "inline-secret";
    },
  ])
    rejects(change);
});

test("native environment sources require their exact typed Secret binding", () => {
  const value = copy(fixture());
  const native = createHarnessConfiguration("openclaw", "gpt-4.1");
  native.secrets = { providers: { model: { source: "env", allowlist: ["UNBOUND_KEY"] } } };
  native.models.providers.openai.apiKey = { source: "env", provider: "model", id: "UNBOUND_KEY" };
  value.immutableConfigurationContent.values = frozenValues(
    admitLoggingConfiguration(native, "info"),
  );
  assert.throws(() => deriveAdmittedConfigurationV1(value), AdmittedConfigurationError);
  value.immutableConfigurationContent.secretBindings.UNBOUND_KEY =
    value.immutableConfigurationContent.secretBindings.DATA_TOKEN;
  assert.doesNotThrow(() => deriveAdmittedConfigurationV1(value));
});

test("null, fractions, negative and unsafe integers are never coerced into this domain", () => {
  for (const value of [null, -0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    rejects((v) => {
      v.configurationGeneration = value;
    });
  rejects((v) => {
    v.immutableConfigurationContent.values.models.providers.codex.models[0].name = null;
  });
  rejects((v) => {
    v.resolvedProfileBindingParameters.serviceAccountAssociation = null;
  });
  rejects((v) => {
    delete v.resolvedProfileBindingParameters.serviceAccountAssociation;
  });
});

test("full exact typed refs reject foreign scope, malformed IDs and reserved delivery", () => {
  for (const change of [
    (v) => {
      v.immutableConfigurationContent.secretBindings.DATA_TOKEN.source.namespaceId = id("ns", 99);
    },
    (v) => {
      v.immutableConfigurationContent.secretBindings.DATA_TOKEN.source.id = "secret-name";
    },
    (v) => {
      v.immutableConfigurationContent.secretBindings.PATH =
        v.immutableConfigurationContent.secretBindings.DATA_TOKEN;
    },
    (v) => {
      v.immutableConfigurationContent.secretBindings.DATA_TOKEN.source.backendRef = {};
    },
    (v) => {
      v.immutableConfigurationContent.secretBindings.DATA_TOKEN.delivery = { type: "file" };
    },
    (v) => {
      v.resolvedProfileBindingParameters.serviceAccountAssociation.serviceAccount.credential.kind =
        "oauth_access_token";
    },
    (v) => {
      v.resolvedProfileBindingParameters.serviceAccountAssociation.serviceAccount.credential.value =
        "secret";
    },
  ])
    rejects(change);
});

test("missing roles, duplicate role identities and realized provider fields reject", () => {
  rejects((v) => {
    delete v.resolvedProfileBindingParameters.roleBindings.storage;
  });
  rejects((v) => {
    v.resolvedProfileBindingParameters.roleBindings.storage.ref =
      v.resolvedProfileBindingParameters.roleBindings.runtime.ref;
  });
  for (const key of ["podUid", "assignmentId", "effectId", "admissionState", "authorized"])
    rejects((v) => {
      v.resolvedProfileBindingParameters[key] = "not-a-binding";
    });
});

test("logical stores require both components, unique members and no path traversal", () => {
  rejects((v) => {
    v.resolvedProfileBindingParameters.storePolicyBindings.pop();
  });
  rejects((v) => {
    v.resolvedProfileBindingParameters.storePolicyBindings.push(
      v.resolvedProfileBindingParameters.storePolicyBindings[0],
    );
  });
  rejects((v) => {
    v.resolvedProfileBindingParameters.storePolicyBindings[0].path = "/state/../other";
  });
  rejects((v) => {
    v.resolvedProfileBindingParameters.storePolicyBindings[0].pvcUid = "uid";
  });
  rejects((v) => {
    v.resolvedProfileBindingParameters.storePolicyBindings[0].store.version = 0;
  });
  rejects((v) => {
    const original = v.resolvedProfileBindingParameters.storePolicyBindings[0];
    v.resolvedProfileBindingParameters.storePolicyBindings.push({ ...original, name: "alias" });
  });
});

test("plain object boundary does not execute getters, toJSON or proxy hooks", () => {
  let called = 0;
  const value = fixture();
  Object.defineProperty(value, "configurationGeneration", {
    enumerable: true,
    get() {
      called++;
      return 3;
    },
  });
  assert.throws(() => deriveAdmittedConfigurationV1(value), AdmittedConfigurationError);
  assert.throws(
    () =>
      deriveAdmittedConfigurationV1(
        new Proxy(
          {},
          {
            ownKeys() {
              called++;
              return [];
            },
          },
        ),
      ),
    AdmittedConfigurationError,
  );
  assert.equal(called, 0);
  rejects((v) => {
    v.toJSON = () => fixture();
  });
});

test("retained bytes reject duplicate keys, malformed UTF8 and oversized input", () => {
  const value = JSON.stringify(fixture());
  const duplicate = value.replace(
    '"configurationGeneration":3',
    '"configurationGeneration":3,"configurationGeneration":4',
  );
  for (const input of [
    new TextEncoder().encode(duplicate),
    new Uint8Array([0xff]),
    new Uint8Array(65_537),
  ])
    assert.throws(() => decodeAdmittedConfigurationV1(input), AdmittedConfigurationError);
  const result = decodeAdmittedConfigurationV1(bytes(fixture()));
  assert.equal(result.projection.configurationGeneration, 3);
});

test("the closed projection does not accept a copied digest in place of admitted content", () => {
  rejects((v) => {
    v.immutableConfigurationContent = { admittedConfigurationDigest: digest("a") };
  });
  rejects((v) => {
    v.configurationVersion = v.configurationGeneration;
    delete v.configurationGeneration;
  });
  assert.throws(() => deriveAdmittedConfigurationV1(undefined), AdmittedConfigurationError);
});
