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
import { join } from "node:path";
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
  await mkdir(join(root, "docs/reference"), { recursive: true });
  await writeFile(join(root, "apps/example.mjs"), "const answer = 42;\n");
  await writeFile(join(root, "docs/guide.md"), "# Guide\n");
  await writeFile(join(root, "docs/reference/api.md"), "#   generated deliberately unformatted\n");
  await symlink(join(repositoryRoot, "node_modules"), join(root, "node_modules"), "dir");
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
  await rm(join(root, "node_modules"));
  result = pushCheck(root, [good]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /installed Prettier executable is unavailable/);
});
