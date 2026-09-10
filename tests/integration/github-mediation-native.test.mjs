import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  EMPTY_BODY_SHA256,
  githubGitReadDigest,
  githubMetadataDigest,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";
import {
  actualAssembly,
  nativeFixtureSelected as selected,
} from "../fixtures/github-mediation-native.mjs";
import { signal } from "../fixtures/runtime-service-trust.mjs";

function openRequest(protocolVersion = 2) {
  return {
    version: protocolVersion,
    sequence: 1,
    request_ref: randomBytes(16).toString("hex"),
    method: "open-read",
    attachment_ref: "attachment/external-client-input",
    repository_owner: "openclaw",
    repository_name: "example",
    ...(protocolVersion === 3
      ? {
          git_operation: "discovery",
          git_protocol: "version=2",
          body_bytes: 0,
          body_sha256: EMPTY_BODY_SHA256,
        }
      : {}),
    request_sha256:
      protocolVersion === 3
        ? githubGitReadDigest("openclaw", "example", "discovery", 0, EMPTY_BODY_SHA256)
        : githubMetadataDigest("openclaw", "example"),
  };
}

test(
  "actual service admission and native mTLS reach broker refusal; fresh sessions survive",
  {
    timeout: 30000,
    skip: selected
      ? false
      : "Select the built native executable and external Workload API test binary.",
  },
  async (t) => {
    const { external } = await actualAssembly(t);
    for (const session of ["first", "second", "third"]) {
      assert.equal(
        (await external.command("connect", { session }).wait("connected")).kind,
        "connected",
      );
      const metadata = openRequest();
      const request = external.command("request", { session, metadata });
      assert.equal((await request.wait("request-started")).kind, "request-started");
      const response = await request.wait("response");
      assert.equal(response.kind, "response");
      assert.equal(response.secret_length, 0);
      assert.equal(response.metadata.request_ref, metadata.request_ref);
      assert.deepEqual(Object.keys(response.metadata).sort(), [
        "code",
        "ok",
        "request_ref",
        "sequence",
        "version",
      ]);
      assert.equal(response.metadata.ok, false);
      assert.equal(response.metadata.version, 2);
      assert.equal(response.metadata.sequence, 1);
      assert.equal(response.metadata.code, "unavailable");
      assert.equal((await external.command("close", { session }).wait("closed")).kind, "closed");
    }
    // The broker emits this refusal only after its real transport inspection.
    // No Work, repository-use, custody release or dispatch owner is installed.
  },
);

test(
  "actual service-registry withdrawal closes the native accepting owner",
  {
    timeout: 30000,
    skip: selected
      ? false
      : "Select the built native executable and external Workload API test binary.",
  },
  async (t) => {
    const { external, trust, f, serviceIdentityRef } = await actualAssembly(t);
    await trust.apply(
      {
        schemaVersion: 1,
        kind: "service-withdraw",
        serviceIdentityRef,
        expectedVersion: 1,
        operationRef: randomUUID(),
      },
      f.context,
      signal(),
    );
    assert.equal(await trust.readCurrentRecord(serviceIdentityRef, signal()), undefined);
    // A current read on the original request catches withdrawal even before the
    // independent watcher has reached its next scheduled read.
    const connected = await external.command("connect", { session: "withdrawn" }).wait("connected");
    if (connected.kind === "connected") {
      const request = external.command("request", {
        session: "withdrawn",
        metadata: openRequest(),
      });
      const result = await request.wait("response");
      assert.equal(result.kind, "failed");
      await external.command("close", { session: "withdrawn" }).wait("closed");
    } else assert.equal(connected.kind, "failed");
  },
);

test(
  "actual borrowed native Session survives narrower call cancellation and releases without closing terminal sink",
  {
    timeout: 30000,
    skip: selected
      ? false
      : "Select the built native executable and external Workload API test binary.",
  },
  async (t) => {
    let inspected = false;
    const impossible = async () => {
      throw new Error("This identity consumer never authorizes Work or dispatch.");
    };
    const { external } = await actualAssembly(t, {
      create(source) {
        return {
          async prepare(request, call) {
            // This test consumer exercises the actual native owner and then
            // refuses unconditionally. It manufactures no Work/P/R/assignment.
            const cancellation = new AbortController();
            const bounded = Object.freeze({
              ...call,
              signal: AbortSignal.any([call.signal, cancellation.signal]),
            });
            const held = await source.acquire(request, bounded);
            assert.ok(held);
            const observed = await source.inspect(held, bounded);
            assert.equal(observed.context, call.context);
            assert.equal(observed.verified.transportBinding, held.transportBinding);
            assert.equal(observed.lifetime, held.signal);
            assert.equal(held.signal.aborted, false);
            const wrongPhase = Buffer.from(JSON.stringify(request));
            await assert.rejects(source.prepareCommittedToken(held, wrongPhase, call));
            await assert.rejects(source.prepareCommittedToken({ ...held }, wrongPhase, call));
            const fixtureToken = Buffer.from("disposable-transport-test-value");
            try {
              assert.throws(() => source.writePreparedCommittedToken({}, fixtureToken, call));
            } finally {
              fixtureToken.fill(0);
            }
            assert.throws(() => source.assertCurrent({ ...held }, call));
            assert.throws(() =>
              source.assertCurrent(held, { ...call, requestRef: "f".repeat(32) }),
            );
            cancellation.abort();
            assert.equal(held.signal.aborted, false);
            assert.throws(() => source.assertCurrent(held, bounded));
            source.assertCurrent(held, call);
            await source.release(held);
            await source.release(held);
            assert.equal(held.signal.aborted, true);
            assert.throws(() => source.assertCurrent(held, call));
            inspected = true;
            return { kind: "refused", code: "unavailable" };
          },
          dispatch: impossible,
          check: impossible,
          writeRelease: impossible,
          settle: impossible,
        };
      },
    });
    const session = "borrowed";
    assert.equal(
      (await external.command("connect", { session }).wait("connected")).kind,
      "connected",
    );
    const metadata = openRequest();
    const response = await external.command("request", { session, metadata }).wait("response");
    assert.equal(response.kind, "response");
    assert.equal(response.secret_length, 0);
    assert.deepEqual(response.metadata, {
      version: 2,
      sequence: 1,
      request_ref: metadata.request_ref,
      ok: false,
      code: "unavailable",
    });
    assert.equal(inspected, true);
    await external.command("close", { session }).wait("closed");
  },
);

for (const protocolVersion of [2, 3])
  for (const cancellation of [
    "acknowledged-write",
    "narrow-call",
    "borrowed-release",
    "narrow-call-and-shutdown",
  ]) {
    test(
      `v${protocolVersion} fixed receiver transport primitive retains submitted bytes through ${cancellation} until native ACK or retirement`,
      {
        timeout: 30000,
        skip:
          selected && (protocolVersion === 2 || process.env.OCC_GITHUB_GIT_READ_TEST_BINARY)
            ? false
            : "Select the built native executable and external Workload API test binary.",
      },
      async (t) => {
        // This is a transport-lifetime test. Disposable phase data at the broker
        // operation port drives the actual native receiver; it supplies no actual
        // Work, State COMMIT, repository authorization or credential-use lease.
        // Those owners require their separate positive composition tests.
        let external;
        let endpoint;
        let held;
        let horizon;
        let exerciseStarted = false;
        const session = `drain-${cancellation}`;
        const phase = Object.freeze({});
        const exercise = Promise.withResolvers();
        exercise.promise.catch(() => {});
        const times = () => ({
          server_time_ms: Date.now(),
          valid_until_ms: Math.min(Date.now() + 1800, horizon),
          operation_until_ms: horizon,
        });
        const assembly = await actualAssembly(
          t,
          {
            create(source) {
              return {
                async prepare(request, call) {
                  held = await source.acquire(request, call);
                  assert.ok(held);
                  horizon = Math.min(Date.now() + 5000, Date.parse(held.horizon));
                  return {
                    kind: "prepared",
                    preparation: phase,
                    original: {
                      operationRef: "transport-fixture/effect",
                      requestDigest: request.request_sha256,
                    },
                    work: {},
                    execution: {},
                    originalHorizon: new Date(horizon).toISOString(),
                    workBindingSha256: `sha256:${"5".repeat(64)}`,
                    dnsBindingRef: "transport-fixture/dns",
                    upstreamIpv4: "140.82.114.3",
                    times: times(),
                  };
                },
                async dispatch(original, _request, call) {
                  assert.equal(original, phase);
                  await source.inspect(held, call);
                  return {
                    kind: "released",
                    release: phase,
                    releaseRef: "transport-fixture/release",
                    times: times(),
                  };
                },
                async check() {
                  throw new Error("This transport fixture never checks repository authority.");
                },
                async writeRelease(original, metadata, call) {
                  exerciseStarted = true;
                  const token = Buffer.from("disposable-transport-test-value");
                  let submitted;
                  let stopping;
                  let peerPaused = false;
                  try {
                    assert.equal(original, phase);
                    const prepared = await source.prepareCommittedToken(held, metadata, call);
                    if (cancellation === "acknowledged-write") {
                      submitted = source.writePreparedCommittedToken(prepared, token, call);
                      await submitted;
                      exercise.resolve();
                      return;
                    }
                    const paused = await external
                      .command("pause-peer", { session })
                      .wait("peer-paused");
                    assert.equal(paused.kind, "peer-paused");
                    assert.equal(paused.state, "stopped");
                    peerPaused = true;
                    const abort = new AbortController();
                    const bounded = {
                      ...call,
                      signal: AbortSignal.any([call.signal, abort.signal]),
                    };
                    let settled = false;
                    // The actual method submits synchronously to its original child
                    // pipe. The peer is OS-stopped, so no native ACK/closed can exist.
                    submitted = source.writePreparedCommittedToken(prepared, token, bounded);
                    submitted.then(
                      () => {
                        settled = true;
                      },
                      () => {
                        settled = true;
                      },
                    );
                    if (cancellation === "borrowed-release") await source.release(held);
                    else abort.abort();
                    if (cancellation === "narrow-call-and-shutdown") stopping = endpoint.close();
                    if (stopping) await new Promise((resolve) => setImmediate(resolve));
                    else await new Promise((resolve) => setTimeout(resolve, 75));
                    assert.equal(settled, false, "cancellation must retain the native write");
                    const stillStopped = await external
                      .command("peer-state", { session })
                      .wait("peer-state");
                    assert.equal(stillStopped.kind, "peer-state", JSON.stringify(stillStopped));
                    assert.equal(stillStopped.state, "stopped");
                    if (stopping) {
                      // The owned shutdown sends SIGTERM then SIGKILL. Only actual
                      // process exit, observed independently by pidfd, drains use.
                      const until = Date.now() + 3000;
                      let retired;
                      do {
                        await new Promise((resolve) => setTimeout(resolve, 25));
                        retired = await external
                          .command("peer-state", { session })
                          .wait("peer-state");
                      } while (retired.state !== "exited" && Date.now() < until);
                      assert.equal(retired.state, "exited");
                    } else {
                      // Closing the remote socket while native is paused cannot
                      // establish that native observed retirement or stopped use.
                      const closed = await external.command("close", { session }).wait("closed");
                      assert.equal(closed.kind, "closed");
                      await new Promise((resolve) => setTimeout(resolve, 25));
                      assert.equal(settled, false, "remote close alone is not native retirement");
                      const resumed = await external
                        .command("resume-peer", { session })
                        .wait("peer-resumed");
                      assert.equal(resumed.kind, "peer-resumed");
                    }
                    await assert.rejects(submitted);
                    exercise.resolve();
                  } catch (error) {
                    exercise.reject(error);
                    throw error;
                  } finally {
                    // The fixture alone owns this peer-process control. Ensure a
                    // failed assertion cannot leave the real native child stopped.
                    if (peerPaused)
                      await external.command("resume-peer", { session }).wait("peer-resumed");
                    if (submitted) await submitted.catch(() => {});
                    token.fill(0);
                  }
                },
                async settle() {
                  return "recorded";
                },
              };
            },
          },
          protocolVersion,
        );
        ({ external, endpoint } = assembly);
        assert.equal(
          (await external.command("connect", { session }).wait("connected")).kind,
          "connected",
        );
        const opened = await external
          .command("request", { session, metadata: openRequest(protocolVersion) })
          .wait("response");
        assert.equal(opened.kind, "response");
        assert.equal(opened.metadata.phase, "opened");
        const {
          version,
          request_ref,
          session_ref,
          effect_ref,
          work_binding_sha256,
          request_sha256,
          dns_binding_ref,
          upstream_ipv4,
        } = opened.metadata;
        const dispatch = external.command("request", {
          session,
          metadata: {
            version,
            sequence: 2,
            request_ref,
            session_ref,
            effect_ref,
            work_binding_sha256,
            request_sha256,
            dns_binding_ref,
            upstream_ipv4,
            method: "dispatch-read",
            peer_certificate_sha256: `sha256:${"6".repeat(64)}`,
          },
        });
        const response = dispatch.wait("response");
        await Promise.race([
          exercise.promise,
          response.then(() => {
            assert.equal(exerciseStarted, true, "native receiver was not reached");
            return exercise.promise;
          }),
        ]);
        if (cancellation === "acknowledged-write") {
          const delivered = await response;
          assert.equal(delivered.kind, "response");
          assert.equal(delivered.metadata.phase, "dispatch-once");
          assert.equal(
            delivered.secret_length,
            Buffer.byteLength("disposable-transport-test-value"),
          );
        }
        await endpoint.close();
      },
    );
  }
