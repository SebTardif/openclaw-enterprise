import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function preparedLauncher(t, stateName = "state with spaces") {
  const root = await mkdtemp(join(tmpdir(), "oce-openshell-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, stateName);
  const commandsPath = join(root, "commands.jsonl");
  await mkdir(bin);
  await mkdir(state);
  await writeFile(commandsPath, "");

  // Only external commands are fixtures. The real launcher owns environment parsing,
  // retained-state decisions, and file deletion; no cluster or model is started.
  const commandSource = `#!${process.execPath}\n${String.raw`
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.LAUNCHER_COMMANDS, JSON.stringify({
  command, args, literal: process.env.LAUNCHER_LITERAL,
}) + "\n");
if (command === "node") {
  if (args[0] !== "-p") process.exit(92);
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (command === "kubectl") {
  if (args.includes("delete")) process.exit(Number(process.env.LAUNCHER_DELETE_EXIT ?? "0"));
  if (args.includes("get") && args.includes("service")) process.stdout.write("fixture-openshell");
  if (args.includes("get") && args.includes("pods") && args.some(arg => arg.startsWith("--output=jsonpath="))) {
    process.stdout.write("fixture-agent");
  }
  if (args.includes("port-forward") && args.includes("0:8080")) {
    process.stdout.write("Forwarding from 127.0.0.1:32123 -> 8080\n");
    setInterval(() => {}, 1000);
  }
}
`}`;
  for (const command of ["node", "docker", "helm", "k3d", "kubectl", "openshell", "pbcopy"]) {
    await writeFile(join(bin, command), commandSource, { mode: 0o700 });
  }

  const demoPath = join(state, "demo.json");
  const demoBytes = `${JSON.stringify({
    namespace: "oce-ns-retained-demo",
    service: "retained-gateway",
    gatewayToken: "fixture-token",
  })}\n`;
  const environment = {
    OPENCLAW_ENTERPRISE_CI_STATE: join(state, "state.json"),
    OCC_KUBECTL_BIN: join(bin, "kubectl"),
    OCC_TEST_KUBERNETES_KUBECONFIG: join(state, "kube=config"),
    OCC_TEST_KUBERNETES_CONTEXT: "k3d-retained-demo",
    OCC_TEST_OPENSHELL_CLI: join(bin, "openshell"),
  };
  await writeFile(demoPath, demoBytes);
  await writeFile(environment.OPENCLAW_ENTERPRISE_CI_STATE, "{}\n");
  const writeEnvironment = async (extra = "") => {
    // prepare.mjs emits GitHub environment data, without shell quoting.
    await writeFile(
      join(state, "env"),
      Object.entries(environment)
        .map(([name, value]) => `${name}=${value}\n`)
        .join("") + extra,
    );
  };
  await writeEnvironment();

  return {
    root,
    state,
    demoPath,
    demoBytes,
    environment,
    writeEnvironment,
    async commands() {
      return (await readFile(commandsPath, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
    },
    run(action, extraEnvironment = {}) {
      return execute("scripts/openshell-local", [action], {
        timeout: 15_000,
        env: {
          ...process.env,
          OCC_OPENSHELL_CONTAINER_ENGINE: "docker",
          OCC_OPENSHELL_LOCAL_STATE_DIR: state,
          LAUNCHER_COMMANDS: commandsPath,
          OPENAI_API_KEY: "fixture-only",
          PATH: `${bin}:${process.env.PATH}`,
          ...extraEnvironment,
        },
      });
    },
  };
}

test("OpenShell Docker help shows only Docker commands", async () => {
  const { stdout } = await execute("scripts/openshell-local", ["help"], {
    env: {
      ...process.env,
      OCC_OPENSHELL_CONTAINER_ENGINE: "docker",
    },
  });

  assert.match(stdout, /pnpm openshell:docker:demo/);
  assert.doesNotMatch(stdout, /podman/i);
});

test("OpenShell Docker launcher does not require or invoke Podman", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oce-openshell-docker-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const command of ["docker", "helm", "k3d", "podman-compose"]) {
    const path = join(bin, command);
    await writeFile(path, "#!/bin/sh\nexit 0\n");
    await chmod(path, 0o700);
  }
  const podman = join(bin, "podman");
  await writeFile(podman, "#!/bin/sh\nexit 91\n");
  await chmod(podman, 0o700);

  const { stdout } = await execute("scripts/openshell-local", ["down"], {
    env: {
      ...process.env,
      OCC_OPENSHELL_CONTAINER_ENGINE: "docker",
      XDG_STATE_HOME: root,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });

  assert.match(
    stdout,
    /\[openshell:docker\] Checking Docker, k3d, Helm, and Node\.js prerequisites\./,
  );
  assert.match(stdout, /OpenShell Docker environment is already down\./);
  await access(join(root, "openclaw-enterprise", "openshell-docker"));
  await assert.rejects(access(join(root, "openclaw-enterprise", "openshell-podman")));
});

test("OpenShell demo refuses to replace retained state before reset", async (t) => {
  const launcher = await preparedLauncher(t);

  await assert.rejects(launcher.run("demo"));
  assert.equal(await readFile(launcher.demoPath, "utf8"), launcher.demoBytes);
  assert.deepEqual(
    await launcher.commands(),
    [],
    "refusal must not start preparation or a test runner",
  );
});

test("OpenShell reset preserves failed cleanup state and removes it only after exact namespace deletion", async (t) => {
  const launcher = await preparedLauncher(t, "state");
  const unrelatedPath = join(launcher.state, "unrelated.json");
  await writeFile(unrelatedPath, "retain me\n");

  // A failed kubectl deletion must leave the retained record available for retry.
  await assert.rejects(launcher.run("reset", { LAUNCHER_DELETE_EXIT: "41" }), { code: 41 });
  assert.equal(await readFile(launcher.demoPath, "utf8"), launcher.demoBytes);
  await launcher.run("reset");
  await assert.rejects(access(launcher.demoPath), { code: "ENOENT" });
  assert.equal(await readFile(unrelatedPath, "utf8"), "retain me\n");
  await access(join(launcher.state, "env"));
  await access(join(launcher.state, "state.json"));
  const deletions = (await launcher.commands()).filter(({ command }) => command === "kubectl");
  assert.equal(deletions.length, 2);
  for (const deletion of deletions) {
    assert.deepEqual(deletion.args, [
      "--kubeconfig",
      launcher.environment.OCC_TEST_KUBERNETES_KUBECONFIG,
      "--context",
      launcher.environment.OCC_TEST_KUBERNETES_CONTEXT,
      "delete",
      "namespace",
      "oce-ns-retained-demo",
      "--ignore-not-found=true",
      "--wait=true",
      "--timeout=120s",
    ]);
  }
});

for (const action of ["reset", "ui", "inspect"]) {
  test(`OpenShell ${action} loads environment values literally`, async (t) => {
    const launcher = await preparedLauncher(t);
    const sentinel = join(launcher.root, "must-not-execute");
    const literal = `spaces = 'single' "double" \\backslash $(touch '${sentinel}') \`touch '${sentinel}'\``;
    await launcher.writeEnvironment(`LAUNCHER_LITERAL=${literal}\n`);

    await launcher.run(action);

    const calls = (await launcher.commands()).filter(({ command }) =>
      ["kubectl", "openshell"].includes(command),
    );
    assert.ok(calls.length > 0, "the management command must reach its external boundary");
    for (const call of calls) assert.equal(call.literal, literal);
    const kubectlCalls = calls.filter(({ command }) => command === "kubectl");
    for (const call of kubectlCalls) {
      assert.equal(
        call.args[call.args.indexOf("--kubeconfig") + 1],
        launcher.environment.OCC_TEST_KUBERNETES_KUBECONFIG,
      );
    }
    await assert.rejects(access(sentinel), { code: "ENOENT" });
    if (action !== "reset") {
      assert.equal(await readFile(launcher.demoPath, "utf8"), launcher.demoBytes);
    }
  });
}

test("OpenShell rejects malformed environment assignments without executing them", async (t) => {
  const launcher = await preparedLauncher(t, "state");
  const sentinel = join(launcher.root, "must-not-execute");
  await launcher.writeEnvironment(`INVALID-NAME=$(touch '${sentinel}')\n`);

  await assert.rejects(launcher.run("reset"));

  assert.deepEqual(await launcher.commands(), [], "invalid environment must fail before kubectl");
  assert.equal(await readFile(launcher.demoPath, "utf8"), launcher.demoBytes);
  await assert.rejects(access(sentinel), { code: "ENOENT" });
});
