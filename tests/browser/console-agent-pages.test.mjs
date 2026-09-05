import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

async function authenticatedPage(t, fixture, namespaceId) {
  const executablePath = process.env.OCC_TEST_BROWSER_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`${fixture.origin}/console/agents?namespace=${namespaceId}`);
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search Agents" }).waitFor();
  return page;
}

async function fixtureWithAgent(t) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Agent page checks", { ready: true });
  const values = createHarnessConfiguration("codex", "gpt-5.1");
  const agent = await fixture.createAgent(namespace.id, "Editable Agent", values, {
    executionMode: "dedicated",
  });
  const page = await authenticatedPage(t, fixture, namespace.id);
  return { fixture, namespace, agent, values, page };
}

test("Agent list search, creation, and draft detail retain the selected Namespace", async (t) => {
  const { fixture, namespace, agent, page } = await fixtureWithAgent(t);
  const otherNamespace = await fixture.createNamespace("Other Agent pages", { ready: true });
  await fixture.createAgent(otherNamespace.id, "Outside selected Namespace");
  const search = page.getByRole("searchbox", { name: "Search Agents" });
  await search.fill(agent.id);
  await page.getByRole("link", { name: agent.name, exact: true }).waitFor();
  assert.equal(
    await page.getByRole("table", { name: "Agents", exact: true }).locator("tbody tr").count(),
    1,
  );
  await search.fill("no-agent-with-this-name");
  await page.getByRole("heading", { name: "No matching Agents", exact: true }).waitFor();
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  await page.getByRole("heading", { name: "Create Agent", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("namespace"), namespace.id);
  await page.getByLabel("Agent name").fill("Agent from list");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}/namespaces/${namespace.id}/agents` &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create Agent", exact: true }).click();
  const response = await createdResponse;
  assert.equal(response.status(), 201);
  const { data: created } = await response.json();
  await page.getByRole("heading", { name: "Agent from list", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Saved draft", exact: true }).waitFor();
  const detail = new URL(page.url());
  assert.equal(detail.pathname, `/console/agents/${created.id}`);
  assert.equal(detail.searchParams.get("namespace"), namespace.id);
  assert.equal(detail.searchParams.get("revision"), "draft");
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${created.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.data, []);
  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  await page.getByRole("link", { name: "Agent from list", exact: true }).waitFor();
  assert.deepEqual(
    await page
      .getByRole("table", { name: "Agents", exact: true })
      .locator("tbody tr td:first-child a")
      .allTextContents(),
    ["Agent from list", "Editable Agent"],
  );
});

test("Agent draft rejects a channel save after another real Configuration update", async (t) => {
  const { fixture, namespace, agent, values, page } = await fixtureWithAgent(t);
  await page.getByRole("link", { name: agent.name, exact: true }).click();
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
  await page.getByLabel("Slack channel IDs").fill("CSTALE123");

  // Another authenticated writer advances the saved generation while this editor is open.
  const updatedValues = { ...values, channels: { slack: { enabled: false, mode: "socket" } } };
  const updated = await fixture.updateConfiguration(
    namespace.id,
    agent.configurationId,
    updatedValues,
  );
  assert.equal(updated.generation, 2);
  const path = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const writes = [];
  page.on("request", (request) => {
    if (request.url() === `${fixture.origin}${path}` && request.method() === "PATCH")
      writes.push(request);
  });
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await page
    .getByText(
      "The saved Configuration changed while you were editing. Close this editor and refresh before saving.",
      { exact: true },
    )
    .waitFor();
  assert.equal(writes.length, 0);
  const current = await fixture.request("GET", path);
  assert.equal(current.status, 200);
  assert.equal(current.data.generation, 2);
  assert.deepEqual(current.data.values, updatedValues);
});

test("leaving Agent channels during save preflight suppresses a stale write and navigation", async (t) => {
  const { fixture, namespace, agent, values, page } = await fixtureWithAgent(t);
  await page.getByRole("link", { name: agent.name, exact: true }).click();
  await page.getByRole("heading", { name: "Editable Configuration", exact: true }).waitFor();
  await page.getByRole("button", { name: "Channels", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
  await page.getByLabel("Slack channel IDs").fill("CLATE123");

  const captured = Promise.withResolvers();
  const release = Promise.withResolvers();
  const completed = Promise.withResolvers();
  t.after(() => release.resolve());
  const path = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const writes = [];
  page.on("request", (request) => {
    if (request.url() === `${fixture.origin}${path}` && request.method() === "PATCH")
      writes.push(request);
  });
  let first = true;
  await page.route(`**${path}`, async (route) => {
    if (!first || route.request().method() !== "GET") return route.continue();
    first = false;
    const response = await route.fetch();
    captured.resolve(response.status());
    await release.promise;
    try {
      await route.fulfill({ response });
    } catch {
      // Navigation can cancel the original successful read before its response is released.
    } finally {
      completed.resolve();
    }
  });
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal(await captured.promise, 200);
  // Browser history creates a new view while the old save still awaits its real preflight read.
  await page.goBack();
  await page.getByRole("heading", { name: "Editable Configuration", exact: true }).waitFor();
  const destination = page.url();
  release.resolve();
  await completed.promise;
  await page.unrouteAll({ behavior: "wait" });
  await page.waitForLoadState("networkidle");
  assert.equal(page.url(), destination);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(writes.length, 0);
  const current = await fixture.request("GET", path);
  assert.equal(current.status, 200);
  assert.equal(current.data.generation, 1);
  assert.deepEqual(current.data.values, values);
});
