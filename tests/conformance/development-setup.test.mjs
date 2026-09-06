import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { checkDevelopmentSetup } from "../../scripts/check-development-setup.mjs";

const rootManifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));
const put = (root, path, value) => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "oce-setup-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, "package.json", {
    name: "setup-fixture",
    engines: rootManifest.engines,
    packageManager: rootManifest.packageManager,
  });
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/consumer\n  - packages/sibling\n");
  put(root, "packages/consumer/package.json", {
    name: "fixture-consumer",
    dependencies: { pino: "1.0.0", "fixture-sibling": "workspace:*" },
  });
  put(root, "packages/sibling/package.json", {
    name: "fixture-sibling",
    version: "1.0.0",
    main: "index.js",
  });
  put(root, "packages/sibling/index.js", "module.exports = 1;\n");
  put(root, "packages/consumer/node_modules/pino/package.json", {
    name: "pino",
    version: "1.0.0",
    main: "index.js",
  });
  put(root, "packages/consumer/node_modules/pino/index.js", "module.exports = 1;\n");
  symlinkSync(
    join(root, "packages/sibling"),
    join(root, "packages/consumer/node_modules/fixture-sibling"),
  );
  const lock =
    "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/consumer:\n    dependencies:\n      pino:\n        specifier: 1.0.0\n        version: 1.0.0\n      fixture-sibling:\n        specifier: workspace:*\n        version: link:../sibling\n\n  packages/sibling: {}\n\npackages: {}\n";
  put(root, "pnpm-lock.yaml", lock);
  put(root, "node_modules/.pnpm/lock.yaml", lock);
  const packages = [
    { name: "openclaw", version: "1.0.0", destination: "openclaw" },
    { name: "@openclaw/ai", version: "1.0.0", destination: "openclaw/node_modules/@openclaw/ai" },
    { name: "@types/ws", version: "1.0.0", destination: "node_modules/@types/ws" },
  ];
  for (const entry of packages)
    put(root, `.build/upstream-sdk/${entry.destination}/package.json`, {
      name: entry.name,
      version: entry.version,
      ...(entry.name === "openclaw"
        ? { exports: { "./plugin-sdk/channel-inbound": { types: "./channel.d.ts" } } }
        : {}),
    });
  put(root, ".build/upstream-sdk/openclaw/channel.d.ts", "export {};\n");
  // This is a metadata fixture for the doctor, not an upstream SDK or a claim
  // that its synthetic package contents establish runtime compatibility.
  put(root, ".build/upstream-sdk/preparation.json", {
    schema: "oce.upstream-sdk-preparation/v1",
    status: "prepared",
    manifestSha256: "a".repeat(64),
    packages,
    links: [],
  });
  return root;
}
const check = (report, id) => report.checks.find((entry) => entry.id === id);

test("prepared metadata resolves from a source export without changing its files", (t) => {
  const root = fixture(t);
  const before = readFileSync(join(root, "pnpm-lock.yaml"));
  const report = checkDevelopmentSetup(root);
  assert.equal(report.checkout, "source-export");
  assert.equal(check(report, "packages/consumer:pino").status, "ok");
  assert.equal(check(report, "packages/consumer:fixture-sibling").status, "ok");
  assert.equal(check(report, "lock-importers").status, "ok");
  assert.equal(check(report, "upstream-sdk").status, "ok");
  assert.deepEqual(readFileSync(join(root, "pnpm-lock.yaml")), before);
  if (check(report, "pnpm").status !== "ok") {
    t.skip("Pinned pnpm is unavailable; prepared-state assertion requires that tool.");
    return;
  }
  assert.equal(
    report.status,
    "prepared",
    JSON.stringify(report.checks.filter((entry) => entry.status !== "ok")),
  );
});

test("missing direct pino is actionable even when an ancestor offers a package", (t) => {
  const root = fixture(t);
  rmSync(join(root, "packages/consumer/node_modules/pino"), { recursive: true });
  put(root, "node_modules/pino/package.json", { name: "pino", version: "1.0.0", main: "index.js" });
  put(root, "node_modules/pino/index.js", "module.exports = 1;\n");
  const report = checkDevelopmentSetup(root);
  assert.equal(report.status, "unprepared");
  assert.equal(check(report, "packages/consumer:pino").status, "missing");
  assert.match(check(report, "packages/consumer:pino").action, /setup owner/);
  assert.equal(check(report, "lock-importers").status, "ok");
});

test("stale manifest, installed package and installed lock are reported separately", (t) => {
  const root = fixture(t);
  const manifest = JSON.parse(readFileSync(join(root, "packages/consumer/package.json")));
  manifest.dependencies.pino = "2.0.0";
  put(root, "packages/consumer/package.json", manifest);
  put(root, "packages/consumer/node_modules/pino/package.json", { name: "pino", version: "3.0.0" });
  put(root, "node_modules/.pnpm/lock.yaml", "outdated\n");
  const report = checkDevelopmentSetup(root);
  for (const id of [
    "packages/consumer:pino:lock",
    "packages/consumer:pino",
    "lock-importers",
    "installed-lockfile",
  ])
    assert.equal(check(report, id).status, "stale");
});

test("workspace dependency linked to another checkout is rejected", (t) => {
  const root = fixture(t);
  const other = fixture(t);
  const alias = join(root, "packages/consumer/node_modules/fixture-sibling");
  rmSync(alias);
  symlinkSync(join(other, "packages/sibling"), alias);
  assert.equal(
    check(checkDevelopmentSetup(root), "packages/consumer:fixture-sibling").status,
    "stale",
  );
});

test("missing SDK declarations and changed SDK identity fail explicitly", (t) => {
  const root = fixture(t);
  rmSync(join(root, ".build/upstream-sdk/openclaw/channel.d.ts"));
  assert.equal(check(checkDevelopmentSetup(root), "upstream-sdk").status, "incomplete");
  put(root, ".build/upstream-sdk/openclaw/package.json", { name: "openclaw", version: "2.0.0" });
  assert.equal(check(checkDevelopmentSetup(root), "upstream-sdk").status, "stale");
});

test("unrecognized workspace syntax cannot produce a prepared report", (t) => {
  const root = fixture(t);
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  assert.equal(check(checkDevelopmentSetup(root), "dependencies").status, "incomplete");
});

test("the reviewed pnpm preparation policy preserves complete workspace checks", (t) => {
  const root = fixture(t);
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  put(root, "pnpm-workspace.yaml", `verifyDepsBeforeRun: error\n\n${workspace}`);
  const report = checkDevelopmentSetup(root);
  assert.equal(check(report, "lock-importers").status, "ok");
  assert.equal(check(report, "packages/consumer:pino").status, "ok");
  // A different setting must not silently broaden the doctor's supported YAML.
  put(root, "pnpm-workspace.yaml", `verifyDepsBeforeRun: install\n\n${workspace}`);
  assert.equal(check(checkDevelopmentSetup(root), "dependencies").status, "incomplete");
});

test("SDK dependency links must retain the identities in the preparation receipt", (t) => {
  const root = fixture(t);
  const target = join(root, "external-dependency");
  put(root, "external-dependency/package.json", {
    name: "fixture-sdk-dependency",
    version: "1.0.0",
  });
  const receiptPath = ".build/upstream-sdk/preparation.json";
  const receipt = JSON.parse(readFileSync(join(root, receiptPath)));
  receipt.links = [
    {
      path: "node_modules/fixture-sdk-dependency",
      target,
      name: "fixture-sdk-dependency",
      version: "1.0.0",
      manifestSha256: createHash("sha256")
        .update(readFileSync(join(target, "package.json")))
        .digest("hex"),
    },
  ];
  put(root, receiptPath, receipt);
  symlinkSync(target, join(root, ".build/upstream-sdk/node_modules/fixture-sdk-dependency"));
  assert.equal(check(checkDevelopmentSetup(root), "upstream-sdk").status, "ok");
  put(root, "external-dependency/package.json", {
    name: "fixture-sdk-dependency",
    version: "2.0.0",
  });
  assert.equal(check(checkDevelopmentSetup(root), "upstream-sdk").status, "stale");
});

test("an actual Git checkout is distinguished from a source export", (t) => {
  const root = fixture(t);
  const git = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  assert.equal(checkDevelopmentSetup(root).checkout, "git-worktree");
});

test("JSON CLI fails on missing pino without repairing the checkout", (t) => {
  const root = fixture(t);
  put(
    root,
    "scripts/development-setup-requirements.mjs",
    readFileSync(
      new URL("../../scripts/development-setup-requirements.mjs", import.meta.url),
      "utf8",
    ),
  );
  put(
    root,
    "scripts/check-development-setup.mjs",
    readFileSync(new URL("../../scripts/check-development-setup.mjs", import.meta.url), "utf8"),
  );
  const missing = join(root, "packages/consumer/node_modules/pino");
  rmSync(missing, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/check-development-setup.mjs"), "--json"],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, "oce.development-setup/v1");
  assert.equal(report.status, "unprepared");
  assert.equal(check(report, "packages/consumer:pino").status, "missing");
  assert.throws(() => readFileSync(join(missing, "package.json")), { code: "ENOENT" });
});
