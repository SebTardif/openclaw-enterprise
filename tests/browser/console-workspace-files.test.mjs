import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ControllerWorkspaceFileUnknownOutcomeError } from "../../apps/controller/src/gateway/contracts.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createConsoleBrowserFixture } from "../helpers/console-browser.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

const filenames = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"];
const browserFixture = createConsoleBrowserFixture();

async function newPage(t) {
  const context = await browserFixture.newContext(t);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  return page;
}

async function login(page, fixture, path) {
  await page.goto(`${fixture.origin}${path}`);
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill(fixture.credentials.password);
  await page.getByRole("button", { name: "Login", exact: true }).click();
}

function workspacePath(namespaceId, agentId, filename) {
  return `/namespaces/${namespaceId}/agents/${agentId}/workspace/files/${filename}`;
}

function workspaceUrl(namespaceId, agentId) {
  return `/console/agents/${agentId}?namespace=${namespaceId}&revision=draft&tab=workspace`;
}

function apiRequests(page, origin) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === origin) {
      let body;
      try {
        body = request.postDataJSON();
      } catch {}
      requests.push({ method: request.method(), path: url.pathname, body });
    }
  });
  return requests;
}

function pathRequests(requests, method, path) {
  return requests.filter((request) => request.method === method && request.path === path);
}

async function fixtureWithWorkspace(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openclaw-console-workspace-files-"));
  t.diagnostic(`workspace file fixture transport directory: ${directory}`);
  const calls = { reads: [], writes: [] };
  const behavior = {
    readUnavailable: false,
    writeUnavailable: false,
    unknownWriteNames: new Set(),
    ...options.behavior,
  };
  const workspaceFilesAccess = {
    async read(request) {
      calls.reads.push(request);
      if (behavior.readUnavailable) return { status: "unavailable" };
      try {
        return {
          status: "ok",
          file: {
            name: request.filename,
            content: await readFile(join(directory, request.revision.agentId, request.filename), {
              encoding: "utf8",
            }),
          },
        };
      } catch (error) {
        if (error?.code === "ENOENT") return { status: "missing" };
        throw error;
      }
    },
    async write(request) {
      calls.writes.push(request);
      if (behavior.writeUnavailable) return { status: "unavailable" };
      const path = join(directory, request.revision.agentId, request.filename);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, request.content, { encoding: "utf8" });
      if (behavior.unknownWriteNames.delete(request.filename)) {
        throw new ControllerWorkspaceFileUnknownOutcomeError("fixture lost workspace write ack");
      }
      return {
        status: "ok",
        file: { name: request.filename, size: Buffer.byteLength(request.content, "utf8") },
      };
    },
  };
  const fixture = await createConsoleAppFixture(t, {
    workspaceFilesAccess,
    workspaceFileRequestTimeoutMs: 1000,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(options.namespaceName ?? "Workspace files", {
    ready: true,
  });
  const agent = await fixture.createAgent(
    namespace.id,
    options.agentName ?? "Workspace Agent",
    createHarnessConfiguration("codex", "gpt-5.1"),
    { executionMode: "dedicated" },
  );

  async function setFile(filename, content) {
    const path = join(directory, agent.id, filename);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { encoding: "utf8" });
  }

  async function getFile(filename) {
    return readFile(join(directory, agent.id, filename), { encoding: "utf8" });
  }

  async function removeFile(filename) {
    await rm(join(directory, agent.id, filename));
  }

  return { fixture, namespace, agent, behavior, calls, setFile, getFile, removeFile };
}

test("workspace files load all fixed names, save one file, and render a visual proof", async (t) => {
  const setup = await fixtureWithWorkspace(t, { namespaceName: "Workspace load" });
  for (const filename of filenames) {
    await setup.setFile(filename, `initial ${filename}\n`);
  }
  const active = await setup.fixture.seedActiveAgentRevision(setup.namespace.id, setup.agent.id);
  const page = await newPage(t);
  const requests = apiRequests(page, setup.fixture.origin);

  await login(page, setup.fixture, workspaceUrl(setup.namespace.id, setup.agent.id));
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  await page.screenshot({ path: "/tmp/agent-workspace-ui.png", fullPage: true });

  for (const filename of filenames) {
    await page.getByText(`${filename} loaded.`, { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel(filename, { exact: true }).inputValue(),
      `initial ${filename}\n`,
    );
  }

  await page.getByLabel("SOUL.md", { exact: true }).fill("updated soul é\n");
  const saveResponse = page.waitForResponse(
    (response) =>
      response.url() ===
        `${setup.fixture.origin}${workspacePath(setup.namespace.id, setup.agent.id, "SOUL.md")}` &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save SOUL.md", exact: true }).click();
  assert.equal((await saveResponse).status(), 200);
  await page.getByText("SOUL.md saved.", { exact: true }).waitFor();
  assert.equal(await setup.getFile("SOUL.md"), "updated soul é\n");

  await page.getByLabel("SOUL.md", { exact: true }).fill("unsaved local edit\n");
  await page.getByRole("button", { name: "Reload SOUL.md", exact: true }).click();
  await page.getByText("SOUL.md loaded.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("SOUL.md", { exact: true }).inputValue(), "updated soul é\n");
  assert.deepEqual(
    filenames.map(
      (filename) =>
        pathRequests(requests, "GET", workspacePath(setup.namespace.id, setup.agent.id, filename))
          .length,
    ),
    [1, 2, 1, 1],
  );
  assert.equal(
    pathRequests(requests, "PUT", workspacePath(setup.namespace.id, setup.agent.id, "SOUL.md"))
      .length,
    1,
  );
  const revision = await setup.fixture.request(
    "GET",
    `/namespaces/${setup.namespace.id}/agents/${setup.agent.id}/revisions/${active.revision.id}`,
  );
  assert.equal(revision.data.id, active.revision.id);
  assert.equal(revision.data.configurationGeneration, active.revision.configurationGeneration);
});

test("missing workspace files can be created and oversize Unicode is rejected before PUT", async (t) => {
  const setup = await fixtureWithWorkspace(t, { namespaceName: "Workspace create" });
  await setup.setFile("USER.md", "small\n");
  await setup.fixture.seedActiveAgentRevision(setup.namespace.id, setup.agent.id);
  const page = await newPage(t);
  const requests = apiRequests(page, setup.fixture.origin);

  await login(page, setup.fixture, workspaceUrl(setup.namespace.id, setup.agent.id));
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  await page
    .getByRole("alert")
    .filter({ hasText: "File unavailable or missing. Check Agent access before creating it." })
    .first()
    .waitFor();

  await page.getByLabel("AGENTS.md", { exact: true }).fill("created from browser\n");
  await page.getByRole("button", { name: "Save AGENTS.md", exact: true }).click();
  await page.getByText("AGENTS.md saved.", { exact: true }).waitFor();
  assert.equal(await setup.getFile("AGENTS.md"), "created from browser\n");

  const userSavePath = workspacePath(setup.namespace.id, setup.agent.id, "USER.md");
  const beforeOversize = pathRequests(requests, "PUT", userSavePath).length;
  await page.getByLabel("USER.md", { exact: true }).fill("é".repeat(8193));
  await page.getByRole("button", { name: "Save USER.md", exact: true }).click();
  const validation = await page
    .getByLabel("USER.md", { exact: true })
    .evaluate((node) => node.validationMessage);
  assert.equal(
    validation,
    "Use valid Unicode without NUL characters, within 16 KiB of UTF-8 content.",
  );
  assert.equal(pathRequests(requests, "PUT", userSavePath).length, beforeOversize);
});

test("reloading a deleted workspace file clears stale text and allows explicit recreation", async (t) => {
  const setup = await fixtureWithWorkspace(t, { namespaceName: "Workspace deleted" });
  for (const filename of filenames) {
    await setup.setFile(
      filename,
      filename === "IDENTITY.md" ? "loaded identity\n" : `${filename}\n`,
    );
  }
  await setup.fixture.seedActiveAgentRevision(setup.namespace.id, setup.agent.id);
  const page = await newPage(t);
  const requests = apiRequests(page, setup.fixture.origin);
  const identityPath = workspacePath(setup.namespace.id, setup.agent.id, "IDENTITY.md");

  await login(page, setup.fixture, workspaceUrl(setup.namespace.id, setup.agent.id));
  await page.getByText("IDENTITY.md loaded.", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("IDENTITY.md", { exact: true }).inputValue(),
    "loaded identity\n",
  );

  await setup.removeFile("IDENTITY.md");
  await page.getByRole("button", { name: "Reload IDENTITY.md", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "File unavailable or missing. Check Agent access before creating it." })
    .waitFor();
  assert.equal(await page.getByLabel("IDENTITY.md", { exact: true }).inputValue(), "");
  await page.getByLabel("IDENTITY.md", { exact: true }).fill("recreated identity\n");
  await page.getByRole("button", { name: "Save IDENTITY.md", exact: true }).click();
  await page.getByText("IDENTITY.md saved.", { exact: true }).waitFor();
  assert.equal(await setup.getFile("IDENTITY.md"), "recreated identity\n");
  assert.equal(pathRequests(requests, "GET", identityPath).length, 2);
  assert.equal(pathRequests(requests, "PUT", identityPath).length, 1);
});

test("unknown workspace write outcomes lock saving until a successful reload without replay", async (t) => {
  const setup = await fixtureWithWorkspace(t, {
    namespaceName: "Workspace unknown",
    behavior: { unknownWriteNames: new Set(["USER.md"]) },
  });
  await setup.setFile("USER.md", "before\n");
  await setup.fixture.seedActiveAgentRevision(setup.namespace.id, setup.agent.id);
  const page = await newPage(t);
  const requests = apiRequests(page, setup.fixture.origin);
  const userPath = workspacePath(setup.namespace.id, setup.agent.id, "USER.md");

  await login(page, setup.fixture, workspaceUrl(setup.namespace.id, setup.agent.id));
  await page.getByText("USER.md loaded.", { exact: true }).waitFor();
  await page.getByLabel("USER.md", { exact: true }).fill("sent once\n");
  const unknown = page.waitForResponse(
    (response) =>
      response.url() === `${setup.fixture.origin}${userPath}` &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save USER.md", exact: true }).click();
  assert.equal((await unknown).status(), 503);
  await page
    .getByRole("alert")
    .filter({
      hasText:
        "Outcome unknown. Your write may have succeeded. Reload this file and review its current contents before saving again.",
    })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Save USER.md", exact: true }).isDisabled(),
    true,
  );
  assert.equal(pathRequests(requests, "PUT", userPath).length, 1);

  await page.getByRole("button", { name: "Reload USER.md", exact: true }).click();
  await page.getByText("USER.md loaded.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "sent once\n");
  assert.equal(pathRequests(requests, "PUT", userPath).length, 1);
});

test("workspace files handle inactive, unavailable, and denied states", async (t) => {
  const setup = await fixtureWithWorkspace(t, { namespaceName: "Workspace failures" });
  await setup.setFile("SOUL.md", "editable\n");
  const page = await newPage(t);
  const requests = apiRequests(page, setup.fixture.origin);

  await login(page, setup.fixture, workspaceUrl(setup.namespace.id, setup.agent.id));
  await page
    .getByText(
      "Workspace files require a deployed Agent with an active revision and a reachable gateway.",
      {
        exact: true,
      },
    )
    .waitFor();
  assert.equal(setup.calls.reads.length, 0);
  assert.equal(
    requests.some((request) => request.path.includes("/workspace/files/")),
    false,
  );

  await setup.fixture.seedActiveAgentRevision(setup.namespace.id, setup.agent.id);
  setup.behavior.readUnavailable = true;
  await page.goto(`${setup.fixture.origin}${workspaceUrl(setup.namespace.id, setup.agent.id)}`);
  await page.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
  await page
    .getByRole("alert")
    .filter({
      hasText: "Workspace access is unavailable. Check the Agent gateway and try reloading.",
    })
    .first()
    .waitFor();
  assert.equal(await page.getByLabel("SOUL.md", { exact: true }).isDisabled(), true);

  setup.behavior.readUnavailable = false;
  await page.getByRole("button", { name: "Reload SOUL.md", exact: true }).click();
  await page.getByText("SOUL.md loaded.", { exact: true }).waitFor();
  await page.getByLabel("SOUL.md", { exact: true }).fill("denied write\n");
  setup.fixture.policy.restrictions.push({
    id: `deny-workspace-write-${randomUUID()}`,
    namespaceId: setup.namespace.id,
    resourceKind: "agent",
    action: "operate",
    effect: "deny",
  });
  const writesBeforeDenied = setup.calls.writes.length;
  await page.getByRole("button", { name: "Save SOUL.md", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Access denied. You do not have permission for this file operation." })
    .waitFor();
  assert.equal(setup.calls.writes.length, writesBeforeDenied);
  assert.equal(await setup.getFile("SOUL.md"), "editable\n");
});
