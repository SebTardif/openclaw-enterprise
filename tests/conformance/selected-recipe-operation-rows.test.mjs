import assert from "node:assert/strict";
import test from "node:test";
import {
  createCredentialSchemaRegistryV1,
  INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1,
} from "@openclaw-enterprise/occ";
import {
  githubOperationRegistrationsV1,
  githubResourcePolicyEncodingV1,
} from "@openclaw-enterprise/occ/internal/backend-recipe-operations-v1";
import {
  syntheticArchiveOperationRegistrationsV1,
  syntheticArchiveResourcePolicyEncodingV1,
  sampleOperationData,
  sampleProfileData,
} from "../fixtures/selected-recipe-operations/synthetic-provider.ts";
import { canonical, schemaDigest, retainedDigest } from "../helpers/credential-schema.mjs";

const rows = [...githubOperationRegistrationsV1, ...syntheticArchiveOperationRegistrationsV1];
const definitions = [
  githubOperationRegistrationsV1[0].definition,
  syntheticArchiveOperationRegistrationsV1[0].definition,
];
const deny = (call, code) => assert.throws(call, new RegExp(`^Error: ${code}$`));

// This harness invokes the actual registry on GitHub production DATA and an
// independently invented third-party fixture; it proves registry behavior only.
// It does not implement or call the declared selected factory/resource projector.
function registeredRows(commit = true) {
  const registry = createCredentialSchemaRegistryV1(definitions, {
    admittedPrimitives: INSTALLED_CREDENTIAL_SCHEMA_PRIMITIVES_V1,
  });
  const scopes = new Map();
  const codecs = new Map();
  for (const definition of definitions) {
    const scope = registry.begin(definition);
    scopes.set(definition.backendId, scope);
    for (const row of rows.filter((row) => row.definition.backendId === definition.backendId)) {
      for (const registration of [row.operationRegistration, row.profileRegistration]) {
        const key = canonical(registration.binding);
        if (!codecs.has(key)) codecs.set(key, scope.schemas.register(registration));
      }
    }
    if (commit) scope.commit();
  }
  return { registry, scopes, codec: (registration) => codecs.get(canonical(registration.binding)) };
}
function operationData(row, opaqueId = "Group/Nested/Case-Sensitive-ID") {
  if (row.definition.backendId === "example-archive") return sampleOperationData(opaqueId);
  const schema = row.operationRegistration.jsonSchema;
  const resource = {
    upstreamInstanceId: "trusted-upstream-instance-A",
    canonicalResourceId: opaqueId,
    resourceSchema: githubResourcePolicyEncodingV1.resourceSchema,
  };
  return {
    kind: schema.properties.kind.const,
    accessProfile: schema.properties.accessProfile.const,
    resource,
  };
}
function profileData(row) {
  if (row.definition.backendId === "example-archive") return sampleProfileData();
  const write =
    row.operationRegistration.jsonSchema.properties.accessProfile.const === "read-write";
  return {
    accessProfile: write ? "read-write" : "read",
    tokenProfile: write ? "repository-write-v1" : "repository-read-v1",
    permissions: write
      ? { metadata: "read", contents: "write", pull_requests: "write" }
      : { metadata: "read", contents: "read" },
  };
}
function resourceIn(row, input) {
  return row.definition.backendId === "github" ? input.resource : input.target;
}

test("finite production catalog preserves the exact ten GitHub operation/profile pairs", () => {
  const expected = [
    ["read", "metadata"],
    ["read", "fetch-discovery"],
    ["read", "fetch"],
    ["read-write", "metadata"],
    ["read-write", "fetch-discovery"],
    ["read-write", "fetch"],
    ["read-write", "push-discovery"],
    ["read-write", "push-probe"],
    ["read-write", "push"],
    ["read-write", "pull-request-create"],
  ];
  assert.deepEqual(
    githubOperationRegistrationsV1.map((row) => [
      row.operationRegistration.jsonSchema.properties.accessProfile.const,
      row.operationRegistration.jsonSchema.properties.kind.const,
    ]),
    expected,
  );
});

test("invented external registration preserves backend identity through the generic contract", () => {
  assert.equal(syntheticArchiveOperationRegistrationsV1.length, 1);
  assert.equal(
    syntheticArchiveOperationRegistrationsV1[0].operationRegistration.jsonSchema.properties.kind
      .const,
    "json-read",
  );
  assert.notDeepEqual(definitions[0], definitions[1]);
  assert.notDeepEqual(
    githubResourcePolicyEncodingV1.resourceSchema,
    syntheticArchiveResourcePolicyEncodingV1.resourceSchema,
  );
  assert.notEqual(
    githubResourcePolicyEncodingV1.resourceNamespace,
    syntheticArchiveResourcePolicyEncodingV1.resourceNamespace,
  );
  for (const row of rows) {
    const backend = row.definition.backendId;
    const data = operationData(row);
    assert.equal(
      row.serviceId,
      backend === "github" ? "github.repository" : "example-archive.documents",
    );
    assert.equal(
      row.exactAction,
      backend === "github"
        ? `credential.github.repository.${data.kind}.v1`
        : "credential.example-archive.documents.inspect-record.v1",
    );
    assert.equal(row.operation.capability.serviceId, row.serviceId);
    assert.deepEqual(
      row.operation.capability.operationSchema,
      row.operationRegistration.binding.schema,
    );
    assert.deepEqual(row.operation.inputSchema, row.operationRegistration.binding.schema);
    assert.deepEqual(
      row.operation.capability.profileSchema,
      row.profileRegistration.binding.schema,
    );
    assert.deepEqual(row.operationRegistration.binding.definition, row.definition);
    assert.deepEqual(row.profileRegistration.binding.definition, row.definition);
    assert.equal(row.operationRegistration.binding.role, "operation");
    assert.equal(row.profileRegistration.binding.role, "credential-profile");
    for (const registration of [row.operationRegistration, row.profileRegistration]) {
      assert.equal(registration.binding.schema.namespace, backend);
      assert.equal(
        registration.binding.schema.digest,
        schemaDigest(registration.jsonSchema, registration.maxBytes, registration.maxDepth),
      );
    }
    for (const bound of [
      row.operation.maxRequests,
      row.operation.maxRequestBytes,
      row.operation.maxResponseBytes,
      row.operation.deadlineMs,
    ]) {
      assert.ok(Number.isSafeInteger(bound) && bound > 0);
    }
    // Registration DATA cannot accidentally become an authority-bearing owner result.
    assert.equal(Object.hasOwn(row, "operationCodec"), false);
    assert.equal(Object.hasOwn(row, "profileCodec"), false);
    assert.equal(Object.hasOwn(row, "canonicalResource"), false);
    assert.ok(Object.isFrozen(row));
    assert.ok(Object.isFrozen(row.operationRegistration.jsonSchema));
    assert.throws(() => {
      row.exactAction = "changed";
    }, TypeError);
  }
});

test("accepted original registry validates, retains and restores GitHub and invented third-party operation/profile data", () => {
  const f = registeredRows();
  for (const row of rows) {
    for (const [registration, data] of [
      [row.operationRegistration, operationData(row)],
      [row.profileRegistration, profileData(row)],
    ]) {
      const codec = f.codec(registration);
      f.registry.assertCodec(codec, registration.binding);
      const value = codec.validate(data);
      const retained = codec.retain(value);
      assert.equal(retained.canonicalJson, canonical(data));
      assert.equal(retained.digest, retainedDigest(registration.binding, canonical(data)));
      assert.deepEqual(codec.retain(codec.restore(JSON.parse(JSON.stringify(retained)))), retained);
    }
  }
});

test("resource DATA preserves opaque IDs and upstream instances and refuses mismatched schema/display names", () => {
  const f = registeredRows();
  for (const row of rows) {
    const codec = f.codec(row.operationRegistration);
    for (const opaque of [
      "Group/Nested/CaseSensitive",
      "group/nested/casesensitive",
      "opaque:id/with/slashes",
      'Nested/É/😀/"quoted"/back\\slash',
    ]) {
      const input = operationData(row, opaque);
      const retained = codec.retain(codec.validate(input));
      const restored = codec.retain(codec.restore(retained));
      assert.equal(restored.canonicalJson, retained.canonicalJson);
      assert.equal(restored.digest, retained.digest);
      const roundTrip = JSON.parse(restored.canonicalJson);
      assert.equal(resourceIn(row, roundTrip).canonicalResourceId, opaque);
      const other = structuredClone(input);
      resourceIn(row, other).upstreamInstanceId = "trusted-upstream-instance-B";
      const otherRetained = codec.retain(codec.validate(other));
      assert.notEqual(otherRetained.canonicalJson, retained.canonicalJson);
      assert.notEqual(otherRetained.digest, retained.digest);
    }
    const input = operationData(row);
    for (const field of ["namespace", "name", "version", "digest"]) {
      const wrong = structuredClone(input);
      const schema = resourceIn(row, wrong).resourceSchema;
      schema[field] = field === "version" ? 2 : schema[field] + "-wrong";
      deny(() => codec.validate(wrong), "INVALID_VALUE");
    }
    const displayName = structuredClone(input);
    delete resourceIn(row, displayName).canonicalResourceId;
    resourceIn(row, displayName).displayName = "owner/repository";
    deny(() => codec.validate(displayName), "INVALID_VALUE");
    deny(() => codec.validate(operationData(row, "x".repeat(1025))), "INVALID_VALUE");
    const extra = { ...input, callerSelectedAction: "allow" };
    deny(() => codec.validate(extra), "INVALID_VALUE");
  }
});

test("registered schemas refuse read-write profile downgrade and read-profile write/fallback DATA", () => {
  const f = registeredRows();
  for (const row of rows) {
    const codec = f.codec(row.operationRegistration);
    const input = operationData(row);
    const wrongProfile = {
      ...input,
      accessProfile: input.accessProfile === "read" ? "read-write" : "read",
    };
    deny(() => codec.validate(wrongProfile), "INVALID_VALUE");
    const wrongKind = {
      ...input,
      kind: row.definition.backendId === "github" ? "json-read" : "push",
    };
    deny(() => codec.validate(wrongKind), "INVALID_VALUE");
    const profile = f.codec(row.profileRegistration);
    const correct = profileData(row);
    const wrongToken = {
      ...correct,
      tokenProfile:
        correct.tokenProfile === "repository-write-v1"
          ? "repository-read-v1"
          : "repository-write-v1",
    };
    deny(() => profile.validate(wrongToken), "INVALID_VALUE");
    const wrongPermissions = structuredClone(correct);
    if (row.definition.backendId === "example-archive") {
      wrongPermissions.permissions.catalog = "edit";
    } else {
      wrongPermissions.permissions.contents =
        correct.tokenProfile === "repository-write-v1" ? "read" : "write";
    }
    deny(() => profile.validate(wrongPermissions), "INVALID_VALUE");
    const omitted = { ...correct };
    delete omitted.tokenProfile;
    deny(() => profile.validate(omitted), "INVALID_VALUE");
  }
});

test("actual codec custody rejects foreign registry/handle and same-kind schema/profile/backend swaps", () => {
  const a = registeredRows();
  const b = registeredRows();
  for (const row of rows) {
    const operation = a.codec(row.operationRegistration);
    const profile = a.codec(row.profileRegistration);
    const foreign = b.codec(row.operationRegistration);
    const input = operationData(row);
    const value = operation.validate(input);
    const retained = operation.retain(value);
    deny(() => a.registry.assertCodec(foreign, row.operationRegistration.binding), "INVALID_CODEC");
    deny(
      () => a.registry.assertCodec({ ...operation }, row.operationRegistration.binding),
      "INVALID_CODEC",
    );
    deny(() => operation.retain(foreign.validate(input)), "INVALID_VALUE");
    deny(() => operation.retain({ ...value }), "INVALID_VALUE");
    deny(() => a.registry.assertCodec(operation, row.profileRegistration.binding), "INVALID_CODEC");
    deny(() => a.registry.assertCodec(profile, row.operationRegistration.binding), "INVALID_CODEC");
    deny(() => profile.retain(value), "INVALID_VALUE");
    deny(() => profile.restore(retained), "INVALID_VALUE");
    // Retained DATA can restore under an identical admitted binding in a fresh
    // registry; this never makes the foreign codec or live handle authentic.
    assert.deepEqual(foreign.retain(foreign.restore(retained)), retained);
    for (const other of rows) {
      if (
        canonical(other.operationRegistration.binding) ===
        canonical(row.operationRegistration.binding)
      )
        continue;
      const otherCodec = a.codec(other.operationRegistration);
      deny(
        () => a.registry.assertCodec(operation, other.operationRegistration.binding),
        "INVALID_CODEC",
      );
      deny(() => otherCodec.retain(value), "INVALID_VALUE");
      deny(() => otherCodec.restore(retained), "INVALID_VALUE");
      deny(() => otherCodec.validate(input), "INVALID_VALUE");
    }
    const profileInput = profileData(row);
    const profileValue = profile.validate(profileInput);
    const retainedProfile = profile.retain(profileValue);
    for (const other of rows) {
      if (
        canonical(other.profileRegistration.binding) === canonical(row.profileRegistration.binding)
      )
        continue;
      const otherProfile = a.codec(other.profileRegistration);
      deny(
        () => a.registry.assertCodec(profile, other.profileRegistration.binding),
        "INVALID_CODEC",
      );
      deny(() => otherProfile.retain(profileValue), "INVALID_VALUE");
      deny(() => otherProfile.restore(retainedProfile), "INVALID_VALUE");
      deny(() => otherProfile.validate(profileInput), "INVALID_VALUE");
    }
  }
});

test("original begin/register/commit refuses foreign backend registration and pending/discarded codecs", () => {
  const f = registeredRows(false);
  for (const row of rows) {
    const codec = f.codec(row.operationRegistration);
    deny(() => f.registry.assertCodec(codec, row.operationRegistration.binding), "INVALID_CODEC");
    deny(() => codec.validate(operationData(row)), "INVALID_CODEC");
  }
  const github = f.scopes.get("github");
  const archive = f.scopes.get("example-archive");
  deny(
    () =>
      github.schemas.register(syntheticArchiveOperationRegistrationsV1[0].operationRegistration),
    "INVALID_SCHEMA",
  );
  deny(
    () => archive.schemas.register(githubOperationRegistrationsV1[0].operationRegistration),
    "INVALID_SCHEMA",
  );
  for (const scope of f.scopes.values()) scope.commit();
  const handles = rows.map((row) => {
    const codec = f.codec(row.operationRegistration);
    const value = codec.validate(operationData(row));
    return { row, codec, value, retained: codec.retain(value) };
  });
  for (const scope of f.scopes.values()) scope.discard();
  for (const { row, codec, value, retained } of handles) {
    deny(() => f.registry.assertCodec(codec, row.operationRegistration.binding), "INVALID_CODEC");
    deny(() => codec.validate(operationData(row)), "INVALID_CODEC");
    deny(() => codec.retain(value), "INVALID_CODEC");
    deny(() => codec.restore(retained), "INVALID_CODEC");
  }
});
