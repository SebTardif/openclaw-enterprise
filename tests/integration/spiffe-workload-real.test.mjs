import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createSpiffeWorkloadIdentitySource } from "../../apps/controller/src/identity/index.ts";

const socketPath = process.env.OCC_TEST_SPIFFE_SOCKET_PATH;
const expectedSpiffeId = process.env.OCC_TEST_SPIFFE_ID;
const audience = process.env.OCC_TEST_SPIFFE_AUDIENCE;
const selected = [socketPath, expectedSpiffeId, audience].some((value) => value !== undefined);

test(
  "real SPIRE Workload API issues and validates the selected local process identity",
  {
    skip: selected
      ? false
      : "Requires an explicitly provisioned real SPIRE Agent and OCC_TEST_SPIFFE_SOCKET_PATH, OCC_TEST_SPIFFE_ID, OCC_TEST_SPIFFE_AUDIENCE.",
    timeout: 35_000,
  },
  async () => {
    assert.ok(
      socketPath && expectedSpiffeId && audience,
      "All three explicit SPIRE test settings are required.",
    );
    const source = createSpiffeWorkloadIdentitySource({
      socketPath,
      expectedSpiffeId,
      timeoutMs: 5000,
    });
    try {
      // The external Agent attests this actual Node process. This proves local source
      // interoperability, not sandbox guest identity or any OCC authorization binding.
      await source.start();
      const metadata = source.getX509IdentityMetadata();
      assert.equal(metadata.spiffeId, expectedSpiffeId);
      assert.ok(Date.parse(metadata.expiresAt) > Date.now());
      assert.ok(metadata.certificateCount > 0);
      assert.ok(metadata.bundleCertificateCount > 0);
      const issued = await source.fetchJwtSvid({ audience });
      const validated = await source.validateJwtSvid({
        token: issued.token,
        audience,
        expectedSpiffeId,
      });
      assert.equal(validated.spiffeId, expectedSpiffeId);
      assert.equal(validated.expiresAt, issued.expiresAt);
      // SPIRE must reject another audience cryptographically; the component must
      // also refuse a valid token when the expected peer identity differs.
      await assert.rejects(
        source.validateJwtSvid({
          token: issued.token,
          audience: `${audience}:denied:${randomUUID()}`,
          expectedSpiffeId,
        }),
      );
      await assert.rejects(
        source.validateJwtSvid({
          token: issued.token,
          audience,
          expectedSpiffeId: `${expectedSpiffeId}-denied`,
        }),
        { code: "IDENTITY_MISMATCH" },
      );
    } finally {
      source.close();
    }
  },
);
