import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";

async function browserPage(t, fixture) {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
      : {}),
  });
  fixture.registerCleanupBeforeAppClose(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "console modules must load and execute"));
  return page;
}

async function login(page, fixture, path) {
  await page.goto(fixture.origin + path);
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
}

test("session client expires the current view through an actual protected response", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Session scope", { ready: true });
  await fixture.createAgent(namespace.id, "Private session agent");
  const page = await browserPage(t, fixture);
  const authenticatedReads = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["/namespaces", "/providers"].includes(url.pathname)) authenticatedReads.push(request);
  });
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Private session agent", { exact: true }).waitFor();
  // Expire the stored Better Auth sessions after session discovery, immediately
  // before the real protected collection read reaches the controller.
  let responseStatus;
  await page.route("**/providers", async (route) => {
    for (const session of fixture.memoryDatabase.session)
      session.expiresAt = new Date(Date.now() - 1000);
    const response = await route.fetch();
    responseStatus = response.status();
    assert.equal(response.headers()["cache-control"], "no-store");
    await route.fulfill({ response });
  });
  await page.getByRole("link", { name: "Providers", exact: true }).click();
  await page.getByText("Your session has expired.", { exact: true }).waitFor();
  assert.equal(responseStatus, 401);
  assert.equal(await page.getByText("Private session agent", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("navigation").count(), 0);
  const location = new URL(page.url());
  assert.equal(location.pathname, "/console/login");
  assert.equal(location.searchParams.get("return"), `/console/providers?namespace=${namespace.id}`);
  assert.ok(authenticatedReads.length >= 3);
  for (const request of authenticatedReads) {
    assert.equal(new URL(request.url()).origin, fixture.origin);
    const headers = await request.allHeaders();
    assert.ok(headers.cookie?.length > 0, "same-origin reads carry the actual session cookie");
  }
  assert.deepEqual(await page.evaluate(() => ({ ...localStorage, ...sessionStorage })), {});
});

test("navigation invalidates an obsolete real collection response", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Navigation scope", { ready: true });
  await fixture.createAgent(namespace.id, "Current navigation agent");
  const page = await browserPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Current navigation agent", { exact: true }).waitFor();
  let release;
  let captured;
  let completed;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise((resolve) => {
    captured = resolve;
  });
  const finished = new Promise((resolve) => {
    completed = resolve;
  });
  t.after(() => release());
  await page.route("**/providers", async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    captured();
    await held;
    try {
      await route.fulfill({ response });
    } catch {
      // Navigation may have already aborted the obsolete browser request.
    } finally {
      completed();
    }
  });
  await page.getByRole("link", { name: "Providers", exact: true }).click();
  await reached;
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByText("Current navigation agent", { exact: true }).waitFor();
  release();
  await finished;
  assert.equal(await page.getByText("openai-primary", { exact: true }).count(), 0);
  assert.equal(new URL(page.url()).pathname, "/console/agents");
  assert.equal(new URL(page.url()).searchParams.get("namespace"), namespace.id);
  await page.getByRole("button", { name: /OpenClaw Enterprise/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByText("Current navigation agent", { exact: true }).waitFor();
});

test("login navigation admits exact internal return pages and rejects external or unknown paths", async (t) => {
  for (const [path, expected] of [
    ["/console/providers", "/console/providers"],
    ["https://example.invalid/console/providers", "/console/agents"],
    ["//example.invalid/console/providers", "/console/agents"],
    ["/console/unknown", "/console/agents"],
    ["/console/../api/auth/session", "/console/agents"],
  ]) {
    await t.test(path, async (t) => {
      // Each case uses its own real account and Controller; repeated sign-ins
      // against one account would correctly exhaust the production quota.
      const fixture = await createConsoleAppFixture(t);
      await fixture.bootstrap();
      const namespace = await fixture.createNamespace("Return scope", { ready: true });
      const destination =
        path === "/console/providers" ? `${path}?namespace=${namespace.id}` : path;
      const page = await browserPage(t, fixture);
      await login(page, fixture, `/console/login?return=${encodeURIComponent(destination)}`);
      // The initial shell is rendered before Namespace discovery completes.
      await page.waitForURL(
        (url) => url.pathname === expected && url.searchParams.get("namespace") === namespace.id,
      );
      await page.getByRole("button", { name: /OpenClaw Enterprise/ }).waitFor();
      assert.equal(new URL(page.url()).origin, fixture.origin);
    });
  }
});

test(
  "real logout clears private UI in another tab sharing the session",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Shared tab session", { ready: true });
    await fixture.createAgent(namespace.id, "Shared private agent");
    const first = await browserPage(t, fixture);
    const location = `/console/agents?namespace=${namespace.id}`;
    await login(first, fixture, location);
    await first.getByText("Shared private agent", { exact: true }).waitFor();

    // Both tabs share the real Better Auth cookie. The second tab must clear its
    // existing view when the first signs out, before another protected read.
    const second = await first.context().newPage();
    second.setDefaultTimeout(10_000);
    await second.goto(fixture.origin + location);
    await second.getByText("Shared private agent", { exact: true }).waitFor();
    const signedOut = first.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/sign-out" &&
        response.request().method() === "POST",
    );
    await first.getByRole("button", { name: /OpenClaw Enterprise/ }).click();
    await first.getByRole("menuitem", { name: "Logout" }).click();
    assert.equal((await signedOut).status(), 200);
    await second
      .getByText(
        "Your session changed in another tab. Sign in or refresh to check current access.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await second.getByText("Shared private agent", { exact: true }).count(), 0);
    assert.equal(await second.getByRole("navigation").count(), 0);
    await second.getByRole("button", { name: "Login", exact: true }).waitFor();

    // Refresh uses the actual signed-out session and cannot restore private data.
    await second.reload();
    await second.getByRole("button", { name: "Login", exact: true }).waitFor();
    assert.equal(await second.getByText("Shared private agent", { exact: true }).count(), 0);
  },
);
