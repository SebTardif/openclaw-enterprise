import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  KubernetesSecretDriver,
  SecretBackendUnavailableError,
  SecretConflictError,
  SecretOwnershipError,
  SecretValidationError,
} from "../../apps/controller/src/drivers/secret/kubernetes/index.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";

function clone(value) {
  return structuredClone(value);
}

function kubernetesNamespaceName(namespaceId) {
  const slug =
    namespaceId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 46)
      .replace(/-+$/g, "") || "ns";
  return `oce-${slug}-${createHash("sha256").update(namespaceId).digest("hex").slice(0, 12)}`;
}

class FakeCoreV1Api {
  namespaces = new Map();
  secrets = new Map();
  reads = 0;
  deletes = [];
  readSecretFailureCodes = [];
  readSecretTimesOut = false;
  loseNextCreateResponse = false;

  addNamespace(namespaceId) {
    const name = kubernetesNamespaceName(namespaceId);
    this.namespaces.set(name, {
      metadata: {
        name,
        labels: {
          "app.kubernetes.io/managed-by": "openclaw-enterprise",
          "openclaw.dev/namespace": namespaceId,
        },
        annotations: { "openclaw.dev/namespace-id": namespaceId },
      },
      status: { phase: "Active" },
    });
    return name;
  }

  async listNamespace({ labelSelector }) {
    const [, namespaceId] = labelSelector.split("=");
    return {
      items: [...this.namespaces.values()].filter(
        ({ metadata }) => metadata.labels?.["openclaw.dev/namespace"] === namespaceId,
      ),
    };
  }

  async readNamespace({ name }) {
    const namespace = this.namespaces.get(name);
    if (namespace === undefined) {
      throw Object.assign(new Error("missing namespace"), { code: 404 });
    }
    return clone(namespace);
  }

  async createNamespacedSecret({ namespace, body }) {
    const key = `${namespace}/${body.metadata.name}`;
    if (this.secrets.has(key)) {
      throw Object.assign(new Error("conflict"), { code: 409 });
    }
    const stored = {
      ...clone(body),
      metadata: {
        ...body.metadata,
        uid: `uid-${this.secrets.size + 1}`,
        resourceVersion: "1",
      },
      data: Object.fromEntries(
        Object.entries(body.stringData).map(([name, value]) => [
          name,
          Buffer.from(value, "utf8").toString("base64"),
        ]),
      ),
    };
    delete stored.stringData;
    this.secrets.set(key, stored);
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      throw new Error(`create response lost after storing ${body.stringData.value}`);
    }
    return clone(stored);
  }

  async readNamespacedSecret({ namespace, name }) {
    this.reads += 1;
    const failureCode = this.readSecretFailureCodes.shift();
    if (failureCode !== undefined) {
      throw Object.assign(new Error(`read failed with ${failureCode}`), { code: failureCode });
    }
    if (this.readSecretTimesOut) {
      const signal = currentComputeAbortSignal();
      await new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    }
    const secret = this.secrets.get(`${namespace}/${name}`);
    if (secret === undefined) {
      throw Object.assign(new Error("missing secret"), { code: 404 });
    }
    return clone(secret);
  }

  async replaceNamespacedSecret({ namespace, name, body }) {
    const key = `${namespace}/${name}`;
    const existing = this.secrets.get(key);
    if (existing === undefined) {
      throw Object.assign(new Error("missing secret"), { code: 404 });
    }
    if (body.metadata.resourceVersion !== existing.metadata.resourceVersion) {
      throw Object.assign(new Error("resource version conflict"), { code: 409 });
    }
    const stored = {
      ...clone(body),
      metadata: {
        ...body.metadata,
        uid: existing.metadata.uid,
        resourceVersion: String(Number(existing.metadata.resourceVersion) + 1),
      },
      data: Object.fromEntries(
        Object.entries(body.stringData).map(([dataKey, value]) => [
          dataKey,
          Buffer.from(value, "utf8").toString("base64"),
        ]),
      ),
    };
    delete stored.stringData;
    this.secrets.set(key, stored);
    return clone(stored);
  }

  async deleteNamespacedSecret({ namespace, name, body }) {
    const key = `${namespace}/${name}`;
    const existing = this.secrets.get(key);
    if (existing === undefined) {
      throw Object.assign(new Error("missing secret"), { code: 404 });
    }
    const preconditions = body?.preconditions;
    this.deletes.push(clone(preconditions));
    if (
      preconditions?.uid !== existing.metadata.uid ||
      preconditions?.resourceVersion !== existing.metadata.resourceVersion
    ) {
      throw Object.assign(new Error("delete precondition conflict"), { code: 409 });
    }
    this.secrets.delete(key);
    return {};
  }
}

function secretId() {
  return `sec_${randomUUID()}`;
}

function namespaceId() {
  return `ns_${randomUUID()}`;
}

function driverWithClient(client) {
  const driver = new KubernetesSecretDriver(
    { authentication: { mode: "inCluster" } },
    { id: "secret-kubernetes", implementation: "occ/kubernetes-secret" },
  );
  driver.client = Promise.resolve(client);
  return driver;
}

test("kubernetes-secret-driver stores, verifies, updates, resolves, and deletes one exact Namespace Secret", async () => {
  const client = new FakeCoreV1Api();
  const nsId = namespaceId();
  const namespace = client.addNamespace(nsId);
  const driver = driverWithClient(client);
  const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };

  const backendRef = await driver.create(identity, "stored-value");
  assert.equal(backendRef.namespaceName, namespace);
  assert.equal(backendRef.key, "value");
  assert.match(backendRef.name, /^secret-[a-f0-9]{12}-[a-f0-9]{12}-[a-f0-9]{12}$/);

  const stored = client.secrets.get(`${namespace}/${backendRef.name}`);
  assert.equal(stored.type, "Opaque");
  assert.equal(stored.immutable, false);
  assert.deepEqual(stored.metadata.labels, {
    "app.kubernetes.io/managed-by": "openclaw-enterprise",
    "openclaw.dev/namespace": nsId,
    "openclaw.dev/secret": identity.id,
  });
  assert.deepEqual(stored.metadata.annotations, {
    "openclaw.dev/namespace-id": nsId,
    "openclaw.dev/secret-id": identity.id,
    "openclaw.dev/secret-name": "model-key",
    "openclaw.dev/secret-driver-id": "secret-kubernetes",
  });

  stored.metadata.labels["operator.example/retained"] = "true";
  await driver.update(
    {
      ...identity,
      driverId: driver.id,
      backendRef,
      createdAt: new Date().toISOString(),
    },
    "rotated-value",
  );
  const updated = client.secrets.get(`${namespace}/${backendRef.name}`);
  assert.equal(updated.metadata.uid, backendRef.uid);
  assert.equal(updated.metadata.labels["operator.example/retained"], "true");
  assert.equal(Buffer.from(updated.data.value, "base64").toString("utf8"), "rotated-value");
  assert.deepEqual(
    await driver.resolve({
      ...identity,
      driverId: driver.id,
      backendRef,
      createdAt: new Date().toISOString(),
    }),
    backendRef,
  );

  await driver.delete({
    ...identity,
    driverId: driver.id,
    backendRef: { ...backendRef, uid: updated.metadata.uid },
    createdAt: new Date().toISOString(),
  });
  assert.deepEqual(client.deletes[0], {
    uid: updated.metadata.uid,
    resourceVersion: updated.metadata.resourceVersion,
  });
  await driver.delete({
    ...identity,
    driverId: driver.id,
    backendRef: { ...backendRef, uid: updated.metadata.uid },
    createdAt: new Date().toISOString(),
  });
});

test("staged Secrets recover unknown writes without exposing or replacing immutable material", async () => {
  const client = new FakeCoreV1Api();
  const nsId = namespaceId();
  const namespace = client.addNamespace(nsId);
  const identity = { id: secretId(), namespaceId: nsId, name: "pending-generation" };
  const value = JSON.stringify({ access: "test-access", refresh: "test-refresh", expires: 12345 });
  const driver = driverWithClient(client);
  assert.equal(await driver.findStaged(identity), undefined);

  // Kubernetes committed the create but the caller never received its backend identity.
  client.loseNextCreateResponse = true;
  await assert.rejects(driver.stage(identity, value), (error) => {
    assert.ok(error instanceof SecretBackendUnavailableError);
    assert.equal(error.message.includes("test-access"), false);
    assert.equal(error.message.includes("test-refresh"), false);
    return true;
  });
  assert.equal(client.secrets.size, 1);

  // A fresh controller recovers with just the persisted immutable identity, not token bytes.
  const recovered = driverWithClient(client);
  const backendRef = await recovered.findStaged(identity);
  assert.deepEqual(Object.keys(backendRef).sort(), ["key", "name", "namespaceName", "uid"]);
  assert.equal(backendRef.namespaceName, namespace);
  assert.deepEqual(await recovered.stage(identity, value), backendRef);
  assert.equal(client.secrets.size, 1);
  const stored = client.secrets.get(`${namespace}/${backendRef.name}`);
  assert.equal(stored.immutable, true);
  assert.equal(Buffer.from(stored.data.value, "base64").toString("utf8"), value);

  const secret = {
    ...identity,
    driverId: recovered.id,
    backendRef,
    createdAt: new Date().toISOString(),
  };
  assert.deepEqual(await recovered.resolve(secret), backendRef);
  await assert.rejects(recovered.update(secret, "replacement"), SecretOwnershipError);
  assert.equal(client.secrets.get(`${namespace}/${backendRef.name}`).data.value, stored.data.value);

  await assert.rejects(
    recovered.delete({ ...secret, backendRef: { ...backendRef, uid: "another-object" } }),
    SecretOwnershipError,
  );
  assert.deepEqual(client.deletes, []);
  await recovered.delete(secret);
  assert.deepEqual(client.deletes, [
    { uid: backendRef.uid, resourceVersion: stored.metadata.resourceVersion },
  ]);
  assert.equal(await recovered.findStaged(identity), undefined);
  await recovered.delete(secret);
});

test("staged Secret retries reject replacement bytes and foreign or mutable backend identities", async () => {
  for (const scenario of [
    "different value",
    "foreign owner",
    "foreign driver",
    "different name",
    "mutable backend",
  ]) {
    const client = new FakeCoreV1Api();
    const nsId = namespaceId();
    const namespace = client.addNamespace(nsId);
    const driver = driverWithClient(client);
    const identity = { id: secretId(), namespaceId: nsId, name: "pending-generation" };
    const backendRef = await driver.stage(identity, "original-material");
    const stored = client.secrets.get(`${namespace}/${backendRef.name}`);
    if (scenario === "foreign owner") {
      stored.metadata.labels["openclaw.dev/secret"] = secretId();
    }
    if (scenario === "foreign driver") {
      stored.metadata.annotations["openclaw.dev/secret-driver-id"] = "other";
    }
    if (scenario === "different name") {
      stored.metadata.annotations["openclaw.dev/secret-name"] = "other";
    }
    if (scenario === "mutable backend") {
      stored.immutable = false;
    }
    const expected = scenario === "different value" ? SecretConflictError : SecretOwnershipError;
    await assert.rejects(
      driver.stage(
        identity,
        scenario === "different value" ? "replacement-material" : "original-material",
      ),
      expected,
      scenario,
    );
    if (scenario !== "different value") {
      await assert.rejects(driver.findStaged(identity), SecretOwnershipError);
    }
    assert.equal(client.secrets.size, 1);
    assert.equal(Buffer.from(stored.data.value, "base64").toString("utf8"), "original-material");
  }
});

test("staged Secret recovery distinguishes missing material from denied access", async () => {
  const client = new FakeCoreV1Api();
  const nsId = namespaceId();
  client.addNamespace(nsId);
  const driver = driverWithClient(client);
  const identity = { id: secretId(), namespaceId: nsId, name: "pending-generation" };
  client.readSecretFailureCodes.push(403);
  await assert.rejects(driver.findStaged(identity), SecretBackendUnavailableError);
  assert.equal(await driver.findStaged(identity), undefined);
});

test("kubernetes-secret-driver fails closed on missing placement, invalid values, and foreign backends", async () => {
  for (const scenario of [
    {
      name: "foreign namespace label",
      mutateStored: (stored) => (stored.metadata.labels["openclaw.dev/namespace"] = namespaceId()),
    },
    {
      name: "foreign Secret label",
      mutateStored: (stored) => (stored.metadata.labels["openclaw.dev/secret"] = secretId()),
    },
    {
      name: "foreign driver annotation",
      mutateStored: (stored) =>
        (stored.metadata.annotations["openclaw.dev/secret-driver-id"] = "other"),
    },
    {
      name: "foreign backend namespace",
      mutateBackendRef: (backendRef) => ({ ...backendRef, namespaceName: "foreign-namespace" }),
    },
    {
      name: "foreign backend UID",
      mutateBackendRef: (backendRef) => ({ ...backendRef, uid: "foreign-uid" }),
    },
  ]) {
    const client = new FakeCoreV1Api();
    const nsId = namespaceId();
    const namespace = client.addNamespace(nsId);
    const driver = driverWithClient(client);
    const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };
    const backendRef = await driver.create(identity, "safe-value");
    scenario.mutateStored?.(client.secrets.get(`${namespace}/${backendRef.name}`));
    await assert.rejects(
      driver.resolve({
        ...identity,
        driverId: driver.id,
        backendRef: scenario.mutateBackendRef?.(backendRef) ?? backendRef,
        createdAt: new Date().toISOString(),
      }),
      SecretOwnershipError,
      scenario.name,
    );
  }

  const client = new FakeCoreV1Api();
  const nsId = namespaceId();
  client.addNamespace(nsId);
  const driver = driverWithClient(client);
  const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };
  await assert.rejects(
    () => driver.create({ ...identity, id: secretId() }, ""),
    SecretValidationError,
  );
  await assert.rejects(
    () => driver.create({ ...identity, id: secretId() }, "\ud800"),
    SecretValidationError,
  );
  await assert.rejects(
    () => driver.create({ ...identity, id: secretId(), namespaceId: namespaceId() }, "safe-value"),
    SecretBackendUnavailableError,
  );
});

test("kubernetes-secret-driver delete reports inaccessible backends instead of idempotent success", async () => {
  for (const failure of [403, 500, "timeout"]) {
    const client = new FakeCoreV1Api();
    const nsId = namespaceId();
    const namespace = client.addNamespace(nsId);
    const driver = driverWithClient(client);
    const identity = { id: secretId(), namespaceId: nsId, name: "model-key" };
    const backendRef = await driver.create(identity, "stored-value");
    const secret = {
      ...identity,
      driverId: driver.id,
      backendRef,
      createdAt: new Date().toISOString(),
    };
    const readCountBeforeDelete = client.reads;
    if (failure === "timeout") {
      client.readSecretTimesOut = true;
    } else {
      client.readSecretFailureCodes.push(failure, failure, failure);
    }

    await assert.rejects(() => driver.delete(secret), SecretBackendUnavailableError);
    assert.equal(client.secrets.has(`${namespace}/${backendRef.name}`), true);
    assert.deepEqual(client.deletes, []);
    assert.ok(client.reads > readCountBeforeDelete);
  }
});
