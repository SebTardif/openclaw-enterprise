import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDENTIAL_STORAGE_LIMITS_V1 as limits,
  CredentialStorageContractErrorV1,
  CredentialStorageSchemasV1,
  SECURITY_EVENT_POLICY,
  parseCredentialStorageV1 as parse,
  parseCredentialStorageJsonV1 as parseJson,
  canonicalCredentialStorageRequestV1 as canonical,
  credentialAffectedFilterDigestV1 as filterDigest,
  credentialStorageExternalDenialV1,
} from "../../packages/contracts/src/index.ts";
import * as v from "../fixtures/credential-storage-v1/vectors.mjs";
import { protocolTraces } from "../fixtures/credential-storage-v1/traces.mjs";

const invalid = (kind, value) =>
  assert.throws(() => parse(kind, value), {
    name: "CredentialStorageContractErrorV1",
    message: "Invalid credential storage V1 value.",
  });
const invalidJson = (kind, value) =>
  assert.throws(() => parseJson(kind, value), CredentialStorageContractErrorV1);
function frozen(value) {
  if (value !== null && typeof value === "object") {
    assert.equal(Object.isFrozen(value), true);
    for (const item of Object.values(value)) frozen(item);
  }
}
function objectPaths(value, path = []) {
  if (value === null || typeof value !== "object") return [];
  return [
    ...(Array.isArray(value) ? [] : [path]),
    ...Object.entries(value).flatMap(([key, item]) => objectPaths(item, [...path, key])),
  ];
}
function atPath(value, path) {
  return path.reduce((item, key) => item[key], value);
}
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  return value;
}

test("supported package exports parse every storage dictionary and return detached immutable values", () => {
  assert.deepEqual(Object.keys(v.samples).sort(), Object.keys(CredentialStorageSchemasV1).sort());
  for (const [kind, make] of Object.entries(v.samples)) {
    const input = make();
    const result = parse(kind, input);
    assert.deepEqual(result, input, kind);
    assert.notEqual(result, input, kind);
    frozen(result);
    assert.deepEqual(parseJson(kind, JSON.stringify(input)), result, kind);
  }
  const input = v.reserve();
  const result = parse("reserve", input);
  input.original.assignmentRef.id = v.id(99);
  input.grant.repositoryIds.push("303");
  assert.equal(result.original.assignmentRef.id, v.id(4));
  assert.deepEqual(result.grant.repositoryIds, ["101", "202"]);
  assert.throws(() => {
    result.binding.secretVersion = 2;
  }, TypeError);
});

test("every nested dictionary rejects extra fields and unsupported schema versions", () => {
  for (const [kind, make] of Object.entries(v.samples)) {
    for (const path of objectPaths(make())) {
      const value = make();
      const object = atPath(value, path);
      object.unrecognized = "not-part-of-the-contract";
      invalid(kind, value);
      delete object.unrecognized;
      if (Object.hasOwn(object, "schemaVersion")) {
        object.schemaVersion = 2;
        invalid(kind, value);
      }
    }
  }
  for (const kind of ["future", "__proto__", "constructor", "toString", null])
    invalid(kind, v.reserve());
});

test("unknown methods, purposes, tags and result reason pairs fail closed", () => {
  invalid("reserve", { ...v.reserve(), method: "mint" });
  invalid("namedUse", { ...v.namedUse(), purpose: "interactive-login" });
  invalid("profile", { ...v.profile(), kind: "workload-selected" });
  invalid("mintOutcome", { ...v.mintOutcome(), outcome: "success" });
  invalid("record", { ...v.tokenRecord(), state: "deleted" });
  invalid("reservationResult", { kind: "denied", reason: "provider-unavailable" });
  invalid("reservationResult", { kind: "unavailable", reason: "scope-hidden" });
  invalid("reservationResult", { kind: "conflict", reason: "authority-denied" });
  invalid("operationResult", { kind: "not-found", nextAction: "mint-again" });
  invalid("operationResult", { ...v.operationResult(), nextAction: "current-authority" });
});

test("parser rejects non-JSON objects without invoking supplied accessors", () => {
  let calls = 0;
  for (const key of ["method", "toJSON"]) {
    const request = v.reserve();
    Object.defineProperty(request, key, {
      enumerable: true,
      get() {
        calls++;
        throw new Error("must not run");
      },
    });
    invalid("reserve", request);
  }
  const nested = v.reserve();
  Object.defineProperty(nested.binding, "secretVersion", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  invalid("reserve", nested);
  assert.equal(calls, 0);
  const handler = {
    get() {
      calls++;
      throw new Error("must not run");
    },
    getPrototypeOf() {
      calls++;
      throw new Error("must not run");
    },
    ownKeys() {
      calls++;
      throw new Error("must not run");
    },
    getOwnPropertyDescriptor() {
      calls++;
      throw new Error("must not run");
    },
  };
  invalid("reserve", new Proxy(v.reserve(), handler));
  const proxyBinding = v.reserve();
  proxyBinding.binding = new Proxy(proxyBinding.binding, handler);
  invalid("reserve", proxyBinding);
  const proxyArray = v.reserve();
  proxyArray.grant.repositoryIds = new Proxy(proxyArray.grant.repositoryIds, handler);
  invalid("reserve", proxyArray);
  assert.equal(calls, 0);
  for (const extra of [Symbol("hidden"), "hidden"]) {
    const request = v.reserve();
    Object.defineProperty(request, extra, { value: true, enumerable: false });
    invalid("reserve", request);
  }
  invalid("reserve", Object.assign(Object.create({ inherited: true }), v.reserve()));
  const arrayPrototype = v.reserve();
  Object.setPrototypeOf(arrayPrototype.grant.repositoryIds, null);
  invalid("reserve", arrayPrototype);
  const sparse = v.reserve();
  delete sparse.grant.repositoryIds[0];
  invalid("reserve", sparse);
  const arrayProperty = v.reserve();
  arrayProperty.grant.repositoryIds.extra = "hidden-scope";
  invalid("reserve", arrayProperty);
  const cyclic = v.reserve();
  cyclic.original = cyclic;
  invalid("reserve", cyclic);
  for (const value of [undefined, 1n, () => {}, new Date(), new Map(), new Set(), NaN, Infinity])
    invalid("reserve", value);
  assert.deepEqual(parse("reserve", Object.assign(Object.create(null), v.reserve())), v.reserve());
});

test("JSON decoder rejects duplicate decoded keys at every depth, invalid syntax and hostile depth", () => {
  const text = JSON.stringify(v.reserve());
  for (const duplicate of [
    text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    text.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
    text.replace('"bindingVersion":1', '"bindingVersion":1,"bindingVersion":1'),
    text.replace('"name":"contents"', '"name":"contents","name":"contents"'),
  ])
    invalidJson("reserve", duplicate);
  for (const text of [
    "",
    "{",
    "{} trailing",
    "[1,]",
    '{"method":undefined}',
    "\u0000{}",
    '"\\uZZZZ"',
  ])
    invalidJson("reserve", text);
  let deep = {};
  for (let depth = 0; depth <= limits.maxJsonDepth; depth++) deep = { child: deep };
  invalid("reserve", { ...v.reserve(), original: deep });
  invalidJson("reserve", JSON.stringify({ ...v.reserve(), original: deep }));
  invalidJson("reserve", '{"__proto__":{"polluted":true}}');
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("raw JSON numeric lexemes cannot round or alias into valid versions and counters", () => {
  // Preserve the original lexemes: object parsing cannot recover text after JS rounds it.
  for (const [kind, value, field] of [
    ["mintOutcome", v.mintOutcome(), "expectedInventoryVersion"],
    ["reserve", v.reserve(), "lifecycleGeneration"],
  ]) {
    const text = JSON.stringify(value);
    for (const lexeme of [
      "9007199254740991.1",
      "1.0000000000000001",
      "1.0",
      "1e0",
      "-0",
      "9007199254740992",
    ]) {
      invalidJson(kind, text.replace(`"${field}":1`, `"${field}":${lexeme}`));
    }
    parseJson(kind, text.replace(`"${field}":1`, `"${field}":9007199254740991`));
  }
  invalidJson(
    "reserve",
    JSON.stringify(v.reserve()).replace('"schemaVersion":1', '"schemaVersion":1.0000000000000001'),
  );
  const page = v.affectedPage([]);
  const pageJson = JSON.stringify(page);
  assert.deepEqual(parseJson("affectedPage", pageJson), page);
  invalidJson("affectedPage", pageJson.replace('"outstandingCount":0', '"outstandingCount":-0'));
  assert.deepEqual(
    parseJson("backendRequirements", JSON.stringify(v.backendRequirements())),
    v.backendRequirements(),
  );
});

test("wire byte ceilings include whitespace and differ for requests and responses", () => {
  for (const [kind, value, max] of [
    ["reserve", v.reserve(), limits.maxRequestBytes],
    ["operationResult", { kind: "not-visible" }, limits.maxResponseBytes],
  ]) {
    const text = JSON.stringify(value);
    const remaining = max - Buffer.byteLength(text);
    assert.deepEqual(parseJson(kind, text + " ".repeat(remaining)), value);
    invalidJson(kind, text + " ".repeat(remaining + 1));
  }
});

test("repository grant canonical ordering prevents duplicate or broader scope encodings", () => {
  const maximum = v.repositoryGrant();
  maximum.repositoryIds = Array.from({ length: limits.maxRepositoryIds }, (_, i) =>
    String(100 + i),
  );
  parse("repositoryGrant", maximum);
  maximum.repositoryIds.push("999");
  invalid("repositoryGrant", maximum);
  for (const repositoryIds of [
    [],
    ["101", "101"],
    ["202", "101"],
    ["0"],
    ["01"],
    ["*"],
    ["owner/repo"],
    ["1".repeat(21)],
    [101],
  ])
    invalid("repositoryGrant", { ...v.repositoryGrant(), repositoryIds });
  parse("repositoryGrant", { ...v.repositoryGrant(), repositoryIds: ["1".repeat(20)] });
  for (const permissions of [
    [],
    [{ name: "metadata", access: "write" }],
    [{ name: "administration", access: "write" }],
    [
      { name: "contents", access: "read" },
      { name: "contents", access: "write" },
    ],
    [
      { name: "metadata", access: "read" },
      { name: "contents", access: "read" },
    ],
    Array.from({ length: limits.maxPermissions + 1 }, () => ({ name: "contents", access: "read" })),
  ])
    invalid("repositoryGrant", { ...v.repositoryGrant(), permissions });
});

test("scope, provider account and permission profile must agree within a request", () => {
  for (const [field, prefix] of [
    ["installationId", "ins"],
    ["namespaceId", "ns"],
    ["agentId", "agt"],
  ]) {
    for (const nested of ["original", "profile", "binding"]) {
      const request = v.reserve();
      request[nested].scope[field] = `${prefix}_${v.id(90)}`;
      invalid("reserve", request);
    }
  }
  for (const field of ["ref", "version", "digest"]) {
    const request = v.reserve();
    request.binding.account[field] =
      field === "version" ? 2 : field === "digest" ? `sha256:${"b".repeat(64)}` : "account/other";
    invalid("reserve", request);
    const grant = v.reserve();
    grant.grant.permissionProfile[field] = request.binding.account[field];
    invalid("reserve", grant);
  }
  const provider = v.reserve();
  provider.binding.providerId = "provider/other";
  invalid("reserve", provider);
  const installation = v.reserve();
  installation.grant.providerInstallationRef = "provider-installation/other";
  invalid("reserve", installation);
  const observation = v.authorityObservation();
  observation.original.scope.agentId = `agt_${v.id(90)}`;
  invalid("authorityObservation", observation);
  const query = v.affectedQuery();
  query.filter.scope.namespaceId = `ns_${v.id(90)}`;
  invalid("affectedQuery", query);
});

test("mode, purpose and material-cache partitions cannot switch credential classes", () => {
  for (const mode of ["native", "mediated", "history-isolated"])
    parse("profile", v.profile("repository", mode));
  parse("profile", v.profile("model"));
  for (const mode of ["native", "history-isolated", "direct-login"])
    invalid("profile", { ...v.profile("model"), mode });
  invalid("reserve", { ...v.reserve(), profile: v.profile("model") });
  invalid("namedUse", { ...v.namedUse("model"), profile: v.profile() });
  invalid("namedUse", { ...v.namedUse(), profile: v.profile("model") });
  for (const mode of ["mediated", "history-isolated"])
    invalid("deliver", { ...v.deliver(), profile: v.profile("repository", mode) });
  parse("cachePartition", v.cachePartition("model"));
  invalid("cachePartition", { ...v.cachePartition("model"), profile: v.profile() });
  invalid("cachePartition", { ...v.cachePartition(), authority: v.authorityObservation() });
  const foreign = v.cachePartition();
  foreign.binding.secretVersion = 2;
  assert.notDeepEqual(
    parse("cachePartition", foreign),
    parse("cachePartition", v.cachePartition()),
  );
});

test("backend requirements describe required capabilities without claiming an implemented backend", () => {
  for (const auditCoupling of ["same-transaction", "durable-outbox"])
    parse("backendRequirements", { ...v.backendRequirements(), auditCoupling });
  for (const [field, value] of Object.entries(v.backendRequirements())) {
    if (value === true)
      invalid("backendRequirements", { ...v.backendRequirements(), [field]: false });
  }
  invalid("backendRequirements", { ...v.backendRequirements(), auditCoupling: "best-effort" });
  invalid("backendRequirements", { ...v.backendRequirements(), verified: true });
});

test("protected model bindings represent all three external credential setup classes", () => {
  for (const credentialClass of ["api-key", "trusted-login", "workload-federation"]) {
    const binding = parse("modelBinding", v.modelBinding(credentialClass));
    assert.equal(binding.profile.credentialClass, credentialClass);
    assert.equal(binding.custody, "external-protected-owner");
    assert.equal(
      binding.setup.invocationMaterial,
      credentialClass === "api-key" ? "api-key" : "access-token-and-account-context",
    );
    parse("namedUse", v.namedUse("model", credentialClass));
    parse("cachePartition", v.cachePartition("model", credentialClass));
  }
});

test("model setup class, invocation kind and lifecycle owner are closed and required", () => {
  for (const credentialClass of ["api-key", "trusted-login", "workload-federation"]) {
    const binding = v.modelBinding(credentialClass);
    for (const otherClass of ["api-key", "trusted-login", "workload-federation"].filter(
      (value) => value !== credentialClass,
    )) {
      invalid("modelBinding", { ...binding, setup: v.modelBinding(otherClass).setup });
    }
    const ownerField = credentialClass === "api-key" ? "rotationOwnerRef" : "refreshOwnerRef";
    for (const field of [ownerField, "lifecycleProfile"]) {
      const missing = structuredClone(binding);
      delete missing.setup[field];
      invalid("modelBinding", missing);
    }
    invalid("modelBinding", {
      ...binding,
      setup: { ...binding.setup, invocationMaterial: "login-and-refresh-state" },
    });
    invalid("modelBinding", { ...binding, custody: "agent-runtime" });
  }
  invalid("modelBinding", { ...v.modelBinding(), profile: v.profile() });
});

test("model named use and cache partitions require the exact binding owner and profile", () => {
  for (const [kind, make] of [
    ["namedUse", v.namedUse],
    ["cachePartition", v.cachePartition],
  ]) {
    const missing = make("model");
    delete missing.modelBinding;
    invalid(kind, missing);
    for (const mutate of [
      (value) => {
        value.scope.agentId = `agt_${v.id(90)}`;
      },
      (value) => {
        value.binding.driverId = "driver/other";
      },
      (value) => {
        value.binding.secretVersion = 2;
      },
      (value) => {
        value.binding.account.version = 2;
      },
      (value) => {
        value.profile.profile.version = 2;
      },
      (value) => {
        value.profile.modelProfile = v.ref("model-other");
      },
      (value) => {
        value.profile.transport.version = 2;
      },
    ]) {
      const input = make("model");
      mutate(input.modelBinding);
      invalid(kind, input);
    }
  }
});

test("model metadata never admits serialized login, refresh, invocation or account-header material", () => {
  for (const credentialClass of ["api-key", "trusted-login", "workload-federation"]) {
    for (const field of [
      "apiKey",
      "loginState",
      "refreshToken",
      "accessToken",
      "accountHeaders",
      "authorization",
      "credentialStorePath",
    ]) {
      const binding = v.modelBinding(credentialClass);
      invalid("modelBinding", { ...binding, [field]: "synthetic-forbidden-material" });
      invalid("modelBinding", {
        ...binding,
        setup: { ...binding.setup, [field]: "synthetic-forbidden-material" },
      });
    }
  }
});

test("canonical model use binds account-link, workspace, invocation and lifecycle selections", () => {
  const request = v.namedUse("model", "trusted-login");
  const expected = canonical("namedUse", request);
  for (const mutate of [
    (value) => {
      value.accountLink.version = 2;
    },
    (value) => {
      value.upstreamWorkspaceRef = "upstream-workspace/other";
    },
    (value) => {
      value.invocationProfile.version = 2;
    },
    (value) => {
      value.setup.lifecycleProfile.version = 2;
    },
    (value) => {
      value.setup.refreshOwnerRef = "owner/other-refresh";
    },
  ]) {
    const input = structuredClone(request);
    mutate(input.modelBinding);
    assert.notEqual(canonical("namedUse", input), expected);
  }
});

test("rotation retains binding ownership and advances exactly the binding CAS version", () => {
  for (const patch of [
    { bindingVersion: 1 },
    { bindingVersion: 3 },
    { secretVersion: 1 },
    { bindingRef: "binding/other" },
    { secretId: `sec_${v.id(90)}` },
    { driverId: "driver/other" },
  ])
    invalid("rotate", { ...v.rotate(), replacement: { ...v.rotate().replacement, ...patch } });
  const rotated = v.rotate();
  rotated.replacement.secretVersion = 3;
  parse("rotate", rotated);
});

test("versions and deadlines have explicit safe numeric and temporal boundaries", () => {
  for (const version of [1, Number.MAX_SAFE_INTEGER])
    parse("reserve", { ...v.reserve(), authorityVersion: version });
  for (const version of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    invalid("reserve", { ...v.reserve(), authorityVersion: version });
  for (const ms of [1, limits.maxCallMs]) parse("reserve", { ...v.reserve(), deadline: v.at(ms) });
  for (const ms of [0, -1, limits.maxCallMs + 1])
    invalid("reserve", { ...v.reserve(), deadline: v.at(ms) });
  for (const deadline of [
    "2026-02-30T00:00:00.000Z",
    "2026-01-01T00:00:05Z",
    "2026-01-01T00:00:05.000+00:00",
  ])
    invalid("reserve", { ...v.reserve(), deadline });
  invalid("originalBinding", { ...v.originalBinding(), turnNotAfter: v.at(900_001) });
  invalid("originalBinding", { ...v.originalBinding(), turnNotAfter: v.now });
  for (const patch of [
    { startNotAfter: v.now },
    { startNotAfter: v.at(5_001) },
    { leaseNotAfter: v.at(4_999) },
    { leaseNotAfter: v.at(900_001) },
  ])
    invalid("authorityObservation", { ...v.authorityObservation(), ...patch });
});

test("every represented generation and CAS version rejects unsafe or noninteger values", () => {
  for (const [kind, make] of Object.entries(v.samples)) {
    const sample = make();
    for (const path of objectPaths(sample)) {
      for (const [field, value] of Object.entries(atPath(sample, path))) {
        if (typeof value !== "number" || !/(?:Version|Generation)$|^version$/.test(field)) continue;
        for (const invalidVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
          const input = make();
          atPath(input, path)[field] = invalidVersion;
          invalid(kind, input);
        }
      }
    }
  }
});

test("authority comparisons and provider expiry evidence cannot precede their required facts", () => {
  invalid("authorityObservation", {
    ...v.authorityObservation(),
    comparedAt: v.at(-1),
    startNotAfter: v.at(4_999),
  });
  for (const outcome of ["accepted", "unknown-expiry-established", "unknown-expired"]) {
    const input = v.mintOutcome(outcome);
    input.expiry.observedAt = new Date(Date.parse(input.observedAt) + 1).toISOString();
    invalid("mintOutcome", input);
  }
  const revoke = v.revocationOutcome("expired");
  revoke.expiry.observedAt = v.at(3_602_001);
  invalid("revocationOutcome", revoke);
});

test("use and delivery diagnostics exclude local callback values, custody and replay instructions", () => {
  for (const [kind, make] of [
    ["useResult", v.useResult],
    ["deliveryResult", v.deliveryResult],
  ]) {
    invalid(kind, { ...make(), value: "local-only-result" });
    invalid(kind, { ...make(), token: {} });
    invalid(kind, {
      ...make(),
      audit: {
        state: "evidence-missing",
        eventRef: v.audit().eventRef,
        incidentRef: "incident/example",
      },
    });
  }
  parse("useResult", {
    kind: "effect-unknown",
    reason: "provider-outcome-unknown",
    operationRef: "operation/use",
    nextAction: "exact-readback-only",
  });
  parse("deliveryResult", {
    kind: "delivery-unknown",
    operationRef: "operation/deliver",
    deliveryRef: "delivery/example",
    nextAction: "exact-readback-only",
  });
  invalid("deliveryResult", {
    kind: "delivery-unknown",
    operationRef: "operation/deliver",
    deliveryRef: "delivery/example",
    nextAction: "deliver-again",
  });
});

test("canonical retries preserve every semantic field while varying only call correlation and bounds", () => {
  const request = v.reserve();
  const { requestId, createdAt, deadline, ...semantic } = request;
  assert.deepEqual(JSON.parse(canonical("reserve", request)), semantic);
  assert.equal(canonical("reserve", request), canonical("reserve", reverseKeys(request)));
  const retry = {
    ...request,
    requestId: `req_${v.id(90)}`,
    createdAt: v.at(1_000),
    deadline: v.at(6_000),
  };
  assert.equal(canonical("reserve", request), canonical("reserve", retry));
  const changed = [
    { ...request, operationRef: "operation/other" },
    { ...request, callerServiceRef: "service/other" },
    { ...request, originalAuditRef: `aud_${v.id(90)}` },
    { ...request, authorityVersion: 2 },
    { ...request, invalidationVersion: 2 },
    {
      ...request,
      original: { ...request.original, assignmentRef: { schemaVersion: 1, id: v.id(90) } },
    },
    { ...request, original: { ...request.original, turnRef: "turn/other" } },
    { ...request, original: { ...request.original, attemptRef: "attempt/other" } },
    { ...request, binding: { ...request.binding, secretVersion: 2 } },
    { ...request, profile: { ...request.profile, mode: "mediated" } },
    { ...request, grant: { ...request.grant, repositoryIds: ["101"] } },
  ];
  for (const value of changed)
    assert.notEqual(canonical("reserve", value), canonical("reserve", request));
  for (const [kind, make, field] of [
    ["mintOutcome", v.mintOutcome, "expectedInventoryVersion"],
    ["claimRevocation", v.claimRevocation, "expectedRevocationVersion"],
    ["revocationOutcome", v.revocationOutcome, "claimVersion"],
    ["rotate", v.rotate, "expectedInvalidationVersion"],
  ]) {
    assert.notEqual(
      canonical(kind, make()),
      canonical(kind, { ...make(), [field]: 2 === make()[field] ? 3 : 2 }),
    );
  }
  assert.throws(() => canonical("record", v.tokenRecord()), CredentialStorageContractErrorV1);
});

test("repository named use requires and canonically binds the preknown attempt and inventory claim", () => {
  const request = v.namedUse();
  for (const field of ["providerAttemptRef", "expectedInventoryVersion"]) {
    const missing = structuredClone(request);
    delete missing[field];
    invalid("namedUse", missing);
  }
  const original = canonical("namedUse", request);
  for (const patch of [
    { providerAttemptRef: "provider-attempt/other" },
    { expectedInventoryVersion: 2 },
    { operationRef: "operation/other-use" },
  ])
    assert.notEqual(canonical("namedUse", { ...request, ...patch }), original);
  assert.equal(
    canonical("namedUse", {
      ...request,
      requestId: `req_${v.id(90)}`,
      createdAt: v.at(1_000),
      deadline: v.at(6_000),
    }),
    original,
  );
  invalid("namedUse", { ...v.namedUse("model"), providerAttemptRef: request.providerAttemptRef });
});

test("fresh reservation receipts identify the exact embedded issuance and intent", () => {
  const reserved = v.reservationResult();
  parse("reservationResult", reserved);
  for (const mismatch of [
    { operationRef: "operation/other-reservation" },
    { intentDigest: v.digest },
  ]) {
    invalid("reservationResult", {
      ...reserved,
      receipt: { ...reserved.receipt, ...mismatch },
    });
  }
});

test("later write and claim receipts retain their own operation identity", () => {
  for (const [kind, value] of [
    ["writeResult", v.writeResult()],
    ["claimResult", v.claimResult()],
  ]) {
    const parsed = parse(kind, value);
    assert.notEqual(parsed.receipt.operationRef, parsed.record.issuance.operationRef);
    assert.notEqual(parsed.receipt.intentDigest, parsed.record.target.intentDigest);
  }
});

test("records bind original operation, complete original assignment intent and inventory receipt version", () => {
  for (const patch of [{ issuanceOperationRef: "operation/other" }, { intentDigest: v.digest }])
    invalid("record", { ...v.tokenRecord(), target: { ...v.locator(), ...patch } });
  const reassigned = v.tokenRecord();
  reassigned.issuance.original.assignmentRef.id = v.id(90);
  invalid("record", reassigned);
  const scopeChanged = v.tokenRecord();
  scopeChanged.issuance.original.scope.agentId = `agt_${v.id(90)}`;
  invalid("record", scopeChanged);
  const receipt = v.reservationResult();
  receipt.receipt.inventoryVersion = 2;
  invalid("reservationResult", receipt);
  const olderInvalidation = v.tokenRecord();
  olderInvalidation.issuance.invalidationVersion = 2;
  olderInvalidation.target = v.locator(olderInvalidation.issuance);
  invalid("record", olderInvalidation);
});

test("known accepted tokens with unproved expiry or scope remain retained and mitigation-only", () => {
  for (const patch of [
    { expiry: { kind: "expiry-unproven" } },
    { returnedScope: { status: "mismatch", evidenceRef: "evidence/scope" } },
    { returnedScope: { status: "unproved", evidenceRef: "evidence/scope" } },
    { invalidationVersion: 2 },
  ]) {
    invalid("record", { ...v.tokenRecord(), ...patch });
    const retained = parse("record", {
      ...v.tokenRecord(),
      ...patch,
      disposition: "mitigation-only",
    });
    assert.equal(retained.tokenRef, "token/example");
    assert.equal(retained.protectedRevocationRef, "revocation-material/example");
  }
  for (const field of ["tokenRef", "protectedRevocationRef"]) {
    const known = v.mintOutcome();
    delete known[field];
    invalid("mintOutcome", known);
  }
  invalid("mintOutcome", { ...v.mintOutcome("unknown"), tokenRef: "token/invented" });
  for (const state of ["reserved", "mint-unknown", "not-issued"]) {
    parse("record", v.tokenRecord(state));
    invalid("record", { ...v.tokenRecord(state), tokenRef: "token/invented" });
  }
});

test("no-byte unknown issuance resolves only through represented expiry or independently evidenced broader revocation", () => {
  for (const outcome of [
    "unknown-expiry-established",
    "unknown-expired",
    "unknown-broader-revocation-confirmed",
  ]) {
    parse("mintOutcome", v.mintOutcome(outcome));
    invalid("mintOutcome", { ...v.mintOutcome(outcome), tokenRef: "token/invented" });
  }
  parse("record", { ...v.tokenRecord("mint-unknown"), expiry: v.expiry() });
  const expired = v.tokenRecord("resolved-without-token");
  parse("record", expired);
  parse("record", {
    ...expired,
    resolution: {
      kind: "broader-revocation-confirmed",
      observedAt: v.now,
      broaderRevocation: v.broaderRevocation(),
    },
  });
  invalid("record", { ...expired, disposition: "current-check-required" });
  invalid("record", { ...expired, tokenRef: "token/invented" });
  invalid("record", {
    ...expired,
    resolution: { ...expired.resolution, expiry: { kind: "expiry-unproven" } },
  });
  invalid("mintOutcome", { ...v.mintOutcome("unknown-expired"), observedAt: v.at(3_601_999) });
  const noResponsibility = v.mintOutcome("unknown-broader-revocation-confirmed");
  delete noResponsibility.broaderRevocation.responsibilityRef;
  invalid("mintOutcome", noResponsibility);
});

test("delivery metadata is native-only and uncertain delivery remains an inventory state", () => {
  for (const state of ["intent-recorded", "delivered", "unknown"]) {
    const record = v.tokenRecord();
    record.delivery = {
      state,
      deliveryRef: "delivery/example",
      deliveryOperationRef: "operation/deliver",
      observedAt: v.now,
    };
    parse("record", record);
    record.issuance.profile.mode = "mediated";
    record.target = v.locator(record.issuance);
    invalid("record", record);
  }
  invalid("deliver", { ...v.deliver(), expectedInventoryVersion: 0 });
  invalid("deliver", { ...v.deliver(), token: "unprotected-material" });
});

test("revocation outcomes remain distinct and expiry uses a conservative clock lower bound", () => {
  for (const outcome of ["confirmed", "pending", "unknown", "failed-terminal", "expired"])
    parse("revocationOutcome", v.revocationOutcome(outcome));
  const expired = v.revocationOutcome("expired");
  parse("revocationOutcome", expired);
  invalid("revocationOutcome", { ...expired, observedAt: v.at(3_601_999) });
  for (const uncertaintyMs of [-1, 0.5, 2_001])
    invalid("revocationOutcome", { ...expired, uncertaintyMs });
  invalid("revocationOutcome", { ...expired, expiry: { kind: "expiry-unproven" } });
  invalid("revocationOutcome", {
    ...v.revocationOutcome("unknown"),
    confirmationEvidenceRef: "evidence/not-confirmed",
  });
  const record = v.tokenRecord();
  record.revocation = {
    state: "unknown",
    version: 2,
    revocationOperationRef: "operation/revoke",
    attemptRef: "attempt/revoke",
    observedAt: v.now,
  };
  invalid("record", record);
  record.disposition = "mitigation-only";
  parse("record", record);
});

test("expired inventory rows agree on provider expiry without requiring identical evidence metadata", () => {
  const record = v.tokenRecord();
  record.disposition = "mitigation-only";
  record.revocation = {
    state: "expired",
    version: 2,
    observedAt: v.at(3_602_000),
    expiry: { ...v.expiry(), evidenceRef: "evidence/later-expiry", observedAt: v.at(1_000) },
    clockEvidenceRef: "evidence/clock",
    uncertaintyMs: 2_000,
  };
  parse("record", record);
  for (const expiresAt of [v.at(3_599_999), v.at(3_600_001)]) {
    invalid("record", { ...record, expiry: { ...record.expiry, expiresAt } });
  }
  parse("record", { ...record, expiry: { kind: "expiry-unproven" } });
  for (const expiry of [record.expiry, { kind: "expiry-unproven" }]) {
    invalid("record", {
      ...record,
      expiry,
      revocation: { ...record.revocation, observedAt: v.at(3_601_999) },
    });
  }
});

test("claim results bind claim CAS, lease and previous-attempt reconciliation exactly", () => {
  for (const prior of ["none", "pending", "unknown", "failed-terminal"])
    parse("claimResult", v.claimResult(prior));
  for (const patch of [
    { claimRef: "claim/other" },
    { claimVersion: 3 },
    { claimNotAfter: v.at(4_999) },
    { nextAction: "reconcile-previous-attempt" },
  ])
    invalid("claimResult", { ...v.claimResult(), ...patch });
  invalid("claimResult", { ...v.claimResult("unknown"), nextAction: "attempt-exact-revocation" });
  const expired = v.claimResult();
  expired.record.revocation.claimNotAfter = v.at(5_001);
  expired.claimNotAfter = v.at(5_001);
  invalid("claimResult", expired);
  const empty = v.claimResult();
  empty.record = v.tokenRecord("reserved");
  empty.receipt.inventoryVersion = 1;
  invalid("claimResult", empty);
  invalid("claimResult", { ...v.claimResult(), token: {} });
});

test("new-authority acceptance requires accepted audit while mitigation may retain an obligation or incident", () => {
  const alternatives = [
    {
      state: "obligation-recorded",
      eventRef: v.audit().eventRef,
      obligationRef: "obligation/example",
      commitRef: "commit/example",
    },
    { state: "evidence-missing", eventRef: v.audit().eventRef, incidentRef: "incident/example" },
  ];
  for (const audit of alternatives) {
    invalid("reservationResult", { ...v.reservationResult(), audit });
    invalid("rotationResult", { ...v.rotationResult(), audit });
    parse("record", { ...v.tokenRecord(), audit, disposition: "mitigation-only" });
    parse("claimResult", { ...v.claimResult(), audit });
  }
  invalid("reservationResult", {
    ...v.reservationResult(),
    audit: { ...v.audit(), source: "caller" },
  });
  parse("writeResult", {
    kind: "evidence-missing",
    operationRef: "operation/example",
    incidentRef: "incident/example",
    providerOutcome: "unknown",
    nextAction: "retain-unknown-and-exact-mitigation",
  });
});

test("affected queries and cursors have bounded exact filter identity", () => {
  const query = v.affectedQuery();
  for (const limit of [1, limits.maxInventoryPageItems])
    parse("affectedQuery", { ...query, limit });
  for (const limit of [0, 1.5, limits.maxInventoryPageItems + 1])
    invalid("affectedQuery", { ...query, limit });
  parse("affectedQuery", {
    ...query,
    cursor: { ...v.cursor(), continuation: "x".repeat(limits.maxCursorBytes) },
  });
  for (const continuation of ["", "x".repeat(limits.maxCursorBytes + 1), "raw/token", "é"])
    invalid("affectedQuery", { ...query, cursor: { ...v.cursor(), continuation } });
  assert.equal(
    filterDigest(query),
    filterDigest({ ...query, requestId: `req_${v.id(90)}`, limit: 1 }),
  );
  assert.notEqual(
    filterDigest(query),
    filterDigest({ ...query, filter: { ...query.filter, invalidationVersion: 3 } }),
  );
  invalid("affectedQuery", { ...query, cursor: { ...v.cursor(), filterDigest: v.digest } });
});

test("affected pages bind snapshot, authorized filter, unique rows and finite counts", () => {
  for (const patch of [
    { snapshotRef: "snapshot/other" },
    { snapshotVersion: 2 },
    { filterDigest: v.digest },
  ])
    invalid("affectedPage", { ...v.affectedPage(), next: { ...v.cursor(), ...patch } });
  invalid("affectedPage", { ...v.affectedPage(), filterDigest: v.digest });
  invalid("affectedPage", { ...v.affectedPage(), expiresAt: v.at(limits.snapshotMaxAgeMs + 1) });
  invalid("affectedPage", { ...v.affectedPage(), expiresAt: v.now });
  invalid("affectedPage", v.affectedPage([v.tokenRecord(), v.tokenRecord()]));
  const foreign = v.tokenRecord();
  foreign.issuance.binding.bindingRef = "binding/foreign";
  foreign.target = v.locator(foreign.issuance);
  invalid("affectedPage", v.affectedPage([foreign]));
  invalid("affectedPage", {
    ...v.affectedPage(),
    outstandingCount: 128,
    unresolvedIssuanceCount: 1,
  });
  invalid("affectedPage", { ...v.affectedPage(), outstandingCount: 129 });
  invalid("affectedPage", { ...v.affectedPage(), outstandingCount: 0 });
  invalid("affectedPage", {
    ...v.affectedPage([v.tokenRecord("reserved")]),
    unresolvedIssuanceCount: 0,
  });
  invalid("affectedPage", { ...v.affectedPage([]), next: v.cursor() });
  invalid("affectedPage", {
    ...v.affectedPage(),
    next: { ...v.cursor(), afterRecordRef: "record/other" },
  });
  invalid("affectedPage", {
    ...v.affectedPage(),
    outstandingCount: limits.maxOutstandingPerAgent + 1,
  });
  const rows = Array.from({ length: limits.maxInventoryPageItems }, (_, i) => {
    const issuance = v.reserve();
    issuance.operationRef = `operation/reserve-${i}`;
    const row = v.tokenRecord("not-issued", issuance);
    row.target.recordRef = `record/${i}`;
    return row;
  });
  parse("affectedPage", v.affectedPage(rows));
  invalid("affectedPage", v.affectedPage([...rows, v.tokenRecord()]));
  parse("affectedPage", { ...v.affectedPage([]), unresolvedIssuanceCount: 1 });
});

test("selected resource ceilings are frozen interface choices linked to the audit policy", () => {
  frozen(limits);
  assert.equal(limits.maxRequestBytes, 65_536);
  assert.equal(limits.maxResponseBytes, 262_144);
  assert.equal(
    limits.maxMaterialCacheBytes,
    limits.maxMaterialCacheEntries * limits.maxMaterialBytes,
  );
  assert.equal(limits.maxTokenBytes, 16_384);
  assert.equal(limits.maxOutstandingPerAgent, 4);
  assert.equal(limits.maxOutstandingPerInstallation, 128);
  assert.equal(limits.maxConcurrentIssuancePerScope, 1);
  assert.equal(limits.revokeBackoffMs.length + 1, limits.revokeAttemptsPerBurst);
  assert.equal(limits.auditAppendDeadlineMs, SECURITY_EVENT_POLICY.appendDeadlineMs);
  assert.equal(limits.terminalRetentionMs, SECURITY_EVENT_POLICY.retentionDays * 86_400_000);
  assert.ok(
    limits.githubRefreshMarginMs > limits.maxClockUncertaintyMs + limits.expirySafetyMarginMs,
  );
});

test("unauthorized projection is a constant immutable denial with no protected references", () => {
  const denied = credentialStorageExternalDenialV1();
  assert.deepEqual(denied, { schemaVersion: 1, code: "not-visible" });
  frozen(denied);
  for (const input of [
    v.reserve(),
    { providerResponse: "synthetic-provider-error", token: "synthetic-material" },
  ]) {
    assert.throws(
      () => parse("operationResult", input),
      (error) => {
        assert.equal(error.message, "Invalid credential storage V1 value.");
        assert.deepEqual(Object.keys(error), ["name"]);
        return true;
      },
    );
  }
});

test("immutable normative traces use actual exported schemas; backend actions are not executed here", () => {
  frozen(protocolTraces);
  for (const trace of protocolTraces) {
    for (const observation of trace.observations) {
      assert.deepEqual(parse(observation.schema, observation.value), observation.value, trace.name);
    }
  }
});
