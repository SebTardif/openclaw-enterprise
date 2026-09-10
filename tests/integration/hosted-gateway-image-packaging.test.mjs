import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const docker = process.env.OCC_DOCKER_BIN ?? "docker";
const image = process.env.OCC_TEST_HOSTED_GATEWAY_IMAGE;
const options =
  image === undefined
    ? { skip: "Set OCC_TEST_HOSTED_GATEWAY_IMAGE to the locally built hosted-gateway target." }
    : {};

async function run(args) {
  const name = `oce-hosted-image-${randomUUID()}`;
  try {
    return await execute(
      docker,
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--user=1000:1000",
        image,
        ...args,
      ],
      { timeout: 30000, maxBuffer: 1000000 },
    );
  } finally {
    // The CLI timeout does not prove container termination. Join removal of only
    // this attempt's exact random name, including a late/failed run.
    await execute(docker, ["rm", "--force", name], { timeout: 10000, maxBuffer: 1000000 }).catch(
      (error) => {
        if (!String(error.stderr).includes(`No such container: ${name}`)) throw error;
      },
    );
  }
}

test(
  "hosted image loads the real fixed gateway graph and preserves Runtime SDK custody",
  options,
  async () => {
    const { stdout } = await run([
      "--input-type=module",
      "-e",
      String.raw`
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { readFileSync, realpathSync, statSync } from "node:fs";
    import { loadGatewayCompositionFactories } from "/app/apps/gateway/src/composition.ts";
    import { main } from "/app/apps/gateway/src/main.mjs";
    const factories = await loadGatewayCompositionFactories();
    for (const name of ["host", "slack", "teams"]) assert.equal(typeof factories[name], "function");
    assert.equal(typeof main, "function");
    const gateway = createRequire("/app/apps/gateway/package.json");
    const contracts = createRequire("/app/packages/contracts/package.json");
    const full = realpathSync("/app/node_modules/openclaw");
    for (const source of ["/app/apps/gateway/node_modules/openclaw", "/app/packages/contracts/node_modules/openclaw"])
      assert.equal(realpathSync(source), full);
    for (const api of ["gateway-host", "slack-hosted", "msteams-hosted"])
      assert.ok(realpathSync(gateway.resolve("openclaw/plugin-sdk/" + api)).startsWith(full + "/"));
    assert.equal(gateway.resolve("openclaw/plugin-sdk/gateway-host"), contracts.resolve("openclaw/plugin-sdk/gateway-host"));
    for (const [name, resolver] of [["contracts", contracts]]) {
      const manifest = JSON.parse(readFileSync("/app/packages/" + name + "/package.json", "utf8"));
      assert.equal(name, "contracts");
      assert.equal(manifest.dependencies.typebox, "1.3.6");
      const selected = realpathSync("/app/packages/" + name + "/node_modules/typebox");
      assert.equal(JSON.parse(readFileSync(selected + "/package.json", "utf8")).version, manifest.dependencies.typebox);
      assert.ok(realpathSync(resolver.resolve("typebox")).startsWith(selected + "/"));
      assert.notEqual(selected, realpathSync("/app/node_modules/typebox"));
    }
    for (const path of ["/app/apps/gateway/src/main.mjs", "/app/packages/occ/src/gateway-startup-v1/owner.ts"]) {
      const info = statSync(path);
      assert.equal(info.uid, 0);
      assert.equal(info.mode & 0o222, 0);
    }
    process.stdout.write("fixed gateway graph and exact package selections loaded\n");
  `,
    ]);
    assert.equal(stdout, "fixed gateway graph and exact package selections loaded\n");
  },
);

test(
  "hosted image binds and executes the actual immutable native parser with owned pipes",
  options,
  async () => {
    const { stdout } = await run([
      "--input-type=module",
      "-e",
      String.raw`
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import { spawn } from "node:child_process";
    import { readFileSync, statSync } from "node:fs";
    import { nativeBinaryPath, nativeExecutableSha256 } from "/app/apps/gateway/src/installed-native.mjs";
    import { verifyGatewayNativeExecutableV1 } from "/app/apps/gateway/src/native-client-executable.ts";
    assert.equal(nativeBinaryPath, "/usr/local/bin/oce-runtime-authority");
    assert.match(nativeExecutableSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(nativeExecutableSha256, "sha256:" + createHash("sha256").update(readFileSync(nativeBinaryPath)).digest("hex"));
    for (const [path, mode] of [[nativeBinaryPath, 0o555], ["/usr/local/bin/oce-clock-observation", 0o555], ["/usr/local/bin/oce-github-mediation", 0o555], ["/app/apps/gateway/src/installed-native.mjs", 0o444]]) {
      const info = statSync(path); assert.equal(info.uid, 0); assert.equal(info.mode & 0o777, mode);
    }
    await verifyGatewayNativeExecutableV1(nativeBinaryPath, nativeExecutableSha256, new AbortController().signal);
    // Exercise the real native parser, with no credentials, sockets or accepted profile.
    const child = spawn(nativeBinaryPath, ["validate-gateway-startup-client-profile"], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    const output = [], errors = [];
    child.stdout.on("data", chunk => output.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({code, signal})); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const invalid = Buffer.from([0, 0, 0, 2, 123, 125]); // framed empty object
    child.stdin.end(invalid);
    const result = await done.finally(() => clearTimeout(timer));
    assert.deepEqual(result, {code: 1, signal: null});
    assert.equal(Buffer.concat(errors).length, 0);
    const response = Buffer.concat(output);
    assert.ok(response.length >= 4);
    assert.equal(response.readUInt32BE(0), response.length - 4);
    assert.deepEqual(JSON.parse(response.subarray(4)), {schemaVersion: 1, result: "invalid"});
    process.stdout.write("actual native binding and invalid-profile parser settled\n");
  `,
    ]);
    assert.equal(stdout, "actual native binding and invalid-profile parser settled\n");
  },
);

test(
  "fixed hosted launcher refuses missing protected launch inputs before admission",
  options,
  async () => {
    await assert.rejects(run([]), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.signal, null);
      assert.equal(error.stdout, "");
      assert.equal(
        error.stderr,
        "Hosted gateway unavailable: startup or cleanup is not confirmed.\n",
      );
      return true;
    });
  },
);
