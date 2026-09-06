import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { fixture, deferred } from "../fixtures/kubernetes-installation-process/values.mjs";

async function invoke(f, method, input) {
  const { call } = f.enroll(method, input);
  return f.participant[method](input, call);
}

test("selected Driver caches one participant and missing protected owners deny before API use", async () => {
  const f = fixture({ missing: true });
  assert.equal(f.driver.getInstallationProcessParticipant(), f.participant);
  assert.deepEqual(await invoke(f, "createOriginal", f.createInput), { kind: "unavailable" });
  assert.equal(f.requests.length, 0);
});

test("missing original retention port is refused before any provider access", async () => {
  const f = fixture({ original: false });
  delete f.dependencies.accepting.retainCreate;
  assert.equal((await invoke(f, "createOriginal", f.createInput)).kind, "unavailable");
  assert.equal(f.requests.length, 0);
  assert.equal(f.claimCount, 0);
});

for (const [bundle, method] of [
  ["accepting", "accept"],
  ["submission", "claimOriginal"],
  ["submission", "consumeSubmission"],
  ["launchPlans", "read"],
  ["settlement", "readCurrent"],
]) {
  test(`missing mandatory ${bundle}.${method} refuses before clients`, async () => {
    const f = fixture();
    delete f.dependencies[bundle][method];
    assert.equal((await invoke(f, "createOriginal", f.createInput)).kind, "unavailable");
    assert.equal(f.requests.length, 0);
    assert.equal(f.claimCount, 0);
  });
}

for (const scenario of ["copied", "revoked", "wrong method", "wrong input", "expired"]) {
  test(`protected accepting boundary refuses ${scenario} call before Kubernetes I/O`, async () => {
    const f = fixture();
    const enrollment = f.enroll(
      scenario === "wrong method" ? "recoverOriginal" : "createOriginal",
      f.createInput,
      scenario === "expired" ? -1 : 30_000,
    );
    let call = enrollment.call;
    const input = structuredClone(f.createInput);
    if (scenario === "copied") call = { ...call };
    if (scenario === "revoked") enrollment.revoke();
    if (scenario === "wrong input") input.binding.createEffectRef = "another-create";
    const result = await f.participant.createOriginal(input, call);
    assert.ok(["denied", "unavailable"].includes(result.kind));
    assert.equal(f.requests.length, 0);
    assert.equal(f.claimCount, 0);
  });
}

test("actual factory creates once through official SDK and retains exact original generation mapping", async () => {
  const f = fixture({ original: false });
  const result = await invoke(f, "createOriginal", f.createInput);
  assert.equal(result.kind, "accepted-object");
  assert.equal(result.original.binding.startup.processGeneration, 7);
  assert.equal(result.original.binding.hostRuntimeGeneration, 19);
  assert.equal(result.original.deployment.uid, "deployment-uid");
  assert.equal(f.claimCount, 1);
  assert.equal(f.consumeCount, 1);
  const post = f.requests.filter(({ method }) => method === "POST");
  assert.equal(post.length, 1);
  assert.deepEqual(post[0].body, f.template);
  assert.ok(post[0].signal instanceof AbortSignal);
  assert.equal(f.outcomes[0].kind, "acknowledged");
});

test("concurrent same-operation calls require one durable claim and one SDK create", async () => {
  const f = fixture({ original: false });
  const results = await Promise.all([
    invoke(f, "createOriginal", f.createInput),
    invoke(f, "createOriginal", f.createInput),
  ]);
  assert.deepEqual(results.map(({ kind }) => kind).sort(), ["accepted-object", "unknown"]);
  assert.equal(f.requests.filter(({ method }) => method === "POST").length, 1);
  assert.equal(f.consumeCount, 1);
  assert.equal((await invoke(f, "createOriginal", f.createInput)).kind, "unknown");
  assert.equal(f.requests.filter(({ method }) => method === "POST").length, 1);
});

test("unknown submission COMMIT sends zero creates and keeps original locator", async () => {
  const f = fixture({ original: false });
  f.claimUnknown = true;
  assert.deepEqual(await invoke(f, "createOriginal", f.createInput), {
    kind: "unknown",
    operation: f.locator,
  });
  assert.equal(f.requests.filter(({ method }) => method === "POST").length, 0);
  assert.equal(f.consumeCount, 0);
});

for (const returned of ["invalid value", "async resolution", "async rejection"]) {
  test(`actual submission boundary rejects ${returned} from synchronous ticket consumption`, async () => {
    const f = fixture({ original: false });
    f.dependencies.submission.consumeSubmission = () => {
      if (returned === "invalid value") return true;
      return returned === "async resolution"
        ? Promise.resolve()
        : Promise.reject(new Error("Invalid asynchronous fence."));
    };
    assert.equal((await invoke(f, "createOriginal", f.createInput)).kind, "unknown");
    await setImmediate();
    assert.equal(f.requests.filter(({ method }) => method === "POST").length, 0);
  });
}

for (const fence of ["authorization", "plan", "cleanup", "settlement"]) {
  test(`async ${fence} accepting fence grants no mutation or disposition`, async () => {
    const f = fixture();
    const badFence = () =>
      Promise.reject(new Error("Synchronous fence was implemented asynchronously."));
    let method = "createOriginal";
    let input = f.createInput;
    if (fence === "authorization") {
      const original = f.dependencies.accepting.accept;
      f.dependencies.accepting.accept = async (...args) => ({
        ...(await original(...args)),
        assertCurrent: badFence,
      });
    } else if (fence === "plan") {
      const original = f.dependencies.launchPlans.read;
      f.dependencies.launchPlans.read = async (...args) => ({
        ...(await original(...args)),
        assertCurrent: badFence,
      });
    } else if (fence === "cleanup") {
      method = "requestRetirement";
      input = f.retirementInput();
      const original = f.dependencies.accepting.readCleanup;
      f.dependencies.accepting.readCleanup = async (...args) => ({
        ...(await original(...args)),
        assertCurrent: badFence,
      });
    } else {
      method = "readReplacementDisposition";
      input = f.locator;
      f.settlement = {
        operation: structuredClone(f.locator),
        disposition: "retired",
        receipt: { recordRef: "controlled-receipt", recordVersion: 1 },
        async recheckCurrent() {},
        assertCurrent: badFence,
      };
    }
    const result = await invoke(f, method, input);
    assert.ok(["unavailable", "unknown"].includes(result.kind));
    await setImmediate();
    assert.equal(
      f.requests.filter(({ method }) => method === "POST" || method === "DELETE").length,
      0,
    );
  });
}

for (const method of [
  "createOriginal",
  "observeExact",
  "requestRetirement",
  "recoverOriginal",
  "readReplacementDisposition",
]) {
  test(`synchronous owner work crossing original deadline cannot authorize ${method}`, async () => {
    const f = fixture();
    let input = f.locator;
    if (method === "createOriginal") input = f.createInput;
    if (method === "requestRetirement") input = f.retirementInput();
    if (method === "observeExact") input = { original: f.original };
    const { call } = f.enroll(method, input, 100);
    let crossed = false;
    function crossDeadline() {
      crossed = true;
      const until =
        performance.now() + Math.max(0, Date.parse(call.authorityCall.deadline) - Date.now()) + 2;
      // Deliberately stay in the current turn so a timer-only guard cannot fire.
      while (performance.now() < until) {}
      return undefined;
    }
    if (method === "createOriginal" || method === "observeExact") {
      const read = f.dependencies.launchPlans.read;
      f.dependencies.launchPlans.read = async (...args) => ({
        ...(await read(...args)),
        assertCurrent: crossDeadline,
      });
    } else if (method === "requestRetirement") {
      const read = f.dependencies.accepting.readCleanup;
      f.dependencies.accepting.readCleanup = async (...args) => ({
        ...(await read(...args)),
        assertCurrent: crossDeadline,
      });
    } else if (method === "recoverOriginal") {
      f.dependencies.accepting.readOriginal = async () => {
        crossDeadline();
        return structuredClone(f.original);
      };
    } else {
      f.settlement = {
        operation: structuredClone(f.locator),
        disposition: "retired",
        receipt: { recordRef: "controlled-physical-receipt", recordVersion: 1 },
        async recheckCurrent() {},
        assertCurrent: crossDeadline,
      };
    }
    const result = await f.participant[method](input, call);
    assert.equal(crossed, true);
    assert.ok(["unknown", "unavailable"].includes(result.kind));
    assert.equal(
      f.requests.filter(({ method }) => method === "POST" || method === "DELETE").length,
      0,
    );
    assert.equal(f.inspections[0].call.authorityCall, call.authorityCall);
    if (method === "observeExact") assert.equal(f.requests.length, 0);
  });
}

for (const failure of ["5xx", "statusless"]) {
  test(`actual Driver mutation wrapper never retries create after ${failure}`, async () => {
    const f = fixture({ original: false });
    f.responseHook = async ({ method }) => {
      if (method !== "POST") return undefined;
      if (failure === "statusless") throw new Error("Controlled transport failure.");
      return {
        status: 503,
        body: { kind: "Status", apiVersion: "v1", status: "Failure", code: 503 },
      };
    };
    assert.equal((await invoke(f, "createOriginal", f.createInput)).kind, "unknown");
    assert.equal(f.requests.filter(({ method }) => method === "POST").length, 1);
    assert.deepEqual(f.outcomes, [{ kind: "unknown" }]);
  });
}

test("late create after cancellation is retained under original ticket and cannot become a successful caller launch", async () => {
  const f = fixture({ original: false });
  const started = deferred();
  const release = deferred();
  const retained = deferred();
  f.responseHook = async ({ method }) => {
    if (method !== "POST") return undefined;
    started.resolve();
    await release.promise;
    return { status: 201, body: f.deployment };
  };
  f.retainHook = async () => retained.resolve();
  const { call, abort } = f.enroll("createOriginal", f.createInput);
  const pending = f.participant.createOriginal(f.createInput, call);
  await started.promise;
  abort.abort(new Error("Original caller left."));
  assert.deepEqual(await pending, { kind: "unknown", operation: f.locator });
  release.resolve();
  await retained.promise;
  await setImmediate();
  assert.equal(f.outcomes[0].kind, "acknowledged");
  assert.equal(f.original.deployment.uid, "deployment-uid");
  assert.equal((await invoke(f, "recoverOriginal", f.locator)).kind, "found");
  assert.equal(f.requests.filter(({ method }) => method === "POST").length, 1);
});

test("failed durable create acknowledgment remains unknown despite API acceptance", async () => {
  const f = fixture({ original: false });
  f.retainAvailable = false;
  assert.equal((await invoke(f, "createOriginal", f.createInput)).kind, "unknown");
  assert.equal((await invoke(f, "recoverOriginal", f.locator)).kind, "unknown");
  assert.equal(f.requests.filter(({ method }) => method === "POST").length, 1);
});

for (const change of ["namespace", "template", "plan"]) {
  test(`create refuses changed ${change} before submission`, async () => {
    const f = fixture({ original: false });
    if (change === "namespace") f.namespace.metadata.uid = "successor-namespace";
    if (change === "template") f.template.spec.template.spec.runtimeClassName = "another-runtime";
    if (change === "plan") f.planCurrent = false;
    assert.equal((await invoke(f, "createOriginal", f.createInput)).kind, "unavailable");
    assert.equal(f.claimCount, 0);
    assert.equal(f.requests.filter(({ method }) => method === "POST").length, 0);
  });
}

test("observation uses immutable ancestry and exposes current RV without rewriting create acknowledgment", async () => {
  const f = fixture();
  f.deployment.metadata.resourceVersion = "after-controller-update";
  f.namespace.metadata.resourceVersion = "after-namespace-update";
  const result = await invoke(f, "observeExact", { original: f.original });
  assert.equal(result.kind, "observed");
  assert.equal(result.original.deployment.resourceVersion, "1");
  assert.equal(result.chain.deployment.resourceVersion, "after-controller-update");
  assert.equal(result.chain.pod.containers.length, 2);
  assert.equal(f.descendants.at(-1).pods[0].identity.uid, "pod-uid");
});

for (const [label, mutate] of [
  [
    "extra regular container",
    (f) => {
      f.pod.spec.containers.push({ name: "sidecar", image: "unselected" });
      f.pod.status.containerStatuses.push({
        ...f.pod.status.containerStatuses[0],
        name: "sidecar",
      });
    },
  ],
  [
    "changed selected image",
    (f) => {
      f.pod.spec.containers[0].image = "different";
    },
  ],
  [
    "foreign namespace UID",
    (f) => {
      f.namespace.metadata.uid = "foreign";
    },
  ],
  [
    "replacement deployment UID",
    (f) => {
      f.deployment.metadata.uid = "successor";
    },
  ],
  [
    "changed controller generation",
    (f) => {
      f.deployment.metadata.generation = 2;
    },
  ],
  [
    "foreign ReplicaSet controller",
    (f) => {
      f.replicaSet.metadata.ownerReferences[0].uid = "foreign";
    },
  ],
  [
    "foreign Pod controller",
    (f) => {
      f.pod.metadata.ownerReferences[0].uid = "foreign";
    },
  ],
  [
    "duplicate controller references",
    (f) => {
      f.pod.metadata.ownerReferences.push({ ...f.pod.metadata.ownerReferences[0] });
    },
  ],
  [
    "missing init identity",
    (f) => {
      f.pod.status.initContainerStatuses[0].containerID = "";
    },
  ],
  [
    "unaccounted ephemeral container",
    (f) => {
      f.pod.spec.ephemeralContainers = [{ name: "debugger" }];
    },
  ],
  [
    "duplicate container name",
    (f) => {
      f.pod.spec.initContainers[0].name = "gateway";
    },
  ],
  [
    "missing node",
    (f) => {
      delete f.pod.spec.nodeName;
    },
  ],
  [
    "runtime class mismatch",
    (f) => {
      f.pod.spec.runtimeClassName = "other";
    },
  ],
  [
    "truncated list",
    (f) => {
      f.listMetadata.continue = "next-page";
    },
  ],
  [
    "list count remains",
    (f) => {
      f.listMetadata.remainingItemCount = 1;
    },
  ],
]) {
  test(`observation refuses ${label}`, async () => {
    const f = fixture();
    mutate(f);
    assert.equal((await invoke(f, "observeExact", { original: f.original })).kind, "unavailable");
    assert.equal(f.requests.filter(({ method }) => method !== "GET").length, 0);
  });
}

test("competing live Pods stay ambiguous while both exact targets are retained for cleanup", async () => {
  const f = fixture();
  const second = structuredClone(f.pod);
  second.metadata.name = "late-pod";
  second.metadata.uid = "late-pod-uid";
  f.extraPods.push(second);
  assert.equal((await invoke(f, "observeExact", { original: f.original })).kind, "ambiguous");
  assert.deepEqual(
    f.descendants.at(-1).pods.map(({ identity }) => identity.uid),
    ["pod-uid", "late-pod-uid"],
  );
});

test("late Pod-list result after cancellation is retained without exposing an observation", async () => {
  const f = fixture();
  const started = deferred();
  const release = deferred();
  const retained = deferred();
  f.responseHook = async ({ path }) => {
    if (!path.endsWith("/pods")) return undefined;
    started.resolve();
    await release.promise;
    return {
      status: 200,
      body: {
        kind: "PodList",
        apiVersion: "v1",
        metadata: { resourceVersion: "late-list" },
        items: [f.pod],
      },
    };
  };
  f.descendantHook = async () => {
    if (f.descendants.at(-1).pods.length) retained.resolve();
  };
  const input = { original: f.original };
  const { call, abort } = f.enroll("observeExact", input);
  const pending = f.participant.observeExact(input, call);
  await started.promise;
  abort.abort(new Error("Caller left during list."));
  assert.equal((await pending).kind, "unavailable");
  release.resolve();
  await retained.promise;
  assert.equal(f.descendants.at(-1).pods[0].identity.uid, "pod-uid");
  assert.equal(f.descendants.at(-1).complete.pods, false);
  assert.equal(f.observations.length, 0);
});

test("truncated list retains attributable partial identity without an absence claim", async () => {
  const f = fixture();
  f.listMetadata.continue = "later-page";
  assert.equal((await invoke(f, "observeExact", { original: f.original })).kind, "unavailable");
  assert.equal(f.descendants.at(-1).replicaSets[0].uid, "replicaset-uid");
  assert.equal(f.descendants.at(-1).complete.replicaSets, false);
  assert.equal(f.observations.length, 0);
});

test("truncated Pod list preserves known Pod identity with incomplete coverage", async () => {
  const f = fixture();
  f.responseHook = async ({ path }) =>
    path.endsWith("/pods")
      ? {
          status: 200,
          body: {
            kind: "PodList",
            apiVersion: "v1",
            metadata: { resourceVersion: "partial-pods", continue: "next" },
            items: [f.pod],
          },
        }
      : undefined;
  assert.equal((await invoke(f, "observeExact", { original: f.original })).kind, "unavailable");
  assert.equal(f.descendants.at(-1).pods[0].identity.uid, "pod-uid");
  assert.equal(f.descendants.at(-1).complete.pods, false);
});

for (const route of ["replicasets", "pods"]) {
  test(`contradictory ${route} list kind cannot become complete evidence`, async () => {
    const f = fixture();
    f.responseHook = async ({ path }) =>
      path.endsWith(`/${route}`)
        ? {
            status: 200,
            body: {
              kind: "DifferentList",
              apiVersion: "wrong/v1",
              metadata: { resourceVersion: "wrong-type-list" },
              items: route === "pods" ? [f.pod] : [f.replicaSet],
            },
          }
        : undefined;
    assert.equal((await invoke(f, "observeExact", { original: f.original })).kind, "unavailable");
    assert.equal(f.descendants.at(-1).complete[route === "pods" ? "pods" : "replicaSets"], false);
    assert.equal(f.observations.length, 0);
  });
}

test("terminal Pod remains control-plane evidence and never a physical replacement disposition", async () => {
  const f = fixture();
  f.pod.status.phase = "Succeeded";
  for (const status of [...f.pod.status.containerStatuses, ...f.pod.status.initContainerStatuses]) {
    status.state = {
      terminated: {
        exitCode: 0,
        startedAt: "2026-09-06T00:00:00.000Z",
        finishedAt: "2026-09-06T00:01:00.000Z",
      },
    };
  }
  assert.equal((await invoke(f, "observeExact", { original: f.original })).kind, "observed");
  assert.deepEqual(await invoke(f, "readReplacementDisposition", f.locator), {
    kind: "unavailable",
  });
});

test("API absence retains original evidence and cannot establish initial or retired disposition", async () => {
  const f = fixture();
  f.missingObject = "deployment";
  assert.equal((await invoke(f, "observeExact", { original: f.original })).kind, "absent");
  assert.equal((await invoke(f, "readReplacementDisposition", f.locator)).kind, "unavailable");
  const empty = fixture({ original: false });
  assert.equal((await invoke(empty, "discoverOriginal", empty.locator)).kind, "unknown");
  assert.equal(
    (await invoke(empty, "readReplacementDisposition", empty.locator)).kind,
    "unavailable",
  );
});

test("retirement requires independent cleanup and exact current UID/RV preconditions", async () => {
  const f = fixture();
  f.deployment.metadata.resourceVersion = "fresh-rv";
  const result = await invoke(f, "requestRetirement", f.retirementInput());
  assert.equal(result.kind, "requested");
  assert.equal(result.termination, "unknown");
  const deletion = f.requests.find(({ method }) => method === "DELETE");
  assert.deepEqual(deletion.body.preconditions, {
    uid: "deployment-uid",
    resourceVersion: "fresh-rv",
  });
  assert.equal(deletion.body.gracePeriodSeconds, 30);
  assert.equal(deletion.body.propagationPolicy, "Foreground");
  assert.deepEqual(f.cleanupOutcomes, ["acknowledged"]);
  assert.equal((await invoke(f, "readReplacementDisposition", f.locator)).kind, "unavailable");
});

for (const scenario of ["missing cleanup", "revoked cleanup", "successor UID", "conflict", "5xx"]) {
  test(`conditional retirement preserves responsibility for ${scenario}`, async () => {
    const f = fixture();
    if (scenario === "missing cleanup") f.cleanupAvailable = false;
    if (scenario === "revoked cleanup") f.cleanupCurrent = false;
    if (scenario === "successor UID") f.deployment.metadata.uid = "successor";
    if (scenario === "conflict" || scenario === "5xx")
      f.responseHook = async ({ method }) =>
        method === "DELETE"
          ? {
              status: scenario === "conflict" ? 409 : 503,
              body: { kind: "Status", apiVersion: "v1", status: "Failure" },
            }
          : undefined;
    const result = await invoke(f, "requestRetirement", f.retirementInput());
    assert.ok(["unavailable", "unknown"].includes(result.kind));
    const deletes = f.requests.filter(({ method }) => method === "DELETE");
    assert.equal(deletes.length, scenario === "conflict" || scenario === "5xx" ? 1 : 0);
    assert.equal((await invoke(f, "readReplacementDisposition", f.locator)).kind, "unavailable");
  });
}

test("disposition consumes only exact current protected source result, with no Kubernetes inference", async () => {
  const f = fixture();
  let current = true;
  f.settlement = {
    operation: structuredClone(f.locator),
    disposition: "retired",
    receipt: { recordRef: "physical-and-late-create-receipt", recordVersion: 4 },
    async recheckCurrent() {
      if (!current) throw new Error("Receipt revoked.");
    },
    assertCurrent() {
      if (!current) throw new Error("Receipt revoked.");
    },
  };
  const result = await invoke(f, "readReplacementDisposition", f.locator);
  assert.equal(result.kind, "verified-disposition");
  assert.equal(result.receipt.recordVersion, 4);
  assert.equal(f.requests.length, 0);
  f.settlement.operation.processGeneration++;
  assert.equal((await invoke(f, "readReplacementDisposition", f.locator)).kind, "unavailable");
  f.settlement.operation.processGeneration--;
  current = false;
  assert.equal((await invoke(f, "readReplacementDisposition", f.locator)).kind, "unavailable");
});
