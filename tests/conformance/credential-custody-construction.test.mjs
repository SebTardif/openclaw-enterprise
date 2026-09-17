import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const gatewayRequire = createRequire(
  new URL("../../apps/credential-gateway/package.json", import.meta.url),
);
const entry = process.env.OCC_TEST_CUSTODY_CONSTRUCTION_ENTRY
  ? pathToFileURL(process.env.OCC_TEST_CUSTODY_CONSTRUCTION_ENTRY)
  : pathToFileURL(
      gatewayRequire.resolve(
        "@openclaw-enterprise/controller/internal/credential-custody-construction-v1",
      ),
    );

test("custody construction facade loads implemented values while deferred factories remain type-only", async () => {
  // Loading the real entry catches declaration-only value reexports before any
  // constructor or credential operation runs. Compiler fixtures cover their types.
  const facade = await import(entry);
  for (const name of [
    "createGitHubAppTokenIssuerV1",
    "createGitHubAppTokenRevokerV1",
    "prepareProtectedGitHubCredentials",
  ]) {
    assert.equal(typeof facade[name], "function", name);
  }
  for (const name of ["createOriginalGitHubIssuedMaterialOwnerV1", "createSqlEnvelopeOwnerV1"]) {
    assert.equal(Object.hasOwn(facade, name), false, name);
  }
});
