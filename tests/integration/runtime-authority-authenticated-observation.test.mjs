import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { InMemoryPlatformState, PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { KubernetesRuntimeObservations } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-observations.ts";
import {
  createComputeDriver,
  selectComputeDriver,
} from "../../apps/controller/src/composition/driver-factories/compute.ts";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import {
  createRuntimeServiceTrustFixture,
  sourceRequest,
  serviceRequest,
  technicalSource,
} from "../fixtures/runtime-service-trust.mjs";
import {
  root,
  testExecutables,
  startFixture,
  protectedSource,
  startAdmittedReadback,
  decodedResponse,
  applyManagement,
  assertNoBytes,
  boundedCompletion,
} from "../fixtures/runtime-authority-native.mjs";
import * as vectors from "../fixtures/runtime-effects-v1/vectors.mjs";

const { options } = JSON.parse(
  readFileSync(
    new URL("../fixtures/kubernetes-lifecycle-collaborators/inputs.json", import.meta.url),
    "utf8",
  ),
);
const policy = "runtime-observation-read-v1";
const transport = "owned-child-stdio-runtime-observation-v1";
const clone = (value) => structuredClone(value);

function compute() {
  return createComputeDriver(
    selectComputeDriver({
      id: "observation-compute",
      configuration: { ...clone(options), isolationProfile: "gvisor-systrap" },
    }),
    createTestConfigurationDriver(),
  );
}

async function admitted(t, binaries, { databaseUrl, selectedCompute = compute() } = {}) {
  const pool = databaseUrl
    ? new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 250 })
    : undefined;
  const state = pool ? new PostgresPlatformState(pool) : new InMemoryPlatformState();
  const peer = await startFixture(t, binaries.fixturePath);
  const source = await technicalSource(
    { ...protectedSource(binaries, peer), transportProfileRef: transport },
    binaries.binaryPath,
  );
  const f = await createRuntimeServiceTrustFixture({
    state,
    ...(pool ? { pool } : {}),
    source,
    binaryPath: binaries.binaryPath,
    nativeSourceRoot: root,
  });
  let readback;
  // Install cleanup before startup so failed listener selection also releases
  // this case's authenticated application and borrowed database pool.
  t.after(async () => {
    await readback?.close();
    await f.close();
    await pool?.end();
  });
  await applyManagement(f, sourceRequest(source.sourceRef));
  const admission = await applyManagement(
    f,
    serviceRequest(f, { peerSPIFFEId: peer.ready.peerSPIFFEId, operationPolicy: policy }),
  );
  readback = await startAdmittedReadback(t, binaries, {
    state,
    trust: f.trust,
    installationId: f.owner.installation.id,
    admission,
    computeDriver: selectedCompute,
  });
  return { f, state, peer, source, admission, readback, compute: selectedCompute };
}

function request(value, method = "discover", duration = 2800) {
  // Representation-only candidate operands. They are intentionally not protected
  // Compute records; real native admission must still refuse missing producers.
  const input = method === "discover" ? vectors.exactCreate() : vectors.candidate();
  let text = JSON.stringify(input);
  for (const [key, original] of Object.entries(vectors.scope))
    text = text.replaceAll(original, value.admission.configuration.allowedScope[key]);
  return {
    schemaVersion: 1,
    method,
    requestRef: `observation/${randomUUID()}`,
    deadline: new Date(Date.now() + duration).toISOString(),
    operation: JSON.parse(text),
  };
}

function capture(t) {
  const admissions = [],
    calls = [];
  const bind = KubernetesRuntimeObservations.prototype.bindNativeAdmission;
  t.mock.method(
    KubernetesRuntimeObservations.prototype,
    "bindNativeAdmission",
    function (admission) {
      const close = bind.call(this, admission);
      admissions.push({ admission, observer: this, close });
      return close;
    },
  );
  for (const method of ["discover", "observe"]) {
    const original = KubernetesComputeDriver.prototype[method];
    t.mock.method(KubernetesComputeDriver.prototype, method, async function (input, call) {
      calls.push({ driver: this, method, input, call });
      return original.call(this, input, call);
    });
  }
  // Count forbidden provider entry without manufacturing an observation result.
  const provider = t.mock.method(KubernetesComputeDriver.prototype, "clients", () => {
    throw new Error("Unqualified observation attempted Kubernetes access.");
  });
  return { admissions, calls, assertNoProvider: () => assert.equal(provider.mock.callCount(), 0) };
}

async function withdraw(value, kind) {
  return applyManagement(value.f, {
    schemaVersion: 1,
    kind,
    operationRef: randomUUID(),
    expectedVersion: 1,
    ...(kind === "service-withdraw"
      ? { serviceIdentityRef: value.admission.subjectRef }
      : { sourceRef: value.source.sourceRef }),
  });
}

test(
  "owned native observation admission reaches the selected Compute and preserves denial",
  { timeout: 180000 },
  async (t) => {
    const binaries = await testExecutables(t);
    await t.test(
      "actual TLS and stdio admit both exact methods, without inventing source records",
      async (t) => {
        const captured = capture(t),
          value = await admitted(t, binaries);
        for (const method of ["discover", "observe"]) {
          const original = request(value, method);
          const result = decodedResponse(
            await value.peer.request(value.readback.address, original).result(),
          );
          assert.equal(result.status, "incomplete");
          assert.equal(result.reasonCode, "authority-unavailable");
          assert.deepEqual(result.input, original.operation);
          const call = captured.calls.at(-1);
          assert.equal(call.driver, value.compute);
          assert.equal(call.method, method);
          assert.equal(call.call.requestRef, original.requestRef);
          assert.deepEqual(clone(call.input), original.operation);
        }
        assert.equal(captured.calls.length, 2);
        assert.equal(captured.admissions.length, 1);
        captured.assertNoProvider();
        assert.equal((await value.f.owner.record()).binding.status, "unbound");
      },
    );

    await t.test(
      "wrong method, missing correlation, malformed input and expired request disclose no bytes",
      async (t) => {
        const captured = capture(t),
          value = await admitted(t, binaries);
        for (const mutate of [
          (r) => {
            r.method = "bind";
          },
          (r) => {
            r.method = "readOperation";
          },
          (r) => {
            delete r.requestRef;
          },
          (r) => {
            r.requestRef = "invalid request";
          },
          (r) => {
            r.operation.unrecognized = true;
          },
          (r) => {
            r.operation.effect.target.component = "gateway";
          },
          (r) => {
            r.deadline = new Date(Date.now() - 1000).toISOString();
          },
        ]) {
          const input = request(value);
          mutate(input);
          assertNoBytes(await value.peer.request(value.readback.address, input).result());
        }
        assert.equal(captured.calls.length, 0);
        captured.assertNoProvider();
      },
    );

    await t.test("wrong Agent remains hidden from original protected reader", async (t) => {
      const captured = capture(t),
        value = await admitted(t, binaries);
      const input = request(value);
      input.operation.effect.target.agentId = `agt_${randomUUID()}`;
      const result = decodedResponse(
        await value.peer.request(value.readback.address, input).result(),
      );
      assert.equal(result.status, "incomplete");
      assert.equal(result.reasonCode, "authority-unavailable");
      captured.assertNoProvider();
    });

    await t.test(
      "genuine captured exchange rejects copied context, changed operands and call bounds",
      async (t) => {
        const captured = capture(t);
        const real = KubernetesRuntimeObservations.prototype.discover;
        t.mock.method(
          KubernetesRuntimeObservations.prototype,
          "discover",
          async function (input, call) {
            const { admission } = captured.admissions.at(-1);
            assert.ok(await admission.contextFactory.inspect(call.context, call));
            assert.ok(await admission.readAuthorization("discover", input, call));
            assert.equal(
              await admission.contextFactory.inspect({ ...call.context }, call),
              undefined,
            );
            for (const changed of [
              { ...call, requestRef: "changed/request" },
              { ...call, recipientRef: "wrong/recipient" },
              { ...call, deadline: new Date(Date.parse(call.deadline) - 1).toISOString() },
            ])
              assert.equal(
                await admission.readAuthorization("discover", input, changed),
                undefined,
              );
            assert.equal(await admission.readAuthorization("observe", input, call), undefined);
            const changed = clone(input);
            changed.effect.target.runtimeGeneration++;
            assert.equal(await admission.readAuthorization("discover", changed, call), undefined);
            return real.call(this, input, call);
          },
        );
        const value = await admitted(t, binaries);
        const result = decodedResponse(
          await value.peer.request(value.readback.address, request(value)).result(),
        );
        assert.equal(result.reasonCode, "authority-unavailable");
        await value.readback.close();
        const old = captured.calls[0],
          admission = captured.admissions[0].admission;
        assert.equal(admission.signal.aborted, true);
        assert.equal(await admission.contextFactory.inspect(old.call.context, old.call), undefined);
        assert.equal(await admission.readAuthorization("discover", old.input, old.call), undefined);
        captured.assertNoProvider();
      },
    );

    for (const kind of ["service-withdraw", "source-withdraw"])
      await t.test(`${kind} during actual admitted dispatch suppresses its response`, async (t) => {
        const captured = capture(t),
          real = KubernetesRuntimeObservations.prototype.discover;
        let value;
        t.mock.method(
          KubernetesRuntimeObservations.prototype,
          "discover",
          async function (input, call) {
            const admission = captured.admissions.at(-1).admission;
            assert.ok(await admission.readAuthorization("discover", input, call));
            await withdraw(value, kind);
            assert.equal(await admission.readAuthorization("discover", input, call), undefined);
            return real.call(this, input, call);
          },
        );
        value = await admitted(t, binaries);
        assertNoBytes(await value.peer.request(value.readback.address, request(value)).result());
        await boundedCompletion(value.readback.closed, 4000, "withdrawn listener did not settle");
        captured.assertNoProvider();
      });

    await t.test(
      "disposal retires old calls and a replacement listener owns only its new exchanges",
      async (t) => {
        const captured = capture(t),
          selectedCompute = compute();
        const first = await admitted(t, binaries, { selectedCompute });
        decodedResponse(await first.peer.request(first.readback.address, request(first)).result());
        const old = captured.calls[0],
          original = captured.admissions[0].admission;
        await first.readback.close();
        const next = await admitted(t, binaries, { selectedCompute });
        decodedResponse(await next.peer.request(next.readback.address, request(next)).result());
        assert.equal(captured.calls[1].driver, selectedCompute);
        assert.equal(await original.readAuthorization("discover", old.input, old.call), undefined);
        assert.equal(
          await captured.admissions[1].admission.contextFactory.inspect(old.call.context, old.call),
          undefined,
        );
        captured.assertNoProvider();
      },
    );

    await t.test("another listener cannot steal an active selected observer", async (t) => {
      const captured = capture(t),
        selectedCompute = compute();
      const first = await admitted(t, binaries, { selectedCompute });
      await assert.rejects(
        admitted(t, binaries, { selectedCompute }),
        /Native runtime readback unavailable/,
      );
      const result = decodedResponse(
        await first.peer.request(first.readback.address, request(first)).result(),
      );
      assert.equal(result.reasonCode, "authority-unavailable");
      assert.equal(captured.admissions.length, 1);
      captured.assertNoProvider();
    });

    for (const action of ["deadline", "disconnect"])
      await t.test(`${action} retires an in-flight original exchange`, async (t) => {
        const captured = capture(t),
          real = KubernetesRuntimeObservations.prototype.discover;
        let entered, release;
        const started = new Promise((resolve) => {
          entered = resolve;
        });
        const held = new Promise((resolve) => {
          release = resolve;
        });
        t.mock.method(
          KubernetesRuntimeObservations.prototype,
          "discover",
          async function (input, call) {
            entered();
            await held;
            return real.call(this, input, call);
          },
        );
        const value = await admitted(t, binaries);
        const exchange = value.peer.request(
          value.readback.address,
          request(value, "discover", action === "deadline" ? 1000 : 2800),
        );
        try {
          await boundedCompletion(started, 2000, "original request did not enter Compute");
          if (action === "disconnect") exchange.cancel();
          assertNoBytes(await exchange.result());
          const old = captured.calls[0];
          assert.equal(
            await captured.admissions[0].admission.contextFactory.inspect(
              old.call.context,
              old.call,
            ),
            undefined,
          );
        } finally {
          release();
        }
        captured.assertNoProvider();
      });
  },
);

test(
  "observation profile admits through real PostgreSQL and the actual native accepting path",
  {
    timeout: 180000,
    skip: process.env.OCC_RUNTIME_OBSERVATION_DATABASE_URL
      ? false
      : "Select a migrated, disposable limited-role observation database.",
  },
  async (t) => {
    const captured = capture(t),
      binaries = await testExecutables(t);
    const value = await admitted(t, binaries, {
      databaseUrl: process.env.OCC_RUNTIME_OBSERVATION_DATABASE_URL,
    });
    const result = decodedResponse(
      await value.peer.request(value.readback.address, request(value, "observe")).result(),
    );
    assert.equal(result.status, "incomplete");
    assert.equal(result.reasonCode, "authority-unavailable");
    await withdraw(value, "service-withdraw");
    await boundedCompletion(
      value.readback.closed,
      4000,
      "withdrawn PostgreSQL listener did not settle",
    );
    captured.assertNoProvider();
  },
);
