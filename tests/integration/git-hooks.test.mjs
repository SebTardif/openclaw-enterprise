import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function createRepositoryFixture(t, { initializeGit = true } = {}) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openclaw-enterprise-git-hooks-"));
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  await mkdir(join(fixtureRoot, "scripts"));
  await mkdir(join(fixtureRoot, ".githooks"));
  await copyFile(
    join(repositoryRoot, "scripts/install-git-hooks.mjs"),
    join(fixtureRoot, "scripts/install-git-hooks.mjs"),
  );
  await copyFile(
    join(repositoryRoot, ".githooks/pre-push"),
    join(fixtureRoot, ".githooks/pre-push"),
  );

  await copyFile(
    join(repositoryRoot, "scripts/format.mjs"),
    join(fixtureRoot, "scripts/format.mjs"),
  );

  if (initializeGit) {
    const initialize = spawnSync("git", ["init", "--quiet"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    assert.equal(initialize.status, 0, initialize.stderr);
  }

  return fixtureRoot;
}

function installHooks(fixtureRoot) {
  return spawnSync(process.execPath, ["scripts/install-git-hooks.mjs"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
}

test("automatic installation skips packaged environments without a Git checkout", async (t) => {
  const fixtureRoot = await createRepositoryFixture(t, { initializeGit: false });

  const automaticInstallation = spawnSync(
    process.execPath,
    ["scripts/install-git-hooks.mjs", "--if-git-present"],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
    },
  );
  assert.equal(automaticInstallation.status, 0, automaticInstallation.stderr);
  assert.match(automaticInstallation.stdout, /Skipping Git hook installation/);

  const explicitInstallation = installHooks(fixtureRoot);
  assert.notEqual(explicitInstallation.status, 0);
  assert.match(explicitInstallation.stderr, /outside a Git checkout/);
});

test("hook installation preserves core.hooksPath and is safely repeatable", async (t) => {
  const fixtureRoot = await createRepositoryFixture(t);
  const protectedHooksPath = join(fixtureRoot, "protected-organization-hooks");
  const configureProtectedHooks = spawnSync(
    "git",
    ["config", "core.hooksPath", protectedHooksPath],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
    },
  );
  assert.equal(configureProtectedHooks.status, 0, configureProtectedHooks.stderr);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = installHooks(fixtureRoot);
    assert.equal(result.status, 0, result.stderr);
  }

  const nativeHookPath = join(fixtureRoot, ".git/hooks/pre-push");
  assert.equal(
    await readFile(nativeHookPath, "utf8"),
    await readFile(join(fixtureRoot, ".githooks/pre-push"), "utf8"),
  );
  assert.notEqual((await stat(nativeHookPath)).mode & 0o111, 0);

  const currentHooksPath = spawnSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  assert.equal(currentHooksPath.status, 0, currentHooksPath.stderr);
  assert.equal(currentHooksPath.stdout.trim(), protectedHooksPath);
});

test("hook installation refuses to replace an existing unmanaged native hook", async (t) => {
  const fixtureRoot = await createRepositoryFixture(t);
  const nativeHookPath = join(fixtureRoot, ".git/hooks/pre-push");
  const unmanagedHook = "#!/bin/sh\n# Existing user-managed pre-push hook\nexit 0\n";
  await writeFile(nativeHookPath, unmanagedHook);
  await chmod(nativeHookPath, 0o755);

  const result = installHooks(fixtureRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unmanaged.*pre-push/i);
  assert.equal(await readFile(nativeHookPath, "utf8"), unmanagedHook);
  assert.notEqual((await stat(nativeHookPath)).mode & 0o111, 0);
});

function git(fixtureRoot, args) {
  const result = spawnSync("git", args, {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Hook test",
      GIT_AUTHOR_EMAIL: "hook@example.test",
      GIT_COMMITTER_NAME: "Hook test",
      GIT_COMMITTER_EMAIL: "hook@example.test",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function formattingFixture(t) {
  const root = await createRepositoryFixture(t);
  const sourceManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      { devDependencies: { prettier: sourceManifest.devDependencies.prettier } },
      null,
      2,
    ) + "\n",
  );
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await writeFile(join(root, ".prettierrc.json"), '{ "printWidth": 100 }\n');
  await writeFile(join(root, ".prettierignore"), "node_modules/\n");
  await mkdir(join(root, "apps"));
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await mkdir(join(root, ".github/actions/example"), { recursive: true });
  await writeFile(join(root, ".github/workflows/check.yml"), "name: Checks\n");
  await writeFile(join(root, ".github/actions/example/action.yml"), "name: Example\n");
  await mkdir(join(root, "docs/reference"), { recursive: true });
  await writeFile(join(root, "apps/example.mjs"), "const answer = 42;\n");
  await writeFile(join(root, "docs/guide.md"), "# Guide\n");
  await writeFile(join(root, "docs/reference/api.md"), "#   generated deliberately unformatted\n");
  await mkdir(join(root, "node_modules"));
  await symlink(
    join(repositoryRoot, "node_modules/prettier"),
    join(root, "node_modules/prettier"),
    "dir",
  );
  await mkdir(join(root, "bin"));
  const packageManagerPath = join(root, "bin/pnpm");
  await writeFile(
    packageManagerPath,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$PACKAGE_MANAGER_INVOCATION_LOG"\nexit 97\n',
  );
  await chmod(packageManagerPath, 0o755);
  return root;
}

function format(root, ...args) {
  return spawnSync(process.execPath, ["scripts/format.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function commit(root) {
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "fixture"]);
  return git(root, ["rev-parse", "HEAD"]);
}

function pushCheck(root, commits) {
  return spawnSync(join(root, ".git/hooks/pre-push"), [], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      PACKAGE_MANAGER_INVOCATION_LOG: join(root, "pnpm-invocation.log"),
    },
    input: commits
      .map((oid, i) => `refs/heads/test${i} ${oid} refs/heads/test${i} ${"0".repeat(40)}\n`)
      .join(""),
  });
}

test("real formatter invalidates warm content/config caches and handles focused unusual paths", async (t) => {
  const root = await formattingFixture(t);
  let result = format(root, "--write");
  assert.equal(result.status, 0, result.stderr);
  result = format(root, "--check");
  assert.equal(result.status, 0, result.stderr);
  const unusual = "apps/name [literal] space.mjs";
  await rename(join(root, "apps/example.mjs"), join(root, unusual));
  await writeFile(join(root, unusual), "const answer={value:42}\n");
  result = format(root, "--check", "--", unusual);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Code style issues/);
  result = format(root, "--write", unusual);
  assert.equal(result.status, 0, result.stderr);
  result = format(root, "--check");
  assert.equal(result.status, 0, result.stderr);
  await writeFile(join(root, ".prettierignore"), "node_modules/\napps/\n");
  await writeFile(join(root, unusual), "const answer={value:42}\n");
  assert.equal(format(root, "--check").status, 0);
  await writeFile(join(root, ".prettierignore"), "node_modules/\n");
  assert.equal(format(root, "--check").status, 1);
  assert.equal(format(root, "--write", unusual).status, 0);
  await writeFile(join(root, ".prettierrc.json"), '{ "semi": false }\n');
  result = format(root, "--check", unusual);
  assert.equal(result.status, 1);
  await rm(join(root, unusual));
  result = format(root, "--check", "docs/guide.md");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(format(root, "--check", "docs/reference/api.md").status, 1);
});

test("native hook checks every outgoing tip independently of dirty worktree and HEAD", async (t) => {
  const root = await formattingFixture(t);
  assert.equal(format(root, "--write").status, 0);
  const good = commit(root);
  assert.equal(installHooks(root).status, 0);
  await writeFile(join(root, "docs/guide.md"), "#   Bad heading\n");
  await writeFile(join(root, "apps/page.html"), "<div    class = 'test'><p>content</p></div>\n");
  await writeFile(join(root, "apps/style.css"), "div{color:red}\n");
  await writeFile(join(root, "apps/example.cjs"), "module.exports={value:42};\n");
  await writeFile(
    join(root, ".github/workflows/check.yml"),
    "name: Checks\non: [ push,pull_request ]\n",
  );
  await writeFile(
    join(root, ".github/actions/example/action.yml"),
    "name: Example\nruns: {using: composite,steps: []}\n",
  );
  // Archive attributes cannot hide committed files from the formatter snapshot.
  await writeFile(join(root, ".gitattributes"), "docs/guide.md export-ignore\n");
  const bad = commit(root);
  git(root, ["checkout", "--quiet", good]);
  // HEAD is clean but the pushed non-HEAD branch contains bad authored docs.
  let result = pushCheck(root, [good, bad]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/guide.md/);
  assert.match(result.stderr, /apps\/page.html/);
  assert.match(result.stderr, /apps\/style.css/);
  assert.match(result.stderr, /apps\/example.cjs/);
  assert.match(result.stderr, /\.github\/workflows\/check.yml/);
  assert.match(result.stderr, /\.github\/actions\/example\/action.yml/);
  // A dirty file must neither rescue a bad committed tip nor reject a good tip.
  await writeFile(join(root, "docs/guide.md"), "#   Another bad heading\n");
  result = pushCheck(root, [good]);
  assert.equal(result.status, 0, result.stderr);
  result = pushCheck(root, ["0".repeat(40)]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  manifest.dependencies = { "unprepared-package": "1.0.0" };
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  result = pushCheck(root, [good]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Outgoing dependency input differs/);
  await rm(join(root, "node_modules"), { recursive: true });
  result = pushCheck(root, [good]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /installed Prettier executable is unavailable/);
  await assert.rejects(stat(join(root, "pnpm-invocation.log")), { code: "ENOENT" });
});

async function configuredPluginFixture(t, configuration) {
  const root = await formattingFixture(t);
  const plugin = join(root, "node_modules/fixture-plugin");
  await mkdir(join(plugin, "node_modules/policy"), { recursive: true });
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({ name: "fixture-plugin", main: "index.cjs" }),
  );
  // Exercise Prettier's actual plugin loader, parser and printer, including an
  // implementation dependency outside the plugin's immediate package files.
  await writeFile(
    join(plugin, "index.cjs"),
    `
const policy = require('./node_modules/policy');
module.exports = {
  parsers: { fixture: { parse: text => ({ text }), astFormat: 'fixture', locStart: () => 0, locEnd: () => 0 } },
  printers: { fixture: { print: path => path.node.text.trimEnd().replace(/;$/, '') + policy.suffix + "\\n" } }
};
`,
  );
  const policy = join(plugin, "node_modules/policy/index.js");
  await writeFile(policy, 'exports.suffix = ";";');
  await writeFile(join(root, ".prettierrc.json"), JSON.stringify(configuration));
  return { root, plugin, policy };
}

test("configured plugins and override plugins do not reuse stale transitive implementation evidence", async (t) => {
  for (const options of [
    {
      plugins: ["fixture-plugin"],
      overrides: [{ files: "apps/example.mjs", options: { parser: "fixture" } }],
    },
    {
      overrides: [
        { files: "apps/example.mjs", options: { parser: "fixture", plugins: ["fixture-plugin"] } },
      ],
    },
  ]) {
    const { root, policy } = await configuredPluginFixture(t, options);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = format(root, "--check", "apps/example.mjs");
      assert.equal(result.status, 0, result.stderr);
    }
    await writeFile(policy, 'exports.suffix = "!";');
    const result = format(root, "--check", "apps/example.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Code style issues/);
  }
});

test("outgoing formatting rejects plugin dependency closures instead of reading dirty workspace plugins", async (t) => {
  const { root, plugin } = await configuredPluginFixture(t, {
    overrides: [
      { files: "apps/example.mjs", options: { parser: "fixture", plugins: ["fixture-plugin"] } },
    ],
  });
  await mkdir(join(root, "packages"));
  await rename(plugin, join(root, "packages/fixture-plugin"));
  await symlink(join(root, "packages/fixture-plugin"), plugin, "dir");
  const tip = commit(root);
  assert.equal(installHooks(root).status, 0);
  for (const implementation of ["exports.suffix = ';';", "exports.suffix = '!';"]) {
    await writeFile(join(root, "packages/fixture-plugin/index.cjs"), implementation);
    const result = pushCheck(root, [tip]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /static JSON configuration without plugins/);
  }
});

test("focused writes reject file paths whose parent symlink escapes the worktree", async (t) => {
  const root = await formattingFixture(t);
  const outside = await mkdtemp(join(tmpdir(), "formatter-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const content = "const answer={value:42}\n";
  await writeFile(join(outside, "escaped.mjs"), content);
  await symlink(outside, join(root, "apps/linked"), "dir");
  const result = format(root, "--write", "apps/linked/escaped.mjs");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside this worktree/);
  assert.equal(await readFile(join(outside, "escaped.mjs"), "utf8"), content);
});

test("root instruction alias checks canonical worktree and outgoing bytes", async (t) => {
  const root = await formattingFixture(t);
  await writeFile(join(root, "AGENTS.md"), "# Instructions\n");
  await symlink("AGENTS.md", join(root, "CLAUDE.md"));
  let result = format(root, "--write");
  assert.equal(result.status, 0, result.stderr);
  result = format(root, "--check");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /symlink|symbolic link/i);
  result = format(root, "--check", "CLAUDE.md");
  assert.equal(result.status, 0, result.stderr);
  const good = commit(root);
  assert.equal(installHooks(root).status, 0);
  result = pushCheck(root, [good]);
  assert.equal(result.status, 0, result.stderr);

  // Both full and alias-focused checks must actually inspect canonical bytes.
  await writeFile(join(root, "AGENTS.md"), "#   Bad instructions\n");
  for (const paths of [[], ["CLAUDE.md"]]) {
    result = format(root, "--check", ...paths);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AGENTS\.md/);
  }
  const bad = commit(root);
  assert.equal(format(root, "--write", "CLAUDE.md").status, 0);
  assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "# Bad instructions\n");
  // A dirty canonical repair cannot rescue the committed alias target.
  result = pushCheck(root, [bad]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AGENTS\.md/);
  result = pushCheck(root, [good]);
  assert.equal(result.status, 0, result.stderr);
  // A dirty unsafe alias must not invalidate the safe alias in a good tip.
  await rm(join(root, "CLAUDE.md"));
  await symlink("../AGENTS.md", join(root, "CLAUDE.md"));
  result = pushCheck(root, [good]);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(join(root, "pnpm-invocation.log")), { code: "ENOENT" });
});

test("outgoing instruction alias must have the exact target and a regular canonical blob", async (t) => {
  const root = await formattingFixture(t);
  await writeFile(join(root, "AGENTS.md"), "# Instructions\n");
  await symlink("AGENTS.md", join(root, "CLAUDE.md"));
  assert.equal(format(root, "--write").status, 0);
  const good = commit(root);
  assert.equal(installHooks(root).status, 0);
  for (const target of ["../AGENTS.md", "/tmp/outside.md", "docs/guide.md"]) {
    await rm(join(root, "CLAUDE.md"));
    await symlink(target, join(root, "CLAUDE.md"));
    const bad = commit(root);
    // Restore the safe worktree alias; only the outgoing Git blob is evidence.
    await rm(join(root, "CLAUDE.md"));
    await symlink("AGENTS.md", join(root, "CLAUDE.md"));
    const result = pushCheck(root, [bad]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing outgoing formatter input symlink: CLAUDE\.md/);
    git(root, ["reset", "--hard", good]);
  }
  for (const canonical of ["symlink", "missing"]) {
    await rm(join(root, "AGENTS.md"));
    if (canonical === "symlink") await symlink("docs/guide.md", join(root, "AGENTS.md"));
    const bad = commit(root);
    git(root, ["reset", "--hard", good]);
    const result = pushCheck(root, [bad]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing outgoing formatter input symlink: (AGENTS|CLAUDE)\.md/);
  }
  await symlink("guide.md", join(root, "docs/CLAUDE.md"));
  const result = pushCheck(root, [commit(root)]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing outgoing formatter input symlink: docs\/CLAUDE\.md/);
  await assert.rejects(stat(join(root, "pnpm-invocation.log")), { code: "ENOENT" });
});

test("worktree instruction aliases reject escapes, chains, missing targets and nested aliases", async (t) => {
  const root = await formattingFixture(t);
  const outside = await mkdtemp(join(tmpdir(), "formatter-instructions-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideFile = join(outside, "AGENTS.md");
  const content = "#   Outside instructions\n";
  await writeFile(outsideFile, content);
  await writeFile(join(root, "AGENTS.md"), "# Instructions\n");
  for (const target of [outsideFile, "../AGENTS.md", "docs/guide.md"]) {
    await symlink(target, join(root, "CLAUDE.md"));
    for (const paths of [[], ["CLAUDE.md"]]) {
      const result = format(root, "--write", ...paths);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /regular formatting input: CLAUDE\.md/);
    }
    await rm(join(root, "CLAUDE.md"));
  }
  await symlink("AGENTS.md", join(root, "CLAUDE.md"));
  await rm(join(root, "AGENTS.md"));
  // Even a chain that remains inside the worktree is outside the exception.
  for (const target of [outsideFile, "docs/guide.md", undefined]) {
    if (target) await symlink(target, join(root, "AGENTS.md"));
    for (const paths of [[], ["CLAUDE.md"]]) {
      const result = format(root, "--write", ...paths);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /regular formatting input: (AGENTS|CLAUDE)\.md/);
    }
    if (target) await rm(join(root, "AGENTS.md"));
  }
  await rm(join(root, "CLAUDE.md"));
  await symlink("guide.md", join(root, "docs/CLAUDE.md"));
  assert.equal(format(root, "--write").status, 1);
  assert.equal(await readFile(outsideFile, "utf8"), content);
});
