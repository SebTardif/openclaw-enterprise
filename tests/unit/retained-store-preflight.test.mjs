import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import { StoreBindingSchemaV1 } from "@openclaw-enterprise/contracts/completed-state-v1";
import { compareRetainedStorePreflightV1 as compare } from "@openclaw-enterprise/occ/persistence/retained-store-preflight-v1";
import { descriptors } from "../fixtures/retained-store-preflight-v1/descriptors.ts";

const digest = `sha256:${"b".repeat(64)}`;
const present = (value) => ({ status: "present", descriptors: value });
const check = (expected, candidate, status, reasonCode) => {
  const result = compare(expected, candidate);
  assert.deepEqual(result, {
    schemaVersion: 1,
    status,
    reasonCode,
    guarantee: "descriptor-comparison-only",
    credentialHomeExclusion: "not-established",
  });
  return result;
};

test("exact private/workspace/configuration descriptors match without authority or overlay proof", () => {
  const expected = descriptors();
  for (const store of expected.stores) assert.equal(Check(StoreBindingSchemaV1, store), true);
  const before = structuredClone(expected);
  check(expected, present(structuredClone(expected)), "match", "descriptors-match");
  assert.deepEqual(expected, before);
});

test("store, mount and subpath ordering does not change the exact keyed inventory", () => {
  const expected = descriptors();
  const candidate = structuredClone(expected);
  candidate.stores.reverse();
  candidate.mounts.reverse();
  for (const store of candidate.stores) store.approvedSubpaths?.reverse();
  for (const mount of candidate.mounts) mount.mount.subpaths.reverse();
  check(expected, present(candidate), "match", "descriptors-match");
});

for (const [state, reason] of [
  ["missing", "store-missing"],
  ["terminating", "store-terminating"],
  ["unknown", "observation-unknown"],
  ["unavailable", "observation-unavailable"],
])
  test(`${state} stays unavailable`, () =>
    check(descriptors(), { status: state }, "unavailable", reason));

for (const [name, mutate, reason] of [
  [
    "Installation",
    (v) => {
      v.ref.scope.installationId = "ins_00000000-0000-4000-8000-000000000009";
    },
    "owner-mismatch",
  ],
  [
    "Namespace",
    (v) => {
      v.ref.scope.namespaceId = "ns_00000000-0000-4000-8000-000000000009";
    },
    "owner-mismatch",
  ],
  [
    "Agent",
    (v) => {
      v.ref.scope.agentId = "agt_00000000-0000-4000-8000-000000000009";
    },
    "owner-mismatch",
  ],
  [
    "logical store",
    (v) => {
      v.ref.logicalStoreRef += "-different";
    },
    "inventory-mismatch",
  ],
  [
    "binding reference",
    (v) => {
      v.ref.bindingRef += "-different";
    },
    "binding-mismatch",
  ],
  [
    "binding version",
    (v) => {
      v.ref.bindingVersion += 1;
    },
    "binding-mismatch",
  ],
  [
    "role",
    (v) => {
      v.role = "workspace";
    },
    "store-kind-mismatch",
  ],
  [
    "cluster",
    (v) => {
      v.clusterRef += "-different";
    },
    "namespace-mismatch",
  ],
  [
    "Kubernetes namespace name",
    (v) => {
      v.namespaceName += "-different";
    },
    "namespace-mismatch",
  ],
  [
    "Kubernetes namespace UID",
    (v) => {
      v.namespaceUid += "-different";
    },
    "namespace-mismatch",
  ],
  [
    "claim name",
    (v) => {
      v.claimName += "-different";
    },
    "claim-replaced",
  ],
  [
    "same-name claim replacement",
    (v) => {
      v.claimUid += "-replacement";
    },
    "claim-replaced",
  ],
  [
    "PV name",
    (v) => {
      v.volumeName += "-different";
    },
    "volume-replaced",
  ],
  [
    "same-name PV replacement",
    (v) => {
      v.volumeUid += "-replacement";
    },
    "volume-replaced",
  ],
  [
    "profile reference",
    (v) => {
      v.storageProfileRef += "-different";
    },
    "storage-profile-mismatch",
  ],
  [
    "profile digest",
    (v) => {
      v.storageProfileDigest = digest;
    },
    "storage-profile-mismatch",
  ],
  [
    "node reference",
    (v) => {
      v.nodeIdentity.nodeRef += "-different";
    },
    "mount-policy-mismatch",
  ],
  [
    "node UID",
    (v) => {
      v.nodeIdentity.nodeUid += "-different";
    },
    "mount-policy-mismatch",
  ],
  [
    "node affinity digest",
    (v) => {
      v.nodeIdentity.affinityProfileDigest = digest;
    },
    "mount-policy-mismatch",
  ],
  [
    "mount policy digest",
    (v) => {
      v.mountPolicyDigest = digest;
    },
    "mount-policy-mismatch",
  ],
  [
    "private agent DB/WAL subpath",
    (v) => {
      v.approvedSubpaths[1].relativePath += "-different";
    },
    "mount-policy-mismatch",
  ],
  [
    "private media subpath",
    (v) => {
      v.approvedSubpaths[2].relativePath += "-different";
    },
    "mount-policy-mismatch",
  ],
  [
    "required write mode",
    (v) => {
      v.approvedSubpaths[0].readOnly = true;
    },
    "mount-policy-mismatch",
  ],
])
  test(`rejects changed ${name} with all other metadata retained`, () => {
    const expected = descriptors();
    const candidate = structuredClone(expected);
    mutate(candidate.stores[0]);
    // These are valid value-schema descriptors, not invented decoder outcomes.
    assert.equal(Check(StoreBindingSchemaV1, candidate.stores[0]), true);
    check(expected, present(candidate), "mismatch", reason);
  });

for (const field of ["backendRef", "objectRef", "objectVersion", "contentDigest"])
  test(`configuration ${field} is exact and never treated as a PVC`, () => {
    const expected = descriptors();
    const candidate = structuredClone(expected);
    candidate.stores[2][field] = field === "contentDigest" ? digest : "different";
    check(expected, present(candidate), "mismatch", "configuration-mismatch");
  });

test("missing, extra, empty and duplicate inventories retain distinct outcomes", () => {
  const expected = descriptors();
  const missing = structuredClone(expected);
  missing.stores.pop();
  check(expected, present(missing), "unavailable", "store-missing");
  check({ stores: [], mounts: [] }, present(expected), "unavailable", "inventory-unavailable");
  const duplicate = structuredClone(expected);
  duplicate.stores.push(structuredClone(duplicate.stores[0]));
  check(expected, present(duplicate), "mismatch", "inventory-ambiguous");
  const extra = structuredClone(expected);
  const store = structuredClone(extra.stores[2]);
  store.ref.logicalStoreRef += "-extra";
  store.ref.bindingRef += "-extra";
  extra.stores.push(store);
  check(expected, present(extra), "mismatch", "inventory-mismatch");
});

test("the 16-store limit is accepted; 17 stores and 33 mounts are not truncated", () => {
  const expected = descriptors();
  while (expected.stores.length < 16) {
    const store = structuredClone(expected.stores[2]);
    store.ref.logicalStoreRef += `-${expected.stores.length}`;
    store.ref.bindingRef += `-${expected.stores.length}`;
    expected.stores.push(store);
  }
  check(expected, present(structuredClone(expected)), "match", "descriptors-match");
  const tooMany = structuredClone(expected);
  tooMany.stores.push(structuredClone(tooMany.stores[2]));
  check(expected, present(tooMany), "unavailable", "inventory-limit");
  const mountLimit = descriptors();
  mountLimit.mounts = Array.from({ length: 33 }, () => mountLimit.mounts[0]);
  check(descriptors(), present(mountLimit), "unavailable", "inventory-limit");
});

for (const [name, mutate, reason] of [
  [
    "private claim alias",
    (v) => {
      v.stores[1].claimUid = v.stores[0].claimUid;
    },
    "store-layout-mismatch",
  ],
  [
    "private PV alias",
    (v) => {
      v.stores[1].volumeUid = v.stores[0].volumeUid;
    },
    "store-layout-mismatch",
  ],
  [
    "private harness exposure",
    (v) => {
      v.stores[0].approvedSubpaths[0].component = "harness";
    },
    "store-layout-mismatch",
  ],
  [
    "missing private media category",
    (v) => {
      v.stores[0].approvedSubpaths.pop();
    },
    "store-layout-mismatch",
  ],
  [
    "DB/WAL and media alias",
    (v) => {
      v.stores[0].approvedSubpaths[2].relativePath = "agent";
    },
    "store-layout-mismatch",
  ],
  [
    "DB/WAL parent exposure",
    (v) => {
      v.stores[0].approvedSubpaths[2].relativePath = "agent/media";
    },
    "store-layout-mismatch",
  ],
  [
    "private category on workspace",
    (v) => {
      v.stores[1].approvedSubpaths[2].category = "state";
    },
    "store-layout-mismatch",
  ],
  [
    "retained native home",
    (v) => {
      v.stores[0].approvedSubpaths[1].relativePath = "agent/codex-home";
    },
    "credential-home-subpath",
  ],
  [
    "workspace native home",
    (v) => {
      v.stores[1].approvedSubpaths[0].relativePath = ".codex";
    },
    "credential-home-subpath",
  ],
])
  test(`equal descriptors cannot validate ${name}`, () => {
    const value = descriptors();
    mutate(value);
    for (const store of value.stores) assert.equal(Check(StoreBindingSchemaV1, store), true);
    check(value, present(structuredClone(value)), "mismatch", reason);
  });

test("all shared categories and directions are admitted exactly", () => {
  for (const category of [
    "workspace",
    "sessions",
    "generated-images",
    "bundled-skills",
    "plugin-skills",
  ]) {
    const expected = descriptors();
    const candidate = structuredClone(expected);
    const path = candidate.stores[1].approvedSubpaths.find(
      (entry) => entry.category === category && entry.component === "harness",
    );
    path.readOnly = !path.readOnly;
    check(expected, present(candidate), "mismatch", "mount-policy-mismatch");
  }
});

test("subpaths may be explicitly absent only in the matching admitted inventory", () => {
  const expected = descriptors();
  expected.stores[1].approvedSubpaths = expected.stores[1].approvedSubpaths.filter(
    (path) => path.category !== "sessions",
  );
  for (const entry of expected.mounts)
    entry.mount.subpaths = entry.mount.subpaths.filter((path) => path.category !== "sessions");
  check(expected, present(structuredClone(expected)), "match", "descriptors-match");
  const candidate = structuredClone(expected);
  candidate.stores[1].approvedSubpaths.pop();
  check(expected, present(candidate), "mismatch", "mount-policy-mismatch");
});

test("matching admitted policy without complete mount descriptors stays unavailable", () => {
  const expected = descriptors();
  check(
    expected,
    present({ stores: expected.stores, mounts: null }),
    "unavailable",
    "mount-evidence-missing",
  );
  check({ ...expected, mounts: null }, present(expected), "unavailable", "mount-evidence-missing");
  const candidate = structuredClone(expected);
  candidate.mounts.pop();
  check(expected, present(candidate), "unavailable", "mount-evidence-missing");
});

for (const field of [
  "namespaceUid",
  "claimUid",
  "volumeUid",
  "nodeUid",
  "effectiveMountPolicyDigest",
])
  test(`mount ${field} must correlate with the immutable binding`, () => {
    const expected = descriptors();
    const candidate = structuredClone(expected);
    candidate.mounts[0].mount[field] = field.endsWith("Digest") ? digest : "different";
    check(expected, present(candidate), "mismatch", "mount-binding-mismatch");
  });

for (const field of ["mountIdentityRef", "filesystemIdentityRef"])
  test(`exact ${field} cannot be replaced by a matching claim`, () => {
    const expected = descriptors();
    const candidate = structuredClone(expected);
    candidate.mounts[0].mount[field] += "-different";
    check(expected, present(candidate), "mismatch", "mount-identity-mismatch");
  });

test("each component subpath mount identity is independently exact", () => {
  const expected = descriptors();
  const candidate = structuredClone(expected);
  candidate.mounts[0].mount.subpaths[1].mountIdentityRef += "-different";
  check(expected, present(candidate), "mismatch", "mount-identity-mismatch");
});

test("mounts cannot borrow another binding version, component, path or mode", () => {
  const expected = descriptors();
  for (const mutate of [
    (v) => {
      v.mounts[0].store.bindingVersion += 1;
    },
    (v) => {
      v.mounts[0].store.scope.agentId = "agt_00000000-0000-4000-8000-000000000009";
    },
  ]) {
    const candidate = structuredClone(expected);
    mutate(candidate);
    check(expected, present(candidate), "mismatch", "mount-binding-mismatch");
  }
  for (const mutate of [
    (v) => {
      v.mounts[0].component = "harness";
    },
    (v) => {
      v.mounts[0].mount.subpaths[0].readOnly = true;
    },
    (v) => {
      v.mounts[0].mount.subpaths[0].relativePath = "other";
    },
    (v) => {
      v.mounts[0].mount.subpaths.pop();
    },
  ]) {
    const candidate = structuredClone(expected);
    mutate(candidate);
    check(expected, present(candidate), "mismatch", "mount-subpaths-mismatch");
  }
});

test("duplicate component evidence and aliased top-level mount identities are ambiguous", () => {
  const expected = descriptors();
  const duplicate = structuredClone(expected);
  duplicate.mounts[1] = structuredClone(duplicate.mounts[0]);
  check(expected, present(duplicate), "mismatch", "mount-evidence-ambiguous");
  const alias = structuredClone(expected);
  alias.mounts[1].mount.mountIdentityRef = alias.mounts[0].mount.mountIdentityRef;
  check(expected, present(alias), "mismatch", "mount-evidence-ambiguous");
});

test("diagnostics are deterministic, bounded and contain no input identifiers", () => {
  const expected = descriptors();
  const candidate = structuredClone(expected);
  candidate.stores[0].claimUid = "sensitive-sentinel-do-not-return";
  const first = compare(expected, present(candidate));
  for (let i = 0; i < 20; i++) assert.deepEqual(compare(expected, present(candidate)), first);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("sensitive-sentinel"), false);
  assert.ok(serialized.length < 256);
});

test("multiple mount conflicts retain the same reason under keyed-set permutations", () => {
  const expected = descriptors();
  const candidate = structuredClone(expected);
  candidate.mounts[0].mount.claimUid = "different";
  candidate.mounts[1].mount.subpaths[0].readOnly = true;
  const first = check(expected, present(candidate), "mismatch", "mount-binding-mismatch");
  candidate.mounts.reverse();
  candidate.stores.reverse();
  for (const entry of candidate.mounts) entry.mount.subpaths.reverse();
  assert.deepEqual(compare(expected, present(candidate)), first);
});

test("multiple layout conflicts retain the same reason under store and subpath permutations", () => {
  const expected = descriptors();
  expected.stores[0].approvedSubpaths[1].relativePath = "agent/codex-home";
  expected.stores[1].approvedSubpaths[2].category = "state";
  const first = check(
    expected,
    present(structuredClone(expected)),
    "mismatch",
    "credential-home-subpath",
  );
  expected.stores.reverse();
  for (const store of expected.stores) store.approvedSubpaths?.reverse();
  assert.deepEqual(compare(expected, present(structuredClone(expected))), first);

  const withinStore = descriptors();
  withinStore.stores[0].approvedSubpaths[1].relativePath = "agent/codex-home";
  withinStore.stores[0].approvedSubpaths[0].category = "workspace";
  const before = compare(withinStore, present(structuredClone(withinStore)));
  withinStore.stores[0].approvedSubpaths.reverse();
  assert.deepEqual(compare(withinStore, present(structuredClone(withinStore))), before);
});
