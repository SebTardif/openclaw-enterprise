import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  canonicalGatewayStartupValueV1,
  gatewayStartupCommandDigestV2,
  parseGatewayStartupBindingV2,
  parseGatewayStartupEventV2,
} from "../../../packages/occ/src/gateway-startup-v1/owner.ts";
import { binding as historicalBinding } from "../gateway-startup-v1/values.mjs";
import { createGatewayStartupServiceSourceV2 } from "../../../apps/gateway/src/startup-agent-service-source.ts";
import { createGatewayStartupBootstrapV2 } from "../../../apps/gateway/src/startup-agent-bootstrap.ts";

const ref = (recordRef) => ({ recordRef, recordVersion: 1 });

/** Controlled native/material/host peers exercise the actual V2 Source,
 * bootstrap and local owner. No credential, PostgreSQL acceptance, native
 * authentication, supported profile, real SDK host or readiness is proved. */
export function controlledAgentBootstrap(options = {}) {
  const subject = {
    kind: "agent-gateway",
    installationId: `ins_${randomUUID()}`,
    namespaceRef: `ns_${randomUUID()}`,
    agentRef: `agt_${randomUUID()}`,
  };
  const startup = {
    schemaVersion: 2,
    subject,
    processRef: "process-one",
    processGeneration: 1,
    operationRef: "accept-one",
    operationDigest: "a".repeat(64),
  };
  const binding = parseGatewayStartupBindingV2({
    ...historicalBinding(),
    schemaVersion: 2,
    startup,
    namespaceRef: subject.namespaceRef,
    agentRef: subject.agentRef,
    selection: {
      manifestRef: randomUUID(),
      manifestDigest: `sha256:${"1".repeat(64)}`,
      admissionRef: randomUUID(),
      admissionVersion: 1,
    },
    profileRefs: Object.fromEntries(
      ["provider", "runtime", "identity", "containment", "storage"].map((kind) => [
        kind,
        { ref: randomUUID(), version: 1, contentDigest: `sha256:${"2".repeat(64)}` },
      ]),
    ),
    admittedConfigurationDigest: `sha256:${"3".repeat(64)}`,
  });
  const recipient = {
    recipient: ref("recipient-one"),
    process: ref("process-one"),
    incarnationRef: "incarnation-one",
    observation: ref("observation-one"),
  };
  const submissionCommand = {
    schemaVersion: 2,
    subject,
    kind: "submit-create",
    operationRef: "submit-one",
    startup,
    expectedHead: { version: 1, startup, recordVersion: 1 },
    input: {
      binding,
      target: {
        clusterRef: "controlled-cluster",
        namespace: { name: "namespace", uid: "namespace-uid", resourceVersion: "1" },
        deploymentName: "gateway",
      },
      launchPlan: ref("launch-one"),
    },
  };
  const consumeCommand = {
    schemaVersion: 2,
    subject,
    kind: "consume-startup",
    operationRef: "consume-one",
    startup,
    expectedHead: { version: 2, startup, recordVersion: 2 },
    recipient,
  };
  const event = (command, before, previousOperationRef) =>
    parseGatewayStartupEventV2({
      schemaVersion: 2,
      kind: command.kind,
      command: {
        schemaVersion: 2,
        subject,
        operationRef: command.operationRef,
        operationDigest: gatewayStartupCommandDigestV2(command),
        startup,
      },
      canonicalCommand: canonicalGatewayStartupValueV1(command),
      beforeHeadVersion: before,
      afterHeadVersion: before + 1,
      beforeRecordVersion: before,
      afterRecordVersion: before + 1,
      previousOperationRef,
      startup,
      createEffectRef: binding.createEffectRef,
      acceptance: null,
      submissionInput: command.kind === "submit-create" ? command.input : null,
      recipient: command.kind === "consume-startup" ? recipient : null,
      withdrawalReason: null,
      auditEventId: `audit-${command.operationRef}`,
    });
  const record = {
    head: {
      subject,
      version: 3,
      processGeneration: 1,
      latestOperationRef: "consume-one",
      startup,
      recordVersion: 3,
      state: "consumed",
    },
    acceptance: {
      binding,
      predecessor: {
        kind: "complete-initial",
        disposition: ref("initial-one"),
        previousStartup: null,
        processOwner: ref("owner-one"),
        settlement: ref("settlement-one"),
      },
      auditEventId: "accept-audit",
    },
    submission: event(submissionCommand, 1, "accept-one"),
    claim: event(consumeCommand, 2, "submit-one"),
  };
  const nativeAbort = new AbortController();
  const events = [];
  const counts = { nativeClose: 0, materialClose: 0, preparedClose: 0, boundClose: 0, starts: 0 };
  let handle;
  let materialParent;
  const connection = {
    binding,
    consumeCommand,
    signal: nativeAbort.signal,
    expiresAtMs: Date.now() + 10000,
    assertCurrent() {
      if (nativeAbort.signal.aborted) throw new Error("Controlled native source closed");
      return options.nativeFence?.();
    },
    async recheckCurrent() {},
    async execute(command, bounds) {
      events.push(command.kind);
      assert.deepEqual(command.subject, subject);
      assert.deepEqual(command.startup, startup);
      assert.ok(Date.parse(bounds.deadline) <= connection.expiresAtMs);
      if (options.execute) return options.execute(command, bounds, record);
      return { kind: command.kind === "consume-startup" ? "consumed" : "current", record };
    },
    async close() {
      counts.nativeClose++;
      nativeAbort.abort();
      return options.nativeCleanup ?? "finished";
    },
  };
  const originals = new WeakSet([connection]);
  const service = createGatewayStartupServiceSourceV2({
    assertOriginal(value) {
      if (!originals.has(value)) throw new Error("Controlled foreign native object");
    },
    async open() {
      events.push("authenticate");
      if (options.openWait) await options.openWait();
      return connection;
    },
  });
  const configuration = {
    schemaVersion: 1,
    installationRef: subject.installationId,
    namespaceRef: binding.namespaceRef,
    agentRef: binding.agentRef,
    admittedRevisionRef: binding.admittedRevisionRef,
    gatewayAssignmentRef: binding.gatewayAssignmentRef,
    runtimeGeneration: binding.hostRuntimeGeneration,
    nativeConfigRef: binding.nativeConfigRef,
    configDigest: binding.configDigest,
    stateSchemaVersion: binding.stateSchemaVersion,
    agentSchemaVersion: binding.agentSchemaVersion,
    protocolVersion: binding.protocolVersion,
    startupDeadlineMs: binding.startupDeadlineMs,
    shutdownDeadlineMs: binding.shutdownDeadlineMs,
    modules: binding.modules,
    ...options.configuration,
  };
  const materialFactory = {
    async bind(original, parent, runtime) {
      events.push("bind-material");
      assert.equal(original, service);
      assert.equal(events.filter((value) => value === "consume-startup").length, 1);
      assert.deepEqual(original.binding(parent), binding);
      handle = parent;
      materialParent = runtime;
      assert.equal(runtime.assertCurrent(), undefined);
      assert.ok(runtime.remainingStartupMs() > 0);
      assert.ok(Object.isFrozen(runtime));
      if (options.bindWait) await options.bindWait();
      return {
        async borrowMaterial() {
          events.push("borrow-material");
          if (options.borrowWait) await options.borrowWait();
          if (options.borrowFailure) {
            await runtime.joinConsumers();
            throw new Error("Controlled material acquisition refused");
          }
          return {
            input: { configuration, dependencies: {}, slack: {}, teams: {} },
            assertCurrent() {
              runtime.assertCurrent();
              if (nativeAbort.signal.aborted) throw new Error("Controlled material revoked");
            },
            async close() {
              try {
                await runtime.joinConsumers();
              } catch {
                return "unknown";
              }
              counts.materialClose++;
              events.push("release-material");
              return options.materialCleanup ?? "finished";
            },
          };
        },
        async close() {
          try {
            await runtime.joinConsumers();
          } catch {
            return "unknown";
          }
          counts.boundClose++;
          if (options.boundCloseWait) await options.boundCloseWait();
          return options.boundCleanup ?? "finished";
        },
      };
    },
  };
  const adapter = {
    async prepare() {
      events.push("prepare");
      if (options.prepareWait) await options.prepareWait();
      if (options.prepareFailure) throw new Error("Controlled preparation refused before handoff");
      return {
        start() {
          counts.starts++;
          events.push("start");
          return {
            quiesce() {
              events.push("quiesce");
            },
            startupSettled: Promise.resolve({
              phase: "ready",
              runtimeGeneration: binding.hostRuntimeGeneration,
              admittedRevisionRef: binding.admittedRevisionRef,
              ...options.ready,
            }),
          };
        },
        async close() {
          counts.preparedClose++;
          if (options.preparedCloseWait) await options.preparedCloseWait();
          if (options.preparedCloseFailure)
            throw new Error("Controlled prepared owner close failed");
          return { cleanup: options.preparedCleanup ?? "finished" };
        },
      };
    },
  };
  return {
    bootstrap: createGatewayStartupBootstrapV2(service, materialFactory, adapter),
    service,
    binding,
    connection,
    record,
    events,
    counts,
    nativeAbort,
    get materialParent() {
      return materialParent;
    },
    get handle() {
      return handle;
    },
  };
}
