import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createConsoleBrowserFixture } from "../helpers/console-browser.mjs";

const browserFixture = createConsoleBrowserFixture();

const routeHoldTimeoutMs = 30_000;

async function artifactDirectory(t) {
  const configured = process.env.OCC_TEST_CONSOLE_ARTIFACT_DIR;
  const directory =
    configured === undefined || configured.length === 0
      ? await mkdtemp(join(tmpdir(), "openclaw-console-browser-"))
      : configured;
  t.diagnostic(`console browser artifacts: ${directory}`);
  return directory;
}

async function newPage(t, fixture) {
  const artifacts = await artifactDirectory(t);
  const context = await browserFixture.newContext(t);
  fixture.registerCleanupBeforeAppClose(() => context.close());
  return { page: await context.newPage(), artifacts };
}

async function newMobilePage(t, fixture) {
  const context = await browserFixture.newContext(t, {
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  fixture.registerCleanupBeforeAppClose(() => context.close());
  return { page: await context.newPage() };
}

async function login(page, fixture, path = "/console/") {
  await page.goto(`${fixture.origin}${path}`);
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL(/\/console\/(agents|providers|namespaces|settings)/);
}

async function openShellMenu(page) {
  await page.getByRole("button", { name: /OpenClaw Enterprise/ }).click();
}

async function chooseNamespace(page, name) {
  await openShellMenu(page);
  await page.getByRole("menuitem", { name: new RegExp(`Namespace: .*`, "i") }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

function deferred() {
  let resolve;
  const promise = new Promise((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitForRoutePhase(promise, description, release, signal) {
  let timeout;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    function fail(reason) {
      release();
      const error = new Error(`${description} did not finish within ${routeHoldTimeoutMs}ms`);
      if (reason !== undefined) error.cause = reason;
      reject(error);
    }

    if (signal?.aborted) {
      fail(signal.reason);
      return;
    }

    timeout = setTimeout(() => fail(), routeHoldTimeoutMs);
    onAbort = () => fail(signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timeout);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

async function holdRoute(t, page, pattern, continueRoute) {
  const releaseGate = deferred();
  const captured = deferred();
  const completed = deferred();
  let released = false;
  let releaseWatchdog;

  function release() {
    if (released) return;
    released = true;
    clearTimeout(releaseWatchdog);
    releaseGate.resolve();
  }

  t.signal?.addEventListener("abort", release, { once: true });
  await page.route(pattern, async (route) => {
    let response;
    try {
      response = await route.fetch();
    } catch {
      response = undefined;
    }
    captured.resolve();
    if (!released && releaseWatchdog === undefined) {
      releaseWatchdog = setTimeout(release, routeHoldTimeoutMs);
      releaseWatchdog.unref?.();
    }
    await releaseGate.promise;
    try {
      await continueRoute(route, response);
    } catch {
      /* The page may already have aborted the obsolete read. */
    } finally {
      completed.resolve();
    }
  });

  return {
    release,
    waitForRelease: () =>
      waitForRoutePhase(captured.promise, `route ${pattern} capture`, release, t.signal),
    waitForCompletion: () =>
      waitForRoutePhase(completed.promise, `route ${pattern} completion`, release, t.signal),
  };
}

function apiRequests(page, origin) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) {
      requests.push({ method: request.method(), path: `${url.pathname}${url.search}` });
    }
  });
  return requests;
}

test("console browser flow keeps Namespace URL state across global pages and logout", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha", { ready: true });
  const beta = await fixture.createNamespace("Beta", { ready: true });
  await fixture.createAgent(alpha.id, "Alpha <script>alert(1)</script>");
  await fixture.createAgent(beta.id, "Beta agent");
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  page.on("dialog", (dialog) => assert.fail(`Unexpected browser dialog: ${dialog.message()}`));

  await login(page, fixture, `/console/?namespace=${beta.id}`);
  await page.getByRole("heading", { name: "Agents" }).waitFor();
  await page.getByText("Beta agent").waitFor();
  assert.match(page.url(), new RegExp(`/console/agents\\?namespace=${beta.id}$`));
  assert.equal(await page.locator("img").count(), 0);

  await page.getByRole("link", { name: "Providers" }).click();
  await page.getByRole("heading", { name: "Providers" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/providers\\?namespace=${beta.id}$`));
  await page.getByText("openai-primary").waitFor();
  await expectNoText(page, /apiKeyPath|workspaceId|credentialTtlSeconds/);

  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/settings\\?namespace=${beta.id}$`));
  await page.reload();
  await page.getByText(fixture.credentials.email.toLowerCase()).waitFor();
  await page.goBack();
  await page.getByRole("heading", { name: "Providers" }).waitFor();
  assert.match(page.url(), new RegExp(`/console/providers\\?namespace=${beta.id}$`));

  await page.getByRole("link", { name: "Agents" }).click();
  await chooseNamespace(page, "Alpha");
  await page.getByText("Alpha <script>alert(1)</script>").waitFor();
  assert.match(page.url(), new RegExp(`/console/agents\\?namespace=${alpha.id}$`));

  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Logout" }).click();
  await page.waitForURL(/\/console\/login$/);
  await page.getByRole("button", { name: "Login" }).waitFor();
  await expectNoText(page, /Alpha|Beta|openai-primary/);
  assert.deepEqual(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
    { local: {}, session: {} },
  );

  const writeRequests = requests.filter(
    (request) => request.method !== "GET" && !request.path.startsWith("/api/auth/sign-"),
  );
  assert.deepEqual(writeRequests, []);
  assert.equal(
    requests.some((request) => /\/deploy(?:\?|$)|\/agents\/agt_/.test(request.path)),
    false,
  );
});

test("console ignores stale collection successes and errors while switching Namespaces", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const slow = await fixture.createNamespace("Slow", { ready: true });
  const current = await fixture.createNamespace("Current", { ready: true });
  await fixture.createAgent(slow.id, "Slow agent");
  await fixture.createAgent(current.id, "Current agent");
  const { page } = await newPage(t, fixture);
  const slowAgents = `**/namespaces/${slow.id}/agents`;
  const slowSuccess = await holdRoute(t, page, slowAgents, (route, response) =>
    response ? route.fulfill({ response }) : route.continue(),
  );
  t.after(() => slowSuccess.release());

  await login(page, fixture, `/console/agents?namespace=${slow.id}`);
  await slowSuccess.waitForRelease();
  await chooseNamespace(page, "Current");
  await page.getByText("Current agent").waitFor();
  slowSuccess.release();
  await slowSuccess.waitForCompletion();
  await expectNoText(page, /Slow agent|unavailable|failed/i);

  await page.unroute(slowAgents);
  const slowError = await holdRoute(t, page, slowAgents, (route) => route.abort("failed"));
  t.after(() => slowError.release());
  await chooseNamespace(page, "Slow");
  await slowError.waitForRelease();
  await chooseNamespace(page, "Current");
  await page.getByText("Current agent").waitFor();
  slowError.release();
  await slowError.waitForCompletion();
  await page.waitForTimeout(100);
  await expectNoText(page, /Slow agent|unavailable|failed/i);
});

test("mobile Namespace menu selects another Namespace without signing out", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const alpha = await fixture.createNamespace("Alpha", { ready: true });
  const beta = await fixture.createNamespace("Beta", { ready: true });
  await fixture.createAgent(alpha.id, "Alpha mobile agent");
  await fixture.createAgent(beta.id, "Beta mobile agent");
  const { page } = await newMobilePage(t, fixture);

  await login(page, fixture, `/console/agents?namespace=${alpha.id}`);
  await page.getByText("Alpha mobile agent").waitFor();

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: /OpenClaw Enterprise/ }).click();
  await page.getByRole("menuitem", { name: /Namespace:/ }).click();
  await page.getByRole("menuitemradio", { name: "Beta" }).click();

  await page.getByText("Beta mobile agent").waitFor();
  assert.match(page.url(), new RegExp(`/console/agents\\?namespace=${beta.id}$`));
  await expectNoText(page, /Welcome back|Your session has expired|Could not confirm logout/);
});

test("console clears private content after session expiry, access revocation, and failed logout", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Revoked", { ready: true });
  await fixture.createAgent(namespace.id, "Revoked agent");
  const { page, artifacts } = await newPage(t, fixture);
  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Revoked agent").waitFor();

  await page.route("**/api/auth/sign-out", async (route) => {
    await route.abort("failed");
  });
  await openShellMenu(page);
  await page.getByRole("menuitem", { name: "Logout" }).click();
  await page.getByText("Could not confirm logout").waitFor();
  await expectNoText(page, /Revoked agent/);
  await page.unroute("**/api/auth/sign-out");
  await page.getByRole("button", { name: "Retry" }).click();
  await page.waitForURL(/\/console\/login$/);

  await login(page, fixture, `/console/agents?namespace=${namespace.id}`);
  await page.getByText("Revoked agent").waitFor();
  fixture.policy.restrictions.push({
    id: "deny-console-namespace-read",
    namespaceId: namespace.id,
    resourceKind: "namespace",
    action: "read",
    effect: "deny",
  });
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByText("Namespace unavailable").waitFor();
  await expectNoText(page, /Revoked agent/);
  fixture.policy.restrictions.length = 0;

  await page.reload();
  await page.getByText("Revoked agent").waitFor();
  // Better Auth's memory adapter stores session expiry as Date values.
  for (const session of fixture.memoryDatabase.session) {
    session.expiresAt = new Date(Date.now() - 1000);
  }
  await page.reload();
  await page.getByText("Your session has expired").waitFor();
  await page.getByRole("button", { name: "Login" }).waitFor();
  await expectNoText(page, /Revoked agent/);

  await page.screenshot({ path: join(artifacts, "session-isolation.png"), fullPage: true });
});

async function expectNoText(page, pattern) {
  await assert.rejects(
    page.getByText(pattern).waitFor({ state: "visible", timeout: 300 }),
    /Timeout/,
  );
}

test("shared browser contexts keep separate users, cookies and storage isolated", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const other = await fixture.createAccountWithPolicy("other-console-user", (principal) => {
    fixture.policy.bindings.push({
      id: `binding-${principal.id}`,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: fixture.policy.roles[0].id,
    });
  });
  const { page: first } = await newPage(t, fixture);
  await login(first, fixture, "/console/settings");
  await first.getByText(fixture.credentials.email.toLowerCase()).waitFor();
  await first.evaluate(() => {
    localStorage.setItem("context-isolation", "first-user");
    sessionStorage.setItem("context-isolation", "first-user");
  });

  // Both users access the same real application origin. The shared process must
  // not carry the first user's session or browser storage into a fresh context.
  const { page: second } = await newPage(t, fixture);
  assert.equal(first.context().browser(), second.context().browser());
  assert.notEqual(first.context(), second.context());
  assert.deepEqual(await second.context().storageState(), { cookies: [], origins: [] });
  await second.goto(`${fixture.origin}/console/settings`);
  await second.getByRole("button", { name: "Login" }).waitFor();
  assert.deepEqual(
    await second.evaluate(() => [
      localStorage.getItem("context-isolation"),
      sessionStorage.getItem("context-isolation"),
    ]),
    [null, null],
  );
  await login(
    second,
    { origin: fixture.origin, credentials: other.credentials },
    "/console/settings",
  );
  await second.getByText(other.credentials.email.toLowerCase()).waitFor();
  await first.reload();
  await first.getByText(fixture.credentials.email.toLowerCase()).waitFor();

  // A real sign-out in one context must leave the other user's session valid.
  await openShellMenu(first);
  await first.getByRole("menuitem", { name: "Logout" }).click();
  await first.waitForURL(/\/console\/login$/);
  await second.reload();
  await second.getByText(other.credentials.email.toLowerCase()).waitFor();
});
