import assert from "node:assert/strict";
import { createPostgresAuthBinding } from "@openclaw-enterprise/occ/auth-persistence/postgres-auth-binding";

const expected = new Error("caller pool inspection failed");
let connects = 0;
let ends = 0;
// The explicit client overload must not inspect caller-owned constructor
// accessors or accidentally reinterpret this resource as Drizzle configuration.
const pool = {
  get constructor() {
    throw expected;
  },
  async connect() {
    connects++;
    throw new Error("unexpected connect");
  },
  async end() {
    ends++;
  },
};
let result;
assert.doesNotThrow(() => {
  result = createPostgresAuthBinding(pool);
});
assert.ok(result instanceof Promise);
const binding = await result;
assert.strictEqual(binding.database.$client, pool);
assert.equal(connects, 0);
assert.equal(ends, 0);
