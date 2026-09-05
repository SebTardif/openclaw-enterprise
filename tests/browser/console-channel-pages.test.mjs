import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

async function openChannels(t, fixture, namespaceId, agentId, revision = "draft") {
  const executablePath = process.env.OCC_TEST_BROWSER_EXECUTABLE || undefined;
  const browser = await chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const writes = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin === fixture.origin &&
      request.method() !== "GET" &&
      !url.pathname.startsWith("/api/auth/sign-")
    ) {
      writes.push({ method: request.method(), path: url.pathname });
    }
  });
  await page.goto(
    `${fixture.origin}/console/agents/${agentId}?namespace=${namespaceId}&revision=${revision}&tab=channels`,
  );
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
  return { page, writes };
}

function configurationResponse(page, fixture, path) {
  return page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${path}` && response.request().method() === "PATCH",
  );
}

test("Teams validates identity, retries an authorized draft save after denial, and disables without changing revisions", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Teams authoring", { ready: true });
  const values = {
    ...createHarnessConfiguration("codex", "gpt-5.1"),
    channels: {
      slack: {
        enabled: false,
        mode: "socket",
        channels: { CKEPT123: { users: ["UKEPT123"], requireMention: true } },
      },
    },
  };
  const agent = await fixture.createAgent(namespace.id, "Teams draft Agent", values, {
    executionMode: "dedicated",
  });
  const admitted = await fixture.deployAgent(namespace.id, agent.id);
  const path = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const { page, writes } = await openChannels(t, fixture, namespace.id, agent.id);
  await page.getByRole("button", { name: "Configure Microsoft Teams", exact: true }).click();
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({
      hasText: "Microsoft Teams requires Application ID and Directory tenant ID before enabling.",
    })
    .waitFor();
  assert.deepEqual(writes, []);

  const appId = "22222222-2222-4222-8222-222222222222";
  const tenantId = "33333333-3333-4333-8333-333333333333";
  await page.getByLabel("Application (client) ID").fill(` ${appId} `);
  await page.getByLabel("Directory (tenant) ID").fill(` ${tenantId} `);
  await page.getByLabel("Require a mention", { exact: true }).uncheck();
  // Deny the real Configuration update while allowing the editor's fresh Agent/Configuration reads.
  fixture.policy.restrictions.push({
    id: "deny-teams-draft-update",
    namespaceId: namespace.id,
    resourceKind: "configuration",
    action: "update",
    effect: "deny",
  });
  const deniedResponse = configurationResponse(page, fixture, path);
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await deniedResponse).status(), 403);
  await page.getByRole("alert").filter({ hasText: "Access denied." }).waitFor();
  assert.equal(await page.getByLabel("Application (client) ID").inputValue(), ` ${appId} `);
  assert.equal(
    await page.getByRole("button", { name: "Save configuration", exact: true }).isEnabled(),
    true,
  );
  assert.deepEqual((await fixture.request("GET", path)).data.values, values);

  fixture.policy.restrictions.length = 0;
  const savedResponse = configurationResponse(page, fixture, path);
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await savedResponse).status(), 200);
  await page.getByText(/Configuration .*generation 2/).waitFor();
  const saved = (await fixture.request("GET", path)).data.values;
  assert.deepEqual(saved.channels.msteams, {
    enabled: true,
    appId,
    tenantId,
    appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
    requireMention: false,
  });
  assert.deepEqual(saved.channels.slack, values.channels.slack);
  assert.deepEqual(saved.plugins.allow, [...values.plugins.allow, "msteams"]);
  assert.deepEqual(saved.plugins.entries.codex, values.plugins.entries.codex);
  assert.deepEqual(saved.plugins.entries.msteams, { enabled: true });

  const disabledResponse = configurationResponse(page, fixture, path);
  await page.getByRole("button", { name: "Disable Microsoft Teams", exact: true }).click();
  assert.equal((await disabledResponse).status(), 200);
  await page.getByText(/Configuration .*generation 3/).waitFor();
  const disabled = (await fixture.request("GET", path)).data.values;
  assert.deepEqual(disabled, {
    ...saved,
    channels: { ...saved.channels, msteams: { ...saved.channels.msteams, enabled: false } },
  });
  assert.deepEqual(
    writes,
    Array.from({ length: 3 }, () => ({ method: "PATCH", path })),
  );
  const revision = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${admitted.id}`,
  );
  assert.deepEqual(revision.data, admitted);
});

test("mixed Slack mention settings remain inspectable and can only be disabled in the draft", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slack native settings", { ready: true });
  const base = createHarnessConfiguration("codex", "gpt-5.1");
  const values = {
    ...base,
    plugins: {
      ...base.plugins,
      allow: [...base.plugins.allow, "slack"],
      entries: { ...base.plugins.entries, slack: { enabled: true } },
    },
    channels: {
      slack: {
        enabled: true,
        mode: "socket",
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        allowFrom: ["UKEPT123"],
        appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
        botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
        channels: {
          CFIRST123: { users: ["UKEPT123"], requireMention: true },
          CSECOND123: { requireMention: false },
        },
      },
    },
  };
  const agent = await fixture.createAgent(namespace.id, "Slack native Agent", values, {
    executionMode: "dedicated",
  });
  // Admission through the controller creates the immutable snapshot used by the read-only view.
  const admitted = await fixture.deployAgent(namespace.id, agent.id);
  const { page, writes } = await openChannels(t, fixture, namespace.id, agent.id, admitted.id);
  assert.equal(
    await page
      .getByText("Read-only AgentRevision values cannot be edited.", { exact: true })
      .count(),
    2,
  );
  assert.equal(await page.getByRole("button", { name: "Disable Slack", exact: true }).count(), 0);
  assert.deepEqual(writes, []);

  await page.getByRole("button", { name: "Saved draft", exact: true }).click();
  await page
    .getByText("Existing Slack channels use mixed Require mention values.", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Edit Slack", exact: true }).isDisabled(),
    true,
  );
  await page.getByText("Slack native configuration", { exact: true }).click();
  await page.getByText('"CFIRST123": {').waitFor();
  assert.deepEqual(writes, []);

  const path = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const response = configurationResponse(page, fixture, path);
  await page.getByRole("button", { name: "Disable Slack", exact: true }).click();
  assert.equal((await response).status(), 200);
  await page.getByText(/Configuration .*generation 2/).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Edit Slack", exact: true }).isDisabled(),
    true,
  );
  assert.deepEqual((await fixture.request("GET", path)).data.values, {
    ...values,
    channels: { slack: { ...values.channels.slack, enabled: false } },
  });
  assert.deepEqual(writes, [{ method: "PATCH", path }]);
  assert.deepEqual(
    (
      await fixture.request(
        "GET",
        `/namespaces/${namespace.id}/agents/${agent.id}/revisions/${admitted.id}`,
      )
    ).data,
    admitted,
  );
});
