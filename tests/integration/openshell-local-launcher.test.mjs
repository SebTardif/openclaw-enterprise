import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

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
