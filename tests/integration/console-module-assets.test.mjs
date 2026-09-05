import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createConsoleAppFixture } from "../helpers/console-app.mjs";

const modules = [
  "api-client",
  "view-lifetime",
  "navigation",
  "shell",
  "agents/list",
  "agents/create",
  "agents/detail",
  "channels/slack",
  "channels/teams",
  "channels/shared-ui",
];

const csp = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

test("console serves every capability module through exact public asset routes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  // The shell and modules are public; application data still requires a real session.
  for (const name of modules) {
    const path = `/console/${name}.mjs`;
    const result = await fixture.rawRequest("GET", path);
    assert.equal(result.response.status, 200, path);
    assert.equal(
      result.response.headers.get("content-type"),
      "text/javascript; charset=utf-8",
      path,
    );
    assert.equal(result.response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(result.response.headers.get("cache-control"), "no-store", path);
    assert.equal(result.response.headers.get("content-security-policy"), csp, path);
    assert.equal(
      result.text,
      await readFile(
        new URL(`../../apps/controller/src/console/${name}.mjs`, import.meta.url),
        "utf8",
      ),
      path,
    );
  }
  const protectedRead = await fixture.rawRequest("GET", "/namespaces");
  assert.equal(protectedRead.response.status, 401);
  assert.equal(JSON.parse(protectedRead.text).data, undefined);
});

test("console module directories do not expose unregistered files or aliases", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  const shell = await readFile(
    new URL("../../apps/controller/src/console/index.html", import.meta.url),
    "utf8",
  );
  for (const path of [
    "/console/agents/",
    "/console/channels/",
    "/console/channels/missing.mjs",
    "/console/agents/detail.mjs.map",
    "/console/agents/list.mjs/extra",
    "/console/agents/%6cist.mjs",
    "/console/channels%2fslack.mjs",
    "/console/console-assets.ts",
    "/console/package.json",
    "/console/.env",
  ]) {
    const result = await fixture.rawRequest("GET", path);
    assert.equal(result.response.status, 404, path);
    assert.equal(result.response.headers.get("content-type"), "text/html; charset=utf-8", path);
    assert.equal(result.response.headers.get("content-security-policy"), csp, path);
    assert.equal(result.text, shell, path);
  }
});
