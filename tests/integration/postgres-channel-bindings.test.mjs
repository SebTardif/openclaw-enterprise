import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { ResourceConflictError } from "../../packages/occ/src/errors.ts";
import {
  channelAudit,
  channelRecords,
  seedChannelOwner,
  verifyChannelBindingStore,
  verifyChannelBindingSameUnitDuplicate,
} from "../conformance/channel-binding-store.contract.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL for real PostgreSQL channel binding storage.",
  timeout: 60000,
};
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function race(store, operations) {
  const ready = deferred();
  let arrived = 0;
  // Each callback has a separate checked-out database client before the race starts.
  return Promise.allSettled(
    operations.map((operation) =>
      store.transact(async (s) => {
        if (++arrived === operations.length) ready.resolve();
        await ready.promise;
        return operation(s);
      }),
    ),
  );
}
function assertOneWinner(results) {
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const losers = results.filter((r) => r.status === "rejected");
  assert.equal(losers.length, 1);
  assert.ok(losers[0].reason instanceof ResourceConflictError);
}

test(
  "PostgreSQL channel metadata: actual adapter parity, restart, constraints and races",
  options,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    const { owner, app, human, route } = await verifyChannelBindingStore(store);
    await t.test("new pool and adapter recover retained rows and versions", async () => {
      const freshPool = new pg.Pool({ connectionString: databaseUrl });
      try {
        const fresh = new PostgresPlatformState(freshPool);
        for (const lookup of [
          (s) => s.channelBindings.findChannelInstallation(app.id),
          (s) => s.channelBindings.findHumanBinding(app.id, human.id),
          (s) => s.channelBindings.findAgentBinding(app.id, route.id),
        ])
          assert.deepEqual(await fresh.read(lookup), await store.read(lookup));
      } finally {
        await freshPool.end();
      }
    });
    await t.test(
      "independent transactions preserve retained app, human and route uniqueness with one audit",
      async () => {
        const records = channelRecords(owner);
        for (const [kind, method, prefix] of [
          ["app", "createChannelInstallation", "chi"],
          ["human", "createHumanBinding", "chh"],
          ["route", "createAgentBinding", "cha"],
        ]) {
          const candidates = [records[kind], { ...records[kind], id: `${prefix}_${randomUUID()}` }];
          const audits = candidates.map(() => channelAudit(owner));
          const results = await race(
            store,
            candidates.map((record, i) => async (s) => {
              const result = await s.channelBindings[method](record);
              await s.audit.append(audits[i]);
              return result;
            }),
          );
          assertOneWinner(results);
          const winner = results.find((r) => r.status === "fulfilled").value;
          if (kind === "app") {
            records.human = { ...records.human, channelInstallationId: winner.id };
            records.route = { ...records.route, channelInstallationId: winner.id };
          }
          const storedAudits = await store.transact((s) => s.audit.list());
          assert.equal(
            storedAudits.filter((a) => audits.some((expected) => expected.id === a.id)).length,
            1,
          );
        }
      },
    );
    await t.test(
      "app and child status CAS races have one winner and no loser success audit",
      async () => {
        const records = channelRecords(owner);
        await store.transact(async (s) => {
          await s.channelBindings.createChannelInstallation(records.app);
          await s.channelBindings.createHumanBinding(records.human);
          await s.channelBindings.createAgentBinding(records.route);
        });
        for (const [kind, method] of [
          ["human", "setHumanBindingStatus"],
          ["route", "setAgentBindingStatus"],
          ["app", "setChannelInstallationStatus"],
        ]) {
          const audits = [channelAudit(owner), channelAudit(owner)];
          const results = await race(
            store,
            audits.map((audit, i) => async (s) => {
              const args = kind === "app" ? [records.app.id] : [records.app.id, records[kind].id];
              const result = await s.channelBindings[method](
                ...args,
                1,
                "disabled",
                `admin-${i}`,
                new Date().toISOString(),
              );
              await s.audit.append(audit);
              return result;
            }),
          );
          assertOneWinner(results);
          const persisted = await store.transact((s) => s.audit.list());
          assert.equal(persisted.filter((a) => audits.some((e) => e.id === a.id)).length, 1);
        }
      },
    );
    await t.test("parent disable serializes before child create and re-enable", async () => {
      for (const operation of ["create", "enable"]) {
        const records = channelRecords(owner);
        await store.transact(async (s) => {
          await s.channelBindings.createChannelInstallation(records.app);
          if (operation === "enable") {
            await s.channelBindings.createHumanBinding(records.human);
            await s.channelBindings.setHumanBindingStatus(
              records.app.id,
              records.human.id,
              1,
              "disabled",
              "admin",
              new Date().toISOString(),
            );
          }
        });
        const locked = deferred(),
          release = deferred(),
          entered = deferred();
        const disabling = store.transact(async (s) => {
          await s.channelBindings.setChannelInstallationStatus(
            records.app.id,
            1,
            "disabled",
            "admin",
            new Date().toISOString(),
          );
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        const child = store.transact(async (s) => {
          entered.resolve();
          return operation === "create"
            ? s.channelBindings.createHumanBinding(records.human)
            : s.channelBindings.setHumanBindingStatus(
                records.app.id,
                records.human.id,
                2,
                "enabled",
                "admin",
                new Date().toISOString(),
              );
        });
        // Attach rejection handling before releasing the transaction holding the parent row.
        const observed = Promise.allSettled([child]);
        await entered.promise;
        release.resolve();
        await disabling;
        const [result] = await observed;
        assert.equal(result.status, "rejected");
        assert.ok(result.reason instanceof ResourceConflictError);
        const found = await store.read((s) =>
          s.channelBindings.findHumanBinding(records.app.id, records.human.id),
        );
        assert.equal(found?.status, operation === "enable" ? "disabled" : undefined);
      }
    });
    await t.test(
      "child create may commit before parent disable, while final parent stays disabled",
      async () => {
        const records = channelRecords(owner);
        await store.transact((s) => s.channelBindings.createChannelInstallation(records.app));
        const locked = deferred(),
          release = deferred(),
          entered = deferred();
        const creating = store.transact(async (s) => {
          await s.channelBindings.createAgentBinding(records.route);
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        const disabling = store.transact(async (s) => {
          entered.resolve();
          return s.channelBindings.setChannelInstallationStatus(
            records.app.id,
            1,
            "disabled",
            "admin",
            new Date().toISOString(),
          );
        });
        await entered.promise;
        release.resolve();
        await Promise.all([creating, disabling]);
        assert.equal(
          (await store.read((s) => s.channelBindings.findChannelInstallation(records.app.id)))
            .status,
          "disabled",
        );
        assert.equal(
          (
            await store.read((s) =>
              s.channelBindings.findAgentBinding(records.app.id, records.route.id),
            )
          ).status,
          "enabled",
        );
      },
    );
    await t.test(
      "SQL grants and constraints reject immutable rewrites, deletes, invalid versions and foreign owners",
      async () => {
        const role = await pool.query(
          "SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
        );
        assert.equal(role.rows[0].name, "occ_app");
        assert.equal(role.rows[0].rolsuper, false);
        assert.equal(role.rows[0].rolbypassrls, false);
        for (const [table, id, column] of [
          ["channel_installations", app.id, "recipient_app_ref"],
          ["channel_human_bindings", human.id, "principal_id"],
          ["channel_agent_bindings", route.id, "agent_id"],
        ]) {
          await assert.rejects(
            pool.query(`DELETE FROM occ.${table} WHERE id=$1`, [id]),
            (e) => e.code === "42501",
          );
          await assert.rejects(
            pool.query(`UPDATE occ.${table} SET ${column}=$2 WHERE id=$1`, [id, "replacement"]),
            (e) => e.code === "42501",
          );
          await assert.rejects(
            pool.query(
              `UPDATE occ.${table} SET status=CASE status WHEN 'enabled' THEN 'disabled' ELSE 'enabled' END,version=0 WHERE id=$1`,
              [id],
            ),
            (e) => e.code === "23514",
          );
        }
        // Direct SQL bypasses repository validation and must still enforce retained owner/state.
        await assert.rejects(
          pool.query(
            `INSERT INTO occ.channel_human_bindings SELECT $1,installation_id,1,'enabled',created_at,created_at,created_by,created_by,$2,provider_subject_ref,iam_driver_id,principal_id,principal_issuer,principal_subject FROM occ.channel_human_bindings WHERE id=$3`,
            [`chh_${randomUUID()}`, `chi_${randomUUID()}`, human.id],
          ),
          (e) => e.code === "23503",
        );
        await assert.rejects(
          pool.query(
            `INSERT INTO occ.channel_agent_bindings SELECT $1,installation_id,1,'enabled',created_at,created_at,created_by,created_by,channel_installation_id,$2,scope_kind,namespace_id,$3 FROM occ.channel_agent_bindings WHERE id=$4`,
            [`cha_${randomUUID()}`, randomUUID(), `agt_${randomUUID()}`, route.id],
          ),
          (e) => e.code === "23514" || e.code === "23503",
        );
      },
    );
    await t.test(
      "service rejects an audit preimage from before an uncommitted app status change",
      async () => {
        const [{ ChannelBindingService }, { NativeIAMDriver }] = await Promise.all([
          import("../../packages/occ/src/channel-bindings.ts"),
          import("../../packages/iam/src/index.ts"),
        ]);
        const admin = {
          kind: "principal",
          id: `prn_${randomUUID()}`,
          issuer: "test-directory",
          subject: randomUUID(),
        };
        const roleId = `rol_${randomUUID()}`;
        // Preprovisioned native policy authorizes the actual service, without a
        // test replacement for its authorization or transaction implementation.
        const policy = {
          identities: [admin],
          groups: [],
          memberships: [],
          restrictions: [],
          roles: [
            { id: roleId, permissions: [{ action: "administer", resourceKind: "installation" }] },
          ],
          bindings: [
            {
              id: `bnd_${randomUUID()}`,
              subjectKind: "identity",
              subjectId: admin.id,
              roleId,
              resourceKind: "installation",
              resourceId: owner.installation.id,
            },
          ],
        };
        const iam = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
        const service = new ChannelBindingService({
          state: store,
          installationId: owner.installation.id,
          iam: () => iam,
        });
        const context = { actorId: admin.id, requestId: `test/${randomUUID()}` };
        const app = await service.createInstallation(context, {
          platform: "slack",
          providerTenantRef: `audit-race-${randomUUID()}`,
          recipientAppRef: "test-app",
        });
        const auditsBefore = await store.transact((s) => s.audit.list());
        const locked = deferred(),
          release = deferred();
        const competing = store.transact(async (s) => {
          const changed = await s.channelBindings.setChannelInstallationStatus(
            app.id,
            1,
            "disabled",
            admin.id,
            new Date().toISOString(),
          );
          assert.equal(changed.version, 2);
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        // READ COMMITTED sees version 1 while another transaction holds version 2
        // uncommitted. Expected version 2 cannot legitimize that older audit image.
        const observed = service
          .setInstallationStatus(context, app.id, { expectedVersion: 2, status: "enabled" })
          .then(
            (value) => ({ kind: "fulfilled", value }),
            (error) => ({ kind: "rejected", error }),
          );
        let timer;
        try {
          const result = await Promise.race([
            observed,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve({ kind: "blocked" }), 3000);
            }),
          ]);
          assert.equal(
            result.kind,
            "rejected",
            "the service must reject the older preimage before waiting for a future row version",
          );
          assert.ok(result.error instanceof ResourceConflictError);
        } finally {
          clearTimeout(timer);
          release.resolve();
          await competing;
          await observed;
        }
        const stored = await store.read((s) => s.channelBindings.findChannelInstallation(app.id));
        assert.equal(stored.status, "disabled");
        assert.equal(stored.version, 2, "the rejected request must not create version 3");
        assert.deepEqual(
          await store.transact((s) => s.audit.list()),
          auditsBefore,
          "the rejected request must not append an audit with a stale previous version",
        );
      },
    );
    await t.test("actual SQL audit failure rolls back newly inserted metadata", async () => {
      const record = channelRecords(owner).app;
      const audit = channelAudit(owner);
      await store.transact((s) => s.audit.append(audit));
      await assert.rejects(
        store.transact(async (s) => {
          await s.channelBindings.createChannelInstallation(record);
          await s.audit.append(audit);
        }),
        ResourceConflictError,
      );
      assert.equal(
        await store.read((s) => s.channelBindings.findChannelInstallation(record.id)),
        undefined,
      );
      assert.equal(
        (await store.transact((s) => s.audit.list())).filter((a) => a.id === audit.id).length,
        1,
      );
    });
  },
);

test(
  "authenticated channel APIs persist two human mappings and recover candidate resolution after controller recreation",
  options,
  async (t) => {
    const [
      { createFastifyApp },
      { createControllerAuth },
      { NativeIAMDriver },
      { OpenClawController },
      { signInToControllerApp },
      { parseReceiptIdentityV1 },
      { resolveChannelCandidateBindingsV1 },
    ] = await Promise.all([
      import("../../apps/controller/src/index.ts"),
      import("../../apps/controller/src/auth/index.ts"),
      import("../../packages/iam/src/index.ts"),
      import("../../packages/occ/src/index.ts"),
      import("../helpers/auth-session.mjs"),
      import("../../apps/controller/src/channels/shared-turn-receipt.ts"),
      import("../../apps/controller/src/channels/channel-principal-bindings.ts"),
    ]);
    const pools = new Set();
    const apps = new Set();
    t.after(async () => {
      for (const app of apps) await app.close();
      for (const pool of pools) await pool.end();
    });
    const initialPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    pools.add(initialPool);
    const initialState = new PostgresPlatformState(initialPool);
    const owner = await seedChannelOwner(initialState);
    const installationId = owner.installation.id;
    const memoryDatabase = { user: [], account: [], session: [], verification: [], apikey: [] };
    const authOptions = {
      mode: "development",
      installationId,
      baseURL: "http://127.0.0.1",
      secret: `channel-postgres-test-${randomUUID()}`,
      secureCookies: false,
      memoryDatabase,
    };
    const auth = createControllerAuth(authOptions);
    const credentials = {
      email: `channel-admin-${randomUUID()}@example.invalid`,
      password: `test-password-${randomUUID()}`,
    };
    const account = await auth.createAccount(credentials);
    const admin = auth.principalSeed(account).principal;
    const humans = [1, 2].map((i) => ({
      kind: "principal",
      id: `prn_${randomUUID()}`,
      issuer: "test-directory",
      subject: `channel-human-${i}-${randomUUID()}`,
    }));
    // Existing selected-IAM policy is deliberately preprovisioned: the API creates
    // channel mappings, not Principals or grants. Better Auth credentials remain a
    // separate in-memory fixture; only channel/OCC PostgreSQL durability is claimed.
    const adminRole = `rol_${randomUUID()}`;
    const agentRole = `rol_${randomUUID()}`;
    const policy = {
      identities: [admin, ...humans],
      groups: [],
      memberships: [],
      restrictions: [],
      roles: [
        { id: adminRole, permissions: [{ action: "administer", resourceKind: "installation" }] },
        {
          id: agentRole,
          namespaceId: owner.namespace.id,
          permissions: [
            { action: "read", resourceKind: "agent" },
            { action: "operate", resourceKind: "agent" },
          ],
        },
      ],
      bindings: [
        {
          id: `bnd_${randomUUID()}`,
          subjectKind: "identity",
          subjectId: admin.id,
          roleId: adminRole,
          resourceKind: "installation",
          resourceId: installationId,
        },
        ...[admin, ...humans].map((principal) => ({
          id: `bnd_${randomUUID()}`,
          subjectKind: "identity",
          subjectId: principal.id,
          roleId: agentRole,
          namespaceId: owner.namespace.id,
          resourceKind: "agent",
          resourceId: owner.agent.id,
        })),
      ],
    };
    async function openApp(state, instanceAuth) {
      const installation = await state.loadInstallation();
      assert.deepEqual(installation, owner.installation);
      const iam = new NativeIAMDriver({ loadNativeIAMState: async () => policy });
      const controller = new OpenClawController(installation, { state, recordOperations: false });
      controller.registerDriver(iam);
      controller.selectDriver("iam", iam.id);
      const app = createFastifyApp({
        controller,
        auth: instanceAuth,
        iamDriver: iam,
        auditSink: state.auditSink,
        publicOrigin: "http://127.0.0.1",
        development: { enabled: true, installationId },
      });
      apps.add(app);
      await app.ready();
      const session = await signInToControllerApp(app, credentials);
      const request = async (method, url, body) => {
        const response = await app.inject({
          method,
          url,
          headers: { host: "127.0.0.1", origin: "http://127.0.0.1", cookie: session.cookie },
          ...(body === undefined ? {} : { payload: body }),
        });
        const payload = response.json();
        assert.equal(response.headers["cache-control"], "no-store");
        assert.match(payload.meta.requestId, /^req_/);
        return { status: response.statusCode, ...payload };
      };
      return { app, controller, iam, request };
    }
    const first = await openApp(initialState, auth);
    const root = "/api/channel-installations";
    const created = await first.request("POST", root, {
      platform: "slack",
      providerTenantRef: `T-${randomUUID()}`,
      recipientAppRef: "A persisted",
    });
    assert.equal(created.status, 201, JSON.stringify(created));
    const connector = created.data;
    const path = `${root}/${connector.id}`;
    const bindings = [];
    for (const human of humans) {
      const response = await first.request("POST", `${path}/human-bindings`, {
        providerSubjectRef: `external/${human.subject}`,
        principal: { issuer: human.issuer, subject: human.subject },
      });
      assert.equal(response.status, 201, JSON.stringify(response));
      assert.equal(response.data.principalId, human.id);
      bindings.push(response.data);
      const found = await first.request("GET", `${path}/human-bindings/${response.data.id}`);
      assert.equal(found.status, 200);
      assert.deepEqual(found.data, response.data);
    }
    const routeResponse = await first.request("POST", `${path}/agent-bindings`, {
      channelRef: "C persisted",
      scopeKind: "slack-private-channel",
      namespaceId: owner.namespace.id,
      agentId: owner.agent.id,
    });
    assert.equal(routeResponse.status, 201, JSON.stringify(routeResponse));
    const route = routeResponse.data;
    assert.equal((await first.request("GET", path)).status, 200);
    assert.deepEqual(
      (await first.request("GET", `${path}/agent-bindings/${route.id}`)).data,
      route,
    );

    // Close the original Fastify app and all its database connections. A fresh
    // state/controller uses persisted rows, not retained repository instances.
    await first.app.close();
    apps.delete(first.app);
    await initialPool.end();
    pools.delete(initialPool);
    const reopenedPool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    pools.add(reopenedPool);
    const reopenedState = new PostgresPlatformState(reopenedPool);
    const reopened = await openApp(reopenedState, createControllerAuth(authOptions));
    assert.notEqual(reopened.controller, first.controller);
    const recoveredApp = await reopened.request("GET", path);
    assert.equal(recoveredApp.status, 200);
    assert.deepEqual(recoveredApp.data, connector);
    const recoveredHumans = await reopened.request("GET", `${path}/human-bindings`);
    assert.equal(recoveredHumans.status, 200);
    assert.deepEqual(
      recoveredHumans.data.items,
      [...bindings].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const recoveredRoute = await reopened.request("GET", `${path}/agent-bindings/${route.id}`);
    assert.equal(recoveredRoute.status, 200);
    assert.deepEqual(recoveredRoute.data, route);
    const auditsBefore = await reopenedState.transact((s) => s.audit.list());
    const operationsBefore = await reopenedState.transact((s) => s.operations.list());
    for (let i = 0; i < humans.length; i++) {
      const receipt = parseReceiptIdentityV1({
        schemaVersion: 1,
        platform: "slack",
        installationRef: installationId,
        channelInstallationRef: connector.id,
        providerTenantRef: connector.providerTenantRef,
        recipientAppRef: connector.recipientAppRef,
        normalizationProfileRef: "test/normalization-v1",
        providerEventRef: `event-${i}`,
        providerMessageRef: `message-${i}`,
        providerSubjectRef: bindings[i].providerSubjectRef,
        channelRef: route.channelRef,
        rootThreadRef: "root/Preserved:α",
        eventDigest: `sha256:${"1".repeat(64)}`,
        contentDigest: `sha256:${"2".repeat(64)}`,
      });
      assert.equal("kind" in receipt, false);
      const mapped = await resolveChannelCandidateBindingsV1(
        {
          state: reopenedState,
          installationId,
          iam: () => reopened.controller.selectedDriver("iam"),
        },
        receipt,
      );
      assert.equal(mapped.kind, "candidate-mapped", JSON.stringify(mapped));
      assert.equal(mapped.authority, "mapping-only");
      assert.equal(mapped.principalId, humans[i].id);
      assert.equal(mapped.humanBindingId, bindings[i].id);
      assert.equal(mapped.agentBindingId, route.id);
      assert.equal(mapped.agentId, owner.agent.id);
      assert.deepEqual(mapped.identity, receipt);
      assert.deepEqual(mapped.versions, { installation: 1, human: 1, agent: 1 });
      assert.ok(mapped.missingAuthority.includes("verified-delivery"));
      assert.ok(mapped.missingAuthority.includes("durable-admission"));
    }
    assert.deepEqual(await reopenedState.transact((s) => s.audit.list()), auditsBefore);
    assert.deepEqual(await reopenedState.transact((s) => s.operations.list()), operationsBefore);
  },
);

for (const kind of ["app", "human", "route"]) {
  test(
    `PostgreSQL retains the ${kind} winner after a handled same-unit duplicate`,
    options,
    async (t) => {
      const pool = new pg.Pool({ connectionString: databaseUrl });
      t.after(() => pool.end());
      await verifyChannelBindingSameUnitDuplicate(new PostgresPlatformState(pool), kind);
    },
  );
}
test(
  "PostgreSQL rejects a transaction whose SQL failure was caught by its callback",
  options,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    const owner = await seedChannelOwner(store);
    const first = channelRecords(owner).app;
    const invalid = { ...channelRecords(owner).app, version: 0 };
    let caught,
      callbackFinished = false;
    await assert.rejects(
      store.transact(async (s) => {
        await s.channelBindings.createChannelInstallation(first);
        try {
          await s.channelBindings.createChannelInstallation(invalid);
        } catch (error) {
          caught = error;
        }
        callbackFinished = true;
        return "must-not-report-commit";
      }),
      (error) => {
        assert.notEqual(
          error.name,
          "PostgresCommitOutcomeUnknownError",
          "a server-reported rollback is a known failure",
        );
        return true;
      },
    );
    assert.equal(callbackFinished, true);
    assert.ok(caught instanceof ResourceConflictError);
    assert.equal(
      await store.read((s) => s.channelBindings.findChannelInstallation(first.id)),
      undefined,
    );
    assert.equal(
      await store.read((s) => s.channelBindings.findChannelInstallation(invalid.id)),
      undefined,
    );
  },
);
