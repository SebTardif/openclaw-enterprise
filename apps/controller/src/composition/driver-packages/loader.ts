import { readFile, realpath } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ComputeDriver,
  ConfigurationDriver,
  DriverImplementation,
  IAMDriver,
  SandboxDriver,
} from "@openclaw-enterprise/contracts";
import type { NativeIAMStateStore } from "@openclaw-enterprise/iam";
import {
  object,
  nonempty,
  type ConfigurationRecord,
  type SelectedDriverConfiguration,
} from "../startup-config/schema.ts";

export interface ExternalDriverModule extends DriverImplementation {
  createDriver(options: {
    readonly id: string;
    readonly implementation: string;
    readonly configuration: ConfigurationRecord;
    readonly platformState?: NativeIAMStateStore;
    readonly getOperationAbortSignal?: () => AbortSignal | undefined;
  }): unknown;
}

export interface LoadedDriverPackage {
  readonly module: ExternalDriverModule;
  readonly implementation: string;
}

const PACKAGE_NAME = /^(?:@[a-zA-Z0-9][a-zA-Z0-9._~-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._~-]*$/;

function importEntrypoint(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const conditions = value as Record<string, unknown>;
  if (Object.hasOwn(conditions, ".")) return importEntrypoint(conditions["."]);
  for (const [condition, target] of Object.entries(conditions)) {
    if (condition !== "import" && condition !== "node" && condition !== "default") continue;
    const selected = importEntrypoint(target);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

export async function loadDriverPackage(
  selection: ConfigurationRecord,
  capability: "configuration" | "iam" | "compute" | "sandbox",
  packageRoot: string,
  allowFixtureTarball: boolean,
): Promise<LoadedDriverPackage | undefined> {
  if (!Object.hasOwn(selection, "package")) return undefined;

  const path = `drivers.${capability}`;
  const packageName = nonempty(selection.package, `${path}.package`);
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(`${path}.package must be one exact npm package name.`);
  }
  const ownerPath = resolve(packageRoot, "package.json");
  let owner: ConfigurationRecord;
  try {
    owner = object(JSON.parse(await readFile(ownerPath, "utf8")), "controller package.json");
  } catch {
    throw new Error(`${path}.package cannot read the controller package manifest.`);
  }
  const dependencies =
    owner.dependencies === undefined
      ? {}
      : object(owner.dependencies, "controller package.json dependencies");
  if (
    !Object.hasOwn(dependencies, packageName) ||
    typeof dependencies[packageName] !== "string" ||
    dependencies[packageName].trim().length === 0
  ) {
    throw new Error(`${path}.package must be a direct controller production dependency.`);
  }
  const dependencyVersion = dependencies[packageName];

  let installedManifestPath: string;
  try {
    const ownerUrl = pathToFileURL(ownerPath);
    const installed = findPackageJSON(packageName, ownerUrl);
    if (installed === undefined) throw new Error("package metadata unavailable");
    installedManifestPath = await realpath(installed);
  } catch {
    throw new Error(`${path}.package selects an unavailable installed Driver package.`);
  }

  let installedManifest: ConfigurationRecord;
  try {
    installedManifest = object(
      JSON.parse(await readFile(installedManifestPath, "utf8")),
      `${path}.package manifest`,
    );
  } catch {
    throw new Error(`${path}.package has invalid installed package metadata.`);
  }
  if (installedManifest.name !== packageName) {
    throw new Error(`${path}.package does not match the installed npm package name.`);
  }
  const installedVersion = nonempty(installedManifest.version, `${path}.package installed version`);
  if (
    dependencyVersion !== installedVersion &&
    !(allowFixtureTarball && /^file:.+\.tgz$/.test(dependencyVersion))
  ) {
    throw new Error(`${path}.package must be pinned to its exact installed production version.`);
  }
  const exportedEntrypoint = importEntrypoint(installedManifest.exports);
  if (exportedEntrypoint === undefined || !exportedEntrypoint.startsWith("./")) {
    throw new Error(`${path}.package must declare an exported compiled ESM entry.`);
  }
  let entryPath: string;
  try {
    entryPath = await realpath(
      createRequire(pathToFileURL(ownerPath)).resolve(
        resolve(dirname(installedManifestPath), exportedEntrypoint),
      ),
    );
  } catch {
    throw new Error(`${path}.package selects an unavailable compiled ESM entry.`);
  }
  const extension = extname(entryPath);
  if (extension !== ".mjs" && !(extension === ".js" && installedManifest.type === "module")) {
    throw new Error(`${path}.package must export precompiled JavaScript ESM.`);
  }
  const contained = relative(dirname(installedManifestPath), entryPath);
  if (contained === "" || contained.startsWith("..") || isAbsolute(contained)) {
    throw new Error(`${path}.package entry escapes its installed package root.`);
  }

  let imported: unknown;
  try {
    imported = await import(pathToFileURL(entryPath).href);
  } catch {
    throw new Error(`${path}.package failed to load its compiled Driver module.`);
  }
  const module = object(imported, `${path}.package exports`);
  if (
    typeof module.validateConfiguration !== "function" ||
    typeof module.createDriver !== "function"
  ) {
    throw new Error(`${path}.package must export Driver validation and a factory.`);
  }
  object(module.configurationSchema, `${path}.configurationSchema`);
  return Object.freeze({
    module: module as unknown as ExternalDriverModule,
    implementation: `${packageName}@${installedVersion}`,
  });
}

export function createExternalDriver(
  implementation: ExternalDriverModule,
  selection: SelectedDriverConfiguration,
  capability: "configuration" | "iam" | "compute" | "sandbox",
  platformState?: NativeIAMStateStore,
  getOperationAbortSignal?: () => AbortSignal | undefined,
): ConfigurationDriver | IAMDriver | ComputeDriver | SandboxDriver {
  if (capability === "iam" && typeof platformState?.loadNativeIAMState !== "function") {
    throw new Error("drivers.iam factory requires platform state.");
  }
  const created = object(
    implementation.createDriver({
      id: selection.id,
      implementation: selection.implementation,
      configuration: selection.configuration,
      ...(platformState === undefined ? {} : { platformState }),
      ...(capability === "compute" && getOperationAbortSignal !== undefined
        ? { getOperationAbortSignal }
        : {}),
    }),
    `drivers.${capability} factory result`,
  );
  if (
    created.capability !== capability ||
    created.id !== selection.id ||
    created.implementation !== selection.implementation
  ) {
    throw new Error(`drivers.${capability} factory returned an unselected Driver identity.`);
  }
  const methods = {
    configuration: ["create", "read", "update", "delete", "validate"],
    iam: ["lookupIdentity", "authorize"],
    compute: ["ensureNamespace", "deleteNamespace", "prepareRevision", "retireRevision"],
    sandbox: ["cleanup"],
  }[capability];
  if (methods.some((method) => typeof created[method] !== "function")) {
    throw new Error(`drivers.${capability} factory returned an invalid Driver contract.`);
  }
  if (
    capability === "sandbox" &&
    ((created.ensureNamespace !== undefined && typeof created.ensureNamespace !== "function") ||
      (created.provisionHarness !== undefined && typeof created.provisionHarness !== "function"))
  ) {
    throw new Error("drivers.sandbox factory returned invalid optional lifecycle hooks.");
  }
  if (
    capability === "compute" &&
    created.setLifecycleDrivers !== undefined &&
    typeof created.setLifecycleDrivers !== "function"
  ) {
    throw new Error("drivers.compute factory returned invalid lifecycle Driver wiring.");
  }
  return created as unknown as ConfigurationDriver | IAMDriver | ComputeDriver | SandboxDriver;
}
