import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  RETIREMENT_PURGE_LIMITS_V1,
  comparePurgeProgressV1,
  createPurgeManifestV1,
  encodeRetirementPurgeV1,
  initialPurgeProgressV1,
  parseRetirementPurgeJsonV1,
  parseRetirementPurgeV1,
  purgeManifestLocatorV1,
} from "../../packages/contracts/src/retirement-purge-manifest-v1.ts";
import {
  manifestBody,
  observation,
  withObservation,
} from "../fixtures/retirement-purge-manifest-v1/values.mjs";
import {
  preserveExactReadbackRequest,
  receiveMetadataReadback,
  summarizeRetainedPurge,
} from "../fixtures/retirement-purge-manifest-v1/consumer.ts";

const make = () => createPurgeManifestV1(manifestBody());
const rejects = (fn) =>
  assert.throws(fn, { name: "TypeError", message: "Invalid retirement purge value." });
const clone = (v) => structuredClone(v);

test("independent canonical manifest digest covers the complete ordered body", () => {
  const body = manifestBody();
  const canonical = (x) => {
    if (Array.isArray(x)) return x.map(canonical);
    if (x !== null && typeof x === "object")
      return Object.fromEntries(
        Object.keys(x)
          .sort()
          .map((k) => [k, canonical(x[k])]),
      );
    return x;
  };
  const expected = `sha256:${createHash("sha256")
    .update("retirement-purge-manifest-v1\n")
    .update(JSON.stringify(canonical(body)))
    .digest("hex")}`;
  assert.equal(make().manifestDigest, expected);
});

test("value and canonical JSON codecs preserve exact immutable identity", () => {
  const manifest = make();
  const wire = encodeRetirementPurgeV1("manifest", manifest);
  assert.equal(
    encodeRetirementPurgeV1("manifest", parseRetirementPurgeJsonV1("manifest", wire)),
    wire,
  );
  assert.ok(Object.isFrozen(manifest.stores[0].store.binding.scope));
  assert.throws(() => {
    manifest.stores[0].store.claimUid = "replacement";
  }, TypeError);
});

for (const [name, mutate] of [
  [
    "operation",
    (m) => {
      m.purgeOperationRef = "another-operation";
    },
  ],
  [
    "request",
    (m) => {
      m.requestRef = "another-request";
    },
  ],
  [
    "version",
    (m) => {
      m.manifestVersion++;
    },
  ],
  [
    "store UID",
    (m) => {
      m.stores[0].store.claimUid = "successor-uid";
    },
  ],
  [
    "binding version",
    (m) => {
      m.stores[0].store.binding.bindingVersion++;
    },
  ],
  [
    "backend object version",
    (m) => {
      m.stores[1].store.objectVersion = "new-version";
    },
  ],
  [
    "retirement generation",
    (m) => {
      m.retiredIdentities[0].activationGeneration++;
    },
  ],
  [
    "retired route version",
    (m) => {
      m.retiredIdentities[0].routeVersion++;
    },
  ],
  [
    "preallocated deletion",
    (m) => {
      m.stores[0].deletionOperationRef = "retry-new-id";
    },
  ],
  [
    "array order",
    (m) => {
      m.stores.reverse();
    },
  ],
])
  test(`changed ${name} fails the original immutable digest`, () => {
    const manifest = clone(make());
    mutate(manifest);
    rejects(() => parseRetirementPurgeV1("manifest", manifest));
  });

for (const [name, mutate] of [
  [
    "foreign store owner",
    (b) => {
      b.stores[0].store.binding.scope.agentId = "agt_44444444-4444-4444-8444-444444444444";
    },
  ],
  [
    "foreign context owner",
    (b) => {
      b.retiredIdentities[1].context.agentRef = "agt_44444444-4444-4444-8444-444444444444";
    },
  ],
  [
    "duplicate logical store",
    (b) => {
      b.stores[1].store.binding.logicalStoreRef = b.stores[0].store.binding.logicalStoreRef;
    },
  ],
  [
    "duplicate physical object",
    (b) => {
      const s = clone(b.stores[0]);
      s.store.binding.logicalStoreRef = "alias";
      s.deletionOperationRef = "alias-delete";
      b.stores.push(s);
    },
  ],
  [
    "duplicate deletion operation",
    (b) => {
      b.stores[1].deletionOperationRef = b.stores[0].deletionOperationRef;
    },
  ],
  [
    "duplicate retired route",
    (b) => {
      b.retiredIdentities.push(clone(b.retiredIdentities[0]));
    },
  ],
  [
    "empty store inventory",
    (b) => {
      b.stores = [];
    },
  ],
  [
    "empty retirement inventory",
    (b) => {
      b.retiredIdentities = [];
    },
  ],
  [
    "unsafe version",
    (b) => {
      b.manifestVersion = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "shared secret",
    (b) => {
      b.stores[0].store.kind = "shared-secret";
    },
  ],
  [
    "shared configuration",
    (b) => {
      b.stores[1].store.ownership = "shared";
    },
  ],
  [
    "barrier disposal",
    (b) => {
      b.retention.permanentRetirementBarrier = "delete";
    },
  ],
  [
    "physical erasure claim",
    (b) => {
      b.physicalErasure = true;
    },
  ],
  [
    "unknown version",
    (b) => {
      b.schemaVersion = 2;
    },
  ],
])
  test(`manifest creation rejects ${name}`, () => {
    const body = manifestBody();
    mutate(body);
    rejects(() => createPurgeManifestV1(body));
  });

test("body alias mutation cannot change the retained manifest", () => {
  const body = manifestBody();
  const manifest = createPurgeManifestV1(body);
  body.stores[0].store.claimUid = "later-mutated";
  assert.equal(manifest.stores[0].store.claimUid, "claim-uid-1");
});

test("bounded codecs reject getters without invoking them", () => {
  let called = 0;
  const body = manifestBody();
  Object.defineProperty(body, "requestRef", {
    enumerable: true,
    get() {
      called++;
      throw new Error("private");
    },
  });
  rejects(() => createPurgeManifestV1(body));
  assert.equal(called, 0);
});

for (const [name, makeBad] of [
  [
    "cyclic input",
    () => {
      const b = manifestBody();
      b.extra = b;
      return b;
    },
  ],
  [
    "symbol property",
    () => {
      const b = manifestBody();
      b[Symbol("hidden")] = 1;
      return b;
    },
  ],
  [
    "non-enumerable property",
    () => {
      const b = manifestBody();
      Object.defineProperty(b, "extra", { value: 1 });
      return b;
    },
  ],
  [
    "sparse array",
    () => {
      const b = manifestBody();
      delete b.stores[0];
      return b;
    },
  ],
  [
    "extra array property",
    () => {
      const b = manifestBody();
      b.stores.x = 1;
      return b;
    },
  ],
  [
    "malformed Unicode",
    () => {
      const b = manifestBody();
      b.requestRef = "\ud800";
      return b;
    },
  ],
  [
    "oversized reference",
    () => {
      const b = manifestBody();
      b.requestRef = "x".repeat(201);
      return b;
    },
  ],
  [
    "oversized JSON",
    () => {
      const b = manifestBody();
      b.requestRef = "x".repeat(RETIREMENT_PURGE_LIMITS_V1.maxJsonBytes + 1);
      return b;
    },
  ],
])
  test(`strict snapshot rejects ${name}`, () => rejects(() => createPurgeManifestV1(makeBad())));

test("canonical wire decoder rejects duplicate keys and noncanonical whitespace", () => {
  const wire = encodeRetirementPurgeV1("manifest", make());
  rejects(() => parseRetirementPurgeJsonV1("manifest", ` ${wire}`));
  rejects(() =>
    parseRetirementPurgeJsonV1(
      "manifest",
      wire.replace('"manifestVersion":1', '"manifestVersion":2,"manifestVersion":1'),
    ),
  );
});

test("unknown is retained until exact positive absence; all live objects must resolve", () => {
  const manifest = make();
  const initial = initialPurgeProgressV1(manifest);
  const uncertain = withObservation(initial, 0, observation(manifest, 0, "unknown"));
  assert.equal(comparePurgeProgressV1(initial, uncertain, 1).kind, "advance");
  assert.equal(summarizeRetainedPurge(uncertain).liveObjectsAbsent, false);
  const firstAbsent = withObservation(uncertain, 0, observation(manifest, 0, "observed-absent", 2));
  assert.equal(comparePurgeProgressV1(uncertain, firstAbsent, 2).kind, "advance");
  const allAbsent = withObservation(firstAbsent, 1, observation(manifest, 1));
  assert.equal(comparePurgeProgressV1(firstAbsent, allAbsent, 3).kind, "advance");
  assert.equal(summarizeRetainedPurge(allAbsent).liveObjectsAbsent, true);
  assert.equal(summarizeRetainedPurge(allAbsent).physicalErasureEstablished, false);
  assert.equal(
    allAbsent.manifest.retention.permanentRetirementBarrier,
    "retain-installation-lifetime",
  );
});

test("present/unknown observations cannot be declared completed", () => {
  const manifest = make();
  const p = withObservation(
    initialPurgeProgressV1(manifest),
    0,
    observation(manifest, 0, "unknown"),
  );
  p.state = "live-objects-absent";
  rejects(() => parseRetirementPurgeV1("progress", p));
});

test("expected progress CAS and repeated exact readback are distinct", () => {
  const manifest = make();
  const before = initialPurgeProgressV1(manifest);
  const after = withObservation(before, 0, observation(manifest, 0));
  assert.equal(comparePurgeProgressV1(before, after, 2).kind, "conflict");
  assert.equal(comparePurgeProgressV1(before, after, 1).kind, "advance");
  assert.equal(comparePurgeProgressV1(after, after, 1).kind, "existing");
});

for (const [name, mutate] of [
  [
    "same-name successor UID",
    (o) => {
      o.store.claimUid = "new-uid-same-name";
    },
  ],
  [
    "foreign binding version",
    (o) => {
      o.store.binding.bindingVersion++;
    },
  ],
  [
    "foreign operation",
    (o) => {
      o.deletionOperationRef = "another-delete";
    },
  ],
  [
    "foreign manifest digest",
    (o) => {
      o.manifest.manifestDigest = `sha256:${"f".repeat(64)}`;
    },
  ],
  [
    "foreign request",
    (o) => {
      o.manifest.requestRef = "another-request";
    },
  ],
  [
    "invalid observation date",
    (o) => {
      o.observedAt = "2026-02-30T00:00:01.000Z";
    },
  ],
])
  test(`progress rejects ${name}`, () => {
    const manifest = make();
    const o = clone(observation(manifest, 0));
    mutate(o);
    const p = withObservation(initialPurgeProgressV1(manifest), 0, o);
    rejects(() => parseRetirementPurgeV1("progress", p));
  });

test("a resolved absence cannot regress or be replaced by another observation", () => {
  const manifest = make();
  const before = withObservation(initialPurgeProgressV1(manifest), 0, observation(manifest, 0));
  for (const outcome of ["unknown", "observed-present", "observed-absent"]) {
    const after = withObservation(before, 0, observation(manifest, 0, outcome, 2));
    assert.equal(comparePurgeProgressV1(before, after, before.recordVersion).kind, "conflict");
  }
});

test("stale sequence, replayed receipt and backwards observation time cannot advance", () => {
  const manifest = make();
  const before = withObservation(
    initialPurgeProgressV1(manifest),
    0,
    observation(manifest, 0, "unknown", 2),
  );
  for (const mutate of [
    (o) => {
      o.observationSequence = 2;
    },
    (o) => {
      o.observationRef = "observation-0-2";
    },
    (o) => {
      o.observedAt = "2026-01-01T00:00:01.000Z";
    },
  ]) {
    const o = clone(observation(manifest, 0, "observed-absent", 3));
    mutate(o);
    assert.equal(comparePurgeProgressV1(before, withObservation(before, 0, o), 2).kind, "conflict");
  }
});

test("recomputed changed manifest remains a conflicting operation", () => {
  const first = initialPurgeProgressV1(make());
  const changedBody = manifestBody();
  changedBody.stores[0].store.claimUid = "new-uid";
  const changed = initialPurgeProgressV1(createPurgeManifestV1(changedBody));
  assert.equal(comparePurgeProgressV1(first, changed, 1).kind, "conflict");
});

test("exact readback preserves original IDs and has no action method", () => {
  const manifest = make();
  const before = initialPurgeProgressV1(manifest);
  const wire = preserveExactReadbackRequest(manifest);
  assert.equal(encodeRetirementPurgeV1("locator", purgeManifestLocatorV1(manifest)), wire);
  const status = receiveMetadataReadback(encodeRetirementPurgeV1("progress", before));
  assert.equal(status.manifest.requestRef, "purge-request-1");
  assert.equal(status.manifest.purgeOperationRef, "purge-operation-1");
  for (const name of ["delete", "resume", "dispatch", "publish", "release"])
    assert.equal(name in status, false);
});

test("Kubernetes selection names only the original PVC, not backing-volume disposal", () => {
  const body = manifestBody();
  assert.equal(make().stores[0].store.deleteTarget, "persistent-volume-claim");
  body.stores[0].store.deleteTarget = "persistent-volume";
  rejects(() => createPurgeManifestV1(body));
});

test("canonical channel installation and Kubernetes namespace schemas are reused", () => {
  for (const mutate of [
    (body) => {
      body.retiredIdentities[2].channelInstallationRef = "invented-channel-id";
    },
    (body) => {
      body.stores[0].store.namespaceName = "Invalid_Namespace";
    },
  ]) {
    const body = manifestBody();
    mutate(body);
    rejects(() => createPurgeManifestV1(body));
  }
});

test("closed codec dispatch rejects inherited and unknown schema names", () => {
  for (const kind of ["__proto__", "constructor", "toString", "retirementAuthority"])
    rejects(() => parseRetirementPurgeV1(kind, {}));
});

test("maximum store inventory fits the finite value contract; one more fails", () => {
  const body = manifestBody();
  body.stores = Array.from({ length: RETIREMENT_PURGE_LIMITS_V1.maxStores }, (_, i) => {
    const row = clone(body.stores[0]);
    row.deletionOperationRef = `delete-${i}`;
    row.store.binding.logicalStoreRef = `store-${i}`;
    row.store.binding.bindingRef = `binding-${i}`;
    row.store.claimUid = `claim-${i}`;
    row.store.volumeUid = `volume-${i}`;
    return row;
  });
  assert.equal(createPurgeManifestV1(body).stores.length, RETIREMENT_PURGE_LIMITS_V1.maxStores);
  body.stores.push(clone(body.stores[0]));
  rejects(() => createPurgeManifestV1(body));
});

test("maximum retired identity inventory is bounded independently of stores", () => {
  const body = manifestBody();
  body.retiredIdentities = Array.from(
    { length: RETIREMENT_PURGE_LIMITS_V1.maxRetiredIdentities },
    (_, i) => ({
      kind: "route",
      routeRef: `route-${i}`,
      routeVersion: 1,
      activationGeneration: 1,
    }),
  );
  assert.equal(
    createPurgeManifestV1(body).retiredIdentities.length,
    RETIREMENT_PURGE_LIMITS_V1.maxRetiredIdentities,
  );
  body.retiredIdentities.push({
    kind: "route",
    routeRef: "excess",
    routeVersion: 1,
    activationGeneration: 1,
  });
  rejects(() => createPurgeManifestV1(body));
});

test("hostile prototype, excessive nesting, and negative zero remain invalid", () => {
  const exotic = Object.assign(Object.create({ hidden: true }), manifestBody());
  rejects(() => createPurgeManifestV1(exotic));
  const deep = manifestBody();
  let nested = deep;
  for (let i = 0; i <= RETIREMENT_PURGE_LIMITS_V1.maxDepth; i++) nested = nested.extra = {};
  rejects(() => createPurgeManifestV1(deep));
  const negative = manifestBody();
  negative.manifestVersion = -0;
  rejects(() => createPurgeManifestV1(negative));
});

test("progress cannot skip sequence, change two stores, or increment without new evidence", () => {
  const manifest = make();
  const before = initialPurgeProgressV1(manifest);
  const skipped = withObservation(before, 0, observation(manifest, 0, "unknown", 2));
  assert.equal(comparePurgeProgressV1(before, skipped, 1).kind, "conflict");
  const both = withObservation(before, 0, observation(manifest, 0));
  both.stores[1].state = { kind: "observed-absent", observation: observation(manifest, 1) };
  both.state = "live-objects-absent";
  assert.equal(comparePurgeProgressV1(before, both, 1).kind, "conflict");
  const unchanged = clone(before);
  unchanged.recordVersion++;
  assert.equal(comparePurgeProgressV1(before, unchanged, 1).kind, "conflict");
});

test("progress counter exhaustion never wraps or becomes a fresh sequence", () => {
  const manifest = make();
  const before = clone(initialPurgeProgressV1(manifest));
  before.recordVersion = Number.MAX_SAFE_INTEGER;
  const after = clone(before);
  after.recordVersion = 1;
  assert.equal(comparePurgeProgressV1(before, after, before.recordVersion).kind, "conflict");
});
