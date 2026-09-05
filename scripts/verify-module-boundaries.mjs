import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Reuse the workspace's existing parser. Checking never installs dependencies.
const require = createRequire(import.meta.url);
const ts = require("typescript");
const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const extensions = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const slash = (value) => value.replaceAll("\\", "/");
const inside = (path, root) => path === root || path.startsWith(`${root}/`);
const matches = (path, patterns) =>
  patterns.some((pattern) =>
    pattern.endsWith("/**") ? inside(path, pattern.slice(0, -3)) : path === pattern,
  );

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      if (["node_modules", "dist", ".git"].includes(entry.name)) return [];
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && extensions.test(entry.name) ? [path] : [];
    }),
  );
  return paths.flat().sort();
}

function exportedTarget(exports, subpath, typeOnly, kind) {
  function select(value) {
    if (typeof value === "string" || value === null) return value;
    if (!value || Array.isArray(value)) return undefined;
    // Object order is significant in Node conditional exports.
    const conditions = new Set([
      ...(typeOnly ? ["types"] : []),
      "node",
      kind === "require" ? "require" : "import",
      "default",
    ]);
    for (const [condition, target] of Object.entries(value)) {
      if (conditions.has(condition)) {
        const selected = select(target);
        if (selected !== undefined) return selected;
      }
    }
    return undefined;
  }
  if (typeof exports === "string" || exports === null)
    return subpath === "." ? select(exports) : undefined;
  if (!exports || Array.isArray(exports)) return undefined;
  if (!Object.keys(exports).some((key) => key.startsWith(".")))
    return subpath === "." ? select(exports) : undefined;
  if (Object.hasOwn(exports, subpath)) return select(exports[subpath]);
  const patterns = Object.keys(exports)
    .filter((key) => key.includes("*"))
    .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
  for (const pattern of patterns) {
    const [prefix, suffix] = pattern.split("*");
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const target = select(exports[pattern]);
    return typeof target === "string"
      ? target.replaceAll("*", subpath.slice(prefix.length, subpath.length - suffix.length))
      : target;
  }
  return undefined;
}

function components(files, edges) {
  const adjacent = new Map(files.map((file) => [file, []]));
  for (const edge of edges) if (adjacent.has(edge.to)) adjacent.get(edge.from).push(edge.to);
  const indices = new Map(),
    low = new Map(),
    stack = [],
    active = new Set(),
    cycles = [];
  let next = 0;
  function visit(file) {
    indices.set(file, next);
    low.set(file, next++);
    stack.push(file);
    active.add(file);
    for (const target of adjacent.get(file)) {
      if (!indices.has(target)) {
        visit(target);
        low.set(file, Math.min(low.get(file), low.get(target)));
      } else if (active.has(target)) low.set(file, Math.min(low.get(file), indices.get(target)));
    }
    if (low.get(file) !== indices.get(file)) return;
    const group = [];
    let item;
    do {
      item = stack.pop();
      active.delete(item);
      group.push(item);
    } while (item !== file);
    if (group.length > 1 || adjacent.get(file).includes(file)) cycles.push(group.sort());
  }
  for (const file of files) if (!indices.has(file)) visit(file);
  return cycles.sort((a, b) => a.join().localeCompare(b.join()));
}

/** Inspect source without executing imports or loading application dependencies. */
export async function verifyModuleBoundaries({ root = defaultRoot, policy, exceptions } = {}) {
  root = resolve(root);
  policy ??= JSON.parse(
    await readFile(resolve(root, "scripts/module-boundaries/policy.json"), "utf8"),
  );
  exceptions ??= JSON.parse(
    await readFile(resolve(root, "scripts/module-boundaries/exceptions.json"), "utf8"),
  );
  if (policy.version !== 1 || exceptions.version !== 1)
    throw new Error("Unsupported module-boundary policy version.");
  for (const field of [
    "sourceRoots",
    "packages",
    "domainSources",
    "domainInfrastructure",
    "implementationTargets",
    "implementationPackages",
    "httpSources",
    "providerRoots",
  ]) {
    if (
      !Array.isArray(policy[field]) ||
      policy[field].some(
        (entry) =>
          typeof entry !== "string" || isAbsolute(entry) || entry.split("/").includes(".."),
      )
    )
      throw new Error(`Invalid policy field: ${field}`);
  }
  if (
    !Array.isArray(exceptions.exceptions) ||
    !Number.isSafeInteger(policy.diagnosticLimit) ||
    policy.diagnosticLimit < 1
  )
    throw new Error("Invalid exceptions or diagnostic limit.");
  const paths = [
    ...new Set(
      (await Promise.all(policy.sourceRoots.map((path) => walk(resolve(root, path))))).flat(),
    ),
  ].sort();
  const sourceText = new Map(
    await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")])),
  );
  const options = { allowJs: true, noResolve: true, noLib: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path, languageVersion) =>
    sourceText.has(path)
      ? ts.createSourceFile(path, sourceText.get(path), languageVersion, true)
      : undefined;
  const program = ts.createProgram(paths, options, host);
  const checker = program.getTypeChecker();
  const files = paths.map((path) => slash(relative(root, path)));
  const fileSet = new Set(files);
  const packages = await Promise.all(
    policy.packages.map(async (path) => {
      const manifest = JSON.parse(await readFile(resolve(root, path, "package.json"), "utf8"));
      if (typeof manifest.name !== "string") throw new Error(`Missing package name: ${path}`);
      return { path, ...manifest };
    }),
  );
  const owner = (file) => packages.find((pkg) => inside(file, pkg.path));
  const edges = [],
    diagnostics = [];
  const add = (rule, edge, message) =>
    diagnostics.push({
      rule,
      from: edge.from,
      to: edge.to ?? "",
      specifier: edge.specifier,
      kind: edge.kind,
      typeOnly: edge.typeOnly,
      bindings: edge.bindings ?? [],
      line: edge.line,
      message,
    });
  function resolveFile(path) {
    let candidate = slash(relative(root, path));
    if (fileSet.has(candidate)) return candidate;
    const replacements =
      { ".js": [".ts", ".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] }[extname(path)] ?? [];
    for (const extension of replacements) {
      const replaced = candidate.slice(0, -extname(path).length) + extension;
      if (fileSet.has(replaced)) return replaced;
    }
    return undefined;
  }
  for (const path of paths) {
    const source = program.getSourceFile(path),
      from = slash(relative(root, path));
    for (const error of source.parseDiagnostics)
      add(
        "source-syntax",
        {
          from,
          specifier: "",
          kind: "syntax",
          typeOnly: false,
          line: source.getLineAndCharacterOfPosition(error.start ?? 0).line + 1,
        },
        ts.flattenDiagnosticMessageText(error.messageText, " "),
      );
    function builtin(node, module) {
      if (!node) return undefined;
      const sameModule = (name) => name === module || name === module.replace(/^node:/, "");
      if (ts.isIdentifier(node)) {
        const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
        if (
          declaration &&
          ts.isImportSpecifier(declaration) &&
          sameModule(declaration.parent.parent.parent.moduleSpecifier.text)
        )
          return (declaration.propertyName ?? declaration.name).text;
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const declaration = checker.getSymbolAtLocation(node.expression)?.declarations?.[0];
        if (
          declaration &&
          ts.isNamespaceImport(declaration) &&
          sameModule(declaration.parent.parent.moduleSpecifier.text)
        )
          return node.name.text;
        if (
          declaration &&
          ts.isImportClause(declaration) &&
          sameModule(declaration.parent.moduleSpecifier.text)
        )
          return node.name.text;
      }
      return undefined;
    }
    const isURL = (node) =>
      builtin(node, "node:url") === "URL" ||
      (ts.isIdentifier(node) && node.text === "URL" && !checker.getSymbolAtLocation(node));
    function isRequire(node, seen = new Set()) {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      const declaration = ts.isIdentifier(node)
        ? checker.getSymbolAtLocation(node)?.valueDeclaration
        : undefined;
      if (ts.isIdentifier(node) && node.text === "require" && !declaration) return true;
      const initializer =
        declaration && ts.isVariableDeclaration(declaration) ? declaration.initializer : node;
      if (initializer && ts.isIdentifier(initializer) && initializer !== node)
        return isRequire(initializer, seen);
      return (
        initializer &&
        ts.isCallExpression(initializer) &&
        builtin(initializer.expression, "node:module") === "createRequire"
      );
    }
    function resolutionKind(node, seen = new Set()) {
      if (!node || seen.has(node)) return undefined;
      seen.add(node);
      if (ts.isIdentifier(node)) {
        const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
        return declaration && ts.isVariableDeclaration(declaration)
          ? resolutionKind(declaration.initializer, seen)
          : undefined;
      }
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isPropertyAccessExpression(node)
      )
        return resolutionKind(node.expression, seen);
      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "resolve" &&
          isRequire(node.expression.expression)
        )
          return "require";
        return resolutionKind(node.arguments[0], seen);
      }
      if (ts.isNewExpression(node)) return resolutionKind(node.arguments?.[0], seen);
      return undefined;
    }
    // Resolve local const bindings by symbol, so a shadowed name cannot select an unrelated path.
    function constant(node, seen = new Set()) {
      if (!node) return undefined;
      if (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isNonNullExpression(node)
      )
        return constant(node.expression, seen);
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isIdentifier(node)) {
        const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
        if (
          !declaration ||
          !ts.isVariableDeclaration(declaration) ||
          !(declaration.parent.flags & ts.NodeFlags.Const) ||
          seen.has(declaration)
        )
          return undefined;
        return constant(declaration.initializer, new Set([...seen, declaration]));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = constant(node.left, seen),
          right = constant(node.right, seen);
        return left !== undefined && right !== undefined ? left + right : undefined;
      }
      if (ts.isTemplateExpression(node)) {
        let value = node.head.text;
        for (const span of node.templateSpans) {
          const item = constant(span.expression, seen);
          if (item === undefined) return undefined;
          value += item + span.literal.text;
        }
        return value;
      }
      if (ts.isPropertyAccessExpression(node)) {
        if (node.getText(source) === "import.meta.url") return pathToFileURL(path).href;
        if (["href", "pathname"].includes(node.name.text)) {
          const value = constant(node.expression, seen);
          if (value?.startsWith("file:"))
            return node.name.text === "href" ? value : new URL(value).pathname;
        }
      }
      if (ts.isNewExpression(node) && isURL(node.expression)) {
        const value = constant(node.arguments?.[0], seen),
          base = constant(node.arguments?.[1], seen);
        if (value !== undefined && base !== undefined) {
          try {
            return new URL(value, base).href;
          } catch {
            return undefined;
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const name = builtin(node.expression, "node:url") ?? builtin(node.expression, "node:path");
        const value = constant(node.arguments[0], seen);
        if (value === undefined) return undefined;
        if (name === "fileURLToPath" && value.startsWith("file:")) return fileURLToPath(value);
        if (name === "pathToFileURL" && isAbsolute(value)) return pathToFileURL(value).href;
        if (name === "dirname" && isAbsolute(value)) return dirname(value);
        if (["join", "resolve"].includes(name) && isAbsolute(value)) {
          const parts = node.arguments.map((argument) => constant(argument, seen));
          if (parts.every((part) => part !== undefined))
            return name === "join" ? join(...parts) : resolve(...parts);
        }
        // createRequire(...).resolve('dependency') selects an external package;
        // preserve its literal specifier without resolving installed dependencies.
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "resolve"
        ) {
          if (isRequire(node.expression.expression)) return value;
        }
      }
      return undefined;
    }
    function record(node, specifier, kind, typeOnly, bindings = ["*"]) {
      const normalizedSpecifier = specifier?.startsWith("file:")
        ? `file:${slash(relative(root, fileURLToPath(specifier)))}`
        : specifier && isAbsolute(specifier)
          ? `file:${slash(relative(root, specifier))}`
          : specifier;
      const edge = {
        from,
        to: "",
        specifier: normalizedSpecifier ?? node.getText(source),
        kind,
        bindings: bindings.sort(),
        typeOnly: typeOnly || source.isDeclarationFile,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      };
      if (specifier === undefined) {
        add(
          "unresolved-dynamic-import",
          edge,
          "Use a statically known module path or an exact reviewed external-loader exception.",
        );
        return;
      }
      if (
        matches(from, policy.domainSources) &&
        !matches(from, policy.domainInfrastructure) &&
        policy.implementationPackages.some(
          (name) => specifier === name || specifier.startsWith(`${name}/`),
        )
      )
        add(
          "domain-to-implementation",
          edge,
          "Domain code must not import concrete database, HTTP or provider dependencies.",
        );
      let targetPath;
      const named = packages.find(
        (pkg) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`),
      );
      if (named) {
        const subpath = specifier === named.name ? "." : `.${specifier.slice(named.name.length)}`;
        const target = exportedTarget(
          named.exports,
          subpath,
          edge.typeOnly,
          resolutionKind(node) ?? kind,
        );
        if (
          typeof target !== "string" ||
          !target.startsWith("./") ||
          !inside(slash(relative(root, resolve(root, named.path, target))), named.path)
        ) {
          add(
            "unsupported-package-export",
            edge,
            `Package ${named.name} does not expose ${subpath} for this import.`,
          );
          return;
        }
        targetPath = resolve(root, named.path, target);
      } else if (specifier.startsWith("file:")) {
        try {
          targetPath = fileURLToPath(specifier);
        } catch {
          add("unresolved-local-import", edge, "Invalid local module URL.");
          return;
        }
      } else if (specifier.startsWith(".") || isAbsolute(specifier))
        targetPath = resolve(dirname(path), specifier);
      else if (specifier.startsWith("#")) {
        add(
          "unresolved-local-import",
          edge,
          "Package import aliases are not supported by this policy; use an explicit supported export or local path.",
        );
        return;
      } else if (specifier.startsWith("@openclaw-enterprise/")) {
        add(
          "unknown-workspace-package",
          edge,
          "Workspace package is not registered in the boundary policy.",
        );
        return;
      } else return;
      edge.to = resolveFile(targetPath) ?? slash(relative(root, targetPath));
      // Package.json dependency anchors are not imports; actual source paths are.
      if (kind === "path" && !extensions.test(targetPath)) return;
      const dependencyAnchor =
        kind === "dependency-anchor" &&
        packages.some((pkg) => edge.to === `${pkg.path}/package.json`);
      if (!fileSet.has(edge.to) && !dependencyAnchor) {
        add(
          "unresolved-local-import",
          edge,
          "Local module is missing or outside the active source graph.",
        );
        return;
      }
      if (
        edges.some(
          (existing) =>
            existing.from === from &&
            existing.to === edge.to &&
            existing.kind === kind &&
            existing.typeOnly === edge.typeOnly &&
            existing.specifier === normalizedSpecifier &&
            JSON.stringify(existing.bindings) === JSON.stringify(edge.bindings),
        )
      )
        return;
      edges.push(edge);
      const sourceOwner = owner(from),
        targetOwner = owner(edge.to);
      if (!named && sourceOwner && targetOwner && sourceOwner !== targetOwner)
        add(
          "cross-package-source",
          edge,
          "Use a supported package export instead of another package's source path.",
        );
      // An application's HTTP entrypoint is composed by startup; library roots
      // are public barrels and may never be imported by their own leaves.
      if (
        sourceOwner?.path.startsWith("packages/") &&
        sourceOwner === targetOwner &&
        from !== `${sourceOwner.path}/src/index.ts` &&
        edge.to === `${sourceOwner.path}/src/index.ts`
      )
        add(
          "internal-root-barrel",
          edge,
          "Package leaves must import their owning leaf contracts instead of their root barrel.",
        );
      if (
        matches(from, policy.domainSources) &&
        !matches(from, policy.domainInfrastructure) &&
        (matches(edge.to, policy.implementationTargets) ||
          (inside(from, "packages/contracts/src") &&
            !inside(edge.to, "packages/contracts/src") &&
            !inside(edge.to, "packages/utils/src"))) &&
        !(
          inside(from, "apps/controller/src/worker") &&
          inside(edge.to, "apps/controller/src/worker")
        )
      ) {
        // The root public facade may re-export adapters; its service imports are checked.
        if (!(from === "packages/occ/src/index.ts" && kind === "export"))
          add(
            "domain-to-implementation",
            edge,
            "Domain code must consume neutral contracts, ports and errors rather than concrete storage, HTTP or provider implementations.",
          );
      }
      if (matches(from, policy.httpSources) && inside(edge.to, "apps/controller/src/drivers"))
        add(
          "http-to-provider",
          edge,
          "HTTP code must consume a domain service or neutral error contract.",
        );
      const provider = policy.providerRoots.find((item) => inside(from, item));
      if (
        provider &&
        policy.providerRoots.some((item) => item !== provider && inside(edge.to, item))
      )
        add(
          "cross-provider-implementation",
          edge,
          "Shared provider behavior must live in a provider-neutral module.",
        );
    }
    function visit(node) {
      if (ts.isImportDeclaration(node))
        record(
          node.moduleSpecifier,
          constant(node.moduleSpecifier),
          "import",
          node.importClause?.isTypeOnly ?? false,
          node.importClause
            ? [
                ...(node.importClause.name
                  ? [`${node.importClause.isTypeOnly ? "type" : "value"}:default`]
                  : []),
                ...(node.importClause.namedBindings &&
                ts.isNamedImports(node.importClause.namedBindings)
                  ? node.importClause.namedBindings.elements.map(
                      (item) =>
                        `${node.importClause.isTypeOnly || item.isTypeOnly ? "type" : "value"}:${(item.propertyName ?? item.name).text}`,
                    )
                  : node.importClause.namedBindings
                    ? ["*"]
                    : []),
              ]
            : [],
        );
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
        record(
          node.moduleSpecifier,
          constant(node.moduleSpecifier),
          "export",
          node.isTypeOnly,
          node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map(
                (item) =>
                  `${node.isTypeOnly || item.isTypeOnly ? "type" : "value"}:${(item.propertyName ?? item.name).text}`,
              )
            : ["*"],
        );
      else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
        record(node.argument.literal, constant(node.argument.literal), "import-type", true);
      else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      )
        record(
          node.moduleReference.expression,
          constant(node.moduleReference.expression),
          "require",
          node.isTypeOnly,
        );
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || isRequire(node.expression))
      )
        record(
          node.arguments[0] ?? node,
          constant(node.arguments[0]),
          node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic-import" : "require",
          false,
        );
      else if (
        ts.isCallExpression(node) &&
        builtin(node.expression, "node:module") === "createRequire"
      ) {
        const value = constant(node.arguments[0]);
        if (
          value &&
          (value.startsWith("file:") || isAbsolute(value)) &&
          value !== pathToFileURL(path).href &&
          value !== path
        )
          record(node.arguments[0], value, "dependency-anchor", false);
      } else if (ts.isNewExpression(node) && isURL(node.expression)) {
        const value = constant(node);
        if (value?.startsWith("file:") && extensions.test(new URL(value).pathname))
          record(node, value, "path", false);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const importEdges = edges.filter((edge) => !["path", "dependency-anchor"].includes(edge.kind));
  const runtimeCycles = components(
    files,
    importEdges.filter((edge) => !edge.typeOnly),
  );
  const typeInvolvingCycles = components(files, importEdges).filter((cycle) =>
    importEdges.some(
      (edge) => edge.typeOnly && cycle.includes(edge.from) && cycle.includes(edge.to),
    ),
  );
  const typeOnlyCycles = typeInvolvingCycles.filter(
    (cycle) => !runtimeCycles.some((runtime) => runtime.every((file) => cycle.includes(file))),
  );
  for (const members of runtimeCycles) {
    const cycleEdges = importEdges
      .filter((edge) => !edge.typeOnly && members.includes(edge.from) && members.includes(edge.to))
      .map(({ from, to, kind, specifier, bindings }) => [from, to, kind, specifier, bindings])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    add(
      "runtime-cycle",
      {
        from: members[0],
        to: members.join(" -> "),
        specifier: JSON.stringify(cycleEdges),
        kind: "cycle",
        typeOnly: false,
        line: 1,
      },
      "Runtime import cycle; members are reported in sorted order, not execution order.",
    );
  }
  const key = ({ rule, from, to, specifier, kind, typeOnly, bindings }) =>
    JSON.stringify([rule, from, to, specifier, kind, typeOnly, bindings]);
  const accepted = new Map();
  for (const exception of exceptions.exceptions) {
    if (
      ["rule", "from", "to", "specifier", "kind", "owner", "removeWhen", "reason"].some(
        (field) => typeof exception[field] !== "string",
      ) ||
      typeof exception.typeOnly !== "boolean" ||
      !Array.isArray(exception.bindings) ||
      exception.bindings.some((name) => typeof name !== "string") ||
      ["owner", "removeWhen", "reason"].some((field) => !exception[field].trim())
    )
      throw new Error(
        "Exceptions require an exact edge, reason, removal condition and capability owner.",
      );
    if (accepted.has(key(exception))) throw new Error("Duplicate module-boundary exception.");
    accepted.set(key(exception), exception);
  }
  const used = new Set(),
    violations = [],
    baseline = [];
  for (const diagnostic of diagnostics) {
    const identity = key(diagnostic),
      exception = accepted.get(identity);
    if (exception) {
      used.add(identity);
      baseline.push({ ...diagnostic, owner: exception.owner, removeWhen: exception.removeWhen });
    } else violations.push(diagnostic);
  }
  for (const [identity, exception] of accepted)
    if (!used.has(identity))
      violations.push({
        ...exception,
        rule: "stale-exception",
        line: 1,
        message: `Remove the obsolete ${exception.rule} exception with its resolved dependency.`,
      });
  const sort = (a, b) =>
    a.from.localeCompare(b.from) || a.line - b.line || a.rule.localeCompare(b.rule);
  violations.sort(sort);
  baseline.sort(sort);
  return {
    ok: violations.length === 0,
    files,
    edges,
    runtimeCycles,
    typeOnlyCycles,
    typeInvolvingCycles,
    violations,
    baseline,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let root = defaultRoot,
    json = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--json") json = true;
    else if (args[index] === "--root" && args[index + 1]) root = resolve(args[++index]);
    else
      throw new Error(
        "Usage: node scripts/verify-module-boundaries.mjs [--root directory] [--json]",
      );
  }
  const result = await verifyModuleBoundaries({ root });
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const policy = JSON.parse(
      await readFile(resolve(root, "scripts/module-boundaries/policy.json"), "utf8"),
    );
    for (const item of result.violations.slice(0, policy.diagnosticLimit))
      process.stderr.write(
        `${item.from}:${item.line} [${item.rule}] ${item.message} ${item.to || item.specifier}\n`,
      );
    if (result.violations.length > policy.diagnosticLimit)
      process.stderr.write(
        `${result.violations.length - policy.diagnosticLimit} additional violations; use --json for the full report.\n`,
      );
    process.stdout.write(
      `Module boundaries ${result.ok ? "verified" : "failed"}: ${result.files.length} sources, ${result.edges.length} local edges, ${result.baseline.length} explicit exceptions, ${result.runtimeCycles.length} runtime cycles, ${result.typeOnlyCycles.length} type-only cycle groups (${result.typeInvolvingCycles.length} type-involving groups), ${result.violations.length} violations.\n`,
    );
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main().catch((error) => {
    process.stderr.write(`Module boundary check failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
