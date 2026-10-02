import { writeFileSync } from "node:fs";

writeFileSync("/tmp/openclaw-cpu-probe.pid", String(process.pid), { flag: "wx", mode: 0o600 });
for (;;) {
  // Stay runnable until the real Gateway wrapper kills this child at its cap.
}
