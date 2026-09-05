import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createRuntimeServiceTrustFixture,
  sourceRequest,
} from "../fixtures/runtime-service-trust.mjs";
import { signInToControllerApp } from "../helpers/auth-session.mjs";

test("real registry routes require a current human session, Principal and exact administrator decision", async (t) => {
  const f = await createRuntimeServiceTrustFixture();
  t.after(() => f.close());
  const route = "/v1/runtime-service-trust/operations";
  const body = sourceRequest(f.source.sourceRef);
  assert.equal(
    (await f.request("POST", route, body, { host: "127.0.0.1", origin: "http://127.0.0.1" }))
      .status,
    401,
  );
  assert.equal(
    (await f.request("POST", route, body, { ...f.headers, origin: "http://foreign.invalid" }))
      .status,
    403,
  );
  assert.equal(
    (await f.request("POST", route, body, { ...f.headers, "sec-fetch-site": "cross-site" })).status,
    403,
  );
  for (const extra of [
    { installationId: f.owner.installation.id },
    { actorId: f.context.actorId },
    { role: "lifecycle-authority" },
    { nativeExecutableSha256: f.source.nativeExecutableSha256 },
  ])
    assert.equal((await f.request("POST", route, { ...body, ...extra })).status, 400);
  assert.equal(
    (await f.request("POST", route, { ...body, operationRef: body.operationRef + "\n" })).status,
    400,
  );
  const admitted = await f.request("POST", route, body);
  assert.equal(admitted.status, 200, JSON.stringify(admitted));
  assert.equal(admitted.data.result, "applied");
  assert.equal((await f.request("POST", route, body)).data.result, "exact-replay");
  const recovered = await f.request("GET", `${route}/${body.operationRef}`);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, admitted.data.record);
  assert.equal((await f.request("GET", `${route}/${randomUUID()}`)).status, 404);
  assert.equal(
    (await f.request("GET", `${route}/${body.operationRef}?installationId=foreign`)).status,
    400,
  );
  await t.test(
    "privileged real service key cannot enter either human management route",
    async () => {
      const principal = { kind: "service_principal", id: `spn_${randomUUID()}` };
      f.policy.identities.push(principal);
      f.policy.bindings.push({
        id: `binding_${randomUUID()}`,
        subjectKind: "identity",
        subjectId: principal.id,
        roleId: f.seed.roles[0].id,
      });
      const key = await f.auth.createServiceKey({ principal, name: "Admin readback fixture" });
      const headers = { ...f.headers, "x-api-key": key.key };
      assert.equal((await f.request("POST", route, body, headers)).status, 403);
      assert.equal(
        (await f.request("GET", `${route}/${body.operationRef}`, undefined, headers)).status,
        403,
      );
    },
  );
  await t.test("a real human without administrator IAM is denied", async () => {
    const credentials = {
      email: `unprivileged-${randomUUID()}@example.invalid`,
      password: `Test-password-${randomUUID()}`,
    };
    const account = await f.auth.createAccount(credentials);
    const principal = f.auth.principalSeed(account).principal;
    f.policy.identities.push(principal);
    const session = await signInToControllerApp(f.app, credentials);
    const headers = { ...f.headers, cookie: session.cookie };
    assert.equal((await f.request("POST", route, body, headers)).status, 403);
    assert.equal(
      (await f.request("GET", `${route}/${body.operationRef}`, undefined, headers)).status,
      403,
    );
  });
  await t.test("exact old receipt cannot bypass a newly withdrawn human grant", async () => {
    const original = f.policy.bindings.splice(0);
    try {
      assert.equal((await f.request("POST", route, body)).status, 403);
      assert.equal((await f.request("GET", `${route}/${body.operationRef}`)).status, 403);
    } finally {
      f.policy.bindings.push(...original);
    }
  });
  await t.test(
    "raw fractional and exponent counter aliases reject before JSON rounding",
    async () => {
      for (const number of ["1.0000000000000001", "9007199254740991.1", "1e0", "1.0"]) {
        const raw = JSON.stringify({
          ...body,
          operationRef: randomUUID(),
          expectedVersion: 1,
        }).replace('"expectedVersion":1', `"expectedVersion":${number}`);
        assert.equal(
          (
            await f.request("POST", route, raw, {
              ...f.headers,
              "content-type": "application/json",
            })
          ).status,
          400,
        );
      }
    },
  );
  const audits = await f.state.transact((unit) => unit.audit.list());
  assert.equal(audits.filter((a) => a.id === admitted.data.record.auditId).length, 1);
  assert.ok(audits.some((a) => a.kind === "authorization_denial"));
});
