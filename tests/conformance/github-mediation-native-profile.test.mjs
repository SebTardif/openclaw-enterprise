import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

test("native Git startup requires an explicit literal profile and matching original owner", () => {
  // These declarations only compile the actual public constructor/source types.
  // They never instantiate a native session, operation owner or authority grant.
  const filename = fileURLToPath(new URL("./native-github-profile-types.ts", import.meta.url));
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
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    allowImportingTsExtensions: true,
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, language, onError, fresh) =>
    path === filename
      ? ts.createSourceFile(filename, source, language, true)
      : original(path, language, onError, fresh);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
  assert.deepEqual(
    diagnostics.map((d) => ({
      line:
        d.file && d.start !== undefined
          ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
          : undefined,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    })),
    [],
  );
});
