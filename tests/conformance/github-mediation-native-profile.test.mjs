import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("native Git startup requires an explicit literal profile and matching original owner", (t) => {
  // These declarations only compile the actual public constructor/source types.
  // They never instantiate a native session, operation owner or authority grant.
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = mkdtempSync(join(root, "tests/.github-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = `
import { startGitHubMediationNative } from "../../apps/controller/src/admission/github-mediation-context.ts";
import type { GitHubMediationNativeOptions, GitHubMediationNativeServiceSource } from "../../apps/controller/src/admission/github-mediation-context.ts";
import type { GitHubMediationOperationOwner } from "../../packages/occ/src/github-mediation-v2/ports.ts";
declare const base: Omit<GitHubMediationNativeOptions, "operations" | "operationsFactory" | "protocolVersion">;
declare const metadataOwner: GitHubMediationOperationOwner<object, object>;
declare const gitOwner: GitHubMediationOperationOwner<object, object, 3>;
declare const metadataSource: GitHubMediationNativeServiceSource;
startGitHubMediationNative({ ...base, operations: metadataOwner });
startGitHubMediationNative({ ...base, protocolVersion: 3, operations: gitOwner });
startGitHubMediationNative({ ...base, protocolVersion: 3, operationsFactory: {
  create(source) { const selected: GitHubMediationNativeServiceSource<3> = source; void selected; return gitOwner; }
} });
// @ts-expect-error A Git owner cannot select its own startup profile.
startGitHubMediationNative({ ...base, operations: gitOwner });
// @ts-expect-error Metadata owner cannot become the Git operation owner.
startGitHubMediationNative({ ...base, protocolVersion: 3, operations: metadataOwner });
// @ts-expect-error A metadata factory cannot become the Git operation factory.
startGitHubMediationNative({ ...base, protocolVersion: 3, operationsFactory: { create() { return metadataOwner; } } });
// @ts-expect-error Explicit Git generic still requires startup selection.
startGitHubMediationNative<object, object, 3>({ ...base, operations: gitOwner });
// @ts-expect-error A union cannot substitute for one literal startup profile.
startGitHubMediationNative<object, object, 2 | 3>({ ...base, protocolVersion: 3, operations: gitOwner });
// @ts-expect-error A metadata source cannot widen through a union.
const widened: GitHubMediationNativeServiceSource<2 | 3> = metadataSource;
// @ts-expect-error A metadata source cannot acquire Git open declarations.
const adopted: GitHubMediationNativeServiceSource<3> = metadataSource;
`;
  const options = {
    noEmit: true,
    strict: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    target: "ES2022",
    module: "NodeNext",
    allowImportingTsExtensions: true,
  };
  writeFileSync(join(directory, "consumer.ts"), source);
  const project = join(directory, "tsconfig.json");
  writeFileSync(project, JSON.stringify({ compilerOptions: options, files: ["consumer.ts"] }));
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "--project", project, "--pretty", "false"],
    { cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
