import assert from "node:assert/strict";
import { readFileSync, writeSync } from "node:fs";
import { ProtectedGitHubCustodyErrorV1 } from "../../../packages/occ/src/credential-custody-v1/protected-github-crypto.ts";
import { ProtectedGitHubTokenStoreV1 } from "../../../packages/occ/src/credential-custody-v1/protected-github-token-store.ts";

const [directory, envelopeFile, originalContext, sizeLimit] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert.match(sizeLimit, /^\d+$/);
const limits = readFileSync("/proc/self/limits", "utf8");
const fsize = limits.match(/^Max file size\s+(\d+)\s+(\d+)\s+bytes[ \t]*$/m);
const core = limits.match(/^Max core file size\s+(\d+)\s+(\d+)\s+bytes[ \t]*$/m);
assert.deepEqual(fsize?.slice(1), [sizeLimit, sizeLimit]);
assert.deepEqual(core?.slice(1), ["0", "0"]);
assert.deepEqual(Object.keys(process.env).sort(), ["LANG", "PATH"]);

const envelope = readFileSync(envelopeFile);
const store = new ProtectedGitHubTokenStoreV1({
  kind: "persistent-posix",
  directory,
  writerMode: "single",
});
assert.equal(store.read(originalContext), undefined);

// A real short write may either return EFBIG or terminate this isolated child
// with SIGXFSZ. The synchronous receipt proves the selected limits were active.
const emit = (event) => writeSync(1, JSON.stringify({ event }) + "\n");
emit("before-retain");
try {
  store.retain(originalContext, envelope);
  emit("unexpected-retain-success");
  process.exitCode = 42;
} catch (error) {
  assert.ok(error instanceof ProtectedGitHubCustodyErrorV1);
  emit("retain-rejected");
} finally {
  envelope.fill(0);
  store.close();
}
