import { cp, mkdir, copyFile, rm } from "node:fs/promises";

const assets = new URL("./dist/assets/console/", import.meta.url);
await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
await cp(new URL("../../apps/controller/src/console/", import.meta.url), assets, {
  recursive: true,
});
// Match the shared contract modules served by the controller's console asset map.
for (const name of ["preset-variables.mjs", "workspace-defaults.mjs"]) {
  await copyFile(
    new URL(`../../packages/contracts/src/${name}`, import.meta.url),
    new URL(name, assets),
  );
}
