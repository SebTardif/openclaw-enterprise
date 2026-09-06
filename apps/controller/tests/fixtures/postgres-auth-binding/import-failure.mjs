import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const expected = new Error("auth binding dependency could not load");
const dependency = process.argv[2];
assert.ok(["drizzle", "schema"].includes(dependency));
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Fail the real dependency boundary before its module is evaluated. The
    // factory itself is unchanged and must preserve this rejection identity.
    if (
      context.parentURL?.endsWith("/auth-persistence/postgres-auth-binding.ts") &&
      specifier ===
        (dependency === "drizzle" ? "drizzle-orm/node-postgres" : "../state/postgres-schema.ts")
    ) {
      throw expected;
    }
    return nextResolve(specifier, context);
  },
});
let connects = 0;
let ends = 0;
const pool = {
  async connect() {
    connects++;
    throw new Error("unexpected connect");
  },
  async end() {
    ends++;
  },
};
try {
  const { createPostgresAuthBinding } =
    await import("@openclaw-enterprise/occ/auth-persistence/postgres-auth-binding");
  await assert.rejects(createPostgresAuthBinding(pool), (error) => error === expected);
  assert.equal(connects, 0);
  assert.equal(ends, 0);
} finally {
  hooks.deregister();
}
