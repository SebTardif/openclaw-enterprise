import { rm, stat } from "node:fs/promises";

// Failed disposal leaves ownership records and credentials available for recovery.
export async function cleanupDevelopmentProfile(root, stateDirectory, down) {
  try {
    await stat(stateDirectory);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await rm(root, { recursive: true, force: true });
    return;
  }
  await down();
  await rm(root, { recursive: true, force: true });
}
