import test from "node:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { lstat, realpath, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  validateProfile,
  validatePodSecurity,
  PodSecurityError,
  validateObservedLifetime,
  ObservedLifetimeError,
  buildHarnessPod,
  buildRegistration,
  buildManagementManifests,
  normalizeObservedPod,
  matchesObservedResource,
} from "../fixtures/spire-first-observation-v1/profile.mjs";
import {
  parseFrame,
  projectDenial,
} from "../fixtures/spire-first-observation-v1/receiver-collector.mjs";
import {
  observeNode,
  establishFilesystemOwner,
  validateDockerConfiguration,
  dockerArguments,
  createLocalResourceCustody,
} from "../fixtures/spire-first-observation-v1/node-observer.mjs";

// This case consumes a separately prepared, exclusively owned environment. It
// owns only the two newly created Pods, returned entry IDs, and local helpers.
const SHA = /^[a-f0-9]{64}$/;
const UID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ENTRY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ENV = Object.freeze({ PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
class Failure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const need = (condition, code) => {
  if (!condition) throw new Failure(code);
};
const safeCode = (error) =>
  error instanceof Failure ||
  error instanceof PodSecurityError ||
  error instanceof ObservedLifetimeError
    ? error.code
    : "UNQUALIFIED";
function json(bytes) {
  try {
    return parseFrame(bytes);
  } catch {
    throw new Failure("JSON_INVALID_OR_LIMIT");
  }
}
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sortedSelectors(selectors) {
  need(Array.isArray(selectors) && selectors.length <= 16, "SELECTORS_INVALID");
  const values = selectors
    .map((s) => {
      need(
        typeof s?.type === "string" &&
          (/^[a-z_]+$/.test(s.type) || s.type === "k8s" || s.type === "k8s_psat") &&
          typeof s.value === "string" &&
          /^[A-Za-z0-9_./:-]{1,512}$/.test(s.value),
        "SELECTORS_INVALID",
      );
      return `${s.type}:${s.value}`;
    })
    .sort();
  need(new Set(values).size === values.length, "SELECTORS_DUPLICATE");
  return values;
}
function idString(id) {
  need(id && typeof id.trust_domain === "string" && typeof id.path === "string", "ID_INVALID");
  const value = `spiffe://${id.trust_domain}${id.path}`;
  need(
    /^spiffe:\/\/[a-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(value) && value.length <= 512,
    "ID_INVALID",
  );
  return value;
}
// Validate all security-relevant entry metadata; the server's batch status is
// authoritative even when the CLI exits zero and echoes the submitted entry.
export function validateEntry(entry, expected, expectedID) {
  need(
    entry &&
      typeof entry.id === "string" &&
      ENTRY_ID.test(entry.id) &&
      (!expectedID || entry.id === expectedID),
    "ENTRY_ID_INVALID",
  );
  need(
    idString(entry.spiffe_id) === expected.spiffeID &&
      idString(entry.parent_id) === expected.parentID,
    "ENTRY_AUTHORITY_MISMATCH",
  );
  need(
    same(sortedSelectors(entry.selectors), sortedSelectors(expected.selectors)),
    "ENTRY_SELECTOR_MISMATCH",
  );
  need(
    entry.hint === "" &&
      entry.x509_svid_ttl === 300 &&
      entry.admin === false &&
      entry.downstream === false &&
      entry.store_svid === false,
    "ENTRY_PRIVILEGES_INVALID",
  );
  need(
    Array.isArray(entry.federates_with) &&
      entry.federates_with.length === 0 &&
      Array.isArray(entry.dns_names) &&
      entry.dns_names.length === 0,
    "ENTRY_PRIVILEGES_INVALID",
  );
  need(
    entry.expires_at === "0" &&
      (!entry.additional_attributes || Object.keys(entry.additional_attributes).length === 0),
    "ENTRY_PRIVILEGES_INVALID",
  );
  return entry.id;
}
export function successfulBatch(response) {
  need(
    Array.isArray(response?.results) &&
      response.results.length === 1 &&
      response.results[0]?.status?.code === 0,
    "BATCH_STATUS_FAILED",
  );
  return response.results[0];
}
async function privateFile(filename, expected, filesystemOwnerUID, mode = 0o600) {
  need(path.isAbsolute(filename) && (await realpath(filename)) === filename, "FILE_NOT_CANONICAL");
  const info = await lstat(filename),
    parent = await lstat(path.dirname(filename));
  need(
    parent.isDirectory() && parent.uid === filesystemOwnerUID && (parent.mode & 0o777) === 0o700,
    "PRIVATE_PARENT_INVALID",
  );
  need(
    info.isFile() &&
      info.uid === filesystemOwnerUID &&
      (info.mode & 0o777) === mode &&
      info.nlink === 1 &&
      info.size <= 16384,
    "PRIVATE_FILE_INVALID",
  );
  const bytes = await readFile(filename);
  need(digest(bytes) === expected, "FILE_HASH_MISMATCH");
  return bytes;
}
async function binary(filename, expected) {
  need((await realpath(filename)) === filename, "TOOL_NOT_CANONICAL");
  const info = await lstat(filename);
  need(
    info.isFile() &&
      (info.mode & 0o022) === 0 &&
      (info.mode & 0o111) !== 0 &&
      info.size <= 256 * 1024 * 1024,
    "TOOL_INVALID",
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  need(hash.digest("hex") === expected, "TOOL_HASH_MISMATCH");
}
async function receipts(directory, filesystemOwnerUID) {
  const parent = path.dirname(directory),
    info = await lstat(parent);
  need(
    (await realpath(parent)) === parent &&
      info.isDirectory() &&
      info.uid === filesystemOwnerUID &&
      (info.mode & 0o777) === 0o700,
    "EVIDENCE_PARENT_INVALID",
  );
  await mkdir(directory, { mode: 0o700 }); // Exclusive: never append to an earlier observation.
  const createdDirectory = await lstat(directory);
  need(
    createdDirectory.uid === filesystemOwnerUID && (createdDirectory.mode & 0o777) === 0o700,
    "EVIDENCE_OWNER_INVALID",
  );
  let previous = null,
    sequence = 0,
    total = 0;
  return async (event, data) => {
    need(++sequence <= 64, "RECEIPT_LIMIT");
    const record = {
      schemaVersion: 1,
      sequence,
      previousSHA256: previous,
      observedAt: new Date().toISOString(),
      event,
      ...data,
    };
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    total += bytes.length;
    need(bytes.length <= 16384 && total <= 131072, "RECEIPT_LIMIT");
    const target = path.join(directory, `${String(sequence).padStart(3, "0")}.json`);
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    const info = await lstat(target);
    need(
      info.uid === filesystemOwnerUID && (info.mode & 0o777) === 0o600 && info.nlink === 1,
      "RECEIPT_OWNER_INVALID",
    );
    previous = digest(bytes);
  };
}

// Every child has bounded output and a deadline. A close event, rather than a
// signal attempt, is the local process settlement observation.
function processes() {
  const active = new Set();
  let totalBytes = 0;
  function launch(
    executable,
    args,
    deadline,
    { input, interactive = false, maxBytes = 16384 } = {},
  ) {
    need(Date.now() < deadline, "DEADLINE_EXPIRED");
    const child = spawn(executable, args, {
      env: ENV,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const state = {
      child,
      closed: false,
      records: [],
      failure: null,
      stdout: [],
      receivedAt: [],
      bytes: 0,
      startTicks: null,
    };
    if (child.pid) {
      try {
        const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
        state.startTicks = stat
          .slice(stat.lastIndexOf(")") + 2)
          .trim()
          .split(/\s+/)[19];
      } catch {
        /* missing identity stays unobserved */
      }
    }
    let killSent = false,
      release,
      settleTimer;
    const finish = () => {
      if (release) {
        release(state);
        release = null;
      }
    };
    active.add(state);
    const kill = () => {
      if (killSent || state.closed || state.held) return;
      killSent = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* close decides */
        }
      }
      settleTimer = setTimeout(() => {
        state.failure = "CHILD_SETTLEMENT_UNKNOWN";
        state.held = true;
        state.heldIdentity = {
          pid: child.pid ?? null,
          processGroup: child.pid ?? null,
          startTicks: state.startTicks,
          closeObserved: false,
        };
        clearTimeout(timer);
        // Release parent handles, without turning this into an exit observation.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish();
      }, 5000);
    };
    state.kill = kill;
    const timer = setTimeout(
      () => {
        state.failure ??= "CHILD_TIMEOUT";
        kill();
      },
      Math.max(1, deadline - Date.now()),
    );
    let pending = Buffer.alloc(0),
      stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      state.bytes += chunk.length;
      totalBytes += chunk.length;
      if (state.bytes > maxBytes || totalBytes > 1024 * 1024) {
        state.failure ??= "CHILD_OUTPUT_LIMIT";
        kill();
        return;
      }
      if (state.failure) return;
      if (!interactive) {
        state.stdout.push(chunk);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      try {
        while (pending.includes(10)) {
          const end = pending.indexOf(10),
            record = json(pending.subarray(0, end));
          pending = pending.subarray(end + 1);
          need(state.records.length < 4, "OBSERVER_RECORD_LIMIT");
          state.records.push(record);
          state.receivedAt.push(Date.now());
        }
      } catch {
        state.failure = "OBSERVER_OUTPUT_INVALID";
        kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      totalBytes += chunk.length;
      if (stderrBytes > maxBytes || totalBytes > 1024 * 1024) {
        state.failure ??= "CHILD_OUTPUT_LIMIT";
        kill();
      }
    });
    child.stdin.on("error", () => {
      state.failure ??= "CHILD_INPUT_FAILED";
    });
    child.on("error", () => {
      state.failure ??= "CHILD_FAILED";
    });
    state.done = new Promise((resolve) => {
      release = resolve;
      child.on("close", (code, signal) => {
        if (state.held) return; // Preserve the disposition at the settlement deadline.
        clearTimeout(timer);
        clearTimeout(settleTimer);
        state.closed = true;
        state.code = code;
        state.signal = signal;
        if (pending.length || stderrBytes) state.failure ??= "CHILD_OUTPUT_INVALID";
        let groupAbsent = !child.pid;
        if (child.pid) {
          try {
            process.kill(-child.pid, 0);
          } catch (error) {
            groupAbsent = error.code === "ESRCH";
          }
        }
        state.processGroupAbsent = groupAbsent;
        if (!groupAbsent) {
          state.failure = "CHILD_PROCESS_GROUP_SETTLEMENT_UNKNOWN";
          state.held = true;
          state.heldIdentity = {
            pid: child.pid,
            processGroup: child.pid,
            startTicks: state.startTicks,
            closeObserved: true,
            processGroupAbsent: false,
          };
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        } else active.delete(state);
        finish();
      });
    });
    if (!interactive) child.stdin.end(input);
    return state;
  }
  async function command(executable, args, deadline, options) {
    const s = await launch(executable, args, deadline, options).done;
    need(s.closed && !s.failure && s.code === 0 && !s.signal, s.failure ?? "COMMAND_FAILED");
    return Buffer.concat(s.stdout);
  }
  return {
    launch,
    command,
    active,
    async settle(deadline) {
      for (const s of active) {
        s.child.stdin.end();
        s.kill();
      }
      while (active.size && Date.now() < deadline)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))),
        );
      return active.size === 0;
    },
  };
}
async function pause(ms, deadline) {
  need(Date.now() + ms < deadline, "DEADLINE_EXPIRED");
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function recordAt(state, index, deadline) {
  while (state.records.length <= index && !state.closed && !state.failure)
    await pause(25, deadline);
  need(!state.failure && state.records.length > index, state.failure ?? "OBSERVER_RECORD_MISSING");
  return state.records[index];
}
function liveCounts(record, phase) {
  need(
    record.connection?.dialAttempts === 1 &&
      record.connection.connectionBegins === 1 &&
      record.connection.connectionEnds === 0,
    "CONNECTION_AMBIGUOUS",
  );
  need(
    Array.isArray(record.rpc) &&
      record.rpc.length === 2 &&
      record.rpc[0].phase === 1 &&
      record.rpc[1].phase === 2 &&
      record.rpc[0].begins === 1 &&
      record.rpc[0].ends === 1 &&
      record.rpc[0].responses === 0 &&
      record.rpc[0].endCode === "PermissionDenied",
    "DENIAL_RPC_INVALID",
  );
  if (phase === 2)
    need(
      record.rpc[1].begins === 1 &&
        record.rpc[1].ends === 1 &&
        record.rpc[1].responses === 1 &&
        record.rpc[1].endCode === "Canceled",
      "DELIVERY_RPC_INVALID",
    );
  else
    need(
      record.rpc[1].begins === 0 && record.rpc[1].ends === 0 && record.rpc[1].responses === 0,
      "DENIAL_RPC_INVALID",
    );
}
function delivery(record, expectedID) {
  liveCounts(record, 2);
  need(
    record.event === "delivered" &&
      record.fetchReturned === true &&
      record.streamEndCode === "Canceled" &&
      record.localStreamCancellation === true &&
      record.entryCount === 1,
    "DELIVERY_INVALID",
  );
  need(
    Array.isArray(record.identities) &&
      record.identities.length === 1 &&
      record.identities[0].spiffeId === expectedID,
    "FULL_SET_MISMATCH",
  );
  const identity = record.identities[0];
  need(
    SHA.test(identity.certificateSHA256) &&
      Date.parse(identity.notBefore) <= Date.now() &&
      Date.parse(identity.notAfter) > Date.now() + 30000,
    "CERTIFICATE_METADATA_INVALID",
  );
  need(
    Array.isArray(record.bundles) &&
      record.bundles.length >= 1 &&
      record.bundles.length <= 4 &&
      record.bundles.every(
        (b) =>
          typeof b.trustDomain === "string" &&
          /^[a-z0-9.-]{1,253}$/.test(b.trustDomain) &&
          SHA.test(b.sha256) &&
          Number.isSafeInteger(b.authorityCount) &&
          b.authorityCount > 0 &&
          b.authorityCount <= 16,
      ),
    "BUNDLE_METADATA_INVALID",
  );
  return {
    entryCount: 1,
    identities: [
      {
        spiffeId: identity.spiffeId,
        certificateSHA256: identity.certificateSHA256,
        notBefore: identity.notBefore,
        notAfter: identity.notAfter,
      },
    ],
    bundles: record.bundles.map((b) => ({
      trustDomain: b.trustDomain,
      authorityCount: b.authorityCount,
      sha256: b.sha256,
    })),
    connection: { dialAttempts: 1, connectionBegins: 1, connectionEnds: 0 },
  };
}

// Fixed owner-selected endpoints only; no application bytes are sent. Timeout
// and connection refusal do not establish the selected network-none boundary.
const guestNetworkCheck = `
const os=require('node:os'), net=require('node:net');
(async()=>{
 const interfaces=Object.values(os.networkInterfaces()).flat().filter(Boolean);
 const loopbackOnly=interfaces.every(i=>i.internal===true);
 const results=[];
 for(const target of JSON.parse(process.argv[1])) {
  const code=await new Promise(resolve=>{
   const s=net.createConnection({host:target.host,port:target.port});let result='UNKNOWN';
   const timer=setTimeout(()=>{result='TIMEOUT';s.destroy()},2500);
   s.on('connect',()=>{result='CONNECTED';s.destroy()});
   s.on('error',e=>{result=['ENETUNREACH','EHOSTUNREACH','EAFNOSUPPORT'].includes(e.code)?e.code:'OTHER';s.destroy()});
   s.on('close',()=>{clearTimeout(timer);resolve(result)});
  });
  results.push({target:target.name,code});
 }
 process.stdout.write(JSON.stringify({loopbackOnly,interfaceCount:interfaces.length,results})+'\\n');
})().catch(()=>{process.stdout.write('{"failed":true}\\n');process.exitCode=1});
`;

async function runObservation(profile, emit, filesystemOwnerUID) {
  const dockerConfig = {
    dockerConfigDirectory: profile.cluster.dockerConfigDirectory,
    dockerConfigSHA256: profile.cluster.dockerConfigSHA256,
    filesystemOwnerUID,
  };
  const localResourceCustody = createLocalResourceCustody();
  const writeReceipt = emit;
  let receiptFailed = false;
  emit = async (...args) => {
    try {
      await writeReceipt(...args);
    } catch (error) {
      localResourceCustody.recordFailure(error);
      receiptFailed = true;
    }
  };
  const p = profile,
    m = p.management,
    children = processes();
  const stop = Math.min(Date.now() + 300000, p.deadlineEpochMs - 300000);
  need(stop > Date.now() + 120000, "INSUFFICIENT_OPERATION_AND_SETTLEMENT_BUDGET");
  const finalDeadline = Math.min(stop + 300000, p.deadlineEpochMs);
  let deadline = stop;
  const commandDeadline = (ms = 10000) => Math.min(deadline - 5000, Date.now() + ms);
  const kargs = (args) => [
    "--kubeconfig",
    p.cluster.kubeconfigPath,
    "--context",
    p.cluster.context,
    "--request-timeout=8s",
    ...args,
  ];
  const kube = async (args, options) =>
    children.command(p.cluster.kubectlPath, kargs(args), commandDeadline(), options);
  const get = async (kind, name, namespace) =>
    json(await kube(["get", kind, name, ...(namespace ? ["-n", namespace] : []), "-o", "json"]));
  const namedPod = async (name, namespace) => {
    const bytes = await kube([
      "get",
      "pod",
      name,
      "-n",
      namespace,
      "--ignore-not-found=true",
      "-o",
      "json",
    ]);
    return bytes.toString().trim() === "" ? null : json(bytes);
  };
  const server = async (family, action, flags = []) => {
    if (managementUIDs?.server) {
      const originalServer = await get("pod", m.serverPod, m.namespace);
      podIdentity(originalServer, m.serverPod, p.artifacts.managementImage, managementUIDs.server);
    }
    if (family === "entry" && ["create", "delete"].includes(action)) await runtimeBoundary();
    return json(
      await kube([
        "exec",
        "-n",
        m.namespace,
        m.serverPod,
        "-c",
        m.serverContainer,
        "--",
        p.paths.spireServerBinary,
        family,
        action,
        "-socketPath",
        p.paths.serverAdminSocket,
        "-output",
        "json",
        ...flags,
      ]),
    );
  };
  const inventory = async () => {
    const entries = [];
    for (const downstream of ["false", "true"]) {
      const response = await server("entry", "show", [`-downstream=${downstream}`]);
      need(
        Array.isArray(response.entries) &&
          response.entries.length <= 2 &&
          response.next_page_token === "",
        "INVENTORY_INVALID",
      );
      entries.push(...response.entries);
    }
    need(
      entries.length <= 2 && new Set(entries.map((e) => e.id)).size === entries.length,
      "INVENTORY_AMBIGUOUS",
    );
    return entries;
  };
  const pods = [],
    entries = [],
    outcomes = { a: "unentered", b: "unentered" };
  let unknownEffect = false,
    failure = null,
    nodeUID,
    managementUIDs,
    dockerNodeIdentity,
    previousMapping = null;
  const ready = (pod) =>
    pod?.status?.phase === "Running" &&
    pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True");
  const podIdentity = (pod, expectedName, image, expectedUID) => {
    need(
      pod.metadata?.name === expectedName &&
        UID.test(pod.metadata.uid) &&
        (!expectedUID || pod.metadata.uid === expectedUID) &&
        !pod.metadata.deletionTimestamp,
      "POD_IDENTITY_CHANGED",
    );
    need(
      pod.spec?.nodeName === p.cluster.nodeName &&
        pod.spec.containers?.length === 1 &&
        pod.spec.containers[0].image === image &&
        ready(pod),
      "POD_NOT_READY_OR_IMAGE_MISMATCH",
    );
    const status = pod.status.containerStatuses;
    need(
      Array.isArray(status) &&
        status.length === 1 &&
        status[0].ready &&
        status[0].restartCount === 0 &&
        /^containerd:\/\/[a-f0-9]{64}$/.test(status[0].containerID),
      "POD_CONTAINER_INVALID",
    );
    need(
      typeof status[0].imageID === "string" &&
        status[0].imageID.endsWith(image.slice(image.indexOf("@") + 1)),
      "POD_IMAGE_DIGEST_MISMATCH",
    );
    return {
      uid: pod.metadata.uid,
      containerId: status[0].containerID.slice("containerd://".length),
    };
  };
  const dockerNode = async () => {
    const observed = json(
      await children.command(
        p.cluster.dockerPath,
        dockerArguments(dockerConfig, [
          "inspect",
          p.cluster.nodeName,
          "--format",
          '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}}}',
        ]),
        commandDeadline(),
      ),
    );
    need(
      SHA.test(observed.id) &&
        observed.running === true &&
        typeof observed.startedAt === "string" &&
        Number.isFinite(Date.parse(observed.startedAt)),
      "DOCKER_NODE_IDENTITY_INVALID",
    );
    return { id: observed.id, startedAt: observed.startedAt };
  };
  const runtimeBoundary = async () => {
    need(nodeUID && dockerNodeIdentity, "ORIGINAL_NODE_IDENTITY_UNOBSERVED");
    const node = await get("node", p.cluster.nodeName);
    need(
      node.metadata.uid === nodeUID && same(await dockerNode(), dockerNodeIdentity),
      "ORIGINAL_NODE_IDENTITY_CHANGED",
    );
  };
  const continuity = async () => {
    await runtimeBoundary();
    const node = await get("node", p.cluster.nodeName);
    need(
      node.metadata.uid === nodeUID &&
        node.status.conditions.some((c) => c.type === "Ready" && c.status === "True"),
      "NODE_CHANGED",
    );
    for (const role of ["agent", "server"]) {
      const pod = await get("pod", m[`${role}Pod`], m.namespace);
      podIdentity(pod, m[`${role}Pod`], p.artifacts.managementImage, managementUIDs[role]);
    }
  };
  try {
    // Reading explicit kubeconfig as JSON does not contact a cluster. Refuse
    // executable credential providers before the first authenticated operation.
    const config = json(
      await children.command(
        p.cluster.kubectlPath,
        ["--kubeconfig", p.cluster.kubeconfigPath, "config", "view", "--raw", "-o", "json"],
        commandDeadline(),
      ),
    );
    need(
      config.clusters?.length === 1 && config.contexts?.length === 1 && config.users?.length === 1,
      "KUBECONFIG_AMBIGUOUS",
    );
    const context = config.contexts[0],
      cluster = config.clusters[0],
      user = config.users[0];
    need(
      context.name === p.cluster.context &&
        context.context.cluster === cluster.name &&
        context.context.user === user.name &&
        cluster.cluster.server === p.cluster.apiURL &&
        cluster.cluster["insecure-skip-tls-verify"] !== true,
      "KUBECONFIG_SELECTION_MISMATCH",
    );
    need(
      Object.keys(user.user).sort().join(",") === "client-certificate-data,client-key-data" &&
        typeof cluster.cluster["certificate-authority-data"] === "string",
      "KUBECONFIG_AUTH_UNSUPPORTED",
    );
    const node = await get("node", p.cluster.nodeName);
    need(
      UID.test(node.metadata?.uid) &&
        Date.parse(node.metadata.creationTimestamp) >= p.deadlineEpochMs - 1800000,
      "NODE_UID_OR_FRESHNESS_INVALID",
    );
    nodeUID = node.metadata.uid;
    dockerNodeIdentity = await dockerNode();
    need(
      node.status.conditions.some((c) => c.type === "Ready" && c.status === "True"),
      "NODE_NOT_READY",
    );
    need(
      node.status.addresses?.filter((a) => a.type === "InternalIP").length === 1 &&
        node.status.addresses.some(
          (a) => a.type === "InternalIP" && a.address === p.cluster.nodeIPv4,
        ),
      "NODE_ADDRESS_MISMATCH",
    );
    const apiSlices = json(
      await kube([
        "get",
        "endpointslices.discovery.k8s.io",
        "-n",
        "default",
        "-l",
        "kubernetes.io/service-name=kubernetes",
        "-o",
        "json",
      ]),
    );
    need(apiSlices.items?.length === 1, "API_TRANSLATED_ENDPOINT_AMBIGUOUS");
    const apiEndpoint = apiSlices.items[0];
    need(
      apiEndpoint.addressType === "IPv4" &&
        apiEndpoint.endpoints?.length === 1 &&
        apiEndpoint.endpoints[0].addresses?.length === 1 &&
        apiEndpoint.endpoints[0].addresses[0] === p.cluster.apiIPv4 &&
        apiEndpoint.ports?.length === 1 &&
        apiEndpoint.ports[0].port === p.cluster.apiPort,
      "API_TRANSLATED_ENDPOINT_MISMATCH",
    );
    const runtime = await get("runtimeclass", p.runtime.runtimeClassName);
    need(runtime.handler === p.runtime.handler, "RUNTIMECLASS_MISMATCH");
    managementUIDs = {};
    const expectedManifests = buildManagementManifests(p);
    for (const role of ["agent", "server"]) {
      const pod = await get("pod", m[`${role}Pod`], m.namespace);
      managementUIDs[role] = podIdentity(pod, m[`${role}Pod`], p.artifacts.managementImage).uid;
      need(
        Date.parse(pod.metadata.creationTimestamp) >= p.deadlineEpochMs - 1800000,
        "MANAGEMENT_FRESHNESS_INVALID",
      );
      if (role === "server") need(pod.status.podIP === m.serverIPv4, "SERVER_ADDRESS_MISMATCH");
      const expected = expectedManifests.find(
        (o) => o.kind === "Pod" && o.metadata.name === m[`${role}Pod`],
      );
      // The lifetime argument was calculated during preparation; validate it
      // independently without reconstructing a later, longer lifetime.
      if (role === "agent") {
        const actualArgs = pod.spec.containers[0].args;
        const index = expected.spec.containers[0].args.indexOf("--lifetime-ms") + 1;
        need(
          Array.isArray(actualArgs) &&
            /^[1-9][0-9]*$/.test(actualArgs[index]) &&
            Number(actualArgs[index]) <= 1800000,
          "COLLECTOR_LIFETIME_INVALID",
        );
        const observedLifetime = validateObservedLifetime(
          "agent",
          pod.metadata.creationTimestamp,
          pod.status.containerStatuses[0].state?.running?.startedAt,
          Number(actualArgs[index]),
          p.deadlineEpochMs,
        );
        await emit("management-deadline-observed", {
          podUID: pod.metadata.uid,
          externalManagementDeadline: true,
          ...observedLifetime,
        });
        expected.spec.containers[0].args[index] = actualArgs[index];
      }
      const comparable = structuredClone(pod.spec);
      if (role === "server") {
        // Kubernetes injects the Server's explicitly enabled API token volume.
        // Admit only that standard projection; no extra arbitrary mount.
        const injected = comparable.volumes.filter((v) =>
          /^kube-api-access-[a-z0-9]+$/.test(v.name),
        );
        need(
          injected.length === 1 && injected[0].projected?.sources?.length === 3,
          "SERVER_API_TOKEN_PROJECTION_INVALID",
        );
        const sources = injected[0].projected.sources;
        need(
          Object.keys(injected[0]).every((k) => ["name", "projected"].includes(k)) &&
            Object.keys(injected[0].projected).every((k) =>
              ["defaultMode", "sources"].includes(k),
            ) &&
            injected[0].projected.defaultMode === 420,
          "SERVER_API_TOKEN_PROJECTION_INVALID",
        );
        need(
          sources.every((v) => Object.keys(v).length === 1),
          "SERVER_API_TOKEN_PROJECTION_INVALID",
        );
        const token = sources.filter((v) => v.serviceAccountToken),
          ca = sources.filter((v) => v.configMap),
          namespace = sources.filter((v) => v.downwardAPI);
        need(
          token.length === 1 && ca.length === 1 && namespace.length === 1,
          "SERVER_API_TOKEN_PROJECTION_INVALID",
        );
        const t = token[0].serviceAccountToken,
          c = ca[0].configMap,
          d = namespace[0].downwardAPI;
        need(
          Object.keys(t).every((k) => ["path", "expirationSeconds"].includes(k)) &&
            t.path === "token" &&
            Number.isSafeInteger(t.expirationSeconds) &&
            t.expirationSeconds >= 600 &&
            t.expirationSeconds <= 3607,
          "SERVER_API_TOKEN_PROJECTION_INVALID",
        );
        need(
          Object.keys(c).every((k) => ["name", "items", "optional"].includes(k)) &&
            c.optional !== true &&
            c.name === "kube-root-ca.crt" &&
            c.items?.length === 1 &&
            Object.keys(c.items[0]).length === 2 &&
            c.items[0].key === "ca.crt" &&
            c.items[0].path === "ca.crt",
          "SERVER_API_TOKEN_PROJECTION_INVALID",
        );
        need(
          Object.keys(d).length === 1 &&
            d.items?.length === 1 &&
            Object.keys(d.items[0]).length === 2 &&
            d.items[0].path === "namespace" &&
            Object.keys(d.items[0].fieldRef ?? {}).length === 2 &&
            d.items[0].fieldRef.apiVersion === "v1" &&
            d.items[0].fieldRef.fieldPath === "metadata.namespace",
          "SERVER_API_TOKEN_PROJECTION_INVALID",
        );
        const mounts = comparable.containers[0].volumeMounts.filter(
          (v) => v.name === injected[0].name,
        );
        need(
          mounts.length === 1 &&
            Object.keys(mounts[0]).every((k) =>
              ["name", "mountPath", "readOnly", "mountPropagation"].includes(k),
            ) &&
            (!mounts[0].mountPropagation || mounts[0].mountPropagation === "None") &&
            mounts[0].mountPath === "/var/run/secrets/kubernetes.io/serviceaccount" &&
            mounts[0].readOnly === true,
          "SERVER_API_TOKEN_PROJECTION_INVALID",
        );
        comparable.volumes = comparable.volumes.filter((v) => v.name !== injected[0].name);
        comparable.containers[0].volumeMounts = comparable.containers[0].volumeMounts.filter(
          (v) => v.name !== injected[0].name,
        );
      }
      validatePodSecurity(comparable, expected.spec);
      need(
        matchesObservedResource({ ...pod, spec: comparable }, expected),
        "MANAGEMENT_PROFILE_MISMATCH",
      );
    }
    for (const [name, key, hash] of [
      [m.trustBundleConfigMap, "bundle.crt", m.trustBundleSHA256],
      [m.kubeletCAConfigMap, "ca.crt", m.kubeletCASHA256],
    ]) {
      const cm = await get("configmap", name, m.namespace);
      need(
        cm.immutable === true &&
          typeof cm.data?.[key] === "string" &&
          Object.keys(cm.data).length === 1 &&
          digest(cm.data[key]) === hash,
        "CA_CONFIGMAP_MISMATCH",
      );
    }
    for (const expected of expectedManifests.filter((o) => o.kind === "ConfigMap")) {
      const actual = await get("configmap", expected.metadata.name, m.namespace);
      need(
        actual.immutable === true && same(actual.data, expected.data),
        "MANAGEMENT_CONFIG_MISMATCH",
      );
    }
    for (const expected of expectedManifests.filter((o) =>
      [
        "Role",
        "ClusterRole",
        "RoleBinding",
        "ClusterRoleBinding",
        "NetworkPolicy",
        "ServiceAccount",
      ].includes(o.kind),
    )) {
      const actual = await get(
        expected.kind.toLowerCase(),
        expected.metadata.name,
        expected.metadata.namespace,
      );
      need(matchesObservedResource(actual, expected), "PREPARED_ACCESS_CONFIGURATION_MISMATCH");
    }
    const expectedPSAT = [
      `cluster:${m.clusterID}`,
      `agent_node_uid:${nodeUID}`,
      `agent_pod_uid:${managementUIDs.agent}`,
      `agent_ns:${m.namespace}`,
      `agent_sa:${m.agentServiceAccount}`,
    ];
    const agentResponse = await server("agent", "list", [
      "-attestationType",
      "k8s_psat",
      "-banned",
      "false",
      "-matchSelectorsOn",
      "superset",
      ...expectedPSAT.flatMap((s) => ["-selector", `k8s_psat:${s}`]),
    ]);
    need(
      agentResponse.agents?.length === 1 && agentResponse.next_page_token === "",
      "ATTESTED_AGENT_AMBIGUOUS",
    );
    const agent = agentResponse.agents[0],
      agentID = idString(agent.id),
      selectors = sortedSelectors(agent.selectors);
    need(
      agentID === `spiffe://${m.trustDomain}/spire/agent/k8s_psat/${m.clusterID}/${nodeUID}` &&
        agent.attestation_type === "k8s_psat" &&
        agent.banned === false &&
        agent.can_reattest === true,
      "ATTESTED_AGENT_INVALID",
    );
    for (const s of [
      ...expectedPSAT,
      `agent_pod_name:${m.agentPod}`,
      `agent_node_name:${p.cluster.nodeName}`,
      `agent_node_ip:${p.cluster.nodeIPv4}`,
    ])
      need(selectors.includes(`k8s_psat:${s}`), "PSAT_SELECTOR_MISMATCH");
    need(
      typeof agent.x509svid_serial_number === "string" &&
        /^[A-Za-z0-9]{1,128}$/.test(agent.x509svid_serial_number) &&
        /^[0-9]{1,12}$/.test(agent.x509svid_expires_at) &&
        Number(agent.x509svid_expires_at) * 1000 > stop,
      "AGENT_EXPIRY_INVALID",
    );
    need((await inventory()).length === 0, "INITIAL_INVENTORY_NOT_EMPTY");
    await emit("prepared-environment-observed", {
      nodeUID,
      dockerNodeIdentity,
      configuredGrantsPresent: true,
      alternateGrantInventoryVerified: false,
      managementPodUIDs: managementUIDs,
      agentID,
      completeInitialEntryCount: 0,
    });
    for (const name of ["a", "b"]) {
      const w = p.workloads[name];
      await runtimeBoundary();
      need((await namedPod(w.podName, p.workloads.namespace)) === null, "WORKLOAD_ALREADY_EXISTS");
      const manifest = buildHarnessPod(p, name);
      await emit("pod-create-intent", { case: name, podName: w.podName });
      need(!receiptFailed, "EVIDENCE_WRITE_FAILED");
      unknownEffect = true;
      const created = json(
        await kube(["create", "-f", "-", "-o", "json"], { input: JSON.stringify(manifest) }),
      );
      need(
        UID.test(created.metadata?.uid) && created.metadata.name === w.podName,
        "CREATED_POD_IDENTITY_INVALID",
      );
      pods.push({
        name: w.podName,
        uid: created.metadata.uid,
        createdAt: created.metadata.creationTimestamp,
        activeDeadlineSeconds: manifest.spec.activeDeadlineSeconds,
        case: name,
        absent: false,
      });
      unknownEffect = false;
      await emit("pod-created", { case: name, podUID: created.metadata.uid });
    }
    for (const owned of pods) {
      await runtimeBoundary();
      let pod;
      do {
        pod = await get("pod", owned.name, p.workloads.namespace);
        need(pod.metadata.uid === owned.uid, "POD_IDENTITY_CHANGED");
        if (!ready(pod)) await pause(500, stop);
      } while (!ready(pod));
      const identity = podIdentity(pod, owned.name, p.artifacts.observerImage, owned.uid);
      const expected = buildHarnessPod(p, owned.case);
      const comparable = normalizeObservedPod(pod, expected);
      need(
        pod.spec.runtimeClassName === p.runtime.runtimeClassName &&
          pod.spec.automountServiceAccountToken === false &&
          comparable.spec.hostPID === false &&
          comparable.spec.hostNetwork === false &&
          comparable.spec.hostIPC === false &&
          pod.spec.volumes?.length === 1,
        "HARNESS_ISOLATION_MISMATCH",
      );
      need(
        pod.metadata.creationTimestamp === owned.createdAt &&
          Number.isSafeInteger(pod.spec.activeDeadlineSeconds) &&
          pod.spec.activeDeadlineSeconds > 0 &&
          pod.spec.activeDeadlineSeconds === owned.activeDeadlineSeconds,
        "WORKLOAD_LIFETIME_CHANGED",
      );
      expected.spec.activeDeadlineSeconds = owned.activeDeadlineSeconds;
      const observedLifetime = validateObservedLifetime(
        "pod",
        owned.createdAt,
        pod.status.startTime,
        pod.spec.activeDeadlineSeconds * 1000,
        p.deadlineEpochMs,
      );
      await emit("workload-deadline-observed", {
        case: owned.case,
        podUID: owned.uid,
        activeDeadlineSeconds: pod.spec.activeDeadlineSeconds,
        ...observedLifetime,
      });
      validatePodSecurity(pod.spec, expected.spec);
      need(matchesObservedResource(pod, expected), "HARNESS_PROFILE_MISMATCH");
      owned.containerId = identity.containerId;
      owned.serviceAccount = pod.spec.serviceAccountName;
      const targets = [
        { name: "kubelet", host: p.cluster.nodeIPv4, port: 10250 },
        { name: "api", host: p.cluster.apiIPv4, port: p.cluster.apiPort },
        { name: "server", host: m.serverIPv4, port: m.serverPort },
      ];
      const result = json(
        await kube([
          "exec",
          "-n",
          p.workloads.namespace,
          owned.name,
          "-c",
          p.workloads[owned.case].containerName,
          "--",
          "node",
          "-e",
          guestNetworkCheck,
          JSON.stringify(targets),
        ]),
      );
      need(
        result.loopbackOnly === true &&
          Number.isSafeInteger(result.interfaceCount) &&
          result.interfaceCount >= 0 &&
          result.interfaceCount <= 4 &&
          result.results?.length === 3,
        "GUEST_NETWORK_UNQUALIFIED",
      );
      need(
        result.results.every(
          (r, i) =>
            r.target === targets[i].name &&
            ["ENETUNREACH", "EHOSTUNREACH", "EAFNOSUPPORT"].includes(r.code),
        ),
        "GUEST_NETWORK_UNQUALIFIED",
      );
      await emit("guest-network-observed", {
        case: owned.case,
        loopbackOnly: true,
        results: result.results.map((r) => ({ target: r.target, code: r.code })),
      });
    }
    const collector = async () => {
      const bytes = await kube(
        [
          "logs",
          "-n",
          m.namespace,
          m.agentPod,
          "-c",
          m.agentContainer,
          "--tail=-1",
          "--limit-bytes=65537",
        ],
        { maxBytes: 65536 },
      );
      const text = bytes.toString("utf8");
      need(text === "" || text.endsWith("\n"), "COLLECTOR_FRAME_INCOMPLETE");
      const records =
        text === ""
          ? []
          : text
              .trimEnd()
              .split("\n")
              .map((line) => json(Buffer.from(line)));
      need(records.length <= 2, "COLLECTOR_RECORD_COUNT");
      return records.map((r, i) => {
        need(
          r.event === "receiver-denial" &&
            r.sequence === i + 1 &&
            Number.isFinite(Date.parse(r.collectorTime)) &&
            Number.isFinite(r.collectorMonotonicMs),
          "COLLECTOR_RECORD_INVALID",
        );
        const s = r.selectors;
        need(s?.provenance === "spire-workload-attestor", "SELECTOR_PROVENANCE_INVALID");
        const raw = `k8s:ns:${s.namespace},k8s:sa:${s.serviceAccount},k8s:pod-uid:${s.podUID},k8s:node-name:${s.nodeName},k8s:container-name:${s.containerName},unix:uid:${s.uid},unix:gid:${s.gid}`;
        let projected;
        try {
          projected = projectDenial({
            level: "error",
            msg: "No identity issued",
            pid: r.receiverPID,
            service: r.service,
            method: r.method,
            registered: r.registered,
            selectors: raw,
            time: r.agentTime,
          });
        } catch {
          throw new Failure("COLLECTOR_RECORD_INVALID");
        }
        need(
          r.acceptedSocketUID === null &&
            r.acceptedSocketGID === null &&
            r.acceptedSocketStartIdentity === null,
          "SOCKET_PROVENANCE_INVALID",
        );
        return {
          ...projected,
          sequence: r.sequence,
          collectorTime: r.collectorTime,
          collectorMonotonicMs: r.collectorMonotonicMs,
        };
      });
    };
    let history = await collector();
    need(history.length === 0, "UNSOLICITED_RECEIVER_EVENT");
    for (const owned of pods) {
      outcomes[owned.case] = "entered";
      const w = p.workloads[owned.case],
        start = Date.now(),
        caseDeadline = Math.min(start + 120000, stop);
      await continuity();
      const observer = children.launch(
        p.cluster.kubectlPath,
        kargs([
          "exec",
          "-i",
          "-n",
          p.workloads.namespace,
          owned.name,
          "-c",
          w.containerName,
          "--",
          p.paths.observerBinary,
          "--socket-path",
          p.paths.socketPath,
          "--expected-id",
          w.spiffeID,
        ]),
        caseDeadline,
        { interactive: true },
      );
      owned.observer = observer;
      const denied = await recordAt(observer, 0, Math.min(start + 15000, caseDeadline));
      need(
        denied.event === "denied" && denied.grpcCode === "PermissionDenied",
        "REAL_DENIAL_MISSING",
      );
      liveCounts(denied, 1);
      const current = await collector();
      need(
        current.length === history.length + 1 && same(current.slice(0, history.length), history),
        "RECEIVER_CORRELATION_AMBIGUOUS",
      );
      const receiver = current.at(-1),
        s = receiver.selectors;
      need(
        Date.parse(receiver.collectorTime) >= start - 1000 &&
          Date.parse(receiver.collectorTime) <= observer.receivedAt[0] + 1000,
        "RECEIVER_TIME_AMBIGUOUS",
      );
      need(
        s.namespace === p.workloads.namespace &&
          s.podUID === owned.uid &&
          s.nodeName === p.cluster.nodeName &&
          s.containerName === w.containerName &&
          s.serviceAccount === owned.serviceAccount,
        "RECEIVER_CALLER_MISMATCH",
      );
      await emit("actual-receiver-denial", {
        case: owned.case,
        grpcCode: "PermissionDenied",
        receiver,
        experimentalTimeSkewMs: 1000,
      });
      const mapping = async () => {
        need(caseDeadline - Date.now() >= 1000, "CASE_DEADLINE_EXPIRED");
        const result = await observeNode({
          nodeName: p.cluster.nodeName,
          podUID: owned.uid,
          receiverPID: receiver.receiverPID,
          expectedSentrySHA256: p.artifacts.sentrySHA256,
          expectedRuntimeFlags: p.runtime.flags,
          expectedRuntimeHandler: p.runtime.handler,
          timeoutMs: Math.max(1000, Math.min(30000, caseDeadline - Date.now())),
          dockerPath: p.cluster.dockerPath,
          ...dockerConfig,
        });
        // The protected helper owns its closed output schema, including any
        // unresolved child custody; preserve that before refusing qualification.
        await emit("protected-node-observation", { case: owned.case, result });
        if (result.custodyHeld === true && result.localResourcesSettled === false)
          localResourceCustody.recordFailure(result);
        else if (result.custodyHeld === true || result.reasonCode === "COMMAND_SETTLEMENT_UNKNOWN")
          unknownEffect = true;
        need(
          result.status === "observed" && result.reasonCode === "OBSERVED",
          "NODE_MAPPING_UNQUALIFIED",
        );
        const o = result.observation;
        need(
          o.pod.uid === owned.uid &&
            o.pod.name === owned.name &&
            o.pod.namespace === p.workloads.namespace &&
            o.mapping.containerId === owned.containerId &&
            o.receiver.effectiveUID === s.uid &&
            o.receiver.effectiveGID === s.gid,
          "NODE_MAPPING_MISMATCH",
        );
        need(
          o.node.name === p.cluster.nodeName &&
            o.node.id === dockerNodeIdentity.id &&
            o.node.startedAt === dockerNodeIdentity.startedAt &&
            o.receiver.provenance === "protected-node-read",
          "NODE_MAPPING_PROVENANCE_INVALID",
        );
        return o;
      };
      const before = await mapping();
      owned.mapping = before;
      if (previousMapping)
        need(
          previousMapping.pod.uid !== before.pod.uid &&
            previousMapping.sandbox.id !== before.sandbox.id &&
            previousMapping.receiver.pid !== before.receiver.pid &&
            previousMapping.mapping.containerId !== before.mapping.containerId,
          "CALLER_SANDBOX_NOT_DISTINCT",
        );
      const registration = buildRegistration(p, owned.case, owned.uid, agentID);
      await emit("entry-create-intent", {
        case: owned.case,
        spiffeID: registration.spiffeID,
        parentID: agentID,
        podUID: owned.uid,
      });
      need(!receiptFailed, "EVIDENCE_WRITE_FAILED");
      unknownEffect = true;
      const response = await server("entry", "create", [
        "-parentID",
        registration.parentID,
        "-spiffeID",
        registration.spiffeID,
        "-x509SVIDTTL",
        "300",
        ...registration.selectors.flatMap((v) => ["-selector", `${v.type}:${v.value}`]),
      ]);
      const created = successfulBatch(response).entry;
      need(
        typeof created?.id === "string" && ENTRY_ID.test(created.id),
        "CREATED_ENTRY_ID_INVALID",
      );
      entries.push({ id: created.id, registration, absent: false });
      unknownEffect = false;
      validateEntry(created, registration, created.id);
      await emit("entry-created", { case: owned.case, entryID: created.id });
      const readback = await server("entry", "show", ["-entryID", created.id]);
      need(
        readback.entries?.length === 1 && readback.next_page_token === "",
        "ENTRY_READBACK_INVALID",
      );
      validateEntry(readback.entries[0], registration, created.id);
      const all = await inventory();
      need(all.length === entries.length, "INVENTORY_MISMATCH");
      for (const e of entries) {
        const match = all.filter((v) => v.id === e.id);
        need(match.length === 1, "INVENTORY_MISMATCH");
        validateEntry(match[0], e.registration, e.id);
      }
      // A single declared sync interval is followed by exactly one positive
      // fetch. Failed propagation is evidence, never retried until it passes.
      await pause(5000, caseDeadline);
      need(
        observer.records.length === 1 && !observer.closed && !observer.failure,
        "OBSERVER_NO_LONGER_WAITING",
      );
      observer.child.stdin.end("continue\n");
      const delivered = await recordAt(observer, 1, caseDeadline),
        deliveredProjection = delivery(delivered, w.spiffeID);
      const closed = await recordAt(observer, 2, caseDeadline);
      await observer.done;
      need(
        !observer.failure &&
          observer.code === 0 &&
          !observer.signal &&
          observer.records.length === 3 &&
          closed.event === "closed" &&
          closed.outcome === "passed" &&
          closed.connection?.dialAttempts === 1 &&
          closed.connection.connectionBegins === 1 &&
          closed.connection.connectionEnds === 1,
        "OBSERVER_SETTLEMENT_UNQUALIFIED",
      );
      const after = await mapping();
      need(same(before, after), "CALLER_MAPPING_CHANGED");
      const afterLogs = await collector();
      need(same(afterLogs, current), "UNSOLICITED_RECEIVER_EVENT");
      await continuity();
      history = current;
      previousMapping = after;
      outcomes[owned.case] = "observed";
      await emit("complete-delivered-set-observed", {
        case: owned.case,
        ...deliveredProjection,
        ownedClientSettled: true,
        wrongCallerControl: owned.case === "b" ? "denied-while-a-entry-present" : null,
      });
    }
  } catch (error) {
    localResourceCustody.recordFailure(error);
    failure = safeCode(error);
    for (const name of ["a", "b"])
      if (outcomes[name] === "entered")
        outcomes[name] = /AMBIGUOUS|UNQUALIFIED/.test(failure) ? "unqualified" : "failed";
    await emit("observation-failed", { reasonCode: failure, outcomes });
  } finally {
    // Settlement is unconditional and has its own fixed reservation. Never
    // remove management resources or retry an ambiguous mutation blindly.
    deadline = finalDeadline;
    const localSettled = await children.settle(Math.min(Date.now() + 5000, finalDeadline));
    let settled = localSettled && !unknownEffect;
    for (const entry of [...entries].reverse()) {
      try {
        const response = await server("entry", "delete", ["-entryID", entry.id]);
        need(
          response.results?.length === 1 && response.results[0].id === entry.id,
          "ENTRY_DELETE_ID_MISMATCH",
        );
        const statusCode = response.results[0].status?.code;
        need(statusCode === 0 || statusCode === 5, "BATCH_STATUS_FAILED");
        const all = await inventory();
        need(!all.some((e) => e.id === entry.id), "ENTRY_REMAINS");
        entry.absent = true;
        await emit("entry-settled", {
          entryID: entry.id,
          absent: true,
          deleteStatusCode: statusCode,
          disposition:
            statusCode === 0 ? "deleted-and-absence-observed" : "not-found-and-absence-observed",
        });
      } catch (error) {
        localResourceCustody.recordFailure(error);
        settled = false;
        await emit("entry-custody-held", { entryID: entry.id, reasonCode: safeCode(error) });
      }
    }
    for (const owned of [...pods].reverse()) {
      try {
        const present = await namedPod(owned.name, p.workloads.namespace);
        if (present) {
          need(present.metadata.uid === owned.uid, "POD_REPLACED_CUSTODY_HELD");
          const uri = `/api/v1/namespaces/${p.workloads.namespace}/pods/${owned.name}`;
          await kube(["delete", "--raw", uri, "-f", "-"], {
            input: JSON.stringify({
              apiVersion: "v1",
              kind: "DeleteOptions",
              preconditions: { uid: owned.uid },
              gracePeriodSeconds: 5,
            }),
          });
        }
        const absenceDeadline = Math.min(Date.now() + 30000, finalDeadline);
        while (await namedPod(owned.name, p.workloads.namespace)) await pause(500, absenceDeadline);
        owned.absent = true;
        // API absence is recorded separately from actual runtime reclamation.
        await runtimeBoundary();
        const runtimeBytes = await children.command(
          p.cluster.dockerPath,
          dockerArguments(dockerConfig, [
            "exec",
            dockerNodeIdentity.id,
            "timeout",
            "-s",
            "KILL",
            "8",
            "crictl",
            "pods",
            "--label",
            `io.kubernetes.pod.uid=${owned.uid}`,
            "-o",
            "json",
          ]),
          commandDeadline(),
        );
        const runtime = json(runtimeBytes);
        need(Array.isArray(runtime.items) && runtime.items.length === 0, "RUNTIME_SANDBOX_REMAINS");
        for (const processIdentity of owned.mapping
          ? [owned.mapping.receiver, owned.mapping.sentry]
          : []) {
          const bytes = await children.command(
            p.cluster.dockerPath,
            dockerArguments(dockerConfig, [
              "exec",
              dockerNodeIdentity.id,
              "timeout",
              "-s",
              "KILL",
              "8",
              "sh",
              "-c",
              'if [ -e "$1" ]; then cat "$1"; else printf absent; fi',
              "sh",
              `/proc/${processIdentity.pid}/stat`,
            ]),
            commandDeadline(),
          );
          const value = bytes.toString();
          if (value !== "absent") {
            const end = value.lastIndexOf(")"),
              fields = value
                .slice(end + 2)
                .trim()
                .split(/\s+/);
            need(
              end > 0 &&
                fields.length >= 20 &&
                /^[0-9]+$/.test(fields[19]) &&
                fields[19] !== processIdentity.startTicks,
              "RUNTIME_PROCESS_REMAINS",
            );
          }
        }
        await runtimeBoundary();
        await emit("pod-settled", {
          case: owned.case,
          podUID: owned.uid,
          apiAbsent: true,
          runtimeSandboxAbsent: true,
          observedRuntimeProcessesAbsent: Boolean(owned.mapping),
        });
      } catch (error) {
        localResourceCustody.recordFailure(error);
        settled = false;
        await emit("pod-custody-held", {
          case: owned.case,
          podUID: owned.uid,
          apiAbsent: owned.absent,
          reasonCode: safeCode(error),
        });
      }
    }
    if (!(await children.settle(Math.min(Date.now() + 5000, finalDeadline)))) settled = false;
    const disposition = localResourceCustody.disposition(settled);
    await emit("final-disposition", {
      outcomes,
      counts: {
        executed: Object.values(outcomes).filter((v) => v !== "unentered").length,
        observed: Object.values(outcomes).filter((v) => v === "observed").length,
        failed: Object.values(outcomes).filter((v) => v === "failed").length,
        unqualified: Object.values(outcomes).filter((v) => v === "unqualified").length,
        unentered: Object.values(outcomes).filter((v) => v === "unentered").length,
      },
      failure,
      ownedHelpersSettled: children.active.size === 0,
      heldHelpers: [...children.active].map(
        (s) =>
          s.heldIdentity ?? {
            pid: s.child.pid ?? null,
            processGroup: s.child.pid ?? null,
            startTicks: s.startTicks,
            closeObserved: false,
          },
      ),
      ...disposition,
      unknownEffect,
      entries: entries.map((e) => ({ id: e.id, absent: e.absent })),
      pods: pods.map((pod) => ({ uid: pod.uid, apiAbsent: pod.absent })),
      managementOwnership: "external-preparer",
      fullQualification: false,
      laterMatrixGroups: "unentered",
    });
    need(!localResourceCustody.disposition(settled).custodyHeld, "CUSTODY_HELD");
    need(!receiptFailed, "EVIDENCE_WRITE_FAILED");
  }
  need(
    !failure && outcomes.a === "observed" && outcomes.b === "observed",
    failure ?? "OBSERVATION_INCOMPLETE",
  );
}

test(
  "real gVisor SPIRE H0/H1/H2 first observation",
  {
    skip:
      process.env.OCC_TEST_SPIRE_FIRST_OBSERVATION_REAL === "1"
        ? false
        : "runtime unselected: OCC_TEST_SPIRE_FIRST_OBSERVATION_REAL=1 and a prepared private profile are required",
    timeout: 610000,
  },
  async () => {
    let emit;
    try {
      const filename = process.env.OCC_SPIRE_FIRST_OBSERVATION_PROFILE,
        expected = process.env.OCC_SPIRE_FIRST_OBSERVATION_PROFILE_SHA256;
      need(typeof filename === "string" && SHA.test(expected ?? ""), "EXPLICIT_PROFILE_REQUIRED");
      const principal = await establishFilesystemOwner(path.dirname(filename));
      need(
        principal.probeSettled === true &&
          principal.provenance === "fresh-protected-file-observation" &&
          Number.isSafeInteger(principal.filesystemOwnerUID),
        "FILESYSTEM_PRINCIPAL_UNQUALIFIED",
      );
      const p = validateProfile(
        json(await privateFile(filename, expected, principal.filesystemOwnerUID)),
      );
      await privateFile(
        p.cluster.kubeconfigPath,
        p.cluster.kubeconfigSHA256,
        principal.filesystemOwnerUID,
      );
      const dockerConfig = validateDockerConfiguration({
        dockerConfigDirectory: p.cluster.dockerConfigDirectory,
        dockerConfigSHA256: p.cluster.dockerConfigSHA256,
        filesystemOwnerUID: principal.filesystemOwnerUID,
      });
      await binary(p.cluster.kubectlPath, p.artifacts.kubectlSHA256);
      await binary(p.cluster.dockerPath, p.artifacts.dockerSHA256);
      emit = await receipts(p.paths.evidenceDir, principal.filesystemOwnerUID);
      await emit("filesystem-principal-observed", { principal });
      await emit("inputs-bound", {
        profileSHA256: expected,
        sourceCommit: p.sourceCommit,
        kubectlSHA256: p.artifacts.kubectlSHA256,
        dockerSHA256: p.artifacts.dockerSHA256,
        dockerConfig,
        absoluteDeadlineEpochMs: p.deadlineEpochMs,
      });
      await runObservation(p, emit, principal.filesystemOwnerUID);
    } catch (error) {
      // Native parser/process errors can contain input. Only closed reason codes
      // cross the TAP boundary; detailed allowed metadata is in private receipts.
      throw new Error(
        error?.custodyHeld === true ? "LOCAL_RESOURCE_CUSTODY_HELD" : safeCode(error),
      );
    }
  },
);
