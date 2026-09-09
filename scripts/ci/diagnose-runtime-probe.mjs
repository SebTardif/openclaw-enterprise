// TODO: Remove this branch-only diagnostic after the provider startup failure is diagnosed.
import { execFile as rawExec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareCodexSeccompProfile } from "./codex-seccomp.mjs";
const run = promisify(rawExec);
const name = "openclaw-k8s-diag-provider";
const directory = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), `${name}-`));
const evidence = join(process.env.RUNNER_TEMP ?? tmpdir(), "probe-evidence");
await mkdir(evidence, { recursive: true, mode: 0o700 });
const kubeconfig = join(directory, "kubeconfig");
const tag = "localhost/oce-provider-diagnostic/runtime:local";
const node = `k3d-${name}-server-0`;
const kubectlArgs = ["--kubeconfig", kubeconfig, "--context", `k3d-${name}`];
async function command(bin, args, options = {}) {
  return run(bin, args, { timeout: options.timeoutMs ?? 600_000, maxBuffer: 30_000_000 });
}
async function capture(file, bin, args) {
  try {
    const result = await command(bin, args, { timeoutMs: 30_000 });
    await writeFile(join(evidence, file), result.stdout + result.stderr);
  } catch (error) {
    await writeFile(
      join(evidence, file),
      `${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    );
  }
}
async function resources(label) {
  await capture(`${label}-disk.txt`, "df", ["-h"]);
  await capture(`${label}-memory.txt`, "free", ["-m"]);
  await capture(`${label}-docker.txt`, "docker", ["system", "df"]);
}
async function execFile(bin, args, options = {}) {
  // Preserve real Pod evidence before the production helper deletes its namespace.
  if (bin === "kubectl" && args.includes("delete") && args.includes("namespace")) {
    const namespace = args[args.indexOf("namespace") + 1];
    await capture("pods.json", "kubectl", [
      ...kubectlArgs,
      "get",
      "pods",
      "-n",
      namespace,
      "-o",
      "json",
    ]);
    await capture("events.json", "kubectl", [
      ...kubectlArgs,
      "get",
      "events",
      "-n",
      namespace,
      "-o",
      "json",
    ]);
    await capture("nodes.json", "kubectl", [...kubectlArgs, "get", "nodes", "-o", "json"]);
    await capture("probe-logs.txt", "kubectl", [
      ...kubectlArgs,
      "logs",
      "-n",
      namespace,
      "-l",
      "openclaw.dev/ci-seccomp-probe=true",
      "--all-containers=true",
      "--prefix",
      "--tail=100",
    ]);
    await capture("k3s-logs.txt", "docker", ["logs", "--tail", "400", node]);
    await resources("failure-or-completion");
  }
  return command(bin, args, options);
}
let clusterCreated = false;
try {
  await resources("before");
  await capture("docker-info.txt", "docker", ["info"]);
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  clusterCreated = true;
  console.log("Creating disposable cluster");
  await command("k3d", [
    "cluster",
    "create",
    name,
    "--servers",
    "1",
    "--agents",
    "0",
    "--api-port",
    `127.0.0.1:${port}`,
    "--kubeconfig-update-default=false",
    "--kubeconfig-switch-context=false",
  ]);
  await writeFile(kubeconfig, (await command("k3d", ["kubeconfig", "get", name])).stdout, {
    mode: 0o600,
  });
  await command("kubectl", [
    ...kubectlArgs,
    "wait",
    "--for=condition=Ready",
    "nodes",
    "--all",
    "--timeout=120s",
  ]);
  console.log("Building repository runtime image");
  const build = await command("docker", [
    "build",
    "--pull=false",
    "-f",
    "deploy/runtime/Dockerfile",
    "-t",
    tag,
    "deploy/runtime",
  ]);
  await writeFile(join(evidence, "build.txt"), build.stdout + build.stderr);
  const platform = (
    await command("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", tag])
  ).stdout.trim();
  const archive = join(directory, "runtime.tar");
  await command("docker", ["image", "save", "--platform", platform, "--output", archive, tag]);
  const imported = await command("k3d", [
    "image",
    "import",
    "--mode",
    "direct",
    archive,
    "-c",
    name,
  ]);
  await writeFile(join(evidence, "import.txt"), imported.stdout + imported.stderr);
  await rm(archive);
  const listing = (await command("docker", ["exec", node, "ctr", "-n", "k8s.io", "images", "list"]))
    .stdout;
  await writeFile(join(evidence, "images-before-alias.txt"), listing);
  const digest = listing
    .split("\n")
    .find((line) => line.split(/\s+/)[0] === tag)
    ?.match(/sha256:[a-f0-9]{64}/)?.[0];
  if (!digest) throw new Error("Imported runtime manifest missing");
  const image = `${tag.slice(0, tag.lastIndexOf(":"))}@${digest}`;
  await command("docker", ["exec", node, "ctr", "-n", "k8s.io", "images", "tag", tag, image]);
  await capture("images.txt", "docker", ["exec", node, "ctr", "-n", "k8s.io", "images", "list"]);
  await command("docker", ["exec", node, "crictl", "inspecti", image]);
  console.log("Imported and verified", image);
  await resources("after-import");
  const result = await prepareCodexSeccompProfile({
    cluster: { name, directory, kubeconfig, context: `k3d-${name}` },
    image,
    execFile,
  });
  await writeFile(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log("Seccomp preparation passed");
} catch (error) {
  await writeFile(
    join(evidence, "error.txt"),
    `${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`,
  );
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (clusterCreated) {
    try {
      await command("k3d", ["cluster", "delete", name]);
    } catch (error) {
      console.error("Cleanup failed:", error.message);
      process.exitCode = 1;
    }
  }
  await rm(directory, { recursive: true, force: true });
}
