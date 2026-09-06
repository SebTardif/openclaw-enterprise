import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  decodeWorkloadProfileManifest,
  WorkloadProfileManifestError,
} from "../../packages/occ/src/workload-profiles/manifest.ts";
import {
  deriveWorkloadProfileManifest,
  projectWorkloadProfileResourceAccountingV1,
} from "../../packages/occ/src/workload-profiles/projections.ts";
import {
  parseRuntimeResourceAccountingV1,
  validateRuntimeResourceAccountingV1,
} from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";
import { WorkloadProfileJsonError } from "../../packages/occ/src/workload-profiles/canonical.ts";
import { workloadProfileManifestFixture } from "../fixtures/workload-profile.mjs";
import {
  envelope as accountingEnvelope,
  selectedRequirements,
} from "../fixtures/runtime-resource-accounting-v1/values.mjs";
import { observation } from "../fixtures/runtime-resource-accounting-v1/observation.mjs";

// This synthetic candidate exercises closed decoding and content identities.
// Its unresolved artifacts and mechanisms do not admit an executable workload.
const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(JSON.stringify(value));
const plain = (value) => JSON.parse(JSON.stringify(value));
const fixture = () => workloadProfileManifestFixture();
const decode = (value) => decodeWorkloadProfileManifest(bytes(value));
const derive = (value) => deriveWorkloadProfileManifest(bytes(value));
const contentKeys = [
  "schemaVersion",
  "target",
  "profileRefs",
  "artifactSet",
  "launchConfiguration",
  "containment",
  "endpoints",
  "evidenceRequirements",
  "capabilities",
];
const projectionKeys = [
  "manifest",
  "artifactSet",
  "launchConfiguration",
  "providerProfile",
  "runtimeProfile",
  "identityProfile",
  "containment",
  "storageProfile",
  "endpoints",
  "evidenceRequirements",
  "mountPolicy",
  "resourceEnvelope",
  "runtimeFlags",
];
const digestKeys = projectionKeys.map((key) => `${key}Digest`);
const unavailable = {
  imageSetDigest: "unresolved-platform-images",
  admittedConfigurationDigest: "deployment-inputs-required",
};
const sortedKeys = (value) => Object.keys(value).sort();

function visit(value, path = [], objects = []) {
  if (value !== null && typeof value === "object") {
    if (!Array.isArray(value)) objects.push(path);
    for (const [key, child] of Object.entries(value))
      visit(child, [...path, Array.isArray(value) ? Number(key) : key], objects);
  }
  return objects;
}
function at(value, path) {
  return path.reduce((current, key) => current[key], value);
}
function altered(path, change) {
  const value = fixture();
  change(at(value, path));
  return value;
}
function rejects(value) {
  for (const operation of [decode, derive])
    assert.throws(
      () => operation(value),
      (error) => error instanceof WorkloadProfileManifestError,
    );
}
function frozen(value) {
  if (value !== null && typeof value === "object") {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) frozen(child);
  }
}
function reorderedObjects(value) {
  if (Array.isArray(value)) return value.map(reorderedObjects);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reorderedObjects(child)]),
  );
}

function setLists(value) {
  return [
    { name: "artifact roles", values: value.artifactSet, key: "role" },
    {
      name: "distribution members",
      values: value.artifactSet.find((entry) => entry.role === "gvisor-node-distribution").members,
      key: "name",
    },
    { name: "containers", values: value.launchConfiguration.containers, key: "name" },
    { name: "mount entries", values: value.launchConfiguration.mountPolicy.entries, key: "name" },
    { name: "capabilities", values: value.capabilities, key: "id" },
    {
      name: "producer entries",
      values: value.evidenceRequirements.requiredProducers,
      key: "claim",
    },
    { name: "claim vocabulary", values: value.evidenceRequirements.requiredClaims },
    { name: "endpoint authorities", values: value.endpoints.nativeGitHub.authorities },
    ...value.capabilities.map((capability) => ({
      name: `${capability.id} claim set`,
      values: capability.requiredClaims,
    })),
  ];
}

test("unresolved and server-bound values retain their distinct exact positions and meanings", () => {
  const value = fixture();
  const unresolvedPaths = visit(value).filter((path) => at(value, path).status === "unresolved");
  const boundPaths = visit(value).filter((path) => at(value, path).status === "server-bound");
  assert.equal(unresolvedPaths.length, 27);
  assert.equal(boundPaths.length, 11);
  const expectedCodes = [
    ...Array.from({ length: 10 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
    ...Array.from({ length: 10 }, (_, index) => `L${String(index + 1).padStart(2, "0")}`),
    "C01",
    "E01",
    "E02",
    "E03",
    "E04",
    "E05",
    "Q01",
  ].sort();
  assert.deepEqual(unresolvedPaths.map((path) => at(value, path).code).sort(), expectedCodes);
  const decoded = decode(value).content;
  for (const [index, path] of unresolvedPaths.entries()) {
    assert.deepEqual(sortedKeys(at(decoded, path)), ["code", "owner", "required", "status"]);
    rejects(
      altered(path, (descriptor) => {
        descriptor.status = "resolved";
      }),
    );
    rejects(
      altered(path, (descriptor) => {
        descriptor.required = true;
      }),
    );
    rejects(
      altered(path, (descriptor) => {
        descriptor.owner = "";
      }),
    );
    rejects(
      altered(path, (descriptor) => {
        descriptor.code = at(value, unresolvedPaths[(index + 1) % unresolvedPaths.length]).code;
      }),
    );
  }
  for (const path of boundPaths) {
    assert.deepEqual(sortedKeys(at(decoded, path)), ["authority", "stage", "status", "valueType"]);
    for (const field of ["authority", "stage", "valueType"])
      rejects(
        altered(path, (descriptor) => {
          descriptor[field] = "unrecognized-binding-selector";
        }),
      );
    rejects(
      altered(path, (descriptor) => {
        descriptor.value = "caller-selected-value";
      }),
    );
  }
});

test("only declared set ordering normalizes and duplicate or missing identities reject", () => {
  const baseline = derive(fixture());
  const lists = setLists(fixture());
  for (const [index, list] of lists.entries()) {
    const identities = list.values.map((entry) => (list.key ? entry[list.key] : entry));
    assert.deepEqual(
      identities,
      [...identities].sort(),
      `independent fixture order for ${list.name}`,
    );
    const reordered = fixture();
    setLists(reordered)[index].values.reverse();
    assert.deepEqual(decode(reordered).canonicalBytes, baseline.canonicalBytes, list.name);
    assert.deepEqual(plain(derive(reordered).digests), plain(baseline.digests), list.name);
    const duplicate = fixture();
    const repeated = setLists(duplicate)[index].values;
    repeated.push(structuredClone(repeated[0]));
    rejects(duplicate);
    const missing = fixture();
    setLists(missing)[index].values.pop();
    rejects(missing);
    if (list.key) {
      const conflicting = fixture();
      const entries = setLists(conflicting)[index].values;
      entries[1][list.key] = entries[0][list.key];
      rejects(conflicting);
    }
  }
  const reversedExecution = fixture();
  reversedExecution.launchConfiguration.topology.containerOrder.reverse();
  rejects(reversedExecution);
  assert.deepEqual(plain(baseline.content.launchConfiguration.topology.containerOrder), [
    "prepare-private-state",
    "agent",
  ]);
  assert.deepEqual(
    baseline.content.launchConfiguration.containers.map((entry) => entry.name),
    ["agent", "prepare-private-state"],
  );
});

test("capability-specific bootstrap requirements do not become a global prerequisite set", () => {
  const value = decode(fixture()).content;
  const claims = (id) =>
    value.capabilities.find((capability) => capability.id === id).requiredClaims;
  for (const capability of value.capabilities) assert.equal(capability.status, "non-executable");
  assert.deepEqual(plain(claims("initial-binding")), [
    "admitted-current-profile",
    "closed-provider-effects",
    "exact-instance-and-restart",
    "observed-artifact-and-final-shape",
    "protected-service-and-preparation",
  ]);
  assert.deepEqual(plain(claims("materialize-harness")), [
    "admitted-current-profile",
    "closed-provider-effects",
    "prelaunch-artifact-and-profile",
    "prior-writers-and-stores",
    "protected-service-and-preparation",
  ]);
  assert.equal(claims("model-call").includes("repository-issuance"), false);
  assert.equal(claims("native-repository").includes("model-mediation"), false);
  for (const id of ["initial-binding", "materialize-harness", "model-call", "native-repository"]) {
    const changed = fixture();
    changed.capabilities.find((capability) => capability.id === id).requiredClaims = [
      ...changed.evidenceRequirements.requiredClaims,
    ];
    rejects(changed);
  }
});

test("foreign references and positive capability flags reject before projection", () => {
  for (const mutate of [
    (value) => {
      value.launchConfiguration.runtime.artifactRole = "gateway";
    },
    (value) => {
      value.launchConfiguration.containers[0].imageRole = "gateway";
    },
    (value) => {
      value.launchConfiguration.containers[0].kind = "init";
    },
    (value) => {
      value.launchConfiguration.mountPolicy.entries[0].container = "gateway";
    },
    (value) => {
      value.launchConfiguration.mountPolicy.entries[0].source = "unknown-store";
    },
    (value) => {
      value.launchConfiguration.mountPolicy.entries[0].subpath = "workspace";
    },
    (value) => {
      value.launchConfiguration.containers[0].imagePlatformDigest = `sha256:${"a".repeat(64)}`;
    },
    (value) => {
      value.target.component = "gateway";
    },
    (value) => {
      value.target.placement = "embedded";
    },
    (value) => {
      value.target.provider = "occ/kubernetes";
    },
    (value) => {
      value.target.fallback = "default";
    },
    (value) => {
      value.containment.supportedRunnableTuple = true;
    },
    (value) => {
      value.capabilities[0].status = "executable";
    },
    (value) => {
      value.launchConfiguration.pod.hostNetwork = true;
    },
    (value) => {
      value.launchConfiguration.containers[0].security.capabilitiesAdd = ["SYS_ADMIN"];
    },
    (value) => {
      value.launchConfiguration.containers[0].security.readOnlyRootFilesystem = false;
    },
  ]) {
    const value = fixture();
    mutate(value);
    rejects(value);
  }
});

test("declared numeric units and selected quantities reject strings and alternate values", () => {
  for (const value of ["100m", "0.1", 99, -1, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    const changed = fixture();
    changed.launchConfiguration.resourceEnvelope.containers[
      "prepare-private-state"
    ].requests.cpuMilli = value;
    for (const operation of [decode, derive])
      assert.throws(
        () => operation(changed),
        (error) =>
          error instanceof WorkloadProfileManifestError ||
          error instanceof WorkloadProfileJsonError,
      );
  }
  for (const [path, key, value] of [
    [
      ["launchConfiguration", "resourceEnvelope", "containers", "agent", "requests"],
      "memoryBytes",
      "1Gi",
    ],
    [["launchConfiguration", "topology"], "terminationGracePeriodSeconds", 30_000],
    [["launchConfiguration", "containers", 0, "security"], "runAsUser", "1000"],
    [
      ["launchConfiguration", "mountPolicy", "emptyDirs", "runtime-home-emptydir"],
      "sizeLimitBytes",
      "1Gi",
    ],
    [["evidenceRequirements", "freshness"], "sourceMaxAgeMs", 15],
  ])
    rejects(
      altered(path, (object) => {
        object[key] = value;
      }),
    );
});

test("path aliases cannot be cleaned into the selected absolute or relative location", () => {
  for (const path of [
    "home/node",
    "/home/./node",
    "/home/../node",
    "//home/node",
    "/home//node",
    "/home/node/",
    "/home/\u0000node",
  ]) {
    const changed = fixture();
    changed.launchConfiguration.mountPolicy.entries.find(
      (entry) => entry.name === "home-agent",
    ).path = path;
    rejects(changed);
  }
  for (const subpath of [
    "/workspace",
    "../workspace",
    "./workspace",
    "workspace/",
    "work//space",
    "*",
  ]) {
    const changed = fixture();
    changed.launchConfiguration.mountPolicy.entries.find(
      (entry) => entry.name === "workspace",
    ).subpath = subpath;
    rejects(changed);
  }
  const value = decode(fixture()).content.launchConfiguration.mountPolicy.entries;
  assert.equal(value.find((entry) => entry.name === "home-agent").path, "/home/node");
  assert.equal(value.find((entry) => entry.name === "home-init").path, "/home/node");
  assert.ok(value.find((entry) => entry.name === "workspace").path.startsWith("/home/node/"));
});

test("raw source, executable and OCI digest formats remain distinct", () => {
  for (const mutate of [
    (value) => {
      value.artifactSet.find((entry) => entry.role === "harness-native").source.commit = "a".repeat(
        64,
      );
    },
    (value) => {
      value.artifactSet.find(
        (entry) => entry.role === "harness-native",
      ).officialBaseline.executableSha256 = `sha256:${"a".repeat(64)}`;
    },
    (value) => {
      value.artifactSet.find((entry) => entry.role === "kubernetes-node").linuxAmd64ManifestDigest =
        "a".repeat(64);
    },
    (value) => {
      value.artifactSet.find((entry) => entry.role === "gvisor-node-distribution").archiveSha256 =
        "A".repeat(64);
    },
  ]) {
    const value = fixture();
    mutate(value);
    rejects(value);
  }
});

test("documentary text enforces UTF-8 byte bounds and controls without normalizing Unicode", () => {
  const path = ["artifactSet", 0, "image"];
  for (const text of ["a".repeat(2048), "é".repeat(1024), "😀".repeat(512)]) {
    assert.equal(encoder.encode(text).byteLength, 2048);
    const value = altered(path, (descriptor) => {
      descriptor.required = text;
    });
    for (const operation of [decode, derive]) {
      assert.equal(at(operation(value).content, path).required, text);
    }
    const over = text + "x";
    assert.equal(encoder.encode(over).byteLength, 2049);
    rejects(
      altered(path, (descriptor) => {
        descriptor.required = over;
      }),
    );
  }
  for (const control of ["\u0000", "\u0009", "\u001f", "\u007f", "\u0085", "\u009f"])
    rejects(
      altered(path, (descriptor) => {
        descriptor.required = `before${control}after`;
      }),
    );
  const composed = derive(
    altered(path, (descriptor) => {
      descriptor.required = "é";
    }),
  );
  const decomposed = derive(
    altered(path, (descriptor) => {
      descriptor.required = "e\u0301";
    }),
  );
  assert.equal(at(composed.content, path).required, "é");
  assert.equal(at(decomposed.content, path).required, "e\u0301");
  assert.notDeepEqual(composed.canonicalBytes, decomposed.canonicalBytes);
  assert.notEqual(composed.digests.manifestDigest, decomposed.digests.manifestDigest);
});

function changedDigests(before, after) {
  return digestKeys.filter((key) => before[key] !== after[key]).sort();
}

test("each unresolved field changes exactly its specified projection domains", () => {
  const baseline = derive(fixture());
  const expected = {
    A01: ["artifactSet"],
    A02: ["artifactSet"],
    A03: ["artifactSet", "runtimeProfile"],
    A04: ["artifactSet", "runtimeProfile"],
    A05: ["artifactSet", "runtimeProfile"],
    A06: ["artifactSet", "runtimeProfile"],
    A07: ["artifactSet"],
    A08: ["artifactSet", "runtimeProfile"],
    A09: ["artifactSet"],
    A10: ["artifactSet"],
    L01: ["launchConfiguration", "runtimeProfile", "runtimeFlags"],
    L02: ["launchConfiguration", "runtimeProfile"],
    L03: ["launchConfiguration", "runtimeProfile"],
    L04: ["launchConfiguration", "runtimeProfile"],
    L05: ["launchConfiguration", "runtimeProfile"],
    L06: ["launchConfiguration", "runtimeProfile"],
    L07: ["launchConfiguration", "runtimeProfile"],
    L08: [
      "launchConfiguration",
      "runtimeProfile",
      "mountPolicy",
      "storageProfile",
      "identityProfile",
    ],
    L09: ["launchConfiguration", "runtimeProfile"],
    L10: ["launchConfiguration", "runtimeProfile", "resourceEnvelope"],
    C01: ["containment"],
    E01: ["endpoints"],
    E02: ["endpoints"],
    E03: ["endpoints"],
    E04: ["endpoints"],
    E05: ["endpoints", "identityProfile"],
    Q01: ["evidenceRequirements", "identityProfile"],
  };
  const original = fixture();
  for (const path of visit(original).filter((path) => at(original, path).status === "unresolved")) {
    const code = at(original, path).code;
    const changed = altered(path, (descriptor) => {
      descriptor.required += " Additional synthetic evidence description.";
    });
    const result = derive(changed);
    const expectedKeys = ["manifest", ...expected[code]].map((key) => `${key}Digest`).sort();
    assert.deepEqual(changedDigests(baseline.digests, result.digests), expectedKeys, code);
    assert.deepEqual(plain(result.unavailableDigests), unavailable, code);
  }
});

test("producer-specific role hashes exclude unrelated evidence and capability descriptions", () => {
  const baseline = derive(fixture());
  const expected = {
    "admitted-current-profile": [],
    "authenticated-peer": ["identityProfile"],
    "closed-provider-effects": ["providerProfile"],
    "exact-instance-and-restart": ["identityProfile", "runtimeProfile"],
    "identity-verification": ["identityProfile"],
    "model-mediation": [],
    "observed-artifact-and-final-shape": [],
    "prelaunch-artifact-and-profile": [],
    "prior-writers-and-stores": [],
    "protected-service-and-preparation": ["providerProfile"],
    "quiet-restore-native-guard": [],
    "repository-issuance": [],
  };
  for (const [claim, roles] of Object.entries(expected)) {
    const changed = fixture();
    changed.evidenceRequirements.requiredProducers.find(
      (entry) => entry.claim === claim,
    ).required += " Synthetic claim description.";
    assert.deepEqual(
      changedDigests(baseline.digests, derive(changed).digests),
      ["manifest", "evidenceRequirements", ...roles].map((key) => `${key}Digest`).sort(),
      claim,
    );
  }
  for (const capability of fixture().capabilities) {
    const changed = fixture();
    changed.capabilities.find((entry) => entry.id === capability.id).reason +=
      " Additional synthetic limitation.";
    assert.deepEqual(
      changedDigests(baseline.digests, derive(changed).digests),
      ["manifestDigest"],
      capability.id,
    );
  }
});

test("runtime artifact hashing includes the selected executable and excludes external gateway data", () => {
  const baseline = derive(fixture());
  const runtime = fixture();
  runtime.artifactSet
    .find((entry) => entry.role === "gvisor-node-distribution")
    .members.find((entry) => entry.name === "runsc").sha256 = "b".repeat(64);
  assert.deepEqual(changedDigests(baseline.digests, derive(runtime).digests), [
    "artifactSetDigest",
    "manifestDigest",
    "runtimeProfileDigest",
  ]);
  const external = fixture();
  external.artifactSet.find((entry) => entry.role === "gateway").packageArchive.sha256 = "8".repeat(
    64,
  );
  assert.deepEqual(changedDigests(baseline.digests, derive(external).digests), [
    "artifactSetDigest",
    "manifestDigest",
  ]);
});

test("a closed unresolved manifest exposes precisely the supported content and digest families", () => {
  const result = derive(fixture());
  assert.deepEqual(sortedKeys(result), [
    "canonicalBytes",
    "content",
    "digests",
    "projections",
    "roleDigests",
    "unavailableDigests",
  ]);
  assert.deepEqual(sortedKeys(result.content), [...contentKeys].sort());
  assert.deepEqual(sortedKeys(result.projections), [...projectionKeys].sort());
  assert.deepEqual(sortedKeys(result.digests), [...digestKeys].sort());
  assert.deepEqual(plain(result.unavailableDigests), unavailable);
  assert.deepEqual(plain(result.roleDigests), {
    provider: result.digests.providerProfileDigest,
    runtime: result.digests.runtimeProfileDigest,
    identity: result.digests.identityProfileDigest,
    containment: result.digests.containmentDigest,
    storage: result.digests.storageProfileDigest,
  });
  assert.equal(result.content.schemaVersion, 1);
  assert.equal(result.content.artifactSet.length, 11);
  assert.equal(result.content.capabilities.length, 8);
  for (const digest of Object.values(result.digests)) assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(result.digests, "imageSetDigest"), false);
  assert.equal(Object.hasOwn(result.digests, "admittedConfigurationDigest"), false);
});

test("every object family rejects extra keys and missing required members", () => {
  const baseline = fixture();
  assert.doesNotThrow(() => decode(baseline));
  for (const path of visit(baseline)) {
    const location = path.join(".") || "root";
    rejects(
      altered(path, (object) => {
        object.unrecognizedManifestField = true;
      }),
    );
    for (const key of Object.keys(at(baseline, path))) {
      const value = altered(path, (object) => {
        delete object[key];
      });
      assert.throws(
        () => decode(value),
        WorkloadProfileManifestError,
        `required ${location}.${key}`,
      );
    }
  }
});

test("manifest and operator-admission envelope fields cannot be mixed", () => {
  for (const [key, value] of [
    ["schemaVersion", 2],
    ["schemaVersion", "1"],
    ["manifestRef", "00000000-0000-4000-8000-000000000001"],
    ["installationId", "ins_00000000-0000-4000-8000-000000000001"],
    ["admissionVersion", 1],
    ["manifestDigest", `sha256:${"1".repeat(64)}`],
  ])
    rejects({ ...fixture(), [key]: value });
});

test("object insertion order and JSON whitespace do not change normalized manifest bytes", () => {
  const original = derive(fixture());
  const reordered = reorderedObjects(fixture());
  const prettyBytes = encoder.encode(` \r\n${JSON.stringify(reordered, null, 2)}\t\n`);
  const decoded = decodeWorkloadProfileManifest(prettyBytes);
  const derived = deriveWorkloadProfileManifest(prettyBytes);
  assert.deepEqual(decoded.canonicalBytes, original.canonicalBytes);
  assert.deepEqual(derived.canonicalBytes, original.canonicalBytes);
  assert.deepEqual(plain(derived.digests), plain(original.digests));
  assert.equal(decoded.canonicalBytes.at(-1) === 0x0a, false);
});

test("returned content, projections and maps are frozen independently from byte buffers", () => {
  const input = bytes(fixture());
  const first = deriveWorkloadProfileManifest(input);
  const expectedBytes = first.canonicalBytes.slice();
  const expectedContent = plain(first.content);
  for (const value of [
    first.content,
    first.projections,
    first.digests,
    first.roleDigests,
    first.unavailableDigests,
  ])
    frozen(value);
  input.fill(0);
  assert.deepEqual(first.canonicalBytes, expectedBytes);
  first.canonicalBytes.fill(0);
  assert.deepEqual(plain(first.content), expectedContent);
  const second = derive(fixture());
  assert.deepEqual(second.canonicalBytes, expectedBytes);
  assert.deepEqual(plain(first.digests), plain(second.digests));
});

test("manifest entry points preserve raw duplicate-key, null and encoding rejection", () => {
  const source = JSON.stringify(fixture());
  const raw = encoder.encode(source);
  const documentaryOffset =
    Buffer.from(raw).indexOf(Buffer.from('"required":"')) + '"required":"'.length;
  assert.ok(documentaryOffset >= '"required":"'.length);
  const invalidUtf8 = Uint8Array.from([
    ...raw.subarray(0, documentaryOffset),
    0xc0,
    0xaf,
    ...raw.subarray(documentaryOffset),
  ]);
  const literalReplacement = Uint8Array.from([
    ...raw.subarray(0, documentaryOffset),
    ...encoder.encode("��"),
    ...raw.subarray(documentaryOffset),
  ]);
  const fullSize = encoder.encode(source + " ".repeat(65_536 - raw.byteLength));
  const tooLarge = Uint8Array.from([...fullSize, 0x20]);
  const invalidBytes = [
    encoder.encode(source.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
    encoder.encode(
      source.replace('"schemaVersion":1', '"schemaVersion":1,"\\u0073chemaVersion":1'),
    ),
    encoder.encode(source.replace('"schemaVersion":1', '"schemaVersion":null')),
    encoder.encode(source.replace('"schemaVersion":1', '"schemaVersion":1e0')),
    encoder.encode(source.replace('"schemaVersion":1', '"schemaVersion":1.0')),
    invalidUtf8,
    tooLarge,
  ];
  for (const operation of [decodeWorkloadProfileManifest, deriveWorkloadProfileManifest]) {
    assert.doesNotThrow(() => operation(fullSize));
    assert.doesNotThrow(() => operation(literalReplacement));
    for (const input of invalidBytes)
      assert.throws(
        () => operation(input),
        (error) =>
          error instanceof WorkloadProfileManifestError ||
          error instanceof WorkloadProfileJsonError,
      );
    assert.throws(
      () => operation(source),
      (error) =>
        error instanceof WorkloadProfileManifestError || error instanceof WorkloadProfileJsonError,
    );
    assert.throws(
      () => operation(fixture()),
      (error) =>
        error instanceof WorkloadProfileManifestError || error instanceof WorkloadProfileJsonError,
    );
  }
});

test("profile projections include exactly their specified subdocuments and selected claims", () => {
  const result = derive(fixture());
  // The fixture's declared sets are independently ordered above; the expected
  // projection must not inherit a decoder's accidental content loss or replacement.
  const value = fixture();
  assert.deepEqual(plain(result.content), value);
  const producers = value.evidenceRequirements.requiredProducers;
  const producer = (claim) => producers.find((entry) => entry.claim === claim);
  const artifact = (role) => value.artifactSet.find((entry) => entry.role === role);
  const runtime = value.launchConfiguration.runtime;
  const expected = {
    manifest: value,
    artifactSet: value.artifactSet,
    launchConfiguration: value.launchConfiguration,
    providerProfile: {
      target: value.target,
      runtimeApplicability: {
        runtimeClass: runtime.runtimeClass,
        handler: runtime.handler,
        type: runtime.type,
        platform: runtime.platform,
        sidecarUsagePolicy: runtime.sidecarUsagePolicy,
      },
      effectRequirements: [
        producer("closed-provider-effects"),
        producer("protected-service-and-preparation"),
      ],
      beforeAnyWrite: value.launchConfiguration.beforeAnyWrite,
    },
    runtimeProfile: {
      artifacts: [
        artifact("gvisor-node-distribution"),
        artifact("harness-native"),
        artifact("kubernetes-node"),
        artifact("pod-sandbox-image"),
      ],
      launchConfiguration: value.launchConfiguration,
      instanceRequirement: producer("exact-instance-and-restart"),
    },
    identityProfile: {
      wholeHarnessIdentity: value.containment.wholeHarnessIdentity,
      mechanismSelection: value.evidenceRequirements.mechanismSelection,
      identityAndAuthority: value.endpoints.identityAndAuthority,
      applicationToken: value.launchConfiguration.mountPolicy.applicationToken,
      claims: [
        producer("authenticated-peer"),
        producer("exact-instance-and-restart"),
        producer("identity-verification"),
      ],
    },
    containment: value.containment,
    storageProfile: {
      mountPolicy: value.launchConfiguration.mountPolicy,
      storeBinding: value.launchConfiguration.serverBindingParameters.stores,
      beforeAnyWrite: value.launchConfiguration.beforeAnyWrite,
    },
    endpoints: value.endpoints,
    evidenceRequirements: value.evidenceRequirements,
    mountPolicy: value.launchConfiguration.mountPolicy,
    resourceEnvelope: value.launchConfiguration.resourceEnvelope,
    runtimeFlags: runtime,
  };
  assert.deepEqual(plain(result.projections), plain(expected));
  assert.equal(Array.isArray(result.projections.runtimeProfile.instanceRequirement), false);
});

test("the synthetic manifest matches independently computed canonical and domain golden values", () => {
  // Fixed values were computed from the synthetic fixture with an independent
  // standard JSON encoder and SHA-256 implementation, using the specified
  // projections and one literal LF after each domain. No production helper
  // generates an expected digest in this test.
  const expected = {
    manifestDigest: "sha256:22d9e275b330760bd125c7c113864f0ec1e095125ff364a5eb31326e53a6c781",
    artifactSetDigest: "sha256:612135441faa39bc418cdc37b7b049e4320bd174673c2ff68dd3895d923c7195",
    launchConfigurationDigest:
      "sha256:ef47d18fd3d5cf0e933f71685da411b0e5ee2e9b577977fc2e74627f6490437e",
    providerProfileDigest:
      "sha256:168381aa38e139dc2b452507c202f29e012aa2d04e796e061270634578461ecc",
    runtimeProfileDigest: "sha256:2099a2a3d76081d9fa4df30a58e9f7763731d31142aa78d464500907e069aa0c",
    identityProfileDigest:
      "sha256:9776a837f4cf3be5c52757e79b0b8ef8020e54226fcf3c9652240858dce16ce3",
    containmentDigest: "sha256:3bd2359f941bbc1ed867622d765a9631f2d79d2d125be35cb69e984388df8f03",
    storageProfileDigest: "sha256:533f0a0f2ad9a6daee83b8fabfb4f942d918e779f402bcc232bf8ef6f00f9290",
    endpointsDigest: "sha256:a977a01ade24a2787b0143e338d8d802d1dd5527395d0c56f00a0877f7cc0481",
    evidenceRequirementsDigest:
      "sha256:82e98cc260d46b1fcab0c5ab986a2379317983c637a560b0b8536b08e79a384c",
    mountPolicyDigest: "sha256:11e66ec0ee0030c885a64c4ed82de21ae33503425943fd7ad057399706202ac3",
    resourceEnvelopeDigest:
      "sha256:81b007040ae0a36b0e73ca6b4980e4620e66aa25afdc6bc5b8c63e0eb4dd8938",
    runtimeFlagsDigest: "sha256:22bb062ada7f2b2e6246110b521c3d14b23a850cc055639ca7c606c132931fff",
  };
  for (const result of [decode(fixture()), derive(fixture())]) {
    assert.equal(result.canonicalBytes.byteLength, 21_724);
    assert.equal(
      createHash("sha256").update(result.canonicalBytes).digest("hex"),
      "55873ffaa2c17871401a2ea00e6cdd8d1bb30b62ab2e4d607e62850b69d27c1b",
    );
  }
  assert.deepEqual(plain(derive(fixture()).digests), expected);
});

// Static synthetic inputs exercise the existing accounting grammar only. They
// are not an accepted profile, a real envelope selection, or runtime evidence.
function staticAccounting(seed = accountingEnvelope()) {
  for (const component of ["gateway", "harness"]) {
    seed.observations[component] = {
      status: "unavailable",
      ownerRef: `fixture-${component}-observer`,
      reason: "producer-port-unavailable",
    };
  }
  return seed;
}
function selectedAccounting(seed = staticAccounting()) {
  const value = fixture();
  value.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting = {
    status: "selected",
    envelope: seed,
  };
  return value;
}
const selectedProjection = (value) => projectWorkloadProfileResourceAccountingV1(bytes(value));
function rejectsAccounting(value) {
  for (const operation of [decode, derive, selectedProjection]) {
    assert.throws(
      () => operation(value),
      (error) =>
        error instanceof WorkloadProfileManifestError || error instanceof WorkloadProfileJsonError,
    );
  }
}

test("static accounting selection retains the full immutable seed and original identity", () => {
  const value = selectedAccounting();
  const branch = value.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting;
  const expectedSeed = parseRuntimeResourceAccountingV1(branch.envelope);
  const decoded = decode(value);
  const projected = selectedProjection(value);
  assert.deepEqual(plain(projected), branch);
  assert.deepEqual(projected.envelope, expectedSeed);
  assert.equal(projected.envelope.envelopeRef, "fixture-envelope");
  assert.equal(projected.envelope.envelopeVersion, 1);
  frozen(projected);
  branch.envelope.envelopeRef = "changed-after-projection";
  assert.equal(projected.envelope.envelopeRef, "fixture-envelope");
  assert.deepEqual(projectWorkloadProfileResourceAccountingV1(decoded.canonicalBytes), projected);
  assert.deepEqual(
    plain(selectedProjection(fixture())),
    fixture().launchConfiguration.resourceEnvelope.podAndRuntimeAccounting,
  );
  const changedShape = selectedAccounting();
  changedShape.target.component = "gateway";
  rejectsAccounting(changedShape); // The accessor still validates the whole definition.
});

test("selected seed identity and content affect only the original enclosing projection domains", () => {
  const value = selectedAccounting();
  const baseline = derive(value);
  const affected = [
    "launchConfigurationDigest",
    "manifestDigest",
    "resourceEnvelopeDigest",
    "runtimeProfileDigest",
  ];
  assert.deepEqual(changedDigests(derive(fixture()).digests, baseline.digests), affected);
  for (const mutate of [
    (seed) => {
      seed.envelopeRef = "another-envelope";
    },
    (seed) => {
      seed.envelopeVersion += 1;
    },
    (seed) => {
      seed.harness.value.contributions[0].resources.cpuMilli.value.request += 1;
    },
    (seed) => {
      seed.gateway.ownerRef = "another-static-owner";
    },
    (seed) => {
      seed.observations.harness.ownerRef = "another-observer-owner";
    },
  ]) {
    const changed = selectedAccounting();
    mutate(changed.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting.envelope);
    const result = derive(changed);
    assert.deepEqual(changedDigests(baseline.digests, result.digests), affected);
    assert.deepEqual(plain(result.unavailableDigests), unavailable);
  }
  // Independent standard JSON encoding confirms that the complete outer object,
  // including its container quantities, remains under the original digest domain.
  const sorted = (value) => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sorted(value[key])]),
      );
    return value;
  };
  const domainHash = (value) =>
    `sha256:${createHash("sha256")
      .update("oce.workload-profile.resource-envelope.v1\n")
      .update(JSON.stringify(sorted(value)))
      .digest("hex")}`;
  assert.equal(
    baseline.digests.resourceEnvelopeDigest,
    domainHash(value.launchConfiguration.resourceEnvelope),
  );
  assert.notEqual(
    baseline.digests.resourceEnvelopeDigest,
    domainHash(value.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting.envelope),
  );
  assert.deepEqual(plain(derive(reorderedObjects(value)).digests), plain(baseline.digests));
});

test("missing accounting budgets remain explicit and confer no admitted configuration", () => {
  const value = selectedAccounting(staticAccounting(selectedRequirements()));
  const result = derive(value);
  const projected = selectedProjection(value);
  assert.equal(projected.envelope.repositoryPreparation.status, "unavailable");
  assert.equal(projected.envelope.harness.value.phases.status, "unavailable");
  const validation = validateRuntimeResourceAccountingV1(projected.envelope);
  assert.equal(validation.status, "incomplete");
  assert.equal(validation.totals.node, null);
  assert.deepEqual(plain(result.unavailableDigests), unavailable);
  assert.ok(result.content.capabilities.every((entry) => entry.status === "non-executable"));
  assert.deepEqual(plain(projected.envelope.effectiveResources), {
    status: "unavailable",
    reason: "producer-port-unavailable",
  });
  assert.equal(Object.hasOwn(projected, "totals"), false);
  assert.equal(Object.hasOwn(projected, "result"), false);
  // A schema-valid seed can still fail the separate arithmetic validator.
  const infeasible = staticAccounting();
  infeasible.harness.value.contributions[0].resources.cpuMilli.value.request = 201;
  assert.equal(
    validateRuntimeResourceAccountingV1(selectedProjection(selectedAccounting(infeasible)).envelope)
      .status,
    "invalid",
  );
});

test("accounting selection rejects malformed, partial and observation-bearing seed variants", () => {
  for (const mutate of [
    (branch) => {
      branch.status = "resolved";
    },
    (branch) => {
      branch.extra = true;
    },
    (branch) => {
      delete branch.envelope;
    },
    (branch) => {
      delete branch.envelope.envelopeRef;
    },
    (branch) => {
      branch.envelope.envelopeRef = "";
    },
    (branch) => {
      branch.envelope.envelopeVersion = 0;
    },
    (branch) => {
      branch.envelope.envelopeVersion = "1";
    },
    (branch) => {
      delete branch.envelope.repositoryPreparation;
    },
    (branch) => {
      delete branch.envelope.observations.gateway.ownerRef;
    },
    (branch) => {
      branch.envelope.observations.harness.ownerRef = "";
    },
    (branch) => {
      branch.envelope.observations.gateway.reason = "owner-input-missing";
    },
    (branch) => {
      branch.envelope.observations.harness.reason = "evidence-unavailable";
    },
    (branch) => {
      branch.envelope.observations.gateway = { status: "required", ownerRef: "owner" };
    },
    (branch) => {
      branch.envelope.observations.harness = {
        status: "unsupported",
        ownerRef: "owner",
        reason: "profile-unsupported",
      };
    },
    (branch) => {
      branch.envelope.observations.harness.observedAt = "2026-01-01T00:00:00.000Z";
    },
    (branch) => {
      branch.envelope.observations.gateway.podUid = "observed-pod";
    },
    (branch) => {
      branch.envelope.effectiveResources.status = "supplied";
    },
    (branch) => {
      branch.envelope.result = "accounted";
    },
    (branch) => {
      branch.envelope.totals = null;
    },
    (branch) => {
      branch.envelope = validateRuntimeResourceAccountingV1(branch.envelope);
    },
  ]) {
    const value = selectedAccounting();
    mutate(value.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting);
    rejectsAccounting(value);
  }
  for (const status of ["incomplete", "ambiguous", "unknown"]) {
    const seed = staticAccounting();
    seed.observations.harness = {
      status: "supplied",
      ownerRef: "fixture-observer",
      value: {
        schemaVersion: 1,
        status,
        input: observation().input,
        reasonCode: "evidence-incomplete",
      },
    };
    assert.doesNotThrow(() => parseRuntimeResourceAccountingV1(seed));
    rejectsAccounting(selectedAccounting(seed));
  }
  const observed = staticAccounting();
  observed.observations.harness = {
    status: "supplied",
    ownerRef: "fixture-observer",
    value: observation(),
  };
  assert.doesNotThrow(() => parseRuntimeResourceAccountingV1(observed));
  rejectsAccounting(selectedAccounting(observed));
});
