import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeNativeChild,
  nativeChildExit,
  verifyNativeExecutable,
} from "../../../admission/native-child-lifetime.ts";
import {
  closedNativeObject,
  consumeNativeFrames,
  nativeJson,
  nativeUnavailable,
  writeNativeFrame,
} from "../../../admission/runtime-authority-wire.ts";

/** Original protected deployment configuration. No Installation JSON or workload
 * request can enroll this source. The node validates its own root-owned copy. */
export interface NodeExecutionClientConfiguration {
  readonly binaryPath: string;
  readonly binaryDigest: string;
  readonly clientConfiguration: Readonly<{
    enrollment: Readonly<Record<string, string | number>>;
    workloadSocket: string;
    enrollmentDigest: string;
  }>;
}

export interface NodeExecutionCaptureInput {
  readonly requestRef: string;
  readonly podName: string;
  readonly podUID: string;
  readonly deadline: string;
  readonly signal: AbortSignal;
}

/** A physical observation handle. It intentionally does not implement an OCC
 * trusted context, RuntimeBinding or the observer's authenticated producer port. */
export interface NodeExecutionCapture {
  readonly kind: "node-physical-execution";
}

export interface NodeNetworkCaptureInput extends NodeExecutionCaptureInput {
  readonly networkName: string;
  readonly interfaceName: string;
}

export interface NodeNetworkCapture {
  readonly kind: "node-physical-network";
}

export interface NodeNetworkObservation {
  readonly schemaVersion: 1;
  readonly kind: "node-physical-network";
  readonly execution: Readonly<Record<string, unknown>>;
  readonly attachment: Readonly<{
    recordJSON: string;
    recordDigest: string;
    serviceInstance: string;
    operationRef: string;
    namespaceDevice: string;
    namespaceInode: string;
  }>;
}

const reference = /^[A-Za-z0-9._:/-]{1,200}$/;
const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A concrete client of the dedicated native node observer. The private handle
 * retains its original child, exact request and real TLS connection; copying the
 * returned values cannot inspect, close or replace another capture. Composition
 * still needs actual enrolled node and profile owners before observer integration. */
export function createNodeExecutionClient(options: NodeExecutionClientConfiguration) {
  const { binaryPath, binaryDigest } = options;
  const configurationBytes = Buffer.from(JSON.stringify(options.clientConfiguration));
  const configuration = closedNativeObject(nativeJson(configurationBytes), [
    "enrollment",
    "workloadSocket",
    "enrollmentDigest",
  ]);
  const enrollment = configuration.enrollment as Readonly<Record<string, unknown>>;
  if (
    !enrollment ||
    typeof enrollment !== "object" ||
    typeof configuration.enrollmentDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(configuration.enrollmentDigest)
  )
    throw nativeUnavailable();
  const captures = new WeakMap<
    NodeExecutionCapture | NodeNetworkCapture,
    {
      kind: "node-physical-execution" | "node-physical-network";
      inspect(): Promise<Readonly<Record<string, unknown>>>;
      close(): Promise<void>;
    }
  >();

  async function captureOriginal(
    input: NodeExecutionCaptureInput,
    network?: Readonly<{ networkName: string; interfaceName: string }>,
  ): Promise<NodeExecutionCapture | NodeNetworkCapture> {
    const { requestRef, podName, podUID, deadline: originalDeadline, signal: parentSignal } = input;
    const remaining = Date.parse(originalDeadline) - Date.now();
    if (
      parentSignal.aborted ||
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      remaining > 10_000 ||
      typeof requestRef !== "string" ||
      !reference.test(requestRef) ||
      typeof podUID !== "string" ||
      !reference.test(podUID) ||
      typeof podName !== "string" ||
      (network !== undefined &&
        (typeof network.networkName !== "string" ||
          typeof network.interfaceName !== "string" ||
          !/^[A-Za-z0-9_.-]{1,256}$/.test(network.networkName) ||
          !/^[A-Za-z0-9_.-]{1,15}$/.test(network.interfaceName))) ||
      !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(podName)
    )
      throw nativeUnavailable();
    const lifetime = new AbortController();
    const signal = AbortSignal.any([
      parentSignal,
      lifetime.signal,
      AbortSignal.timeout(Math.ceil(remaining)),
    ]);
    await verifyNativeExecutable(binaryPath, binaryDigest, signal);
    signal.throwIfAborted();
    const deadline = new Date(originalDeadline)
      .toISOString()
      .replace(/(\.\d*?[1-9])0+Z$/, "$1Z")
      .replace(/\.000Z$/, "Z");
    const executionRequest = {
      schemaVersion: 1,
      method: "capture-execution",
      requestRef: requestRef,
      sourceRef: enrollment.sourceRef,
      sourceVersion: enrollment.version,
      clusterRef: enrollment.clusterRef,
      nodeUID: enrollment.nodeUID,
      namespace: enrollment.namespace,
      podName: podName,
      podUID: podUID,
      deadline,
    };
    const request =
      network === undefined
        ? executionRequest
        : {
            schemaVersion: 1,
            method: "capture-network",
            execution: executionRequest,
            networkName: network.networkName,
            interfaceName: network.interfaceName,
          };
    const kind = network === undefined ? "node-physical-execution" : "node-physical-network";
    const requestDigest = sha256(Buffer.from(JSON.stringify(request)));
    const child = spawn(binaryPath, ["client"], {
      env: {},
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    child.stdin.on("error", () => {});
    const exited = nativeChildExit(child);
    let stop = () => {};
    const inspections = new Set<Promise<Readonly<Record<string, unknown>>>>();
    let closing: Promise<void> | undefined;
    let closed = false;
    let recordDigest: string | undefined;
    let recordBytes: string | undefined;
    let pending:
      | {
          status: "observed" | "current";
          resolve(value: Readonly<Record<string, unknown>>): void;
          reject(reason: Error): void;
        }
      | undefined;
    const close = (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      closing = Promise.resolve().then(async () => {
        try {
          await closeNativeChild(child, exited);
        } finally {
          await Promise.allSettled([...inspections]);
        }
      });
      lifetime.abort();
      signal.removeEventListener("abort", abort);
      pending?.reject(nativeUnavailable());
      pending = undefined;
      stop();
      return closing;
    };
    const abort = () => {
      void close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    exited.then(abort);
    stop = consumeNativeFrames(
      child.stdout,
      (raw) => {
        try {
          if (closed || signal.aborted || !pending) throw nativeUnavailable();
          const reply = closedNativeObject(nativeJson(raw), [
            "schemaVersion",
            "status",
            "requestDigest",
            "recordDigest",
            "record",
          ]);
          const record = closedNativeObject(
            reply.record,
            network === undefined
              ? [
                  "schemaVersion",
                  "kind",
                  "requestDigest",
                  "enrollmentDigest",
                  "observedAt",
                  "validUntil",
                  "physical",
                ]
              : ["schemaVersion", "kind", "execution", "attachment"],
          );
          const execution =
            network === undefined
              ? record
              : closedNativeObject(record.execution, [
                  "schemaVersion",
                  "kind",
                  "requestDigest",
                  "enrollmentDigest",
                  "observedAt",
                  "validUntil",
                  "physical",
                ]);
          const bytes = JSON.stringify(record);
          const physical = execution.physical as Readonly<Record<string, unknown>>;
          if (network !== undefined) {
            const attachment = closedNativeObject(record.attachment, [
              "recordJSON",
              "recordDigest",
              "serviceInstance",
              "operationRef",
              "namespaceDevice",
              "namespaceInode",
            ]);
            if (
              typeof attachment.recordJSON !== "string" ||
              Buffer.byteLength(attachment.recordJSON) > 64 * 1024 ||
              attachment.recordDigest !== sha256(Buffer.from(attachment.recordJSON)) ||
              typeof attachment.serviceInstance !== "string" ||
              !/^[0-9a-f]{32}$/.test(attachment.serviceInstance) ||
              typeof attachment.operationRef !== "string" ||
              !/^[A-Za-z0-9_.-]{1,256}$/.test(attachment.operationRef) ||
              typeof attachment.namespaceDevice !== "string" ||
              !/^(0|[1-9][0-9]{0,19})$/.test(attachment.namespaceDevice) ||
              BigInt(attachment.namespaceDevice) > 18446744073709551615n ||
              typeof attachment.namespaceInode !== "string" ||
              !/^[1-9][0-9]{0,19}$/.test(attachment.namespaceInode) ||
              BigInt(attachment.namespaceInode) > 18446744073709551615n
            )
              throw nativeUnavailable();
            // The actual Go client closed-parses native uint64 fields. Keep its
            // exact bytes; this JSON view is used only for string correspondence.
            const actual = JSON.parse(attachment.recordJSON) as Record<string, unknown>;
            if (
              actual.serviceInstance !== attachment.serviceInstance ||
              actual.operationRef !== attachment.operationRef ||
              actual.requestRef !== requestRef ||
              actual.networkName !== network.networkName ||
              actual.interfaceName !== network.interfaceName ||
              actual.containerId !== physical?.sandboxID
            )
              throw nativeUnavailable();
          }
          if (
            reply.schemaVersion !== 1 ||
            reply.status !== pending.status ||
            reply.requestDigest !== requestDigest ||
            reply.recordDigest !== sha256(Buffer.from(bytes)) ||
            record.schemaVersion !== 1 ||
            record.kind !== kind ||
            execution.schemaVersion !== 1 ||
            execution.kind !== "node-physical-execution" ||
            execution.requestDigest !== requestDigest ||
            execution.enrollmentDigest !== configuration.enrollmentDigest ||
            execution.validUntil !== deadline ||
            typeof execution.observedAt !== "string" ||
            !Number.isFinite(Date.parse(execution.observedAt)) ||
            Date.parse(execution.observedAt) > Date.now() ||
            !physical ||
            physical.nodeUID !== enrollment.nodeUID ||
            physical.podUID !== podUID ||
            (recordDigest !== undefined &&
              (reply.recordDigest !== recordDigest || bytes !== recordBytes))
          )
            throw nativeUnavailable();
          recordDigest = reply.recordDigest as string;
          recordBytes = bytes;
          const original = pending;
          pending = undefined;
          const freeze = (value: unknown): void => {
            if (!value || typeof value !== "object") return;
            for (const child of Object.values(value)) freeze(child);
            Object.freeze(value);
          };
          freeze(record);
          original.resolve(record);
        } catch {
          abort();
        }
      },
      abort,
    );
    const receive = (status: "observed" | "current") => {
      if (closed || signal.aborted || pending) throw nativeUnavailable();
      const promise = new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
        pending = { status, resolve, reject };
      });
      promise.catch(() => {});
      return promise;
    };
    try {
      const first = receive("observed");
      await writeNativeFrame(child.stdin, nativeJson(configurationBytes), signal);
      await writeNativeFrame(child.stdin, request, signal);
      await first;
      if (closed || signal.aborted) throw nativeUnavailable();
      const handle = Object.freeze({ kind });
      captures.set(handle, {
        kind,
        close,
        inspect() {
          // Publish the complete continuation before the first native write.
          const work = Promise.resolve().then(async () => {
            try {
              const current = receive("current");
              await writeNativeFrame(
                child.stdin,
                { schemaVersion: 1, method: "inspect", requestDigest, recordDigest },
                signal,
              );
              return await current;
            } catch (error) {
              void close().catch(() => {});
              throw error;
            }
          });
          inspections.add(work);
          work.then(
            () => inspections.delete(work),
            () => inspections.delete(work),
          );
          return work;
        },
      });
      return handle;
    } catch (error) {
      await close();
      throw error;
    }
  }
  return Object.freeze({
    capture(input: NodeExecutionCaptureInput): Promise<NodeExecutionCapture> {
      return captureOriginal(input) as Promise<NodeExecutionCapture>;
    },
    captureNetwork(input: NodeNetworkCaptureInput): Promise<NodeNetworkCapture> {
      const { networkName, interfaceName } = input;
      return captureOriginal(input, { networkName, interfaceName }) as Promise<NodeNetworkCapture>;
    },
    inspectNetwork(handle: NodeNetworkCapture): Promise<NodeNetworkObservation> {
      const capture = captures.get(handle);
      if (!capture || capture.kind !== "node-physical-network") throw nativeUnavailable();
      return capture.inspect() as unknown as Promise<NodeNetworkObservation>;
    },
    inspect(handle: NodeExecutionCapture) {
      const capture = captures.get(handle);
      if (!capture || capture.kind !== "node-physical-execution") throw nativeUnavailable();
      return capture.inspect();
    },
    async close(handle: NodeExecutionCapture | NodeNetworkCapture) {
      const capture = captures.get(handle);
      if (!capture) throw nativeUnavailable();
      await capture.close();
    },
  });
}
