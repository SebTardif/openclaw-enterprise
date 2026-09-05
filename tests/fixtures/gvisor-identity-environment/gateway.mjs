import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const expiresAt = process.env.OCE_RUN11_EXPIRES_AT;
const deadline = Date.parse(expiresAt ?? "");
for (const key of Object.keys(process.env)) delete process.env[key];
process.umask(0o077);

const status = readFileSync("/proc/self/status", "utf8");
const limits = readFileSync("/proc/self/limits", "utf8");
if (
  process.platform !== "linux" ||
  process.arch !== "x64" ||
  process.getuid() !== 1000 ||
  !/^CapPrm:\s+0+$/m.test(status) ||
  !/^CapEff:\s+0+$/m.test(status) ||
  !/^CapBnd:\s+0+$/m.test(status) ||
  !/^NoNewPrivs:\s+1$/m.test(status) ||
  !/^Max open files\s+256\s+256\s+files\s*$/m.test(limits) ||
  !/^Max core file size\s+0\s+0\s+bytes\s*$/m.test(limits) ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiresAt ?? "") ||
  !Number.isFinite(deadline) ||
  deadline <= Date.now() ||
  deadline - Date.now() > 6 * 60 * 60 * 1_000
) {
  process.stderr.write("RUN11 gateway preflight failed\n");
  process.exit(1);
}

const sockets = new Set();
let stopping = false;
const server = createServer({ maxHeaderSize: 4_096 }, (req, res) => {
  res.setHeader("Connection", "close");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" || req.headers["content-length"] || req.headers["transfer-encoding"]) {
    res.writeHead(400).end('{"error":"unsupported_request"}\n');
    return;
  }
  if (req.url === "/readyz") {
    const ready = !stopping && Date.now() < deadline;
    res
      .writeHead(ready ? 200 : 503)
      .end(`${JSON.stringify({ ready, role: "RUN11 supporting HTTP gateway fixture" })}\n`);
    return;
  }
  res.writeHead(404).end('{"error":"not_found"}\n');
});
server.maxConnections = 8;
server.maxRequestsPerSocket = 1;
server.headersTimeout = 2_000;
server.requestTimeout = 2_000;
server.keepAliveTimeout = 1;
server.setTimeout(2_000, (socket) => socket.destroy());
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
server.on("upgrade", (_req, socket) => socket.destroy());
server.on("clientError", (_error, socket) => socket.destroy());
function stop(code) {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(code));
  for (const socket of sockets) socket.destroy();
  setTimeout(() => process.exit(1), 2_000).unref();
}
server.on("error", () => stop(1));
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
setTimeout(() => stop(0), deadline - Date.now());
server.listen(8080, "0.0.0.0");
