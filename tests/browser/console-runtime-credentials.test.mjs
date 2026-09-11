import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { createConsoleBrowserFixture } from "../helpers/console-browser.mjs";

const browserFixture = createConsoleBrowserFixture();

async function artifactDirectory(t) {
  const configured = process.env.OCC_TEST_CONSOLE_ARTIFACT_DIR;
  const directory =
    configured === undefined || configured.length === 0
      ? await mkdtemp(join(tmpdir(), "openclaw-console-runtime-credentials-browser-"))
      : configured;
  t.diagnostic(`console runtime credential browser artifacts: ${directory}`);
  return directory;
}

async function newPage(t, fixture) {
  const artifacts = await artifactDirectory(t);
  const context = await browserFixture.newContext(t);
  fixture.registerCleanupBeforeAppClose(() => context.close());
  return { page: await context.newPage(), artifacts };
}

async function login(page, fixture, path) {
  await page.goto(`${fixture.origin}${path}`);
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL(/\/console\/(agents|providers|namespaces|settings)/);
}

function detailUrl(fixture, namespaceId, agentId, tab = "credentials") {
  const url = new URL(`/console/agents/${agentId}`, fixture.origin);
  url.searchParams.set("namespace", namespaceId);
  url.searchParams.set("revision", "draft");
  url.searchParams.set("tab", tab);
  return `${url.pathname}${url.search}`;
}

function credentialEnvelope(data) {
  return {
    data,
    meta: { requestId: `req_${randomUUID()}` },
  };
}

// Stub only the credential HTTP boundary to test browser handling of metadata,
// submissions, and unknown outcomes. These cases do not prove credential storage,
// V2 admission, or runtime readiness.
async function routeRuntimeCredentials(page, fixture, namespaceId, agentId, handler) {
  const path = `/namespaces/${namespaceId}/agents/${agentId}/runtime-credentials`;
  await page.route(`${fixture.origin}${path}`, async (route, request) => {
    await handler(route, request);
  });
}

async function expectNoText(page, pattern) {
  await assert.rejects(
    page.getByText(pattern).waitFor({ state: "visible", timeout: 300 }),
    /Timeout/,
  );
}

function nativeValues(marker, { slack = false } = {}) {
  const values = createHarnessConfiguration("codex", "gpt-5.1");
  return {
    ...values,
    plugins: {
      ...values.plugins,
      entries: {
        ...values.plugins.entries,
        knowledge: { enabled: true, config: { marker } },
      },
    },
    ...(slack
      ? {
          channels: {
            slack: {
              enabled: true,
              mode: "socket",
              appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
              botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
              dmPolicy: "allowlist",
              groupPolicy: "allowlist",
              allowFrom: ["U123"],
              channels: { C123: { requireMention: true } },
            },
          },
        }
      : {}),
  };
}

function nativeValuesWithImplicitSlack(marker) {
  const values = nativeValues(marker, { slack: true });
  const { enabled, ...slack } = values.channels.slack;
  return { ...values, channels: { slack } };
}

function nativeValuesWithImplicitTeams(marker) {
  return {
    ...nativeValues(marker),
    channels: {
      msteams: {
        appId: "00000000-0000-4000-8000-000000000000",
        tenantId: "11111111-1111-4111-8111-111111111111",
        appPassword: { source: "env", provider: "default", id: "MSTEAMS_APP_PASSWORD" },
        requireMention: true,
      },
    },
  };
}

test("credential metadata does not authorize deployment without saved V2 prerequisites", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Runtime credential gate", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Credential-gated Agent",
    nativeValues("gate"),
    { executionMode: "dedicated" },
  );
  const secretValue = "sk-console-runtime-secret";
  const requests = [];
  let status = {
    transportConfigured: false,
    modelConfigured: false,
    slackConfigured: false,
  };
  const { page, artifacts } = await newPage(t, fixture);
  const deploymentRequests = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/deploy"))
      deploymentRequests.push(request);
  });
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route, request) => {
    if (request.method() === "POST") {
      requests.push(request.postDataJSON());
      status = {
        transportConfigured: true,
        modelConfigured: request.postDataJSON().modelApiKey === secretValue,
        slackConfigured: false,
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentialEnvelope(status)),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await expectNoText(page, /Slack app token|Slack bot token/);
  await page.getByText(/Missing runtime credential metadata: Transport, Model/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy saved draft" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save credentials" }).isDisabled(), true);
  await page.getByLabel("OpenAI API key").fill(secretValue);
  assert.equal(await page.getByRole("button", { name: "Save credentials" }).isDisabled(), false);
  await expectNoText(page, secretValue);
  await page.getByRole("button", { name: "Save credentials" }).click();
  await page.getByText("Credential metadata refreshed.").waitFor();
  assert.deepEqual(requests, [{ modelApiKey: secretValue }]);
  assert.equal(await page.getByLabel("OpenAI API key").inputValue(), "");
  await expectNoText(page, secretValue);
  await page
    .getByText(
      "Stored runtime credential metadata is present. This does not confirm live model or Slack readiness.",
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy saved draft" }).isDisabled(), true);

  // Credential metadata cannot supply the applicable ServiceAccount or admitted
  // workload profile. This draft has neither, so no deploy command is submitted.
  const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.serviceAccountId, undefined);
  assert.equal(saved.data.workloadProfileSelection, undefined);
  const revisions = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/${agent.id}/revisions`,
  );
  assert.equal(revisions.status, 200);
  assert.deepEqual(revisions.data, []);
  assert.deepEqual(deploymentRequests, []);
  await page.screenshot({ path: join(artifacts, "runtime-credentials.png"), fullPage: true });
});

test("transport-only credential recovery can save an empty body", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Transport credential recovery", {
    ready: true,
  });
  const agent = await fixture.createAgent(
    namespace.id,
    "Transport Credential Agent",
    nativeValues("transport"),
    { executionMode: "dedicated" },
  );
  const requests = [];
  let status = {
    transportConfigured: false,
    modelConfigured: true,
    slackConfigured: false,
  };
  const { page } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route, request) => {
    if (request.method() === "POST") {
      requests.push(request.postDataJSON());
      status = {
        transportConfigured: true,
        modelConfigured: true,
        slackConfigured: false,
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentialEnvelope(status)),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await page.getByText(/Missing runtime credential metadata: Transport/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Save credentials" }).isDisabled(), false);
  await page.getByRole("button", { name: "Save credentials" }).click();
  await page.getByText("Credential metadata refreshed.").waitFor();
  assert.deepEqual(requests, [{}]);
  assert.equal(await page.getByRole("button", { name: "Deploy saved draft" }).isDisabled(), true);
});

test("Slack credential gate treats omitted enabled as enabled", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Implicit Slack credential gate", {
    ready: true,
  });
  const agent = await fixture.createAgent(
    namespace.id,
    "Implicit Slack Credential Agent",
    nativeValuesWithImplicitSlack("implicit-slack"),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        credentialEnvelope({
          transportConfigured: true,
          modelConfigured: true,
          slackConfigured: false,
        }),
      ),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await page.getByLabel("Slack app token").waitFor();
  await page.getByLabel("Slack bot token").waitFor();
  await page.getByText(/Missing runtime credential metadata: Slack/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy saved draft" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save credentials" }).isDisabled(), true);
});

test("Teams-enabled drafts keep console deploy blocked", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Teams credential gate", {
    ready: true,
  });
  const agent = await fixture.createAgent(
    namespace.id,
    "Teams Credential Agent",
    nativeValuesWithImplicitTeams("implicit-teams"),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        credentialEnvelope({
          transportConfigured: true,
          modelConfigured: true,
          slackConfigured: false,
        }),
      ),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await page
    .getByText(
      "Microsoft Teams credentials and readiness are operator-managed and cannot be confirmed by this Credentials tab. Use the selected workload profile's operator setup for Teams.",
    )
    .waitFor();
  assert.equal(await page.getByRole("button", { name: "Deploy saved draft" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Save credentials" }).isDisabled(), true);
});

test("Slack credential fields appear only when Slack is enabled and unknown save failures require refresh", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Slack credential gate", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Slack Credential Agent",
    nativeValues("slack", { slack: true }),
    { executionMode: "dedicated" },
  );
  const requests = [];
  let postCount = 0;
  let status = {
    transportConfigured: true,
    modelConfigured: true,
    slackConfigured: false,
  };
  const hostileBackendMessage = "sk-hostile-backend-error-sentinel";
  const { page } = await newPage(t, fixture);
  await routeRuntimeCredentials(page, fixture, namespace.id, agent.id, async (route, request) => {
    if (request.method() === "POST") {
      postCount += 1;
      requests.push(request.postDataJSON());
      if (postCount === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "DEPENDENCY_UNAVAILABLE", message: hostileBackendMessage },
            meta: { requestId: `req_${randomUUID()}` },
          }),
        });
        return;
      }
      status = {
        transportConfigured: true,
        modelConfigured: true,
        slackConfigured: true,
      };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(credentialEnvelope(status)),
    });
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials" }).waitFor();
  await page.getByText(/Missing runtime credential metadata: Slack/).waitFor();
  await page.getByLabel("Slack app token").fill("xapp-console-secret");
  await page.getByLabel("Slack bot token").fill("xoxb-console-secret");
  await page.getByRole("button", { name: "Save credentials" }).click();
  await page.getByText(/Outcome unknown/).waitFor();
  await expectNoText(page, hostileBackendMessage);
  assert.equal(await page.locator(".runtime-credentials .credential-status.missing").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Save credentials" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Deploy saved draft" }).isDisabled(), true);
  await expectNoText(page, /xapp-console-secret|xoxb-console-secret/);

  await page.getByRole("button", { name: "Refresh status" }).click();
  await page.getByText(/Missing runtime credential metadata: Slack/).waitFor();
  await page.getByLabel("Slack app token").fill("xapp-console-secret-2");
  await page.getByLabel("Slack bot token").fill("xoxb-console-secret-2");
  await page.getByRole("button", { name: "Save credentials" }).click();
  await page.getByText("Credential metadata refreshed.").waitFor();
  assert.deepEqual(requests, [
    { slack: { appToken: "xapp-console-secret", botToken: "xoxb-console-secret" } },
    { slack: { appToken: "xapp-console-secret-2", botToken: "xoxb-console-secret-2" } },
  ]);
  assert.equal(await page.getByRole("button", { name: "Deploy saved draft" }).isDisabled(), true);
});

test("a real ServiceAccount association keeps initial runtime credential controls unavailable", async (t) => {
  // With no external Provider selected, the real native account API creates the
  // Namespace-owned association without provisioning credentials or admission.
  const fixture = await createConsoleAppFixture(t, { providers: [] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Operator credential source", { ready: true });
  const account = await fixture.request("POST", `/namespaces/${namespace.id}/service-accounts`, {
    body: { name: "Operator-managed account" },
  });
  assert.equal(account.status, 201);
  const agent = await fixture.createAgent(
    namespace.id,
    "ServiceAccount credential Agent",
    nativeValues("service-account"),
    { executionMode: "dedicated", serviceAccountId: account.data.id },
  );
  assert.equal(agent.serviceAccountId, account.data.id);
  assert.equal(agent.workloadProfileSelection, undefined);
  const { page } = await newPage(t, fixture);
  const credentialRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === fixture.origin && url.pathname.endsWith("/runtime-credentials"))
      credentialRequests.push(request);
  });

  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id));
  await page.getByRole("heading", { name: "Runtime credentials", exact: true }).waitFor();
  await page
    .getByText(/This initial-credential form cannot provision or qualify those credentials/)
    .waitFor();
  assert.equal(await page.getByLabel("OpenAI API key").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Save credentials" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Deploy saved draft" }).isDisabled(), true);
  assert.deepEqual(credentialRequests, []);
  const saved = await fixture.request("GET", `/namespaces/${namespace.id}/agents/${agent.id}`);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.serviceAccountId, account.data.id);
  assert.equal(saved.data.workloadProfileSelection, undefined);
});
