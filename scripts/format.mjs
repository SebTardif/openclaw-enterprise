import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scope = [
  "{apps,packages,scripts,tests}/**/*.{ts,mjs,cjs,json,html,css}",
  "*.{json,yaml,yml,md}",
  "docs/**/*.md",
  "!docs/reference/api.md",
  ".github/**/*.yml",
];
const git = (args) => execFileSync("git", args, { cwd: root, maxBuffer: 128 * 1024 * 1024 });
const files = () =>
  git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .toString()
    .split("\0")
    .filter(Boolean);
const dependencyInput = (path) =>
  /(^|\/)package\.json$/.test(path) ||
  ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc"].includes(path);
const configurationInput = (path) => /(^|\/)(\.prettier[^/]*|prettier\.config\.[^/]+)$/.test(path);
const inScope = (path) =>
  path !== "docs/reference/api.md" &&
  (/^(apps|packages|scripts|tests)\/.*\.(ts|mjs|cjs|json|html|css)$/.test(path) ||
    /^[^/]+\.(json|yaml|yml|md)$/.test(path) ||
    /^docs\/.*\.md$/.test(path) ||
    /^\.github\/.*\.yml$/.test(path));

// Package contents also invalidate the built-in formatter cache when its version
// stays unchanged. Configured plugins have arbitrary dependency closures, so
// their checks remain uncached instead of guessing an implementation identity.
function hashTree(hash, path) {
  const metadata = lstatSync(path);
  if (metadata.isDirectory()) {
    for (const name of readdirSync(path).sort()) {
      if (name !== "node_modules") {
        hash.update(name);
        hashTree(hash, join(path, name));
      }
    }
  } else if (metadata.isFile()) hash.update(readFileSync(path));
  else throw new Error(`Unsupported formatter package entry: ${path}`);
}

function hasPlugins(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => key === "plugins" || hasPlugins(child));
}

function unboundedConfiguration(path, content) {
  if (configurationInput(path) && !path.endsWith("ignore")) {
    if (!path.endsWith(".json")) return true;
    return hasPlugins(JSON.parse(content));
  }
  if (path.endsWith("package.json")) {
    const config = JSON.parse(content).prettier;
    return typeof config === "string" || hasPlugins(config);
  }
  return false;
}

function cacheIdentity(prettierRoot) {
  const hash = createHash("sha256").update(process.version);
  hashTree(hash, prettierRoot);
  for (const path of files().sort()) {
    if (!dependencyInput(path) && !configurationInput(path)) continue;
    if (!existsSync(join(root, path))) continue;
    const content = readFileSync(join(root, path));
    hash.update(path).update(content);
    if (unboundedConfiguration(path, content)) return undefined;
  }
  return hash.digest("hex");
}

function runFormatter(cwd, mode, paths, cache, binary) {
  const args = [
    binary,
    mode,
    ...(cache ? ["--cache", "--cache-strategy", "content", "--cache-location", cache] : []),
    ...paths,
  ];
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Formatting failed (${result.signal ?? result.status}).`);
}

function snapshot(commit, destination) {
  const entries = git(["ls-tree", "-rz", "--full-tree", commit])
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, oid] = entry.slice(0, tab).split(" ");
      return { mode, type, oid, path: entry.slice(tab + 1) };
    });
  const regular = entries.filter(({ mode, type }) => type === "blob" && mode !== "120000");
  for (const entry of entries) {
    if (
      entry.mode === "120000" &&
      (inScope(entry.path) || configurationInput(entry.path) || dependencyInput(entry.path))
    ) {
      // Main's root instruction alias is the only allowed input symlink. Its
      // exact target and canonical bytes must both belong to this same commit.
      const canonical = entries.find(({ path }) => path === "AGENTS.md");
      if (
        entry.path === "CLAUDE.md" &&
        git(["cat-file", "blob", entry.oid]).equals(Buffer.from("AGENTS.md")) &&
        canonical?.type === "blob" &&
        ["100644", "100755"].includes(canonical.mode)
      )
        continue;
      throw new Error(`Refusing outgoing formatter input symlink: ${entry.path}`);
    }
  }
  // cat-file preserves Git bytes, including export-ignore paths, without smudge
  // filters or executing checkout hooks. Never read the dirty worktree as proof.
  const blobs = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: regular.map(({ oid }) => oid).join("\n") + "\n",
    maxBuffer: 128 * 1024 * 1024,
  });
  let offset = 0;
  for (const entry of regular) {
    const newline = blobs.indexOf(10, offset);
    const size = Number(blobs.subarray(offset, newline).toString().split(" ")[2]);
    if (!Number.isSafeInteger(size)) throw new Error("Invalid Git blob response.");
    const content = blobs.subarray(newline + 1, newline + 1 + size);
    offset = newline + 1 + size + 1;
    if (unboundedConfiguration(entry.path, content)) {
      throw new Error(
        `Outgoing formatting requires static JSON configuration without plugins: ${entry.path}`,
      );
    }
    const target = join(destination, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  // Dependency preparation is explicit. A different outgoing manifest/lockfile
  // needs its own prepared checkout; this check never runs a package manager.
  const inputs = new Set([...files(), ...entries.map(({ path }) => path)].filter(dependencyInput));
  for (const path of inputs) {
    const installedInput = join(root, path);
    const outgoingInput = join(destination, path);
    if (
      existsSync(installedInput) !== existsSync(outgoingInput) ||
      (existsSync(installedInput) &&
        !readFileSync(installedInput).equals(readFileSync(outgoingInput)))
    )
      throw new Error(`Outgoing dependency input differs from prepared checkout: ${path}`);
  }
}

try {
  const [mode, ...rawPaths] = process.argv.slice(2);
  if (!["--check", "--write", "--pre-push"].includes(mode))
    throw new Error("Usage: node scripts/format.mjs --check|--write [--] [files...] | --pre-push");
  const binary = join(root, "node_modules/prettier/bin/prettier.cjs");
  if (!existsSync(binary))
    throw new Error(
      "The installed Prettier executable is unavailable; prepare dependencies explicitly.",
    );
  const prettierRoot = realpathSync(resolve(dirname(binary), ".."));
  const manifest = JSON.parse(readFileSync(join(root, "package.json")));
  const installedVersion = JSON.parse(readFileSync(join(prettierRoot, "package.json"))).version;
  if (manifest.devDependencies?.prettier !== installedVersion)
    throw new Error(
      "Installed Prettier does not match the pinned manifest; prepare dependencies explicitly.",
    );
  const gitDirectory = git(["rev-parse", "--absolute-git-dir"]).toString().trim();
  const cacheDirectory = join(gitDirectory, "oce-format-cache");
  mkdirSync(cacheDirectory, { recursive: true });
  if (mode === "--pre-push") {
    if (rawPaths.length) throw new Error("--pre-push takes ref updates on stdin only.");
    const updates = readFileSync(0, "utf8").trim();
    const commits = new Set();
    for (const line of updates ? updates.split("\n") : []) {
      const fields = line.split(/\s+/);
      if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(fields[1]))
        throw new Error("Invalid pre-push ref update.");
      if (!/^0+$/.test(fields[1]))
        commits.add(
          git(["rev-parse", "--verify", `${fields[1]}^{commit}`])
            .toString()
            .trim(),
        );
    }
    for (const commit of commits) {
      const directory = mkdtempSync(join(tmpdir(), "oce-format-tip-"));
      try {
        snapshot(commit, directory);
        console.log(`Checking outgoing ref tip ${commit}`);
        // Fresh committed snapshots deliberately do not reuse mutable-worktree
        // evidence. Prettier resolves configuration from the outgoing bytes.
        runFormatter(directory, "--check", scope, undefined, binary);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } else {
    const paths = rawPaths[0] === "--" ? rawPaths.slice(1) : rawPaths;
    function worktreeInput(path) {
      let relativePath = relative(root, resolve(root, path));
      const metadata = lstatSync(join(root, relativePath), { throwIfNoEntry: false });
      if (
        relativePath === "CLAUDE.md" &&
        metadata?.isSymbolicLink() &&
        readlinkSync(join(root, relativePath)) === "AGENTS.md" &&
        lstatSync(join(root, "AGENTS.md"), { throwIfNoEntry: false })?.isFile()
      ) {
        relativePath = "AGENTS.md";
      } else if (!metadata?.isFile()) {
        throw new Error(`Expected an existing regular formatting input: ${path}`);
      }
      const actualRelativePath = relative(
        realpathSync(root),
        realpathSync(join(root, relativePath)),
      );
      if (
        isAbsolute(actualRelativePath) ||
        actualRelativePath === ".." ||
        actualRelativePath.startsWith(`..${sep}`)
      ) {
        throw new Error(`Formatting input resolves outside this worktree: ${path}`);
      }
      return `./${relativePath}`;
    }
    // Validate before Prettier or the cache can follow an input symlink. The
    // full glob skips the validated alias; AGENTS.md remains a normal input.
    let instructionAlias = false;
    for (const path of files()) {
      if (!inScope(path) && !configurationInput(path) && !dependencyInput(path)) continue;
      if (!lstatSync(join(root, path), { throwIfNoEntry: false })) continue;
      const canonical = worktreeInput(path);
      if (path === "CLAUDE.md" && canonical === "./AGENTS.md") instructionAlias = true;
    }
    const selected = paths.length
      ? [
          ...new Set(
            paths.map((path) => {
              const relativePath = relative(root, resolve(root, path));
              if (
                isAbsolute(relativePath) ||
                relativePath === ".." ||
                relativePath.startsWith(`..${sep}`) ||
                !inScope(relativePath)
              )
                throw new Error(`Expected an existing authored file in formatting scope: ${path}`);
              return worktreeInput(path);
            }),
          ),
        ]
      : [...scope, ...(instructionAlias ? ["!CLAUDE.md"] : [])];
    const identity = cacheIdentity(prettierRoot);
    // Each invocation owns its cache file; promote atomically after success.
    // Concurrent invocations can lose cache hits, never manufacture a pass.
    const stableCache = identity && join(cacheDirectory, `${identity}.json`);
    const cache = stableCache && `${stableCache}.${process.pid}`;
    if (cache && existsSync(stableCache)) writeFileSync(cache, readFileSync(stableCache));
    try {
      runFormatter(root, mode, selected, cache, binary);
      if (cache && existsSync(cache)) {
        const { renameSync } = await import("node:fs");
        renameSync(cache, stableCache);
      }
    } finally {
      if (cache) rmSync(cache, { force: true });
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
