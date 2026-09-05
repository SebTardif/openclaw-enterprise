import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { AuditEventFactory } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver, createAuthPrincipalSeed } from "../../packages/iam/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { ResourceConflictError } from "../../packages/occ/src/errors.ts";
import { ensureDevelopmentBootstrap } from "../helpers/bootstrap-installation.mjs";

// This suite invokes the real bootstrap subprocess, so it needs a separately
// migrated, empty disposable database, never the ordinary integration singleton.
const databaseUrl = process.env.OCC_CHANNEL_ADMINISTRATION_DATABASE_URL;
const migrationDatabaseUrl = process.env.OCC_CHANNEL_ADMINISTRATION_MIGRATION_DATABASE_URL;

test(
  "real PostgreSQL channel-administration bootstrap, binding integrity and native IAM evidence",
  {
    skip: databaseUrl
      ? false
      : "Set OCC_CHANNEL_ADMINISTRATION_DATABASE_URL and OCC_CHANNEL_ADMINISTRATION_MIGRATION_DATABASE_URL to a fresh migrated disposable PostgreSQL database.",
    timeout: 120_000,
  },
  async (t) => {
    assert.ok(migrationDatabaseUrl, "retained-row transitions require the limited migration owner");
    const application = new URL(databaseUrl);
    const migration = new URL(migrationDatabaseUrl);
    assert.equal(application.host, migration.host);
    assert.equal(application.pathname, migration.pathname);
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    const ownerPool = new pg.Pool({ connectionString: migrationDatabaseUrl, max: 4 });
    t.after(async () => {
      await pool.end();
      await ownerPool.end();
    });
    for (const [connection, role] of [
      [pool, "occ_app"],
      [ownerPool, "occ_migrator"],
    ]) {
      const result = await connection.query(
        "SELECT current_user AS name, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      assert.deepEqual(result.rows[0], {
        name: role,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
      });
    }
    const state = new PostgresPlatformState(pool);
    assert.equal(
      await state.loadInstallation(),
      undefined,
      "bootstrap evidence requires a fresh database; an existing Installation must not be replaced",
    );
    const email = `channel-admin-${randomUUID()}@example.invalid`;
    await ensureDevelopmentBootstrap(t, {
      databaseUrl,
      email,
      password: `disposable-password-${randomUUID()}`,
      authSecret: `disposable-bootstrap-secret-${randomUUID()}`,
      installationName: "Channel administration SQL integration",
      environment: { PATH: process.env.PATH },
    });
    const installation = await state.loadInstallation();
    assert.ok(installation);
    const bootstrapped = await state.loadNativeIAMState(installation.id);
    const human = bootstrapped.identities.find((identity) => identity.kind === "principal");
    assert.ok(human);
    const humanBinding = bootstrapped.bindings.find((binding) => binding.subjectId === human.id);
    assert.ok(humanBinding);
    const roleId = humanBinding.roleId;
    const serviceBinding = bootstrapped.bindings.find(
      (binding) =>
        binding.roleId === roleId &&
        bootstrapped.identities.some(
          (identity) => identity.id === binding.subjectId && identity.kind === "service_principal",
        ),
    );
    assert.ok(
      serviceBinding,
      "actual bootstrap creates a separate service binding to the same Role",
    );
    const mapping = {
      schemaVersion: 1,
      version: 1,
      status: "enabled",
      installationId: installation.id,
      roleId,
      semanticClass: "installation-administrator",
    };
    const iam = new NativeIAMDriver(state);
    const authorize = (principalId, installationId = installation.id) =>
      iam.authorize({
        principalId,
        action: "administer",
        resource: { kind: "installation", id: installationId },
      });
    const expectedEvidence = (bindings) => ({
      schemaVersion: 1,
      installationId: installation.id,
      mappings: bindings,
    });
    const readMapping = async (id) => {
      const result = await pool.query(
        "SELECT channel_administration FROM occ.iam_access_bindings WHERE id = $1",
        [id],
      );
      assert.equal(result.rowCount, 1);
      return result.rows[0].channel_administration;
    };
    const insertBinding = async (value, overrides = {}, connection = pool) => {
      const id = overrides.id ?? `bnd_${randomUUID()}`;
      await connection.query(
        `INSERT INTO occ.iam_access_bindings
         (id, namespace_id, identity_subject_id, group_subject_id, role_id,
          resource_kind, resource_id, channel_administration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          id,
          overrides.namespaceId ?? null,
          overrides.groupId === undefined ? (overrides.subjectId ?? human.id) : null,
          overrides.groupId ?? null,
          overrides.roleId ?? roleId,
          Object.hasOwn(overrides, "resourceKind") ? overrides.resourceKind : "installation",
          Object.hasOwn(overrides, "resourceId") ? overrides.resourceId : installation.id,
          value === undefined ? null : JSON.stringify(value),
        ],
      );
      return id;
    };
    const updateMapping = (id, value) =>
      ownerPool.query(
        "UPDATE occ.iam_access_bindings SET channel_administration = $2::jsonb WHERE id = $1",
        [id, value === undefined ? null : JSON.stringify(value)],
      );
    const checkViolation = (error) => error.code === "23514";

    await t.test("actual bootstrap persists only its human semantic registration", async () => {
      assert.deepEqual(humanBinding.channelAdministration, mapping);
      assert.deepEqual(await readMapping(humanBinding.id), mapping);
      assert.equal(serviceBinding.channelAdministration, undefined);
      assert.equal(await readMapping(serviceBinding.id), null);
      const decision = await authorize(human.id);
      assert.equal(decision.allowed, true);
      assert.deepEqual(
        decision.evidence.channelAdministration,
        expectedEvidence([{ bindingId: humanBinding.id, roleId, version: 1 }]),
      );
      const serviceDecision = await authorize(serviceBinding.subjectId);
      assert.equal(serviceDecision.allowed, true, "bootstrap service keeps its generic IAM grant");
      assert.deepEqual(serviceDecision.evidence.channelAdministration, expectedEvidence([]));
      const otherInstallation = await authorize(human.id, `ins_${randomUUID()}`);
      assert.deepEqual(otherInstallation.evidence.channelAdministration.mappings, []);
    });

    let additional;
    await t.test(
      "actual additional-account seed and append do not inherit mapping from a Role",
      async () => {
        additional = createAuthPrincipalSeed(
          installation.id,
          human.issuer,
          { id: randomUUID() },
          { roleId },
        );
        const persisted = await state.appendNativeIAMPrincipal(additional);
        const binding = persisted.bindings.find((item) => item.id === additional.bindings[0].id);
        assert.deepEqual(binding, additional.bindings[0]);
        assert.equal(binding.channelAdministration, undefined);
        assert.equal(await readMapping(binding.id), null);
        const decision = await authorize(additional.principal.id);
        assert.equal(decision.allowed, true);
        assert.deepEqual(decision.evidence.channelAdministration, expectedEvidence([]));
      },
    );

    await t.test(
      "seed and append writers preserve explicitly provided canonical mappings",
      async () => {
        const seeded = createAuthPrincipalSeed(installation.id, human.issuer, { id: randomUUID() });
        await state.seedNativeIAM({
          identities: [seeded.principal],
          groups: [],
          memberships: [],
          roles: seeded.roles,
          bindings: seeded.bindings,
          restrictions: [],
        });
        // This is explicit persistence coverage; ordinary account creation above
        // passes its real unmapped seed and cannot infer registration from a Role.
        const appended = createAuthPrincipalSeed(
          installation.id,
          human.issuer,
          { id: randomUUID() },
          { roleId },
        );
        const registered = {
          ...appended,
          bindings: appended.bindings.map((binding) => ({
            ...binding,
            channelAdministration: mapping,
          })),
        };
        await state.appendNativeIAMPrincipal(registered);
        const reopenedPool = new pg.Pool({ connectionString: databaseUrl });
        try {
          const recovered = await new PostgresPlatformState(reopenedPool).loadNativeIAMState();
          for (const binding of [...seeded.bindings, ...registered.bindings]) {
            assert.deepEqual(
              recovered.bindings.find((item) => item.id === binding.id),
              binding,
            );
            assert.deepEqual(await readMapping(binding.id), binding.channelAdministration);
          }
        } finally {
          await reopenedPool.end();
        }
      },
    );

    await t.test(
      "limited application INSERT enforces closed JSON shape and initial version",
      async (shape) => {
        const invalid = [
          ["JSON null", null],
          ["array", []],
          ["string", "mapping"],
          ["number", 1],
          ["extra property", { ...mapping, authority: "administrator" }],
        ];
        for (const key of Object.keys(mapping)) {
          const missing = { ...mapping };
          delete missing[key];
          invalid.push([`missing ${key}`, missing], [`null ${key}`, { ...mapping, [key]: null }]);
        }
        for (const version of [0, -1, 1.5, "1", true, 2, Number.MAX_SAFE_INTEGER, 9007199254740992])
          invalid.push([`version ${String(version)} (${typeof version})`, { ...mapping, version }]);
        for (const schemaVersion of [2, "1", true])
          invalid.push([`schema ${String(schemaVersion)}`, { ...mapping, schemaVersion }]);
        for (const status of ["active", "ENABLED", false, {}])
          invalid.push([`status ${JSON.stringify(status)}`, { ...mapping, status }]);
        for (const semanticClass of ["administrator", "service-administrator", true, []])
          invalid.push([`class ${JSON.stringify(semanticClass)}`, { ...mapping, semanticClass }]);
        for (const field of ["installationId", "roleId"])
          for (const value of [
            "",
            "  ",
            "\u00a0",
            "x\u0001y",
            "x\u007fy",
            "x".repeat(1025),
            "é".repeat(513),
            1,
            {},
            [],
          ])
            invalid.push([`${field} malformed ${invalid.length}`, { ...mapping, [field]: value }]);
        for (const [name, value] of invalid) {
          await shape.test(name, async () => {
            const id = `bnd_${randomUUID()}`;
            await assert.rejects(insertBinding(value, { id }), checkViolation);
            assert.equal(
              (await pool.query("SELECT id FROM occ.iam_access_bindings WHERE id = $1", [id]))
                .rowCount,
              0,
            );
          });
        }
      },
    );

    const namespace = (await pool.query("SELECT id FROM occ.namespaces LIMIT 1")).rows[0];
    assert.ok(namespace, "actual bootstrap must create its default Namespace");
    const namespacedRoleId = `role_${randomUUID()}`;
    await pool.query(
      "INSERT INTO occ.iam_roles (id, namespace_id, permissions) VALUES ($1, $2, $3::jsonb)",
      [
        namespacedRoleId,
        namespace.id,
        JSON.stringify([{ action: "read", resourceKind: "namespace" }]),
      ],
    );
    await t.test(
      "SQL binds mapping to its singleton, actual Role and Installation scope",
      async (scope) => {
        const cases = [
          [
            "another Installation mapping",
            { ...mapping, installationId: `ins_${randomUUID()}` },
            {},
          ],
          ["another mapping Role", { ...mapping, roleId: namespacedRoleId }, {}],
          ["another exact resource", mapping, { resourceId: `ins_${randomUUID()}` }],
          ["Namespace resource", mapping, { resourceKind: "namespace", resourceId: namespace.id }],
          [
            "Namespace binding",
            mapping,
            { namespaceId: namespace.id, resourceKind: null, resourceId: null },
          ],
          [
            "Namespace Role",
            { ...mapping, roleId: namespacedRoleId },
            {
              roleId: namespacedRoleId,
              namespaceId: namespace.id,
              resourceKind: "namespace",
              resourceId: namespace.id,
            },
          ],
        ];
        for (const [name, value, overrides] of cases)
          await scope.test(name, () =>
            assert.rejects(insertBinding(value, overrides), checkViolation),
          );
        const legacyId = await insertBinding(undefined, { subjectId: additional.principal.id });
        assert.equal(
          await readMapping(legacyId),
          null,
          "an actual generic grant remains unregistered",
        );
        await assert.rejects(updateMapping(legacyId, { ...mapping, version: 2 }), checkViolation);
        await updateMapping(legacyId, mapping);
        assert.deepEqual(
          await readMapping(legacyId),
          mapping,
          "explicit first registration starts at one",
        );
      },
    );

    await t.test(
      "app privileges preserve IAM ownership; owner updates retain identity and exact versions",
      async (updates) => {
        const id = await insertBinding(mapping);
        for (const statement of [
          "UPDATE occ.iam_access_bindings SET channel_administration = NULL WHERE id = $1",
          "UPDATE occ.iam_access_bindings SET identity_subject_id = identity_subject_id WHERE id = $1",
          "DELETE FROM occ.iam_access_bindings WHERE id = $1",
        ])
          await assert.rejects(pool.query(statement, [id]), (error) => error.code === "42501");
        const alternateRoleId = `role_${randomUUID()}`;
        const groupId = `grp_${randomUUID()}`;
        await pool.query("INSERT INTO occ.iam_roles (id, permissions) VALUES ($1, '[]'::jsonb)", [
          alternateRoleId,
        ]);
        await pool.query("INSERT INTO occ.iam_groups (id, name) VALUES ($1, $2)", [
          groupId,
          `Retarget ${randomUUID()}`,
        ]);
        const retargets = [
          ["binding id", "id = $2", `bnd_${randomUUID()}`],
          ["identity subject", "identity_subject_id = $2", additional.principal.id],
          ["subject kind", "identity_subject_id = NULL, group_subject_id = $2", groupId],
          ["Role", "role_id = $2", alternateRoleId],
          ["resource kind", "resource_kind = 'namespace', resource_id = $2", namespace.id],
          ["wildcard scope", "resource_kind = NULL, resource_id = NULL", undefined],
          [
            "Namespace",
            "namespace_id = $2, resource_kind = NULL, resource_id = NULL",
            namespace.id,
          ],
        ];
        for (const [name, columns, value] of retargets)
          await updates.test(`retarget ${name}`, () =>
            assert.rejects(
              ownerPool.query(
                `UPDATE occ.iam_access_bindings SET ${columns} WHERE id = $1`,
                value === undefined ? [id] : [id, value],
              ),
              checkViolation,
            ),
          );
        for (const [name, value] of [
          ["SQL NULL downgrade", undefined],
          ["JSON null downgrade", null],
          ["status without version", { ...mapping, status: "disabled" }],
          ["skipped version", { ...mapping, status: "disabled", version: 3 }],
          ["version without status", { ...mapping, version: 2 }],
          ["unsafe version", { ...mapping, status: "disabled", version: 9007199254740992 }],
          [
            "mapping Installation",
            { ...mapping, installationId: `ins_${randomUUID()}`, status: "disabled", version: 2 },
          ],
          ["mapping Role", { ...mapping, roleId: alternateRoleId, status: "disabled", version: 2 }],
        ])
          await updates.test(name, () => assert.rejects(updateMapping(id, value), checkViolation));
        await assert.rejects(
          ownerPool.query("DELETE FROM occ.iam_access_bindings WHERE id = $1", [id]),
          checkViolation,
        );
        await updateMapping(id, mapping);
        assert.deepEqual(await readMapping(id), mapping, "unchanged mapping is an allowed no-op");
        const disabled = { ...mapping, version: 2, status: "disabled" };
        await updateMapping(id, disabled);
        assert.deepEqual(await readMapping(id), disabled);
        await assert.rejects(updateMapping(id, mapping), checkViolation);
        await assert.rejects(updateMapping(id, undefined), checkViolation);
        await assert.rejects(
          ownerPool.query("DELETE FROM occ.iam_access_bindings WHERE id = $1", [id]),
          checkViolation,
        );
        await updateMapping(id, disabled);
        await updateMapping(id, { ...mapping, version: 3 });
        assert.deepEqual(await readMapping(id), { ...mapping, version: 3 });
      },
    );

    await t.test(
      "actual duplicate SQL audit rolls back append identity and registered binding together",
      async () => {
        const seed = createAuthPrincipalSeed(
          installation.id,
          human.issuer,
          { id: randomUUID() },
          { roleId },
        );
        const registered = {
          ...seed,
          bindings: seed.bindings.map((binding) => ({
            ...binding,
            channelAdministration: mapping,
          })),
        };
        const audit = new AuditEventFactory().create({
          installationId: installation.id,
          actorId: human.id,
          action: "test.channel-administration.append",
          resource: { kind: "installation", id: installation.id },
        });
        await state.auditSink.append(audit);
        await assert.rejects(
          state.appendNativeIAMPrincipal(registered, audit),
          ResourceConflictError,
        );
        const recovered = await state.loadNativeIAMState();
        assert.equal(
          recovered.identities.some((identity) => identity.id === seed.principal.id),
          false,
        );
        assert.equal(
          recovered.bindings.some((binding) => binding.id === seed.bindings[0].id),
          false,
        );
        assert.equal(
          (await pool.query("SELECT id FROM occ.audit_events WHERE id = $1", [audit.id])).rowCount,
          1,
        );
      },
    );

    await t.test(
      "independent SQL clients serialize mapped version and retarget races",
      async (races) => {
        for (const competingChange of ["stale expected version", "identity retarget"]) {
          await races.test(competingChange, async () => {
            const id = await insertBinding(mapping);
            const disabled = { ...mapping, version: 2, status: "disabled" };
            const first = await ownerPool.connect();
            const second = await ownerPool.connect();
            let competing;
            try {
              await first.query("BEGIN");
              await second.query("BEGIN");
              await first.query("SET LOCAL statement_timeout = '5s'");
              await second.query("SET LOCAL statement_timeout = '5s'");
              const firstPid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
              const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
              assert.notEqual(
                firstPid,
                secondPid,
                "the operations must use independent PostgreSQL clients",
              );
              const change = `UPDATE occ.iam_access_bindings SET channel_administration = $2::jsonb
              WHERE id = $1 AND (channel_administration->>'version')::numeric = 1`;
              assert.equal((await first.query(change, [id, JSON.stringify(disabled)])).rowCount, 1);
              // The first transaction holds the actual row lock. Confirm PostgreSQL
              // blocks the second statement before committing the winning withdrawal.
              competing = (
                competingChange === "stale expected version"
                  ? second.query(change, [id, JSON.stringify(disabled)])
                  : second.query(
                      "UPDATE occ.iam_access_bindings SET identity_subject_id = $2 WHERE id = $1",
                      [id, additional.principal.id],
                    )
              ).then(
                (value) => ({ value }),
                (error) => ({ error }),
              );
              const deadline = Date.now() + 4_000;
              let observedBlocking = false;
              while (Date.now() < deadline) {
                const observation = await ownerPool.query(
                  "SELECT pg_blocking_pids($1) AS blockers",
                  [secondPid],
                );
                if (observation.rows[0].blockers.includes(firstPid)) {
                  observedBlocking = true;
                  break;
                }
                await delay(20);
              }
              assert.equal(
                observedBlocking,
                true,
                "the contender must reach a real PostgreSQL lock wait",
              );
              await first.query("COMMIT");
              const result = await competing;
              if (competingChange === "stale expected version") {
                assert.equal(result.error, undefined);
                // An identical unconditional update is a permitted no-op. The explicit
                // expected-version predicate rejects this stale compare-and-set instead.
                assert.equal(result.value.rowCount, 0);
                await second.query("COMMIT");
              } else {
                assert.equal(result.error?.code, "23514");
                await second.query("ROLLBACK");
              }
              assert.deepEqual(await readMapping(id), disabled);
              const retained = await pool.query(
                "SELECT identity_subject_id FROM occ.iam_access_bindings WHERE id = $1",
                [id],
              );
              assert.equal(retained.rows[0].identity_subject_id, human.id);
            } finally {
              await first.query("ROLLBACK");
              await second.query("ROLLBACK");
              if (competing !== undefined) await competing;
              first.release();
              second.release();
            }
          });
        }
      },
    );

    await t.test(
      "database rollback retains the previous mapping after a valid withdrawal",
      async () => {
        const id = await insertBinding(mapping);
        const client = await ownerPool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "UPDATE occ.iam_access_bindings SET channel_administration = $2::jsonb WHERE id = $1",
            [id, JSON.stringify({ ...mapping, version: 2, status: "disabled" })],
          );
          await assert.rejects(
            client.query("INSERT INTO occ.iam_roles (id, permissions) VALUES ($1, '[]'::jsonb)", [
              roleId,
            ]),
            (error) => error.code === "23505",
          );
          await client.query("ROLLBACK");
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
        assert.deepEqual(await readMapping(id), mapping);
      },
    );

    await t.test(
      "fresh native authorization excludes disabled mappings while retaining generic grants",
      async () => {
        const seed = createAuthPrincipalSeed(
          installation.id,
          human.issuer,
          { id: randomUUID() },
          { roleId },
        );
        const registered = {
          ...seed,
          bindings: seed.bindings.map((binding) => ({
            ...binding,
            channelAdministration: mapping,
          })),
        };
        await state.appendNativeIAMPrincipal(registered);
        const id = seed.bindings[0].id;
        assert.deepEqual(
          (await authorize(seed.principal.id)).evidence.channelAdministration,
          expectedEvidence([{ bindingId: id, roleId, version: 1 }]),
        );
        await updateMapping(id, { ...mapping, version: 2, status: "disabled" });
        const disabled = await authorize(seed.principal.id);
        assert.equal(disabled.allowed, true);
        assert.deepEqual(disabled.evidence.channelAdministration, expectedEvidence([]));
        await updateMapping(id, { ...mapping, version: 3 });
        assert.deepEqual(
          (await authorize(seed.principal.id)).evidence.channelAdministration,
          expectedEvidence([{ bindingId: id, roleId, version: 3 }]),
        );
      },
    );

    await t.test(
      "a persisted group mapping qualifies only through actual current membership and permission",
      async () => {
        const member = createAuthPrincipalSeed(
          installation.id,
          human.issuer,
          { id: randomUUID() },
          { roleId },
        );
        const nonmember = createAuthPrincipalSeed(
          installation.id,
          human.issuer,
          { id: randomUUID() },
          { roleId },
        );
        await state.appendNativeIAMPrincipal(member);
        await state.appendNativeIAMPrincipal(nonmember);
        const groupId = `grp_${randomUUID()}`;
        await pool.query("INSERT INTO occ.iam_groups (id, name) VALUES ($1, $2)", [
          groupId,
          `Current members ${randomUUID()}`,
        ]);
        await pool.query(
          "INSERT INTO occ.iam_group_memberships (group_id, principal_id) VALUES ($1, $2)",
          [groupId, member.principal.id],
        );
        const id = await insertBinding(mapping, { groupId });
        assert.deepEqual(
          (await authorize(member.principal.id)).evidence.channelAdministration,
          expectedEvidence([{ bindingId: id, roleId, version: 1 }]),
        );
        assert.deepEqual(
          (await authorize(nonmember.principal.id)).evidence.channelAdministration,
          expectedEvidence([]),
        );
        const noGrantRole = `role_${randomUUID()}`;
        await pool.query("INSERT INTO occ.iam_roles (id, permissions) VALUES ($1, $2::jsonb)", [
          noGrantRole,
          JSON.stringify([{ action: "read", resourceKind: "installation" }]),
        ]);
        await insertBinding(
          { ...mapping, roleId: noGrantRole },
          { subjectId: nonmember.principal.id, roleId: noGrantRole },
        );
        assert.deepEqual(
          (await authorize(nonmember.principal.id)).evidence.channelAdministration,
          expectedEvidence([]),
          "metadata on a non-granting Role must not add semantic authority",
        );
      },
    );

    await t.test(
      "an actual persisted Restriction independently denies enabled mapped administrators",
      async () => {
        const restrictionId = `rst_${randomUUID()}`;
        await pool.query(
          `INSERT INTO occ.iam_restrictions (id, action, resource_kind, resource_id, effect)
         VALUES ($1, 'administer', 'installation', $2, 'deny')`,
          [restrictionId, installation.id],
        );
        const decision = await authorize(human.id);
        assert.equal(decision.allowed, false);
        assert.ok(decision.evidence.restrictionIds.includes(restrictionId));
        assert.deepEqual(decision.evidence.channelAdministration, expectedEvidence([]));
        assert.deepEqual(
          await readMapping(humanBinding.id),
          mapping,
          "deny does not erase the retained registration",
        );
      },
    );
  },
);
