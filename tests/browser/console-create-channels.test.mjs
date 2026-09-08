import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";

async function authenticatedCreatePage(t, fixture, namespaceId) {
  const executablePath = process.env.OCC_TEST_BROWSER_EXECUTABLE || undefined;
  const browser = await chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`${fixture.origin}/console/agents/new?namespace=${namespaceId}`);
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await page.getByRole("heading", { name: "Create Agent", exact: true }).waitFor();
  return page;
}

function collectWrites(page, origin) {
  const writes = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() === "GET") return;
    if (url.pathname.startsWith("/api/auth/sign-")) return;
    let body;
    try {
      body = request.postDataJSON();
    } catch {}
    writes.push({ method: request.method(), path: url.pathname, body });
  });
  return writes;
}

async function configurationValues(page) {
  return JSON.parse(await page.getByLabel("Configuration JSON").inputValue());
}

test("Agent creation stages Slack and Teams channels into the initial Configuration", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Create channels", { ready: true });
  const page = await authenticatedCreatePage(t, fixture, namespace.id);
  const writes = collectWrites(page, fixture.origin);

  await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
  await page.getByLabel("Slack channel IDs").fill("CCHANNEL1, CCHANNEL2");
  await page.getByLabel("Allowed user IDs").fill("UUSER1, UUSER2");
  await page.getByRole("button", { name: "Apply channel settings", exact: true }).click();
  await page.getByRole("button", { name: "Edit Slack", exact: true }).waitFor();

  await page.getByRole("button", { name: "Configure Microsoft Teams", exact: true }).click();
  await page.getByLabel("Application (client) ID").fill("22222222-2222-4222-8222-222222222222");
  await page.getByLabel("Directory (tenant) ID").fill("33333333-3333-4333-8333-333333333333");
  await page.getByLabel("Require a mention", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Apply channel settings", exact: true }).click();
  await page.getByRole("button", { name: "Edit Microsoft Teams", exact: true }).waitFor();

  const staged = await configurationValues(page);
  assert.deepEqual(staged.channels.slack, {
    enabled: true,
    mode: "socket",
    appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
    botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
    allowFrom: ["UUSER1", "UUSER2"],
    channels: {
      CCHANNEL1: { requireMention: true },
      CCHANNEL2: { requireMention: true },
    },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
  });
  assert.deepEqual(staged.channels.msteams, {
    enabled: true,
    appId: "22222222-2222-4222-8222-222222222222",
    tenantId: "33333333-3333-4333-8333-333333333333",
    appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
    requireMention: false,
  });
  assert.deepEqual(staged.plugins.allow, ["codex", "slack", "msteams"]);
  assert.deepEqual(staged.plugins.entries.slack, { enabled: true });
  assert.deepEqual(staged.plugins.entries.msteams, { enabled: true });

  await page.getByLabel("Agent name").fill("Agent with create channels");
  const configurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  const agentResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const configurationPayload = await (await configurationResponse).json();
  const agentPayload = await (await agentResponse).json();
  assert.deepEqual(configurationPayload.data.values, staged);
  assert.equal(agentPayload.data.configurationId, configurationPayload.data.id);
  assert.equal(agentPayload.data.executionMode, "dedicated");
  assert.equal(agentPayload.data.activeRevisionId, undefined);

  const saved = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/configurations/${configurationPayload.data.id}`,
  );
  assert.deepEqual(saved.data.values, staged);
  assert.deepEqual(
    writes.map((write) => [write.method, write.path]),
    [
      ["POST", `/namespaces/${namespace.id}/configurations`],
      ["POST", `/namespaces/${namespace.id}/agents`],
    ],
  );
});

test("Agent creation enforces channel mode limits and reuses a saved channel Configuration", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Create channel retry", { ready: true });
  await fixture.createAgent(namespace.id, "Duplicate channel Agent");
  const page = await authenticatedCreatePage(t, fixture, namespace.id);
  const writes = collectWrites(page, fixture.origin);

  await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
  await page.getByLabel("Slack channel IDs").fill("CRETRY123");
  await page.getByRole("button", { name: "Apply channel settings", exact: true }).click();
  await page.getByRole("button", { name: "Edit Slack", exact: true }).waitFor();
  const staged = await configurationValues(page);

  await page.getByLabel("Execution mode").selectOption("embedded");
  await page.getByLabel("Agent name").fill("Embedded channel Agent");
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /Channels require Dedicated execution/ })
    .waitFor();
  assert.deepEqual(writes, []);

  await page.getByLabel("Execution mode").selectOption("dedicated");
  await page.getByLabel("Agent name").fill("Duplicate channel Agent");
  const configurationResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/configurations` &&
      response.request().method() === "POST",
  );
  const deniedAgentResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const configurationPayload = await (await configurationResponse).json();
  assert.equal((await deniedAgentResponse).status(), 409);
  await page.getByText(`Configuration saved: ${configurationPayload.data.id}.`).waitFor();
  await page.getByText(/conflicts with the saved state/i).waitFor();
  assert.deepEqual(configurationPayload.data.values, staged);
  assert.equal(await page.getByLabel("Configuration JSON").evaluate((node) => node.readOnly), true);
  assert.equal(await page.getByRole("button", { name: "Edit Slack", exact: true }).count(), 0);

  await page.getByLabel("Agent name").fill("Retried channel Agent");
  const retryResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const retried = await (await retryResponse).json();
  assert.equal(retried.data.name, "Retried channel Agent");
  assert.equal(retried.data.configurationId, configurationPayload.data.id);
  assert.deepEqual(
    writes.map((write) => [write.method, write.path]),
    [
      ["POST", `/namespaces/${namespace.id}/configurations`],
      ["POST", `/namespaces/${namespace.id}/agents`],
      ["POST", `/namespaces/${namespace.id}/agents`],
    ],
  );
});
