import assert from "node:assert/strict";
import test from "node:test";
import {
  CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1,
  CREDENTIAL_BACKEND_PROFILE_LIMITS_V1,
  CredentialBackendProfileErrorV1,
  assessCredentialBackendProfileV1,
  parseCredentialBackendProfileV1,
  parseCredentialBackendProfileJsonV1,
} from "@openclaw-enterprise/contracts/credential-backend-profile-v1";
import {
  CREDENTIAL_STORAGE_LIMITS_V1,
  parseCredentialStorageV1,
  canonicalCredentialStorageRequestV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import { SECURITY_EVENT_POLICY } from "@openclaw-enterprise/contracts/security-events";
import { declaration, ref, id } from "../fixtures/credential-backend-profile-v1/vectors.mjs";
import {
  traces,
  unknownMint,
  mintUnknownRecord,
  emptyFinalPage,
  mint,
  readback,
} from "../fixtures/credential-backend-profile-v1/traces.mjs";

const invalid = (value) =>
  assert.throws(
    () => parseCredentialBackendProfileV1(value),
    (error) =>
      error instanceof CredentialBackendProfileErrorV1 &&
      error.message === "Invalid credential backend profile V1.",
  );

test("unprovided custody and unproved backend capabilities remain incomplete", () => {
  const result = assessCredentialBackendProfileV1(declaration());
  assert.equal(result.kind, "incomplete-declaration");
  assert.deepEqual(
    result.missingCapabilities,
    Object.keys(CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1),
  );
  assert.equal(result.runtimeAttestation, "not-established");
  assert.equal(result.authority, "not-granted");
});
for (const model of [false, true])
  test(`complete ${model ? "model" : "repository"} declarations remain unproved at runtime`, () => {
    const input = declaration({ complete: true, model });
    const result = assessCredentialBackendProfileV1(input);
    assert.equal(result.kind, "compatible-declaration");
    assert.deepEqual(result.missingCapabilities, []);
    assert.equal(result.runtimeAttestation, "not-established");
    assert.equal(result.authority, "not-granted");
    assert.deepEqual(parseCredentialBackendProfileJsonV1(JSON.stringify(input)), input);
  });
for (const name of Object.keys(CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1)) {
  test(`capability ${name} cannot be omitted or attributed to another owner`, () => {
    const absent = declaration({ complete: true });
    delete absent.capabilities[name];
    invalid(absent);
    const wrongOwner = declaration({ complete: true });
    wrongOwner.capabilities[name].adapter = ref("different-owner");
    invalid(wrongOwner);
  });
  test(`capability ${name} unsupported/unproved cannot yield compatibility`, () => {
    for (const status of ["unsupported", "unproved"]) {
      const input = declaration({ complete: true });
      input.capabilities[name] = { status, reason: "capability-unimplemented" };
      const result = assessCredentialBackendProfileV1(input);
      assert.equal(result.kind, "incomplete-declaration");
      assert.deepEqual(result.missingCapabilities, [name]);
    }
  });
}
const negativeEdits = {
  "unknown field": (v) => {
    v.extra = true;
  },
  "unknown nested field": (v) => {
    v.inventory.extra = true;
  },
  "unknown capability": (v) => {
    v.capabilities.extra = { status: "supported" };
  },
  "missing requirement": (v) => {
    delete v.requirements.externalCustody;
  },
  "false required capability": (v) => {
    v.requirements.externalCustody = false;
  },
  "unknown schema version": (v) => {
    v.schemaVersion = 2;
  },
  "remote process": (v) => {
    v.placement.kind = "remote-process";
  },
  "serialized handles": (v) => {
    v.placement.handleTransport = "json";
  },
  "workload custody": (v) => {
    v.placement.materialBoundary = "agent-execution";
  },
  "missing service identity": (v) => {
    delete v.placement.serviceIdentity;
  },
  "HTTP identity": (v) => {
    v.placement.serviceIdentity = "https://example.test/credential-owner";
  },
  "unknown backend": (v) => {
    v.namedSecret.kind = "generic-secret-store";
  },
  "missing object UID": (v) => {
    delete v.namedSecret.uid;
  },
  "missing object resourceVersion": (v) => {
    delete v.namedSecret.resourceVersion;
  },
  "mutable-only version policy": (v) => {
    v.namedSecret.versionPolicy = "kubernetes-resource-version";
  },
  "missing secret version": (v) => {
    delete v.namedSecret.binding.secretVersion;
  },
  "immutable version disagreement": (v) => {
    v.namedSecret.immutableVersionRecord.version++;
  },
  "secret binding disagreement": (v) => {
    v.cachePartition.binding.bindingRef = "other/example";
  },
  "secret driver disagreement": (v) => {
    v.cachePartition.binding.driverId = "other/example";
  },
  "provider disagreement": (v) => {
    v.cachePartition.profile.providerId = "other/example";
  },
  "account version disagreement": (v) => {
    v.cachePartition.profile.account.version++;
  },
  "Agent disagreement": (v) => {
    v.cachePartition.scope.agentId = `agt_${id(9)}`;
  },
  "installation disagreement": (v) => {
    v.inventory.installationId = `ins_${id(9)}`;
  },
  "missing database binding": (v) => {
    delete v.inventory.databaseBindingRef;
  },
  "missing journal binding": (v) => {
    delete v.inventory.journalBindingRef;
  },
  "separate transaction": (v) => {
    v.inventory.transaction = "same-database-new-transaction";
  },
  "method-local commit": (v) => {
    v.inventory.callbackGate = "method-return";
  },
  "outbox without selected mapping": (v) => {
    v.requirements.auditCoupling = "durable-outbox";
  },
  "blind retry": (v) => {
    v.inventory.uncertainty = "retry";
  },
  "evict unresolved": (v) => {
    v.inventory.capacity = "evict-oldest";
  },
  "audit-copy inventory retention": (v) => {
    v.inventory.terminalRetention = "audit-copy";
  },
  "unprovided supported custody": (v) => {
    v.custody = { kind: "unprovided" };
  },
  "missing encryption profile": (v) => {
    delete v.custody.encryptionAndKeyCustodyProfile;
  },
  "missing token custody": (v) => {
    delete v.custody.tokenBindingRef;
  },
  "missing revocation custody": (v) => {
    delete v.custody.revocationBindingRef;
  },
  "raw material property": (v) => {
    v.custody.token = "synthetic-forbidden-value";
  },
  "supported without evidence": (v) => {
    delete v.capabilities.externalCustody.evidenceRef;
  },
};
for (const [name, edit] of Object.entries(negativeEdits))
  test(`rejects ${name}`, () => {
    const input = declaration({ complete: true });
    edit(input);
    invalid(input);
  });
for (const name of Object.keys(CREDENTIAL_STORAGE_LIMITS_V1))
  test(`preserves inherited bound ${name}`, () => {
    const input = declaration({ complete: true });
    if (Array.isArray(input.bounds[name])) input.bounds[name][0]++;
    else input.bounds[name]++;
    invalid(input);
    const missing = declaration();
    delete missing.bounds[name];
    invalid(missing);
  });
test("audit append and terminal minimum retain their original policy constants", () => {
  const value = parseCredentialBackendProfileV1(declaration());
  assert.deepEqual(value.bounds, CREDENTIAL_STORAGE_LIMITS_V1);
  assert.equal(value.bounds.auditAppendDeadlineMs, SECURITY_EVENT_POLICY.appendDeadlineMs);
  assert.equal(value.bounds.terminalRetentionMs, SECURITY_EVENT_POLICY.retentionDays * 86400000);
});
test("model projection uses canonical model setup/profile consistency", () => {
  const value = declaration({ complete: true, model: true });
  value.cachePartition.modelBinding.setup.kind = "trusted-login";
  invalid(value);
});
test("parser returns an immutable copy without retaining input aliases", () => {
  const input = declaration();
  const value = parseCredentialBackendProfileV1(input);
  input.namedSecret.binding.secretVersion = 99;
  assert.equal(value.namedSecret.binding.secretVersion, 1);
  assert.ok(
    Object.isFrozen(value) &&
      Object.isFrozen(value.namedSecret.binding) &&
      Object.isFrozen(value.bounds.revokeBackoffMs),
  );
  assert.throws(() => {
    value.bounds.revokeBackoffMs.push(1);
  }, TypeError);
});
test("objects with accessors, proxies, custom prototypes or toJSON are rejected without execution", () => {
  let calls = 0;
  const getter = declaration();
  Object.defineProperty(getter, "schemaVersion", {
    enumerable: true,
    get() {
      calls++;
      return 1;
    },
  });
  invalid(getter);
  const proxy = new Proxy(declaration(), {
    ownKeys() {
      calls++;
      return [];
    },
  });
  invalid(proxy);
  const nested = declaration();
  nested.namedSecret = new Proxy(nested.namedSecret, {
    get() {
      calls++;
    },
  });
  invalid(nested);
  const custom = declaration();
  Object.setPrototypeOf(custom, {
    toJSON() {
      calls++;
    },
  });
  invalid(custom);
  const toJSON = declaration();
  toJSON.toJSON = () => {
    calls++;
  };
  invalid(toJSON);
  assert.equal(calls, 0);
});
test("overlong property names are rejected before serialization", (context) => {
  const input = declaration();
  input["x".repeat(CREDENTIAL_BACKEND_PROFILE_LIMITS_V1.maxStringCharacters + 1)] = true;
  const stringify = JSON.stringify;
  let serializationCalls = 0;
  // Observe the real serialization boundary without replacing its behavior.
  // This small input checks ordering; it is not a resource-exhaustion probe.
  context.mock.method(JSON, "stringify", function (...args) {
    serializationCalls++;
    return Reflect.apply(stringify, JSON, args);
  });
  invalid(input);
  assert.equal(serializationCalls, 0);
});

test("cyclic, sparse, symbolic, nonenumerable and nonfinite values are rejected", () => {
  const cyclic = declaration();
  cyclic.extra = cyclic;
  invalid(cyclic);
  const sparse = declaration();
  delete sparse.bounds.revokeBackoffMs[0];
  invalid(sparse);
  const symbol = declaration();
  symbol[Symbol("extra")] = 1;
  invalid(symbol);
  const hidden = declaration();
  Object.defineProperty(hidden, "hidden", { value: 1 });
  invalid(hidden);
  for (const bad of [Infinity, NaN, -0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const v = declaration();
    v.profile.version = bad;
    invalid(v);
  }
});
test("bounded parser rejects excessive text/depth/key/node structure", () => {
  assert.throws(
    () =>
      parseCredentialBackendProfileJsonV1(
        " ".repeat(CREDENTIAL_BACKEND_PROFILE_LIMITS_V1.maxProfileBytes + 1),
      ),
    CredentialBackendProfileErrorV1,
  );
  const long = declaration();
  long.profile.ref = "a".repeat(1025);
  invalid(long);
  const depth = declaration();
  let cursor = depth;
  for (let i = 0; i < 34; i++) {
    cursor.extra = {};
    cursor = cursor.extra;
  }
  invalid(depth);
  const keys = declaration();
  for (let i = 0; i < 65; i++) keys[`extra${i}`] = i;
  invalid(keys);
  const nodes = declaration();
  nodes.extra = Array.from({ length: 63 }, () => Array(63).fill(1));
  invalid(nodes);
});
for (const [name, edit] of Object.entries({
  duplicate: (s) => s.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
  "escaped duplicate": (s) =>
    s.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
  "rounded fraction": (s) => s.replace('"schemaVersion":1', '"schemaVersion":1.00000000000000001'),
  "oversized integer": (s) => s.replace('"version":1', '"version":9007199254740993'),
  exponent: (s) => s.replace('"version":1', '"version":1e0'),
  "negative zero": (s) => s.replace('"version":1', '"version":-0'),
  "trailing JSON": (s) => `${s}{}`,
}))
  test(`JSON rejects ${name} without echoing input`, () => {
    assert.throws(
      () => parseCredentialBackendProfileJsonV1(edit(JSON.stringify(declaration()))),
      (error) =>
        error instanceof CredentialBackendProfileErrorV1 &&
        error.message === "Invalid credential backend profile V1.",
    );
  });

// These validate example values against the actual accepted storage codec. They
// do not execute the ordering statements or prove backend crash/restart behavior.
for (const trace of traces)
  test(`normative trace uses accepted storage values: ${trace.name}`, () => {
    for (const { kind, value } of trace.samples)
      assert.deepEqual(parseCredentialStorageV1(kind, value), value);
  });
test("unknown expiry remains unproved and future expiry is still mint-unknown", () => {
  assert.equal(
    parseCredentialStorageV1("mintOutcome", unknownMint()).expiry.kind,
    "expiry-unproven",
  );
  const bad = unknownMint();
  bad.expiry = mint().expiry;
  assert.throws(() => parseCredentialStorageV1("mintOutcome", bad));
  const row = parseCredentialStorageV1("record", mintUnknownRecord());
  assert.equal(row.state, "mint-unknown");
  assert.equal(row.disposition, "scope-held");
});
test("an empty final snapshot can still report live and unknown obligations", () => {
  const page = parseCredentialStorageV1("affectedPage", emptyFinalPage());
  assert.equal(page.records.length, 0);
  assert.equal(page.next, null);
  assert.equal(page.outstandingCount, 1);
  assert.equal(page.unresolvedIssuanceCount, 1);
  assert.equal(page.coverage, "persisted-snapshot-only");
});
test("exact original readback retains the original CAS-sensitive digest", () => {
  const original = mint();
  const read = readback("mintOutcome", original);
  const changed = { ...original, expectedInventoryVersion: original.expectedInventoryVersion + 1 };
  assert.notEqual(
    canonicalCredentialStorageRequestV1("mintOutcome", original),
    canonicalCredentialStorageRequestV1("mintOutcome", changed),
  );
  assert.equal(read.originalOperationRef, original.operationRef);
  assert.equal(read.originalMethod, original.method);
  assert.notEqual(read.originalIntentDigest, readback("mintOutcome", changed).originalIntentDigest);
});
