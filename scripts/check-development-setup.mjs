#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const scalar = (text) => text.replace(/^(['"])(.*)\1$/, "$2");
const groups = ["dependencies", "devDependencies", "optionalDependencies"];
const setupAction =
  "Worktree setup owner: prepare dependencies separately with pinned pnpm and the frozen lockfile; rerun this check directly with Node.";

// Accept only the generated importer subset used by this workspace. Unknown
// layouts fail explicitly instead of silently checking part of the graph.
function importers(text) {
  if (!/^lockfileVersion: ['"]?9\.0['"]?$/m.test(text))
    throw new Error("Unsupported lockfile version");
  const section = text.split(/^importers:\s*$/m)[1]?.split(/^\S/m)[0];
  if (!section) throw new Error("Missing importers");
  const result = {};
  let importer, group, name;
  for (const line of section.split("\n")) {
    if (!line.trim()) continue;
    let match;
    if ((match = /^  (\S.*):(?: \{\})?$/.exec(line))) {
      importer = scalar(match[1]);
      result[importer] = {};
      group = undefined;
    } else if ((match = /^    (dependencies|devDependencies|optionalDependencies):$/.exec(line))) {
      group = match[1];
      result[importer][group] = {};
    } else if ((match = /^      (.+):$/.exec(line)) && group) {
      name = scalar(match[1]);
      result[importer][group][name] = {};
    } else if ((match = /^        (specifier|version): (.+)$/.exec(line)) && name && group) {
      result[importer][group][name][match[1]] = scalar(match[2]);
    } else throw new Error("Unsupported importer layout");
  }
  return result;
}

function workspacePaths(text) {
  const paths = [];
  let packages = false;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (line === "verifyDepsBeforeRun: error") {
      packages = false;
      continue;
    }
    if (line === "packages:") {
      packages = true;
      continue;
    }
    const match = /^  - (.+)$/.exec(line);
    if (!packages || !match) throw new Error("Unsupported workspace layout");
    const path = scalar(match[1]);
    if (path.startsWith("!")) continue;
    if (!/^(apps|packages)\/[a-zA-Z0-9_-]+$/.test(path))
      throw new Error("Expected explicit workspace directories");
    paths.push(path);
  }
  if (!paths.length) throw new Error("Missing workspace directories");
  return [".", ...paths];
}

export function checkDevelopmentSetup(root) {
  const start = performance.now();
  root = realpathSync(root);
  const checks = [];
  const add = (id, status, message, action) =>
    checks.push({ id, status, message, ...(status !== "ok" && action ? { action } : {}) });
  const inspect = (id, run) => {
    try {
      run();
    } catch (error) {
      add(
        id,
        error.code === "ENOENT" ? "missing" : "incomplete",
        "Required setup metadata is absent or unsupported.",
        setupAction,
      );
    }
  };
  const rootManifest = json(join(root, "package.json"));
  const minimumNode = /^>=(\d+)$/.exec(rootManifest.engines?.node ?? "");
  add(
    "node",
    minimumNode && Number(process.versions.node.split(".")[0]) >= Number(minimumNode[1])
      ? "ok"
      : "stale",
    `Node ${process.versions.node}; required ${rootManifest.engines?.node ?? "unspecified"}.`,
    "Worktree setup owner: select the declared Node version.",
  );
  const pnpmVersion = /^pnpm@([^+]+)/.exec(rootManifest.packageManager ?? "")?.[1];
  const pnpm = spawnSync("pnpm", ["--version"], {
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
    env: {
      ...process.env,
      COREPACK_ENABLE_NETWORK: "0",
      COREPACK_ENABLE_AUTO_PIN: "0",
      npm_config_manage_package_manager_versions: "false",
    },
  });
  add(
    "pnpm",
    pnpm.error?.code === "ENOENT"
      ? "missing"
      : pnpm.status !== 0
        ? "incomplete"
        : pnpm.stdout.trim() === pnpmVersion
          ? "ok"
          : "stale",
    pnpm.status === 0
      ? `pnpm ${pnpm.stdout.trim()}; required ${pnpmVersion}.`
      : "Pinned pnpm is unavailable within the three-second probe limit.",
    "Worktree setup owner: make the declared pnpm version available separately; Corepack network access is disabled.",
  );
  const git = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 1000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const checkout =
    git.status === 0 && realpathSync(git.stdout.trim()) === root ? "git-worktree" : "source-export";
  add(
    "checkout",
    "ok",
    checkout === "git-worktree"
      ? "Git worktree detected."
      : "Source-only export: Git hooks and outgoing-commit verification are unavailable.",
  );
  const identities = {};
  inspect("dependencies", () => {
    const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const paths = workspacePaths(workspace);
    const lockBytes = readFileSync(join(root, "pnpm-lock.yaml"));
    const lock = importers(lockBytes.toString());
    identities.lockfileSha256 = digest(lockBytes);
    identities.workspaceSha256 = digest(workspace);
    identities.manifests = {};
    const manifests = paths.map((path) => {
      const bytes = readFileSync(join(root, path, "package.json"));
      identities.manifests[path] = digest(bytes);
      return { path, manifest: JSON.parse(bytes) };
    });
    const names = new Map(manifests.map(({ path, manifest }) => [manifest.name, path]));
    const expected = {};
    for (const { path, manifest } of manifests) {
      expected[path] = {};
      for (const group of groups) {
        if (Object.keys(manifest[group] ?? {}).length) expected[path][group] = {};
        for (const [name, specifier] of Object.entries(manifest[group] ?? {})) {
          expected[path][group][name] = specifier;
          const id = `${path}:${name}`;
          if (lock[path]?.[group]?.[name]?.specifier !== specifier)
            add(
              `${id}:lock`,
              "stale",
              "Manifest and lockfile specifiers differ.",
              "Change owner: update and review the lockfile separately before preparing dependencies.",
            );
          try {
            const actual = realpathSync(join(root, path, "node_modules", name));
            const installed = json(join(actual, "package.json"));
            if (installed.name !== name) throw new Error("Package identity mismatch");
            let intended;
            if (specifier.startsWith("workspace:"))
              intended = names.has(name) ? join(root, names.get(name)) : undefined;
            else if (specifier.startsWith("link:"))
              intended = resolve(root, path, specifier.slice(5));
            if (specifier.startsWith("workspace:") || specifier.startsWith("link:")) {
              if (
                !intended ||
                relative(root, intended).startsWith("..") ||
                relative(root, actual).startsWith("..") ||
                actual !== realpathSync(intended)
              ) {
                add(
                  id,
                  "stale",
                  "Local dependency points outside its intended worktree location.",
                  setupAction,
                );
                continue;
              }
            } else {
              const version = lock[path]?.[group]?.[name]?.version?.split("(")[0];
              if (!version || installed.version !== version) {
                add(
                  id,
                  "stale",
                  "Installed package version differs from the current lockfile.",
                  setupAction,
                );
                continue;
              }
            }
            // Node resolves metadata from the importing package. This never loads
            // third-party package code or runs its lifecycle hooks.
            const resolved = findPackageJSON(name, pathToFileURL(join(root, path, "package.json")));
            if (!resolved || realpathSync(resolved) !== realpathSync(join(actual, "package.json")))
              throw new Error("Resolution differs");
            add(id, "ok", "Declared package identity and resolution agree.");
          } catch (error) {
            add(
              id,
              error.code === "ENOENT" || error.code === "ERR_MODULE_NOT_FOUND"
                ? "missing"
                : "incomplete",
              "Declared package is missing, unresolved, or has incomplete metadata.",
              setupAction,
            );
          }
        }
      }
    }
    const lockSpecs = Object.fromEntries(
      Object.entries(lock).map(([path, values]) => [
        path,
        Object.fromEntries(
          Object.entries(values).map(([group, deps]) => [
            group,
            Object.fromEntries(
              Object.entries(deps).map(([name, entry]) => [name, entry.specifier]),
            ),
          ]),
        ),
      ]),
    );
    const normalize = (value) =>
      value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, normalize(value[key])]),
          )
        : value;
    if (JSON.stringify(normalize(expected)) !== JSON.stringify(normalize(lockSpecs)))
      add(
        "lock-importers",
        "stale",
        "Lockfile importers do not exactly match current workspace declarations.",
        "Change owner: update and review the lockfile separately.",
      );
    else add("lock-importers", "ok", "All current manifest declarations match lockfile importers.");
    inspect("installed-lockfile", () => {
      const installed = readFileSync(join(root, "node_modules/.pnpm/lock.yaml"));
      add(
        "installed-lockfile",
        digest(installed) === identities.lockfileSha256 ? "ok" : "stale",
        "Installed lockfile compared with current pnpm-lock.yaml.",
        setupAction,
      );
    });
  });
  inspect("upstream-sdk", () => {
    const sdk = join(root, ".build/upstream-sdk");
    const receiptBytes = readFileSync(join(sdk, "preparation.json"));
    const receipt = JSON.parse(receiptBytes);
    if (
      receipt.schema !== "oce.upstream-sdk-preparation/v1" ||
      receipt.status !== "prepared" ||
      !/^[a-f0-9]{64}$/.test(receipt.manifestSha256)
    )
      throw new Error("Incomplete receipt");
    const layout = {
      openclaw: "openclaw",
      "@openclaw/ai": "openclaw/node_modules/@openclaw/ai",
      "@types/ws": "node_modules/@types/ws",
    };
    if (
      !Array.isArray(receipt.packages) ||
      receipt.packages.length !== 3 ||
      !Array.isArray(receipt.links)
    )
      throw new Error("Incomplete package identities");
    for (const [name, destination] of Object.entries(layout)) {
      const entry = receipt.packages.find((item) => item.name === name);
      if (entry?.destination !== destination) throw new Error("Unexpected SDK layout");
      const installed = json(join(sdk, destination, "package.json"));
      if (installed.name !== name || installed.version !== entry.version) {
        add(
          "upstream-sdk",
          "stale",
          "Prepared SDK package identity differs from its preparation receipt.",
          "Worktree setup owner: prepare the reviewed upstream SDK in a new owned directory.",
        );
        return;
      }
      if (name === "openclaw") {
        const target = installed.exports?.["./plugin-sdk/channel-inbound"]?.types;
        if (
          typeof target !== "string" ||
          !target.startsWith("./") ||
          target.includes("..") ||
          !existsSync(join(sdk, destination, target))
        )
          throw new Error("Missing channel-inbound declarations");
      }
    }
    if (
      receipt.packages.find((item) => item.name === "openclaw").version !==
      receipt.packages.find((item) => item.name === "@openclaw/ai").version
    )
      throw new Error("SDK companion version mismatch");
    for (const link of receipt.links) {
      if (
        typeof link.path !== "string" ||
        (!/^(?:openclaw\/)?node_modules\/(?:@[^/]+\/)?[^/]+$/.test(link.path) &&
          !/^openclaw\/node_modules\/@openclaw\/ai\/node_modules\/(?:@[^/]+\/)?[^/]+$/.test(
            link.path,
          )) ||
        link.path.split("/").some((part) => part === "..")
      )
        throw new Error("Unsupported SDK link path");
      const target = join(sdk, link.path);
      const manifestBytes = readFileSync(join(target, "package.json"));
      const installed = JSON.parse(manifestBytes);
      if (
        realpathSync(target) !== link.target ||
        installed.name !== link.name ||
        installed.version !== link.version ||
        digest(manifestBytes) !== link.manifestSha256
      ) {
        add(
          "upstream-sdk",
          "stale",
          "Prepared SDK dependency link identity differs from its preparation receipt.",
          setupAction,
        );
        return;
      }
    }
    identities.sdkReceiptSha256 = digest(receiptBytes);
    add(
      "upstream-sdk",
      "ok",
      "Prepared receipt, package identities and channel-inbound declaration target exist; full content/provenance is not reverified.",
    );
  });
  return {
    schema: "oce.development-setup/v1",
    status: checks.every((check) => check.status === "ok") ? "prepared" : "unprepared",
    checkout,
    identities,
    checks,
    durationMs: Math.round(performance.now() - start),
    scope:
      "Local Node/pnpm workspace metadata and SDK identity only; no tests or infrastructure readiness probes.",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--json") || args.length > 1) {
    console.error("Usage: node scripts/check-development-setup.mjs [--json]");
    process.exitCode = 2;
  } else {
    try {
      const report = checkDevelopmentSetup(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
      if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(
          `Development setup: ${report.status} (${report.durationMs} ms; ${report.checkout}).`,
        );
        for (const check of report.checks.filter((item) => item.status !== "ok"))
          console.log(`${check.status}: ${check.id}: ${check.message}\n  ${check.action}`);
        console.log(report.scope);
      }
      process.exitCode = report.status === "prepared" ? 0 : 1;
    } catch {
      console.error(
        "Development setup: incomplete root manifest; worktree setup owner must prepare this checkout separately.",
      );
      process.exitCode = 1;
    }
  }
}
