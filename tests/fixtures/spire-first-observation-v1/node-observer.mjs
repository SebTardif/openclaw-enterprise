// Protected operator tooling only. Never include this file or Docker access in a Harness image.
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "oce.spire-first-node-observation/v1";
const DEFAULT_HANDLER = "oce-gvisor-systrap";
const FLAGS = ["--platform=systrap", "--sidecar-usage-policy=STRICT", "--network=none"];
const ID = /^[a-f0-9]{64}$/;
const UID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const COMMAND_BYTES = 1024 * 1024;
const TOTAL_BYTES = 8 * COMMAND_BYTES;

class ObservationFailure extends Error {
  constructor(code, ownedChild = null) {
    super(code);
    this.code = code;
    this.ownedChild = ownedChild;
  }
}
function requireFact(value, code) {
  if (!value) throw new ObservationFailure(code);
}
function optionsOf(input) {
  requireFact(input && typeof input === "object" && !Array.isArray(input), "INPUT_INVALID");
  const keys = [
    "nodeName",
    "podUID",
    "receiverPID",
    "expectedSentrySHA256",
    "expectedRuntimeFlags",
    "expectedRuntimeHandler",
    "timeoutMs",
    "dockerPath",
  ];
  requireFact(
    Object.keys(input).every((key) => keys.includes(key)),
    "INPUT_INVALID",
  );
  requireFact(
    typeof input.nodeName === "string" &&
      input.nodeName.length <= 63 &&
      /^k3d-[a-z0-9][a-z0-9-]*-server-0$/.test(input.nodeName),
    "INPUT_INVALID",
  );
  requireFact(typeof input.podUID === "string" && UID.test(input.podUID), "INPUT_INVALID");
  requireFact(
    Number.isSafeInteger(input.receiverPID) &&
      input.receiverPID > 0 &&
      input.receiverPID <= 4194304,
    "INPUT_INVALID",
  );
  requireFact(
    typeof input.expectedSentrySHA256 === "string" && ID.test(input.expectedSentrySHA256),
    "INPUT_INVALID",
  );
  requireFact(
    typeof input.dockerPath === "string" &&
      isAbsolute(input.dockerPath) &&
      input.dockerPath.length <= 4096 &&
      !/[\x00-\x1f\x7f]/.test(input.dockerPath),
    "INPUT_INVALID",
  );
  const timeoutMs = input.timeoutMs ?? 60000;
  requireFact(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60000,
    "INPUT_INVALID",
  );
  const expectedRuntimeFlags = input.expectedRuntimeFlags ?? FLAGS;
  const expectedRuntimeHandler = input.expectedRuntimeHandler ?? DEFAULT_HANDLER;
  requireFact(
    typeof expectedRuntimeHandler === "string" &&
      expectedRuntimeHandler.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(expectedRuntimeHandler),
    "INPUT_INVALID",
  );
  requireFact(
    Array.isArray(expectedRuntimeFlags) &&
      expectedRuntimeFlags.length >= 3 &&
      expectedRuntimeFlags.length <= 4 &&
      new Set(expectedRuntimeFlags).size === expectedRuntimeFlags.length &&
      FLAGS.every((flag) => expectedRuntimeFlags.includes(flag)) &&
      expectedRuntimeFlags.every((flag) => [...FLAGS, "--host-uds=open"].includes(flag)),
    "INPUT_INVALID",
  );
  return {
    ...input,
    timeoutMs,
    expectedRuntimeHandler,
    expectedRuntimeFlags: [...expectedRuntimeFlags],
  };
}
function result(startedAt, code, observation = null, ownedChild = null) {
  return {
    schemaVersion: VERSION,
    status: code === "OBSERVED" ? "observed" : "unqualified",
    reasonCode: code,
    startedAt,
    finishedAt: new Date().toISOString(),
    evidenceAuthenticated: false,
    identityQualified: false,
    custodyHeld: ownedChild !== null,
    ownedChild,
    observation,
  };
}
function safeCode(error) {
  return error instanceof ObservationFailure ? error.code : "OBSERVATION_INVALID";
}

// Observe the filesystem's actual creation principal: mapped filesystems can
// assign a fresh file a different UID from process.getuid(). Neither UID0 nor
// a configured owner is a substitute for this protected local observation.
export async function establishFilesystemOwner(parent) {
  let directoryFD;
  let probeFD;
  let probePath;
  let parentIdentity;
  let probeIdentity;
  let probeCreated = false;
  let probeSettled = true;
  let descriptorsSettled = true;
  let failure = null;
  let observed = null;
  const sameDirectory = (stat) =>
    stat.isDirectory() &&
    stat.dev === parentIdentity.dev &&
    stat.ino === parentIdentity.ino &&
    stat.uid === parentIdentity.uid &&
    (stat.mode & 0o7777) === 0o700;
  try {
    requireFact(
      typeof parent === "string" &&
        isAbsolute(parent) &&
        parent.length <= 4096 &&
        !/[\x00-\x1f\x7f]/.test(parent) &&
        realpathSync(parent) === parent,
      "FILESYSTEM_PARENT_INVALID",
    );
    directoryFD = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    );
    parentIdentity = fstatSync(directoryFD);
    requireFact(
      parentIdentity.isDirectory() &&
        (parentIdentity.mode & 0o7777) === 0o700 &&
        Number.isSafeInteger(parentIdentity.uid) &&
        parentIdentity.uid >= 0 &&
        sameDirectory(lstatSync(parent)),
      "FILESYSTEM_PARENT_INVALID",
    );
    const processUID = process.getuid();
    requireFact(
      Number.isSafeInteger(processUID) && processUID >= 0,
      "FILESYSTEM_PRINCIPAL_INVALID",
    );
    // Anchor creation and cleanup to the already opened directory incarnation.
    // This Linux operator fixture never follows a replacement at the input path.
    probePath = `/proc/self/fd/${directoryFD}/.oce-owner-probe-${randomBytes(16).toString("hex")}`;
    probeFD = openSync(
      probePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    probeCreated = true;
    probeSettled = false;
    probeIdentity = fstatSync(probeFD);
    requireFact(
      probeIdentity.isFile() &&
        (probeIdentity.mode & 0o7777) === 0o600 &&
        probeIdentity.nlink === 1 &&
        probeIdentity.size === 0 &&
        probeIdentity.uid === parentIdentity.uid,
      "FILESYSTEM_PRINCIPAL_MISMATCH",
    );
    requireFact(
      sameDirectory(fstatSync(directoryFD)) && sameDirectory(lstatSync(parent)),
      "FILESYSTEM_PARENT_CHANGED",
    );
    observed = {
      filesystemOwnerUID: probeIdentity.uid,
      processUID,
      provenance: "fresh-protected-file-observation",
      probeSettled: true,
    };
  } catch (error) {
    failure = error instanceof ObservationFailure ? error.code : "FILESYSTEM_PREFLIGHT_FAILED";
  } finally {
    if (probeFD !== undefined) {
      try {
        closeSync(probeFD);
      } catch {
        failure = "FILESYSTEM_PROBE_UNSETTLED";
        descriptorsSettled = false;
      }
    }
    if (probeCreated) {
      try {
        const current = lstatSync(probePath);
        requireFact(
          probeIdentity &&
            current.dev === probeIdentity.dev &&
            current.ino === probeIdentity.ino &&
            current.isFile() &&
            current.nlink === 1,
          "FILESYSTEM_PROBE_UNSETTLED",
        );
        unlinkSync(probePath);
        try {
          lstatSync(probePath);
        } catch (error) {
          if (error?.code === "ENOENT") probeSettled = true;
          else throw error;
        }
        requireFact(probeSettled, "FILESYSTEM_PROBE_UNSETTLED");
        requireFact(
          sameDirectory(fstatSync(directoryFD)) && sameDirectory(lstatSync(parent)),
          "FILESYSTEM_PARENT_CHANGED",
        );
      } catch (error) {
        failure = error instanceof ObservationFailure ? error.code : "FILESYSTEM_PROBE_UNSETTLED";
      }
    }
    if (directoryFD !== undefined) {
      try {
        closeSync(directoryFD);
      } catch {
        failure = "FILESYSTEM_PREFLIGHT_FAILED";
        descriptorsSettled = false;
      }
    }
  }
  probeSettled = probeSettled && descriptorsSettled;
  if (failure || !probeSettled || !observed) {
    const error = new ObservationFailure(failure ?? "FILESYSTEM_PROBE_UNSETTLED");
    error.probeSettled = probeSettled;
    error.custodyHeld = !probeSettled;
    throw error;
  }
  return observed;
}

function statIdentity(text, pid) {
  requireFact(typeof text === "string" && text.length <= 8192, "PROCESS_INVALID");
  const end = text.lastIndexOf(")");
  requireFact(end > 0 && text.slice(0, text.indexOf(" (")) === String(pid), "PROCESS_INVALID");
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  requireFact(
    fields.length >= 20 && /^[RSDIT]$/.test(fields[0]) && /^[1-9][0-9]{0,19}$/.test(fields[19]),
    "PROCESS_NOT_LIVE",
  );
  return fields[19]; // Linux proc stat field 22; comm can contain spaces and parentheses.
}
function effectiveIds(status) {
  requireFact(typeof status === "string" && status.length <= 65536, "PROCESS_INVALID");
  const get = (key) => {
    const matches = status.split("\n").filter((line) => line.startsWith(`${key}:`));
    requireFact(matches.length === 1, "PROCESS_INVALID");
    const values = matches[0]
      .slice(key.length + 1)
      .trim()
      .split(/\s+/);
    requireFact(
      values.length === 4 &&
        values.every((value) => /^[0-9]{1,10}$/.test(value) && Number(value) <= 4294967295),
      "PROCESS_INVALID",
    );
    return Number(values[1]);
  };
  return { effectiveUID: get("Uid"), effectiveGID: get("Gid") };
}
function processOf(raw, expectedPID) {
  requireFact(raw && raw.pid === expectedPID, "PROCESS_INVALID");
  const startTicks = statIdentity(raw.statBefore, expectedPID);
  requireFact(startTicks === statIdentity(raw.statAfter, expectedPID), "PROCESS_CHANGED");
  requireFact(
    typeof raw.pidNamespace === "string" && /^pid:\[[1-9][0-9]{0,19}\]$/.test(raw.pidNamespace),
    "PROCESS_INVALID",
  );
  requireFact(
    typeof raw.executableSHA256 === "string" && ID.test(raw.executableSHA256),
    "PROCESS_INVALID",
  );
  requireFact(
    typeof raw.cgroup === "string" && raw.cgroup.length <= 65536 && raw.cgroup.length > 0,
    "PROCESS_INVALID",
  );
  requireFact(
    typeof raw.cmdline === "string" && raw.cmdline.length <= 65536 && raw.cmdline.endsWith("\0"),
    "PROCESS_INVALID",
  );
  const args = raw.cmdline.slice(0, -1).split("\0");
  requireFact(
    args.length > 0 && args.length <= 256 && args.every((arg) => arg.length <= 8192),
    "PROCESS_INVALID",
  );
  return {
    pid: expectedPID,
    startTicks,
    pidNamespace: raw.pidNamespace,
    executableSHA256: raw.executableSHA256,
    ...effectiveIds(raw.status),
    args,
    cgroup: raw.cgroup,
  };
}
function safeProcess(process) {
  return {
    pid: process.pid,
    startTicks: process.startTicks,
    pidNamespace: process.pidNamespace,
    executableSHA256: process.executableSHA256,
    effectiveUID: process.effectiveUID,
    effectiveGID: process.effectiveGID,
    provenance: "protected-node-read",
  };
}
function sameProcess(a, b) {
  requireFact(
    JSON.stringify(safeProcess(a)) === JSON.stringify(safeProcess(b)) &&
      a.cgroup === b.cgroup &&
      JSON.stringify(a.args) === JSON.stringify(b.args),
    "PROCESS_CHANGED",
  );
}
// Match whole path/argument components, never a substring of a foreign ID.
function containsId(text, id) {
  return new RegExp(`(?:^|[^a-zA-Z0-9])${id}(?=$|[^a-zA-Z0-9])`).test(text);
}
function podBinding(process, podUID) {
  const podIDs = [
    ...process.cgroup.matchAll(
      /(?:^|[/_-])pod([a-f0-9]{8}[-_][a-f0-9]{4}[-_][a-f0-9]{4}[-_][a-f0-9]{4}[-_][a-f0-9]{12})(?=[/.\n]|$)/g,
    ),
  ].map((match) => match[1].replaceAll("_", "-"));
  requireFact(podIDs.length > 0 && podIDs.every((id) => id === podUID), "PEER_NOT_MAPPED");
}
function actualFlags(process, expected) {
  const selected = [];
  for (const name of ["platform", "sidecar-usage-policy", "network", "host-uds"]) {
    const found = process.args.filter((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
    requireFact(found.length <= 1, "RUNTIME_FLAGS_INVALID");
    if (found.length) selected.push(found[0]);
  }
  requireFact(
    FLAGS.every((flag) => selected.includes(flag)) &&
      selected.every((flag) => [...FLAGS, "--host-uds=open"].includes(flag)) &&
      expected.every((flag) => selected.includes(flag)),
    "RUNTIME_FLAGS_INVALID",
  );
  return selected;
}
function inventory(sandboxes, containers, podUID, expectedRuntimeHandler) {
  requireFact(
    Array.isArray(sandboxes) &&
      sandboxes.length <= 256 &&
      Array.isArray(containers) &&
      containers.length <= 256,
    "CRI_INVALID",
  );
  const selected = sandboxes.filter(
    (item) => item?.metadata?.uid === podUID || item?.labels?.["io.kubernetes.pod.uid"] === podUID,
  );
  // A second incarnation, even stopped, needs separate review rather than a preferred match.
  requireFact(selected.length === 1, "SANDBOX_AMBIGUOUS");
  const sandbox = selected[0];
  requireFact(
    ID.test(sandbox.id) &&
      sandbox.metadata?.uid === podUID &&
      sandbox.labels?.["io.kubernetes.pod.uid"] === podUID &&
      sandbox.state === "SANDBOX_READY" &&
      sandbox.runtimeHandler === expectedRuntimeHandler,
    "SANDBOX_INVALID",
  );
  const namespace = sandbox.metadata.namespace;
  const name = sandbox.metadata.name;
  requireFact(
    typeof namespace === "string" &&
      NAME.test(namespace) &&
      typeof name === "string" &&
      NAME.test(name),
    "CRI_INVALID",
  );
  const scoped = containers.filter(
    (item) =>
      item?.podSandboxId === sandbox.id || item?.labels?.["io.kubernetes.pod.uid"] === podUID,
  );
  requireFact(scoped.length > 0 && scoped.length <= 16, "CONTAINER_AMBIGUOUS");
  for (const item of scoped) {
    requireFact(
      ID.test(item.id) &&
        item.podSandboxId === sandbox.id &&
        item.labels?.["io.kubernetes.pod.uid"] === podUID &&
        item.state === "CONTAINER_RUNNING" &&
        typeof item.metadata?.name === "string" &&
        NAME.test(item.metadata.name),
      "CONTAINER_INVALID",
    );
  }
  requireFact(
    new Set(scoped.map((item) => item.id)).size === scoped.length &&
      new Set(scoped.map((item) => item.metadata.name)).size === scoped.length,
    "CONTAINER_AMBIGUOUS",
  );
  return {
    pod: { uid: podUID, namespace, name },
    sandbox: { id: sandbox.id, runtimeHandler: sandbox.runtimeHandler },
    containers: scoped
      .map((item) => ({ id: item.id, name: item.metadata.name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
function nodeOf(raw, name) {
  requireFact(
    raw &&
      raw.running === true &&
      typeof raw.id === "string" &&
      ID.test(raw.id) &&
      typeof raw.startedAt === "string" &&
      raw.startedAt.length <= 40 &&
      Number.isFinite(Date.parse(raw.startedAt)) &&
      /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(raw.startedAt),
    "NODE_INVALID",
  );
  return { name, id: raw.id, startedAt: raw.startedAt };
}

// Pure projection of protected observations, exported for parser/mapping unit checks.
// Calling this helper with synthetic data is not an executed node observation.
export function projectNodeObservation(input, snapshot) {
  const startedAt = new Date().toISOString();
  try {
    const options = optionsOf(input);
    const node = nodeOf(snapshot.nodeBefore, options.nodeName);
    requireFact(
      JSON.stringify(node) === JSON.stringify(nodeOf(snapshot.nodeAfter, options.nodeName)),
      "NODE_CHANGED",
    );
    const before = inventory(
      snapshot.sandboxesBefore,
      snapshot.containersBefore,
      options.podUID,
      options.expectedRuntimeHandler,
    );
    const after = inventory(
      snapshot.sandboxesAfter,
      snapshot.containersAfter,
      options.podUID,
      options.expectedRuntimeHandler,
    );
    requireFact(JSON.stringify(before) === JSON.stringify(after), "CRI_CHANGED");
    requireFact(
      Array.isArray(snapshot.sentriesBefore) &&
        snapshot.sentriesBefore.length === 1 &&
        Array.isArray(snapshot.sentriesAfter) &&
        snapshot.sentriesAfter.length === 1,
      "SENTRY_AMBIGUOUS",
    );
    const sentry = processOf(snapshot.sentriesBefore[0], snapshot.sentriesBefore[0].pid);
    const sentryAfter = processOf(snapshot.sentriesAfter[0], sentry.pid);
    sameProcess(sentry, sentryAfter);
    requireFact(
      sentry.args[0].split("/").at(-1) === "runsc-sandbox" &&
        sentry.executableSHA256 === options.expectedSentrySHA256,
      "SENTRY_INVALID",
    );
    podBinding(sentry, options.podUID);
    requireFact(
      sentry.args.some((arg) => containsId(arg, before.sandbox.id)),
      "SENTRY_NOT_MAPPED",
    );
    const runtimeFlags = actualFlags(sentry, options.expectedRuntimeFlags);
    const receiver = processOf(snapshot.receiverBefore, options.receiverPID);
    sameProcess(receiver, processOf(snapshot.receiverAfter, options.receiverPID));
    podBinding(receiver, options.podUID);
    requireFact(receiver.pidNamespace === sentry.pidNamespace, "PEER_NAMESPACE_MISMATCH");
    const componentName = receiver.args[0].split("/").at(-1);
    const component =
      receiver.pid === sentry.pid
        ? "sentry"
        : componentName === "runsc-gofer" &&
            receiver.executableSHA256 === options.expectedSentrySHA256
          ? "gofer"
          : "unknown";
    requireFact(component !== "unknown", "PEER_COMPONENT_UNKNOWN");
    if (component === "sentry") sameProcess(receiver, sentry);
    const references = receiver.cgroup + "\n" + receiver.args.join("\n");
    const mapped = before.containers.filter((item) => containsId(references, item.id));
    const sandboxMapped = containsId(references, before.sandbox.id);
    // Runtime peers can represent an entire sandbox: never pick one of several containers.
    requireFact(
      mapped.length <= 1 &&
        (mapped.length === 1 || (sandboxMapped && before.containers.length === 1)),
      "PEER_AMBIGUOUS",
    );
    requireFact(component !== "sentry" || before.containers.length === 1, "PEER_AMBIGUOUS");
    requireFact(
      component !== "gofer" || (mapped.length === 1 && containsId(receiver.cgroup, mapped[0].id)),
      "PEER_NOT_MAPPED",
    );
    const containerId = mapped[0]?.id ?? before.containers[0].id;
    return result(startedAt, "OBSERVED", {
      node,
      ...before,
      runtimeFlags,
      sentry: safeProcess(sentry),
      receiver: { ...safeProcess(receiver), component, containerId },
      mapping: { podUID: options.podUID, sandboxId: before.sandbox.id, containerId },
    });
  } catch (error) {
    return result(startedAt, safeCode(error));
  }
}

// This helper observes only an owned operator child. Synthetic/unit calls do not
// establish Docker, remote command, SPIRE or workload settlement. Raw bounded
// command output stays internal to observeNode and is never its result payload.
export async function waitForOwnedCommand(child, options, budget = { bytes: 0 }) {
  const {
    timeoutMs,
    settlementMs = 2000,
    identity,
    signalGroup = (pid) => process.kill(-pid, "SIGKILL"),
    // Unit-only association seam; observeNode never accepts or supplies it.
    // The default observes exactly the owned child's expected detached group.
    groupObservation = (pid) => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch (error) {
        return error?.code === "ESRCH" ? true : null;
      }
    },
  } = options;
  requireFact(typeof groupObservation === "function", "INPUT_INVALID");
  requireFact(
    Number.isFinite(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= 10000 &&
      Number.isInteger(settlementMs) &&
      settlementMs > 0 &&
      settlementMs <= 2000,
    "INPUT_INVALID",
  );
  requireFact(
    identity &&
      (identity.pid === null || (Number.isSafeInteger(identity.pid) && identity.pid > 0)) &&
      identity.processGroupID === identity.pid &&
      (identity.startTicks === null || /^[1-9][0-9]{0,19}$/.test(identity.startTicks)),
    "INPUT_INVALID",
  );
  return await new Promise((resolveCommand) => {
    let finished = false;
    let failure = null;
    let bytes = 0;
    let killRequested = false;
    let exitObserved = false;
    let directCloseObserved = false;
    let settlementTimer;
    const stdout = [];
    const groupAbsent = () => {
      if (identity.processGroupID === null) return null;
      try {
        const observation = groupObservation(identity.processGroupID);
        return observation === true || observation === false ? observation : null;
      } catch {
        return null;
      }
    };
    const finish = (reasonCode, held, processGroupAbsent = groupAbsent()) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(settlementTimer);
      let output = null;
      if (reasonCode === "COMMAND_OK") {
        try {
          output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
        } catch {
          reasonCode = "COMMAND_OUTPUT_INVALID";
        }
      }
      stdout.length = 0;
      if (held) {
        // Closing our pipes ends observation; it does not establish child exit.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      resolveCommand(
        Object.freeze({
          reasonCode,
          custodyHeld: held,
          ownedChild: held
            ? Object.freeze({
                pid: identity.pid,
                startTicks: identity.startTicks,
                processGroupID: identity.processGroupID,
                exitObserved,
                directCloseObserved,
                processGroupAbsent,
                killRequested,
                streamsClosed: true,
              })
            : null,
          output,
        }),
      );
    };
    const kill = (code) => {
      if (finished) return;
      failure ??= code;
      stdout.length = 0;
      // A failed signal or absent close must still reach a finite custody result.
      settlementTimer ??= setTimeout(
        () => finish("COMMAND_SETTLEMENT_UNKNOWN", true),
        settlementMs,
      );
      if (!killRequested && identity.processGroupID !== null) {
        killRequested = true;
        try {
          signalGroup(identity.processGroupID);
        } catch {
          /* no settlement is inferred */
        }
      }
    };
    const timer = setTimeout(() => kill("OBSERVATION_TIMEOUT"), timeoutMs);
    for (const [stream, retain] of [
      [child.stdout, true],
      [child.stderr, false],
    ]) {
      stream.on("data", (chunk) => {
        if (finished) return;
        bytes += chunk.length;
        budget.bytes += chunk.length;
        if (bytes > COMMAND_BYTES || budget.bytes > TOTAL_BYTES) kill("COMMAND_OUTPUT_LIMIT");
        else if (!failure && retain) stdout.push(chunk);
      });
      stream.on("error", () => {
        if (!finished) kill("COMMAND_FAILED");
      });
    }
    // Keep safe late-event listeners after finite return; no late error or close
    // may produce an unhandled exception or revise an already returned hold.
    child.on("error", () => {
      if (!finished) kill("COMMAND_FAILED");
    });
    child.on("exit", () => {
      exitObserved = true;
    });
    child.on("close", (code, signal) => {
      if (finished) return;
      directCloseObserved = true;
      // A direct close says nothing about descendants in the detached group.
      // Only the actual group's ESRCH observation permits command completion.
      if (code === null && signal === null && identity.pid !== null) {
        kill("COMMAND_FAILED");
        return;
      }
      const processGroupAbsent = groupAbsent();
      if (identity.pid !== null && processGroupAbsent !== true) {
        finish("COMMAND_SETTLEMENT_UNKNOWN", true, processGroupAbsent);
        return;
      }
      // A failed spawn with no assigned PID created no owned process group.
      // A PID-less successful close is insufficient evidence of settlement.
      if (identity.pid === null && code === 0) {
        finish("COMMAND_SETTLEMENT_UNKNOWN", true, null);
        return;
      }
      finish(
        failure ?? (code === 0 && !signal ? "COMMAND_OK" : "COMMAND_FAILED"),
        false,
        processGroupAbsent,
      );
    });
  });
}

// Remote reads also have their own timeout. Local Docker exit never establishes
// remote process termination. The caller retains any returned custody hold.
function commandRunner(options) {
  const deadline = performance.now() + options.timeoutMs;
  const budget = { bytes: 0 };
  return async (args) => {
    const remaining = deadline - performance.now();
    requireFact(remaining > 0, "OBSERVATION_TIMEOUT");
    let child;
    try {
      child = spawn(options.dockerPath, ["--host", "unix:///var/run/docker.sock", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
      });
    } catch {
      throw new ObservationFailure("COMMAND_FAILED");
    }
    const pid = child.pid ?? null;
    let startTicks = null;
    if (pid !== null) {
      try {
        startTicks = statIdentity(readFileSync(`/proc/${pid}/stat`, "utf8"), pid);
      } catch {
        /* absent identity remains explicit if settlement cannot be observed */
      }
    }
    const command = await waitForOwnedCommand(
      child,
      {
        timeoutMs: Math.min(10000, remaining),
        identity: { pid, startTicks, processGroupID: pid },
      },
      budget,
    );
    if (command.reasonCode !== "COMMAND_OK")
      throw new ObservationFailure(command.reasonCode, command.ownedChild);
    return command.output;
  };
}
export async function observeNode(input) {
  const startedAt = new Date().toISOString();
  try {
    const options = optionsOf(input);
    const docker = commandRunner(options);
    const exec = (...args) =>
      docker(["exec", options.nodeName, "timeout", "-s", "KILL", "8", ...args]);
    const node = async () =>
      JSON.parse(
        await docker([
          "inspect",
          options.nodeName,
          "--format",
          '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}}}',
        ]),
      );
    const sandboxes = async () =>
      JSON.parse(
        await exec(
          "crictl",
          "pods",
          "--label",
          `io.kubernetes.pod.uid=${options.podUID}`,
          "-o",
          "json",
        ),
      ).items;
    const containers = async (sandboxId) =>
      JSON.parse(await exec("crictl", "ps", "-a", "--pod", sandboxId, "-o", "json")).containers;
    const process = async (pid) => {
      requireFact(Number.isSafeInteger(pid) && pid > 0 && pid <= 4194304, "PROCESS_INVALID");
      const base = `/proc/${pid}`;
      const statBefore = await exec("cat", `${base}/stat`);
      const status = await exec("cat", `${base}/status`);
      const cgroup = await exec("cat", `${base}/cgroup`);
      const cmdline = await exec("cat", `${base}/cmdline`);
      const pidNamespace = (await exec("readlink", `${base}/ns/pid`)).trim();
      const hash = await exec("sha256sum", `${base}/exe`);
      requireFact(new RegExp(`^[a-f0-9]{64}  /proc/${pid}/exe\n$`).test(hash), "PROCESS_INVALID");
      const statAfter = await exec("cat", `${base}/stat`);
      return {
        pid,
        statBefore,
        statAfter,
        status,
        cgroup,
        cmdline,
        pidNamespace,
        executableSHA256: hash.slice(0, 64),
      };
    };
    const sentries = async (sandboxId) => {
      const lines = (await exec("ps", "-eo", "pid,args")).split("\n");
      requireFact(lines.length <= 8192, "PROCESS_LIST_LIMIT");
      const pids = lines
        .filter(
          (line) => /(?:^|\s|\/)runsc-sandbox(?:\s|$)/.test(line) && containsId(line, sandboxId),
        )
        .map((line) => Number(line.trim().split(/\s+/, 1)[0]));
      requireFact(pids.length === 1, "SENTRY_AMBIGUOUS");
      return [await process(pids[0])];
    };
    const snapshot = {};
    snapshot.nodeBefore = await node();
    nodeOf(snapshot.nodeBefore, options.nodeName);
    snapshot.sandboxesBefore = await sandboxes();
    requireFact(
      Array.isArray(snapshot.sandboxesBefore) &&
        snapshot.sandboxesBefore.length === 1 &&
        ID.test(snapshot.sandboxesBefore[0]?.id),
      "SANDBOX_AMBIGUOUS",
    );
    snapshot.containersBefore = await containers(snapshot.sandboxesBefore[0].id);
    const selected = inventory(
      snapshot.sandboxesBefore,
      snapshot.containersBefore,
      options.podUID,
      options.expectedRuntimeHandler,
    );
    snapshot.sentriesBefore = await sentries(selected.sandbox.id);
    snapshot.receiverBefore = await process(options.receiverPID);
    snapshot.receiverAfter = await process(options.receiverPID);
    snapshot.sentriesAfter = await sentries(selected.sandbox.id);
    snapshot.sandboxesAfter = await sandboxes();
    snapshot.containersAfter = await containers(selected.sandbox.id);
    snapshot.nodeAfter = await node();
    return { ...projectNodeObservation(options, snapshot), startedAt };
  } catch (error) {
    return result(
      startedAt,
      safeCode(error),
      null,
      error instanceof ObservationFailure ? error.ownedChild : null,
    );
  }
}

async function readInput() {
  let bytes = 0;
  const chunks = [];
  const timer = setTimeout(
    () => process.stdin.destroy(new ObservationFailure("INPUT_TIMEOUT")),
    5000,
  );
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      requireFact(bytes <= 8192, "INPUT_INVALID");
      chunks.push(chunk);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    // Reject overwritten explicit selections, including escaped-equivalent keys.
    // Skip entire JSON strings so colons embedded in a value are never keys.
    const keys = new Set();
    for (let offset = 0; offset < text.length; offset++) {
      if (text[offset] !== '"') continue;
      const start = offset++;
      while (offset < text.length) {
        if (text[offset] === "\\") offset += 2;
        else if (text[offset] === '"') break;
        else offset++;
      }
      requireFact(offset < text.length, "INPUT_INVALID");
      let next = offset + 1;
      while (/\s/.test(text[next] ?? "x")) next++;
      if (text[next] === ":") {
        const key = JSON.parse(text.slice(start, offset + 1));
        requireFact(!keys.has(key), "INPUT_INVALID");
        keys.add(key);
      }
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
    chunks.length = 0;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let output;
  try {
    requireFact(process.argv.length === 2, "INPUT_INVALID");
    output = await observeNode(await readInput());
  } catch (error) {
    output = result(new Date().toISOString(), safeCode(error));
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.status === "observed" ? 0 : 1;
}
