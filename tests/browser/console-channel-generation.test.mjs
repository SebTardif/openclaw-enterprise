import assert from "node:assert/strict";
import test from "node:test";
import { createConsoleBrowserFixture } from "../helpers/console-browser.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const browsers = createConsoleBrowserFixture();

test("channel save rejects a concurrent update after browser preflight", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Channel generation check", { ready: true });
  const values = createHarnessConfiguration("codex", "gpt-5.1");
  const agent = await fixture.createAgent(namespace.id, "Channel generation Agent", values, {
    executionMode: "dedicated",
  });
  const context = await browsers.newContext(t);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(
    `${fixture.origin}/console/agents/${agent.id}?namespace=${namespace.id}&revision=draft&tab=channels`,
  );
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
  await page.getByRole("button", { name: "Configure Slack", exact: true }).click();
  await page.getByLabel("Slack channel IDs").fill("CEDIT123");
  const path = `/namespaces/${namespace.id}/configurations/${agent.configurationId}`;
  const concurrent = { ...values, channels: { slack: { enabled: false, mode: "socket" } } };
  let submitted;
  // Advance the real Configuration after the UI preflight, before its PATCH reaches Fastify.
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    submitted = route.request().postDataJSON();
    await fixture.updateConfiguration(namespace.id, agent.configurationId, concurrent);
    await route.continue();
  });
  const saved = page.waitForResponse(
    (response) =>
      response.url() === `${fixture.origin}${path}` && response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await saved).status(), 409);
  assert.equal(submitted.expectedGeneration, 1);
  const current = await fixture.request("GET", path);
  assert.equal(current.data.generation, 2);
  assert.deepEqual(current.data.values, concurrent);
  assert.equal(await page.getByRole("dialog").count(), 1);
});
