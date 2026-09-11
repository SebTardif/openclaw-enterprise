import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubAppTokenIssuerV1 } from "../../packages/occ/src/index.ts";
import { call, keyIdentity, providerFixture } from "../helpers/github-app-provider.mjs";

for (const cancellation of ["abort", "deadline"]) {
  test(
    `provider ${cancellation} joins original material finalizer without replay`,
    { timeout: 15000 },
    async (t) => {
      const f = await providerFixture(t);
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const provider = createGitHubAppTokenIssuerV1({
        ...f.options,
        material: {
          close() {
            f.material.close();
          },
          withJwt(key, bounds, consume) {
            return f.material.withJwt(key, bounds, async (jwt, check) => {
              const result = await consume(jwt, check);
              entered.resolve();
              await release.promise;
              return result;
            });
          },
        },
      });
      const abort = new AbortController();
      const attempt = call(cancellation === "deadline" ? 1500 : 5000);
      attempt.bounds.signal = abort.signal;
      const outward = provider.mint(attempt);
      t.after(async () => {
        release.resolve();
        const result = await outward;
        await provider.settleAttempt(result);
      });
      await entered.promise;
      const busy = await provider.mint(attempt);
      assert.equal(busy.kind, "not-dispatched");
      await provider.settleAttempt(busy);
      attempt.providerAttemptRef = "changed-after-dispatch";
      if (cancellation === "abort") abort.abort();
      const result = await outward;
      assert.equal(result.kind, "unknown");
      assert.equal(result.providerAttemptRef, "provider/fixture");
      assert.ok(f.captured.has(result.material));
      await assert.rejects(provider.settleAttempt({ ...result }));
      await assert.rejects(f.provider.settleAttempt(result));
      let settled = false;
      const drained = provider.settleAttempt(result).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "outward cancellation does not settle the original owner");
      await assert.rejects(f.material.withJwt(keyIdentity, call().bounds, async () => "busy"));
      release.resolve();
      await drained;
      assert.equal(
        await f.material.withJwt(keyIdentity, call().bounds, async () => "available"),
        "available",
      );
      assert.equal(result.kind, "unknown", "settlement cannot upgrade the prior result");
      assert.equal(f.requests.length, 1);
    },
  );
}
