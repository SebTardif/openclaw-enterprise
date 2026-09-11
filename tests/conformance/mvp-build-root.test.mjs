import assert from "node:assert/strict";
import { chown, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageNativeArtifact } from "../../scripts/build-mvp.mjs";

// Changing real file ownership requires a separately selected privileged Linux
// host. Keep ordinary build verification runnable by the unprivileged CI user.
test(
  "native staging rejects a real foreign owner",
  {
    skip:
      process.platform !== "linux" || process.getuid() !== 0
        ? "Requires privilege to create a genuinely foreign-owned file."
        : false,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "oce-native-owner-"));
    try {
      const source = join(directory, "source");
      await writeFile(source, "inert bytes", { mode: 0o755 });
      await chown(source, 65534, 65534);
      await assert.rejects(
        stageNativeArtifact(source, join(directory, "output")),
        /owned by root or the current user/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
