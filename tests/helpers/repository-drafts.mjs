import { setTimeout as delay } from "node:timers/promises";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { expectStatus } from "./postgres-controller-app.mjs";

export function repositoryDraft(
  binding,
  { repositoryId = 789, checkoutRef = "refs/heads/main" } = {},
) {
  return {
    schemaVersion: 1,
    repositories: [
      {
        bindingRef: {
          kind: "repository_binding",
          namespaceId: binding.namespaceId,
          id: binding.id,
        },
        repositoryId,
        checkoutRef,
        readProfile: "checkout",
        publication: { mode: "disabled" },
      },
    ],
  };
}

// Only shared prerequisites are created implicitly. Scenarios create/assert their own bindings and Agents.
export async function createRepositoryScenario(fixture, { name }) {
  const { request, actors, controller, pool } = fixture;
  const namespace = expectStatus(await request(actors.admin, "POST", "/namespaces", { name }), 201);
  // Advance the real controller lifecycle; this fixture does not provision a runtime Namespace.
  await controller.handleNamespaceLifecycle(actors.admin.principal.id, namespace.id, "ready");
  const base = `/namespaces/${namespace.id}`;
  const configuration = expectStatus(
    await request(actors.admin, "POST", `${base}/configurations`, { kind: "agent", values: {} }),
    201,
  );
  const secret = expectStatus(
    await request(actors.admin, "POST", `${base}/secrets`, {
      name: "Signing key reference",
      value: "synthetic-signing-key",
    }),
    201,
  );
  const descriptor = {
    appId: 123,
    installationId: 456,
    repositoryIds: [789],
    keySecretRef: secret.ref,
  };

  return {
    namespace,
    base,
    configuration,
    secret,
    descriptor,
    createBinding: (value = descriptor, actor = actors.admin) =>
      request(actor, "POST", `${base}/repository-bindings`, value),
    getBinding: (binding, actor = actors.admin) =>
      request(actor, "GET", `${base}/repository-bindings/${binding.id}`),
    updateBinding: (binding, value, actor = actors.admin) =>
      request(actor, "PATCH", `${base}/repository-bindings/${binding.id}`, value),
    createAgent: (actor = actors.admin) =>
      request(actor, "POST", `${base}/agents`, {
        name: "Draft agent",
        configurationId: configuration.id,
      }),
    patchAgentDraft: (agent, value, actor = actors.admin) =>
      request(actor, "PATCH", `${base}/agents/${agent.id}`, {
        configurationId: configuration.id,
        ...(value === undefined ? {} : { repositoryAccess: value }),
      }),
    getAgent: (agent, actor = actors.admin) => request(actor, "GET", `${base}/agents/${agent.id}`),
    deployAgent: (agent, actor = actors.admin) =>
      request(actor, "POST", `${base}/agents/${agent.id}/deploy`),
    readPersistedDraft: async (agent) =>
      (
        await new PostgresPlatformState(pool).read((unit) =>
          unit.agents.findAgent(namespace.id, agent.id),
        )
      ).repositoryAccess,
  };
}

export async function deploymentCounts(pool) {
  return (
    await pool.query(
      "SELECT (SELECT count(*)::int FROM occ.agent_revisions) revisions, (SELECT count(*)::int FROM occ.controller_work) work",
    )
  ).rows[0];
}

export async function waitForRevisionWork(pool, revisionId) {
  let state;
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query("SELECT state FROM occ.controller_work WHERE revision_id=$1", [
      revisionId,
    ]);
    state = result.rows[0]?.state;
    if (state === "succeeded") return state;
    await delay(25);
  }
  return state;
}
