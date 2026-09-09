import assert from "node:assert/strict";
import test from "node:test";
import { generateApiReference } from "../../scripts/generate-occ-api-reference.mjs";

function reference(operation) {
  return generateApiReference({
    openapi: "3.0.3",
    info: { title: "Test API", version: "1.0.0" },
    paths: { "/resource": { get: { responses: { 200: { description: "OK" } }, ...operation } } },
  });
}

test("permission metadata without prose is never described as unrestricted", () => {
  const rendered = reference({
    "x-openclaw-permissions": [
      { action: "administer", resourceKind: "installation", scope: "requested" },
    ],
  });
  assert.match(rendered, /\*\*Permissions:\*\* Requires the IAM permissions below\./);
  assert.match(rendered, /\| `administer` \| `installation` \| `requested` \|/);
  assert.doesNotMatch(rendered, /No IAM permission required/);
});

test("explicit permission descriptions and empty permission sets retain their meaning", () => {
  assert.match(
    reference({ description: "Current resource authority is required." }),
    /\*\*Permissions:\*\* Current resource authority is required\./,
  );
  assert.match(
    reference({ "x-openclaw-permissions": [] }),
    /\*\*Permissions:\*\* No IAM permission required\./,
  );
});
