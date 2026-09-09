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
    NodeExecutionCapture,
    { inspect(): Promise<Readonly<Record<string, unknown>>>; close(): Promise<void> }
  >();

  return Object.freeze({
    async capture(input: NodeExecutionCaptureInput): Promise<NodeExecutionCapture> {
      const {
        requestRef,
        podName,
        podUID,
        deadline: originalDeadline,
        signal: parentSignal,
      } = input;
      const remaining = Date.parse(originalDeadline) - Date.now();
      if (
        parentSignal.aborted ||
        !Number.isFinite(remaining) ||
        remaining <= 0 ||
        remaining > 10_000 ||
        !reference.test(requestRef) ||
        !reference.test(podUID) ||
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
      const deadline = new Date(originalDeadline)
        .toISOString()
        .replace(/(\.\d*?[1-9])0+Z$/, "$1Z")
        .replace(/\.000Z$/, "Z");
      const request = {
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
      const requestDigest = sha256(Buffer.from(JSON.stringify(request)));
      const child = spawn(binaryPath, ["client"], {
        env: {},
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      child.stdin.on("error", () => {});
      const exited = nativeChildExit(child);
      let stop = () => {};
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
        closing = Promise.resolve().then(() => closeNativeChild(child, exited));
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
            const record = closedNativeObject(reply.record, [
              "schemaVersion",
              "kind",
              "requestDigest",
              "enrollmentDigest",
              "observedAt",
              "validUntil",
              "physical",
            ]);
            const bytes = JSON.stringify(record);
            const physical = record.physical as Readonly<Record<string, unknown>>;
            if (
              reply.schemaVersion !== 1 ||
              reply.status !== pending.status ||
              reply.requestDigest !== requestDigest ||
              reply.recordDigest !== sha256(Buffer.from(bytes)) ||
              record.schemaVersion !== 1 ||
              record.kind !== "node-physical-execution" ||
              record.requestDigest !== requestDigest ||
              record.enrollmentDigest !== configuration.enrollmentDigest ||
              record.validUntil !== deadline ||
              typeof record.observedAt !== "string" ||
              !Number.isFinite(Date.parse(record.observedAt)) ||
              Date.parse(record.observedAt) > Date.now() ||
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
            original.resolve(Object.freeze(record));
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
        const handle = Object.freeze({ kind: "node-physical-execution" as const });
        captures.set(handle, {
          close,
          async inspect() {
            try {
              const current = receive("current");
              await writeNativeFrame(
                child.stdin,
                { schemaVersion: 1, method: "inspect", requestDigest, recordDigest },
                signal,
              );
              return await current;
            } catch (error) {
              await close();
              throw error;
            }
          },
        });
        return handle;
      } catch (error) {
        await close();
        throw error;
      }
    },
    inspect(handle: NodeExecutionCapture) {
      const capture = captures.get(handle);
      if (!capture) throw nativeUnavailable();
      return capture.inspect();
    },
    async close(handle: NodeExecutionCapture) {
      const capture = captures.get(handle);
      if (!capture) throw nativeUnavailable();
      await capture.close();
    },
  });
}
