import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

const worker = new Worker(
  'require("node:worker_threads").parentPort.postMessage("running"); for (;;) {}',
  { eval: true },
);
// Worker "online" precedes script execution; wait until its loop is next.
await once(worker, "message");
writeFileSync("/tmp/openclaw-cpu-probe.pid", String(process.pid), { flag: "wx", mode: 0o600 });
for (;;) {
  // Both threads stay runnable until the real wrapper kills their process at its cap.
}
