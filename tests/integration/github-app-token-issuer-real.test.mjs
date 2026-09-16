import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { request } from "node:https";
import { isAbsolute } from "node:path";
import test from "node:test";
import {
  createGitHubAppMaterialV1,
  createGitHubAppTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
} from "../../apps/controller/src/providers/token/github/index.ts";

const selected = process.env.OCC_TEST_GITHUB_APP_REAL === "1";
const requiredNames = [
  "OCC_TEST_GITHUB_APP_CLIENT_ID",
  "OCC_TEST_GITHUB_APP_PRIVATE_KEY_PATH",
  "OCC_TEST_GITHUB_APP_INSTALLATION_ID",
  "OCC_TEST_GITHUB_APP_REPOSITORY_ID",
  "OCC_TEST_GITHUB_APP_REPOSITORY",
];

function positiveId(name) {
  const value = process.env[name];
  assert.ok(/^[1-9][0-9]*$/.test(value), `${name} must be a positive integer.`);
  const id = Number(value);
  assert.ok(Number.isSafeInteger(id), `${name} must be a safe integer.`);
  return id;
}

async function privateKeyFromFile(path) {
  assert.ok(isAbsolute(path), "The App private key path must be absolute.");
  let file;
  let pem;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    assert.ok(
      stat.isFile() && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= 16 * 1024,
      "The App key must be a bounded private file without group or other access.",
    );
    pem = await file.readFile();
    assert.ok(pem.length <= 16 * 1024, "The App private key file is too large.");
    return createPrivateKey(pem);
  } catch {
    throw new Error(
      "OCC_TEST_GITHUB_APP_PRIVATE_KEY_PATH must contain a readable private RSA key.",
    );
  } finally {
    pem?.fill(0);
    await file?.close();
  }
}

// This independent observation uses GitHub itself; it never substitutes for the
// production issuer's transport. Errors and assertions must not print API bodies.
async function repositoryInventory(bytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const req = request(
      "https://api.github.com/installation/repositories?per_page=2",
      {
        agent: false,
        rejectUnauthorized: true,
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${bytes.toString("utf8")}`,
          "User-Agent": "openclaw-enterprise-github-app-live-test",
          "X-GitHub-Api-Version": "2026-03-10",
          Connection: "close",
        },
      },
      (response) => {
        void (async () => {
          let body;
          try {
            for await (const chunk of response) {
              length += chunk.length;
              if (length > 256 * 1024) {
                chunk.fill(0);
                throw new Error("GitHub inventory response exceeded its bound.");
              }
              chunks.push(chunk);
            }
            const status = response.statusCode;
            // A redirect or denial remains an observed status; never follow it.
            body = Buffer.concat(chunks);
            const inventory = status === 200 ? JSON.parse(body.toString("utf8")) : undefined;
            resolve({ status, inventory });
          } catch {
            req.destroy();
            reject(new Error("The bounded GitHub repository inventory read failed."));
          } finally {
            body?.fill(0);
            for (const chunk of chunks) chunk.fill(0);
          }
        })();
      },
    );
    req.on("error", () => {
      reject(new Error("The bounded GitHub repository inventory request failed."));
    });
    req.end();
  });
}

test(
  "real GitHub App issuer mints one private repository read token and revokes its exact handle without the App key",
  {
    skip: selected
      ? false
      : "Set OCC_TEST_GITHUB_APP_REAL=1 with an authorized App key and private test repository.",
    timeout: 150_000,
  },
  async () => {
    for (const name of requiredNames) {
      assert.ok(process.env[name]?.trim(), `${name} is required when OCC_TEST_GITHUB_APP_REAL=1.`);
    }
    const installationId = positiveId("OCC_TEST_GITHUB_APP_INSTALLATION_ID");
    const repositoryId = positiveId("OCC_TEST_GITHUB_APP_REPOSITORY_ID");
    const fullName = process.env.OCC_TEST_GITHUB_APP_REPOSITORY;
    assert.ok(
      /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(fullName),
      "OCC_TEST_GITHUB_APP_REPOSITORY must select one owner/name.",
    );
    const privateKey = await privateKeyFromFile(process.env.OCC_TEST_GITHUB_APP_PRIVATE_KEY_PATH);
    const identity = {
      clientId: process.env.OCC_TEST_GITHUB_APP_CLIENT_ID,
      bindingRef: "test/github-app",
      immutableVersion: createHash("sha256")
        .update(createPublicKey(privateKey).export({ type: "spki", format: "der" }))
        .digest("hex"),
    };
    let keyCurrent = true;
    const material = createGitHubAppMaterialV1({
      privateKey,
      identity,
      clock: Date.now,
      assertCurrent() {
        assert.ok(keyCurrent, "The test's App key lease must remain current for minting.");
      },
    });
    // Test-owned staging proves live provider compatibility, not durable custody
    // or the regular Agent repository-read workflow, which remain separate gates.
    const captured = new Map();
    const custody = {
      capture(bytes, observation) {
        const handle = Object.freeze({});
        captured.set(handle, { bytes: Buffer.from(bytes), observation });
        return handle;
      },
      async withRevocationToken(handle, _bounds, consume) {
        assert.ok(captured.has(handle), "Cleanup requires this custody owner's original handle.");
        return consume(captured.get(handle).bytes);
      },
    };
    const attempts = new Set();
    const attempt = () => {
      const providerAttemptRef = `test/github-app/${randomUUID()}`;
      attempts.add(providerAttemptRef);
      return {
        providerAttemptRef,
        bounds: { signal: new AbortController().signal, deadline: Date.now() + 30_000 },
      };
    };
    const common = {
      clock: Date.now,
      endpoint: { kind: "github" },
      custody,
      assertDispatchCurrent(input) {
        assert.ok(attempts.has(input.providerAttemptRef), "Only this live test owns the attempt.");
      },
    };
    const issuer = createGitHubAppTokenIssuerV1({
      ...common,
      material,
      selection: {
        key: identity,
        installationId,
        repositories: [{ id: repositoryId, fullName }],
        permissions: { metadata: "read", contents: "read" },
      },
    });
    const revoker = createGitHubAppTokenRevokerV1(common);
    const revokeAttempted = new Set();
    async function revoke(handle) {
      // An unknown dispatched effect is not permission to replay a DELETE.
      revokeAttempted.add(handle);
      const result = await revoker.revoke(attempt(), handle);
      await revoker.settleAttempt(result);
      assert.equal(result.kind, "confirmed", "Exact-token cleanup must be confirmed by GitHub.");
    }
    let mintResult;
    try {
      mintResult = await issuer.mint(attempt());
      await issuer.settleAttempt(mintResult);
      assert.equal(
        mintResult.kind,
        "minted",
        "The real App key must mint the selected read scope.",
      );
      assert.equal(captured.size, 1);
      const retained = captured.get(mintResult.material);
      assert.ok(retained, "The minted result must retain the original captured handle.");
      assert.equal(retained.observation.scopeAccepted, true);
      const before = await repositoryInventory(retained.bytes);
      assert.equal(before.status, 200, "The newly minted token must authenticate with GitHub.");
      assert.ok(
        before.inventory?.total_count === 1 &&
          Array.isArray(before.inventory.repositories) &&
          before.inventory.repositories.length === 1,
        "The token must expose exactly one repository.",
      );
      const repository = before.inventory.repositories[0];
      assert.ok(
        repository.id === repositoryId &&
          typeof repository.full_name === "string" &&
          repository.full_name.toLowerCase() === fullName.toLowerCase() &&
          repository.private === true,
        "The token must expose the selected private test repository.",
      );

      // Losing signing material must not prevent mitigation of the retained token.
      keyCurrent = false;
      material.close();
      await revoke(mintResult.material);
      const after = await repositoryInventory(retained.bytes);
      assert.equal(after.status, 401, "GitHub must reject the exact token after revocation.");
    } finally {
      try {
        // A late or scope-invalid response can capture material without returning
        // it as minted. Join the original operation before enumerating obligations.
        if (mintResult) await issuer.settleAttempt(mintResult);
        keyCurrent = false;
        material.close();
        for (const handle of captured.keys()) {
          if (!revokeAttempted.has(handle)) await revoke(handle);
        }
      } finally {
        keyCurrent = false;
        material.close();
        for (const { bytes } of captured.values()) bytes.fill(0);
      }
    }
  },
);
