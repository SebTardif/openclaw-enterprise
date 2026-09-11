import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { createConsoleBrowserFixture } from "../helpers/console-browser.mjs";

// These are browser protocol tests for the real deployment panel, IndexedDB,
// and HTTP transport. The small server supplies illustrative wire documents;
// it is not the OCE controller and does not admit profiles or qualify runtimes.
// Authenticated controller/admission integration requires its separate fixtures.
const browser = createConsoleBrowserFixture();
const accountId = "protocol-account";
const namespaceId = `ns_${randomUUID()}`;
const agentId = `agt_${randomUUID()}`;
const configurationId = `cfg_${randomUUID()}`;
const path = `/namespaces/${namespaceId}/agents/${agentId}`;

function documents() {
  return {
    agent: {
      id: agentId,
      namespaceId,
      configurationId,
      providerId: null,
      executionMode: "dedicated",
      maximumExecutionMs: null,
      serviceAccountId: `sa_${randomUUID()}`,
      workloadProfileSelection: {
        manifestRef: randomUUID(),
        manifestDigest: `sha256:${"a".repeat(64)}`,
        admissionRef: randomUUID(),
        admissionVersion: 1,
      },
    },
    configuration: { id: configurationId, namespaceId, generation: 1 },
  };
}

function accepted(command, historical = false) {
  const operation = {
    operationRef: command.operationRef,
    kind: "deploy",
    revisionSource: "saved-draft",
    lifecycleGeneration: (command.expectedLifecycleGeneration ?? 0) + 1,
    desiredMode: "running",
    acceptedAt: "2026-09-11T10:00:00.000Z",
    ...(historical ? { requestedRevisionId: `rev_${randomUUID()}` } : {}),
  };
  return historical ? { operation, observation: {} } : { disposition: "accepted", operation };
}

async function fixture(
  t,
  { missingSelection = false, receiptMismatch = false, historyMismatch = false } = {},
) {
  let sessionAccountId = accountId;
  const data = documents();
  if (missingSelection) {
    delete data.agent.serviceAccountId;
    delete data.agent.workloadProfileSelection;
  }
  const requests = [];
  const commands = new Map();
  const assets = new Map([
    [
      "/agents/deploy.mjs",
      new URL("../../apps/controller/src/console/agents/deploy.mjs", import.meta.url),
    ],
    ["/dom.mjs", new URL("../../apps/controller/src/console/dom.mjs", import.meta.url)],
  ]);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (assets.has(url.pathname)) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(await readFile(assets.get(url.pathname)));
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><title>Deployment protocol client</title><main></main>
          <script type="module">
            import { createDeploymentPanel } from "/agents/deploy.mjs";
            const controller = new AbortController();
            let current = true;
            const panel = createDeploymentPanel({
              context: { accountId: ${JSON.stringify(accountId)}, namespaceId: ${JSON.stringify(namespaceId)},
                signal: controller.signal, isCurrent: () => current, onExpired: () => { current = false; controller.abort(); document.querySelector("main").textContent = "Expired account"; } },
              path: ${JSON.stringify(path)}, ...${JSON.stringify(data)}
            });
            document.querySelector("main").append(panel.section);
            window.panelReady = panel.ready;
            window.panelText = () => panel.section.textContent;
            window.abortPanel = () => { current = false; controller.abort(); document.querySelector("main").textContent = "Inactive view"; };
          </script>`);
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({ method: request.method, path: url.pathname, body });
      let result;
      let status = 200;
      if (request.method === "GET" && url.pathname === "/api/auth/session")
        result = { user: { id: sessionAccountId } };
      else if (request.method === "GET" && url.pathname === path) result = data.agent;
      else if (
        request.method === "GET" &&
        url.pathname === `/namespaces/${namespaceId}/configurations/${configurationId}`
      )
        result = data.configuration;
      else if (request.method === "GET" && url.pathname === `${path}/lifecycle`)
        result = { namespaceId, agentId, head: null };
      else if (request.method === "POST" && url.pathname === `${path}/deploy`) {
        const command = JSON.parse(body);
        commands.set(command.operationRef, command);
        result = accepted(command);
        if (receiptMismatch) result.operation.operationRef = randomUUID();
        status = 202;
      } else if (
        request.method === "GET" &&
        url.pathname.startsWith(`${path}/lifecycle/operations/`)
      ) {
        const command = commands.get(url.pathname.split("/").at(-1));
        if (command) {
          result = accepted(command, true);
          if (historyMismatch) result.operation.acceptedAt = "2026-09-11T11:00:00.000Z";
        } else status = 404;
      } else status = 404;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: result ?? null, meta: { requestId: `req_${randomUUID()}` } }),
      );
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    commands,
    setAccountId: (value) => {
      sessionAccountId = value;
    },
  };
}

async function context(t, persist = true) {
  const result = await browser.newContext(t);
  // Only the browser storage-permission boundary is controlled. Reservation and
  // serialization use Chromium's actual IndexedDB transactions in every case.
  // This permission stub does not prove durable storage against browser eviction.
  await result.addInitScript((allowed) => {
    Object.defineProperty(navigator.storage, "persisted", { value: async () => allowed });
    Object.defineProperty(navigator.storage, "persist", { value: async () => allowed });
  }, persist);
  return result;
}

async function open(context, origin) {
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(origin);
  await page.evaluate(() => window.panelReady);
  return page;
}

async function retained(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("oce-lifecycle-deploy-v2", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["active", "history"], "readonly");
        const active = transaction.objectStore("active").getAll();
        const history = transaction.objectStore("history").getAll();
        transaction.oncomplete = () => resolve({ active: active.result, history: history.result });
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
}

const posts = (fixture) => fixture.requests.filter((request) => request.method === "POST");

test(
  "deployment client keeps missing saved selections disabled without POST",
  { timeout: 30_000 },
  async (t) => {
    const server = await fixture(t, { missingSelection: true });
    const page = await open(await context(t), server.origin);
    await page
      .getByText(/Save an applicable ServiceAccount and workload profile selection/)
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Deploy saved draft", exact: true }).isDisabled(),
      true,
    );
    assert.deepEqual(posts(server), []);
    assert.deepEqual(await retained(page), { active: [], history: [] });
  },
);

test(
  "deployment client fails closed when persistent storage permission is denied",
  { timeout: 30_000 },
  async (t) => {
    const server = await fixture(t);
    const page = await open(await context(t, false), server.origin);
    await page.getByRole("button", { name: "Deploy saved draft", exact: true }).click();
    await page.getByText(/Deployment was not submitted/).waitFor();
    assert.deepEqual(server.requests, []);
    assert.deepEqual(await retained(page), { active: [], history: [] });
  },
);

test(
  "deployment client serializes concurrent tabs to one retained command and POST",
  { timeout: 30_000 },
  async (t) => {
    const server = await fixture(t);
    const shared = await context(t);
    const first = await open(shared, server.origin);
    const second = await open(shared, server.origin);
    await Promise.all(
      [first, second].map((page) =>
        page.getByRole("button", { name: "Deploy saved draft", exact: true }).click(),
      ),
    );
    await Promise.all(
      [first, second].map((page) =>
        page.getByText(/Deployment accepted \(HTTP 202\)|Deployment outcome unresolved/).waitFor(),
      ),
    );
    assert.equal(posts(server).length, 1);
    const ledger = await retained(first);
    assert.equal(ledger.active.length, 1);
    assert.deepEqual(
      ledger.history.filter((record) => record.command),
      ledger.active,
    );
    assert.deepEqual(
      ledger.history.filter((record) => !record.command),
      [accepted(ledger.active[0].command).operation],
    );
    assert.equal(ledger.active[0].body, posts(server)[0].body);
  },
);

test(
  "deployment client retains before sending and reload reads the original after an unknown outcome",
  { timeout: 30_000 },
  async (t) => {
    const server = await fixture(t);
    const page = await open(await context(t), server.origin);
    let original;
    await page.route(`**${path}/deploy`, async (route) => {
      original = JSON.parse(route.request().postData());
      const ledger = await retained(page);
      assert.equal(ledger.active.length, 1);
      assert.deepEqual(ledger.active[0].command, original);
      assert.equal(ledger.active[0].body, route.request().postData());
      assert.deepEqual(ledger.history, ledger.active);
      // The server receives the original command, but the browser loses its reply.
      await route.fetch({ timeout: 10_000 });
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "Deploy saved draft", exact: true }).click();
    await page.getByText(/Deployment outcome unresolved/).waitFor();
    await page.unroute(`**${path}/deploy`);
    await page.reload();
    await page.evaluate(() => window.panelReady);
    await page.getByText(/An original command is retained/).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Deploy saved draft", exact: true }).isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "Read original deployment", exact: true }).click();
    await page
      .getByText(
        /Historical read only: current serving, cutover, and termination are not established/,
      )
      .waitFor();
    assert.equal(posts(server).length, 1);
    assert.equal(
      server.requests.filter(
        (request) => request.path === `${path}/lifecycle/operations/${original.operationRef}`,
      ).length,
      1,
    );
    assert.deepEqual((await retained(page)).active[0].command, original);
    // A successful original-operation read may release only the active reservation.
    // Preparing another intent retains history and never submits on its own.
    await page.getByRole("button", { name: "Prepare another deployment", exact: true }).click();
    await page
      .getByText(/A new deployment requires a separate click and fresh saved-input checks/)
      .waitFor();
    assert.equal(posts(server).length, 1);
    const released = await retained(page);
    assert.deepEqual(released.active, []);
    assert.equal(released.history.length, 1);
    assert.deepEqual(released.history[0].command, original);
    assert.equal(
      await page.getByRole("button", { name: "Deploy saved draft", exact: true }).isEnabled(),
      true,
    );
  },
);

test(
  "deployment client validates receipt identity and keeps acceptance separate from serving",
  { timeout: 30_000 },
  async (t) => {
    for (const receiptMismatch of [false, true]) {
      await t.test(
        receiptMismatch ? "mismatched original operation" : "matching original operation",
        async (t) => {
          const server = await fixture(t, { receiptMismatch });
          const page = await open(await context(t), server.origin);
          await page.getByRole("button", { name: "Deploy saved draft", exact: true }).click();
          await page
            .getByText(
              receiptMismatch
                ? /Deployment outcome unresolved/
                : /This is an admission receipt, not a revision or runtime success/,
            )
            .waitFor();
          assert.equal(posts(server).length, 1);
          assert.equal(
            await page
              .getByRole("button", { name: "Deploy saved draft", exact: true })
              .isDisabled(),
            true,
          );
          assert.equal((await retained(page)).active.length, 1);
          if (receiptMismatch)
            assert.equal(await page.getByText(/Deployment accepted \(HTTP 202\)/).count(), 0);
        },
      );
    }
  },
);

test(
  "deployment client cannot revive an aborted view from a delayed receipt",
  { timeout: 30_000 },
  async (t) => {
    const server = await fixture(t);
    const page = await open(await context(t), server.origin);
    const received = Promise.withResolvers();
    const release = Promise.withResolvers();
    const completed = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route(`**${path}/deploy`, async (route) => {
      try {
        const response = await route.fetch({ timeout: 10_000 });
        received.resolve();
        await release.promise;
        await route.fulfill({ response });
      } catch {
        // Aborting the actual fetch can invalidate the held browser route.
      } finally {
        completed.resolve();
      }
    });
    await page.getByRole("button", { name: "Deploy saved draft", exact: true }).click();
    await received.promise;
    const oldText = await page.evaluate(() => {
      window.abortPanel();
      return window.panelText();
    });
    release.resolve();
    await completed.promise;
    assert.equal(await page.locator("main").textContent(), "Inactive view");
    assert.equal(await page.evaluate(() => window.panelText()), oldText);
    assert.equal(posts(server).length, 1);
    assert.equal((await retained(page)).active.length, 1);
  },
);

test(
  "deployment client expires a changed account before submission or original-operation recovery",
  { timeout: 30_000 },
  async (t) => {
    for (const recover of [false, true]) {
      await t.test(
        recover ? "before original-operation recovery" : "before submission",
        async (t) => {
          const server = await fixture(t);
          const page = await open(await context(t), server.origin);
          if (recover) {
            await page.getByRole("button", { name: "Deploy saved draft", exact: true }).click();
            await page.getByText(/Deployment accepted \(HTTP 202\)/).waitFor();
          }
          const before = await retained(page);
          const previousRequests = server.requests.length;
          server.setAccountId("different-protocol-account");
          await page
            .getByRole("button", {
              name: recover ? "Read original deployment" : "Deploy saved draft",
              exact: true,
            })
            .click();
          await page.getByText("Expired account", { exact: true }).waitFor();
          assert.deepEqual(server.requests.slice(previousRequests), [
            { method: "GET", path: "/api/auth/session", body: "" },
          ]);
          assert.equal(posts(server).length, recover ? 1 : 0);
          assert.deepEqual(await retained(page), before);
          assert.equal(
            await page.getByRole("button", { name: "Deploy saved draft", exact: true }).count(),
            0,
          );
        },
      );
    }
  },
);

test(
  "deployment client preserves its command when readback disagrees with the stored receipt",
  { timeout: 30_000 },
  async (t) => {
    const server = await fixture(t, { historyMismatch: true });
    const page = await open(await context(t), server.origin);
    await page.getByRole("button", { name: "Deploy saved draft", exact: true }).click();
    await page.getByText(/Deployment accepted \(HTTP 202\)/).waitFor();
    const before = await retained(page);
    assert.equal(before.history.length, 2);
    await page.getByRole("button", { name: "Prepare another deployment", exact: true }).click();
    await page.getByText(/Original operation unavailable or unresolved/).waitFor();
    assert.equal(posts(server).length, 1);
    assert.deepEqual(await retained(page), before);
    assert.equal(
      await page.getByRole("button", { name: "Deploy saved draft", exact: true }).isDisabled(),
      true,
    );
  },
);
