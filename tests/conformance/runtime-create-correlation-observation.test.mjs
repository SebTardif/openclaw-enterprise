import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseRuntimeEffectsV1 } from "../../packages/contracts/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { resolveRuntimePreparationCreateReferenceV1 } from "../../packages/occ/src/runtime-preparation/create-reference.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { PREPARED_DEPLOYMENT_ANNOTATIONS as annotations } from "../../apps/controller/src/drivers/compute/kubernetes/prepared-deployment.ts";
import { currentComputeAbortSignal } from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { seedPreparation } from "../fixtures/runtime-preparation.mjs";

const { options } = JSON.parse(
  readFileSync(
    new URL("../fixtures/kubernetes-lifecycle-collaborators/inputs.json", import.meta.url),
    "utf8",
  ),
);
const copy = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function twoMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

// Real retained-history projection and actual selected Driver; controlled SDK
// responses only. Opaque test tokens/context do NOT authenticate a native call,
// State-recognized read or writer custody. These tests qualify physical data and
// local joining, never a native observation, C2 record or Runtime fence authority.
async function fixture(t, { clusterRef, noDependencies = false } = {}) {
  const seeded = await seedPreparation(new InMemoryPlatformState());
  await seeded.append(seeded.plan);
  await seeded.append(seeded.child);
  const child = seeded.child.child;
  const retained = {
    status: "retained",
    childOperation: await seeded.operation(seeded.child.operationRef),
    history: await seeded.history(),
    preparation: await seeded.record(),
    child,
    providerWireUtf8: seeded.providerWireUtf8,
    submission: {
      submissionRef: randomUUID(),
      effectRef: child.effect.effectRef,
      ...seeded.scope,
      revisionId: child.effect.target.revisionId,
      preparationRef: seeded.child.preparationRef,
      preparationVersion: 2,
      requestDigest: child.effect.requestDigest,
      providerWireDigest: child.providerWire.bytesDigest,
      submittedAt: "2026-09-06T00:00:01.000Z",
    },
    response: {
      namespace: "controlled-runtime",
      name: child.providerTarget.name,
      uid: child.predicate.uid,
      resourceVersion: "created-rv",
      receivedAt: "2026-09-06T00:00:02.000Z",
    },
  };
  const locator = { kind: "submission", submissionRef: retained.submission.submissionRef };
  const located = resolveRuntimePreparationCreateReferenceV1(seeded.scope, locator, retained);
  assert.equal(
    located.status,
    "located",
    "controlled history must be valid before the physical boundary",
  );
  assert.equal(located.input.expectedObject, null);
  const request = {
    operationRef: randomUUID(),
    requestRef: "controlled-source-request",
    scope: seeded.scope,
    locator,
    input: located.input,
    expectedVersion: null,
  };
  const sourceAbort = new AbortController();
  const call = {
    requestRef: request.requestRef,
    recipientRef: "controlled-recipient",
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: sourceAbort.signal,
    context: Object.freeze({}),
  };
  const provider = {
    namespace: {
      kind: "Namespace",
      apiVersion: "v1",
      metadata: {
        name: retained.response.namespace,
        uid: child.providerTarget.kubernetesNamespaceUid,
        resourceVersion: "namespace-rv",
      },
    },
    deployment: {
      kind: "Deployment",
      apiVersion: "apps/v1",
      metadata: {
        name: retained.response.name,
        namespace: retained.response.namespace,
        uid: retained.response.uid,
        resourceVersion: retained.response.resourceVersion,
        annotations: {
          [annotations.assignment]: child.providerTarget.ownerAssignmentRef.id,
          [annotations.create]: child.providerTarget.ownerCreateEffectRef,
          // Deliberately independent of the retained requested/predicate epoch.
          [annotations.fence]: "23",
        },
      },
    },
  };
  const calls = [],
    hooks = {};
  const clients = {
    core: {
      async readNamespace(input) {
        calls.push({ kind: "namespace", input, signal: currentComputeAbortSignal() });
        return hooks.namespace ? hooks.namespace(input) : copy(provider.namespace);
      },
    },
    apps: {
      async readNamespacedDeployment(input) {
        calls.push({ kind: "deployment", input, signal: currentComputeAbortSignal() });
        return hooks.deployment ? hooks.deployment(input) : copy(provider.deployment);
      },
    },
  };
  const driver = new KubernetesComputeDriver(
    copy(options),
    noDependencies
      ? {}
      : {
          // Deliberately only the constructor's physical cluster comparison input.
          // This is not a complete observation/admission dependency or producer.
          runtimeObservationDependencies: {
            clusterRef: clusterRef ?? child.providerTarget.clusterRef,
          },
        },
  );
  driver.apiClients = Promise.resolve(clients);
  const selection = new DriverSelection();
  selection.registerDriver(driver);
  selection.selectDriver("compute", driver.id);
  const f = {
    retained,
    request,
    call,
    sourceAbort,
    provider,
    calls,
    hooks,
    clients,
    driver,
    selection,
  };
  if (!noDependencies) {
    f.owner = driver.createCorrelationObservationOwner(selection);
    t.after(async () => {
      await f.owner.close().catch(() => {});
    });
    f.begin = () => f.owner.begin(Object.freeze({}), f.request, f.call);
  }
  return f;
}

function noAuthority(read) {
  assert.equal("evidence" in read, false);
  assert.equal("recordRef" in read, false);
  assert.equal("sourceCall" in read, false);
  assert.equal("object" in read, false);
}

test("correlation physical read preserves exact history and observed encoding, then repeats both reads", async (t) => {
  const f = await fixture(t),
    operation = f.begin();
  const read = await operation.qualifyRetained(f.retained);
  assert.deepEqual(read.input, copy(f.request.input));
  assert.deepEqual(read.namespace, {
    name: f.retained.response.namespace,
    uid: f.request.input.providerTarget.kubernetesNamespaceUid,
    resourceVersion: "namespace-rv",
  });
  assert.deepEqual(read.deployment, {
    name: f.retained.response.name,
    uid: f.retained.response.uid,
    resourceVersion: f.retained.response.resourceVersion,
  });
  assert.deepEqual(read.encoding, {
    ownerAssignmentRef: f.request.input.providerTarget.ownerAssignmentRef.id,
    ownerCreateEffectRef: f.request.input.providerTarget.ownerCreateEffectRef,
    fenceEpoch: 23,
  });
  assert.notEqual(read.encoding.fenceEpoch, f.retained.child.guard.requestedFenceEpoch);
  noAuthority(read);
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.encoding));
  const prepared = operation.prepareCommit();
  assert.equal(prepared, operation.prepareCommit(), "the same preparation joins the exact work");
  await prepared;
  const count = f.calls.length;
  assert.equal(operation.assertCurrent(), undefined);
  assert.equal(f.calls.length, count, "final fence has no provider or State query");
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ["namespace", "deployment", "namespace", "deployment"],
  );
  await operation.release();
  assert.equal(
    f.sourceAbort.signal.aborted,
    false,
    "local observation cleanup does not close native exchange",
  );
  await assert.rejects(operation.prepareCommit());
  assert.equal(f.calls.length, count);
});

test("correlation reader refuses missing original cluster construction without provider entry", async (t) => {
  const f = await fixture(t, { noDependencies: true });
  assert.throws(() => f.driver.createCorrelationObservationOwner(f.selection));
  assert.equal(f.calls.length, 0);
});

test("correlation read refuses a different captured cluster before provider entry", async (t) => {
  const f = await fixture(t, { clusterRef: "different-original-cluster" });
  await assert.rejects(f.begin().qualifyRetained(f.retained));
  assert.equal(f.calls.length, 0);
});

test("correlation read requires a retained response and never interprets history as physical evidence", async (t) => {
  const f = await fixture(t);
  delete f.retained.response;
  await assert.rejects(f.begin().qualifyRetained(f.retained));
  assert.equal(f.calls.length, 0);
});

test("correlation read preserves expectedObject null instead of overwriting a caller expectation", async (t) => {
  const f = await fixture(t);
  f.request = copy(f.request);
  f.request.input = parseRuntimeEffectsV1("exactCreate", {
    ...f.request.input,
    expectedObject: {
      target: copy(f.request.input.providerTarget),
      uid: f.retained.response.uid,
      resourceVersion: f.retained.response.resourceVersion,
      fenceEpoch: 23,
    },
  });
  await assert.rejects(f.begin().qualifyRetained(f.retained));
  assert.equal(f.calls.length, 0);
});

test("correlation read rejects another scope or create effect before provider access", async (t) => {
  for (const field of ["scope", "effect"])
    await t.test(field, async (t) => {
      const f = await fixture(t);
      f.request = copy(f.request);
      if (field === "scope") f.request.scope.agentId = "another-agent";
      else f.request.input.effect.effectRef = randomUUID();
      await assert.rejects(f.begin().qualifyRetained(f.retained));
      assert.equal(f.calls.length, 0);
    });
});

test("correlation physical checks refuse wrong Namespace or Deployment identity and ownership", async (t) => {
  const changes = {
    "Namespace UID": (f) => {
      f.provider.namespace.metadata.uid = "replacement";
    },
    "Namespace deletion": (f) => {
      f.provider.namespace.metadata.deletionTimestamp = "2026-09-06T00:00:03.000Z";
    },
    "Namespace kind": (f) => {
      f.provider.namespace.kind = "ConfigMap";
    },
    "Deployment UID": (f) => {
      f.provider.deployment.metadata.uid = "replacement";
    },
    "Deployment resourceVersion": (f) => {
      f.provider.deployment.metadata.resourceVersion = "replacement-rv";
    },
    "Deployment namespace": (f) => {
      f.provider.deployment.metadata.namespace = "another-namespace";
    },
    "Deployment apiVersion": (f) => {
      f.provider.deployment.apiVersion = "v1";
    },
    "Deployment deletion": (f) => {
      f.provider.deployment.metadata.deletionTimestamp = "2026-09-06T00:00:03.000Z";
    },
    "assignment owner": (f) => {
      f.provider.deployment.metadata.annotations[annotations.assignment] = "another-assignment";
    },
    "create owner": (f) => {
      f.provider.deployment.metadata.annotations[annotations.create] = randomUUID();
    },
  };
  for (const [name, change] of Object.entries(changes))
    await t.test(name, async (t) => {
      const f = await fixture(t);
      change(f);
      await assert.rejects(f.begin().qualifyRetained(f.retained));
      assert.ok(f.calls.length > 0);
    });
});

test("correlation physical epoch is strict observed encoding, never coercion or a requested fallback", async (t) => {
  for (const epoch of [undefined, "0", "-1", "01", "1.0", "NaN", "9007199254740992"])
    await t.test(String(epoch), async (t) => {
      const f = await fixture(t);
      if (epoch === undefined) delete f.provider.deployment.metadata.annotations[annotations.fence];
      else f.provider.deployment.metadata.annotations[annotations.fence] = epoch;
      await assert.rejects(f.begin().qualifyRetained(f.retained));
    });
});

test("correlation prepare refuses changed Namespace version, object version or epoch without rebasing", async (t) => {
  for (const field of ["namespace", "deployment", "epoch"])
    await t.test(field, async (t) => {
      const f = await fixture(t),
        operation = f.begin();
      const first = await operation.qualifyRetained(f.retained);
      if (field === "epoch") f.provider.deployment.metadata.annotations[annotations.fence] = "24";
      else f.provider[field].metadata.resourceVersion = "changed-rv";
      await assert.rejects(operation.prepareCommit());
      assert.throws(() => operation.assertCurrent());
      assert.equal(first.encoding.fenceEpoch, 23);
      assert.equal(first.namespace.resourceVersion, "namespace-rv");
    });
});

test("correlation actual SDK failure is joined and does not become a partial observation", async (t) => {
  const f = await fixture(t),
    operation = f.begin();
  f.hooks.deployment = async () => {
    throw { statusCode: 403, message: "controlled forbidden" };
  };
  await assert.rejects(operation.qualifyRetained(f.retained));
  await assert.rejects(operation.release());
  assert.equal(f.sourceAbort.signal.aborted, false);
});

test("correlation cancellation with hung Namespace read withholds result and joins the late original read", async (t) => {
  const f = await fixture(t),
    operation = f.begin(),
    entered = deferred(),
    gate = deferred();
  let actual;
  f.hooks.namespace = async () => {
    entered.resolve();
    actual = await gate.promise;
    return actual;
  };
  const qualification = operation.qualifyRetained(f.retained);
  await entered.promise;
  f.sourceAbort.abort();
  await assert.rejects(qualification);
  const release = operation.release();
  assert.equal(release, operation.release());
  let joined = false;
  void release.then(
    () => {
      joined = true;
    },
    () => {
      joined = true;
    },
  );
  await twoMicrotasks();
  assert.equal(joined, false, "late SDK response remains under the original release join");
  const late = copy(f.provider.namespace);
  gate.resolve(late);
  await assert.rejects(release);
  assert.equal(actual, late);
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ["namespace"],
  );
});

test("correlation observation release aborts only its local read and retains late Deployment completion", async (t) => {
  const f = await fixture(t),
    operation = f.begin(),
    entered = deferred(),
    gate = deferred();
  f.hooks.deployment = async () => {
    entered.resolve();
    return gate.promise;
  };
  const qualification = operation.qualifyRetained(f.retained);
  await entered.promise;
  const release = operation.release();
  await assert.rejects(qualification);
  assert.equal(f.sourceAbort.signal.aborted, false);
  assert.equal(f.calls.at(-1).signal.aborted, true);
  let joined = false;
  void release.then(
    () => {
      joined = true;
    },
    () => {
      joined = true;
    },
  );
  await twoMicrotasks();
  assert.equal(joined, false);
  gate.resolve(copy(f.provider.deployment));
  await assert.rejects(release);
  assert.throws(() => operation.assertCurrent());
});

test("correlation release observes late SDK rejection without reopening native source lifetime", async (t) => {
  const f = await fixture(t),
    operation = f.begin(),
    entered = deferred(),
    gate = deferred();
  f.hooks.deployment = async () => {
    entered.resolve();
    return gate.promise;
  };
  const qualification = operation.qualifyRetained(f.retained);
  await entered.promise;
  const release = operation.release();
  await assert.rejects(qualification);
  gate.reject(new Error("controlled late SDK rejection"));
  await assert.rejects(release);
  assert.equal(f.sourceAbort.signal.aborted, false);
});

test("correlation original operation association is single-use and closed operations cannot acquire new work", async (t) => {
  const f = await fixture(t),
    original = Object.freeze({});
  const operation = f.owner.begin(original, f.request, f.call);
  assert.throws(() => f.owner.begin(original, f.request, f.call));
  await operation.qualifyRetained(f.retained);
  await operation.release();
  const count = f.calls.length;
  await assert.rejects(operation.qualifyRetained(f.retained));
  await assert.rejects(operation.prepareCommit());
  assert.equal(f.calls.length, count);
});

test("correlation duplicate qualification refuses while retaining its already-entered provider read", async (t) => {
  const f = await fixture(t),
    operation = f.begin(),
    entered = deferred(),
    gate = deferred();
  f.hooks.namespace = async () => {
    entered.resolve();
    return gate.promise;
  };
  const first = operation.qualifyRetained(f.retained);
  await entered.promise;
  await assert.rejects(operation.qualifyRetained(f.retained));
  const release = operation.release();
  gate.resolve(copy(f.provider.namespace));
  await assert.rejects(first);
  await assert.rejects(release);
  assert.equal(f.calls.length, 1);
});

test("correlation reentrant close during capture is registered before getter work and enters no provider", async (t) => {
  const f = await fixture(t);
  let closing;
  const request = {
    ...f.request,
    get operationRef() {
      closing = f.owner.close();
      assert.equal(f.owner.close(), closing);
      return f.request.operationRef;
    },
  };
  assert.throws(() => f.owner.begin(Object.freeze({}), request, f.call));
  await assert.rejects(closing);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sourceAbort.signal.aborted, false);
});

test("correlation reentrant owner close inside actual provider work joins that operation", async (t) => {
  const f = await fixture(t),
    operation = f.begin(),
    entered = deferred(),
    gate = deferred();
  let closing;
  f.hooks.namespace = async () => {
    closing = f.owner.close();
    assert.equal(closing, f.owner.close());
    entered.resolve();
    return gate.promise;
  };
  const qualification = operation.qualifyRetained(f.retained);
  await entered.promise;
  await assert.rejects(qualification);
  let joined = false;
  void closing.then(
    () => {
      joined = true;
    },
    () => {
      joined = true;
    },
  );
  await twoMicrotasks();
  assert.equal(joined, false);
  gate.resolve(copy(f.provider.namespace));
  await assert.rejects(closing);
  assert.equal(f.calls.length, 1);
});

test("correlation final local fence retains the original Driver identity after asynchronous reads", async (t) => {
  const f = await fixture(t),
    operation = f.begin();
  await operation.qualifyRetained(f.retained);
  await operation.prepareCommit();
  f.driver.id = "changed-original-driver";
  assert.throws(() => operation.assertCurrent());
  f.driver.id = "compute-kubernetes-local";
  assert.throws(() => operation.assertCurrent(), "a failed held selection cannot revive");
});

test("correlation capture rejects an expired original call before any provider work", async (t) => {
  const f = await fixture(t);
  f.call.deadline = "2026-01-01T00:00:00.000Z";
  assert.throws(() => f.begin());
  assert.equal(f.calls.length, 0);
});

test("correlation cleanup joins delayed client acquisition and never enters its late clients", async (t) => {
  const f = await fixture(t),
    gate = deferred();
  f.driver.apiClients = gate.promise;
  const operation = f.begin();
  const qualification = operation.qualifyRetained(f.retained);
  await twoMicrotasks();
  f.sourceAbort.abort();
  await assert.rejects(qualification);
  const release = operation.release();
  let joined = false;
  void release.then(
    () => {
      joined = true;
    },
    () => {
      joined = true;
    },
  );
  await twoMicrotasks();
  assert.equal(joined, false);
  gate.resolve(f.clients);
  await assert.rejects(release);
  assert.equal(f.calls.length, 0);
});

test("correlation prepare owns cancellation and late read through its final cleanup join", async (t) => {
  const f = await fixture(t),
    operation = f.begin(),
    entered = deferred(),
    gate = deferred();
  await operation.qualifyRetained(f.retained);
  f.hooks.deployment = async () => {
    entered.resolve();
    return gate.promise;
  };
  const preparation = operation.prepareCommit();
  await entered.promise;
  f.sourceAbort.abort();
  await assert.rejects(preparation);
  const release = operation.release();
  let joined = false;
  void release.then(
    () => {
      joined = true;
    },
    () => {
      joined = true;
    },
  );
  await twoMicrotasks();
  assert.equal(joined, false);
  gate.resolve(copy(f.provider.deployment));
  await assert.rejects(release);
  assert.equal(f.calls.length, 4);
});

test("correlation preparation uses the captured SDK receivers despite later client replacement", async (t) => {
  const f = await fixture(t),
    operation = f.begin();
  await operation.qualifyRetained(f.retained);
  let replacementCalls = 0;
  const replacement = () => {
    replacementCalls++;
    throw new Error("replacement client entered");
  };
  f.clients.core.readNamespace = replacement;
  f.clients.apps.readNamespacedDeployment = replacement;
  f.driver.apiClients = Promise.resolve({
    core: { readNamespace: replacement },
    apps: { readNamespacedDeployment: replacement },
  });
  await operation.prepareCommit();
  assert.equal(replacementCalls, 0);
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ["namespace", "deployment", "namespace", "deployment"],
  );
});

test("correlation owner closes every operation before joining a hung first read", async (t) => {
  const f = await fixture(t),
    gate = deferred(),
    bothEntered = deferred();
  let entered = 0;
  f.hooks.namespace = async () => {
    if (++entered === 2) bothEntered.resolve();
    return gate.promise;
  };
  const first = f.begin(),
    second = f.begin();
  const firstRead = first.qualifyRetained(f.retained);
  const secondRead = second.qualifyRetained(f.retained);
  await bothEntered.promise;
  const close = f.owner.close();
  await Promise.all([assert.rejects(firstRead), assert.rejects(secondRead)]);
  assert.ok(f.calls.every((call) => call.signal.aborted));
  let joined = false;
  void close.then(
    () => {
      joined = true;
    },
    () => {
      joined = true;
    },
  );
  await twoMicrotasks();
  assert.equal(joined, false);
  gate.resolve(copy(f.provider.namespace));
  await assert.rejects(close);
  assert.equal(f.sourceAbort.signal.aborted, false);
});
