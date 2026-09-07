// Controlled values exercise the local owner; they are not production admission or material.
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
export function binding() {
  return {
    startup: {
      installationId: "installation-fixture",
      processRef: "process-fixture",
      processGeneration: 7,
      operationRef: "startup-fixture",
      operationDigest: "a".repeat(64),
    },
    createEffectRef: "create-fixture",
    selection: { recordRef: "selection-fixture", recordVersion: 2 },
    configurationRef: "configuration-fixture",
    configurationVersion: 3,
    profileRef: "profile-fixture",
    profileVersion: 2,
    namespaceRef: "namespace-fixture",
    agentRef: "agent-fixture",
    admittedRevisionRef: "revision-fixture",
    gatewayAssignmentRef: "assignment-fixture",
    hostRuntimeGeneration: 19,
    nativeConfigRef: "native-fixture",
    configDigest: "b".repeat(64),
    stateOwnership: { recordRef: "paths-fixture", recordVersion: 1 },
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    modules: [
      {
        id: "identity",
        kind: "identity",
        profileRef: "identity-profile",
        requiredCapabilities: [],
      },
      { id: "slack", kind: "channel", profileRef: "slack-profile", requiredCapabilities: [] },
      { id: "teams", kind: "channel", profileRef: "teams-profile", requiredCapabilities: [] },
      { id: "harness", kind: "harness", profileRef: "harness-profile", requiredCapabilities: [] },
      {
        id: "persistence",
        kind: "persistence",
        profileRef: "persistence-profile",
        requiredCapabilities: [],
      },
    ],
    startupDeadlineMs: 1000,
    shutdownDeadlineMs: 1000,
  };
}
export function controlledPeer() {
  const events = [];
  const revoke = new AbortController();
  const b = binding();
  const readiness = deferred();
  const c = {
    schemaVersion: 1,
    installationRef: b.startup.installationId,
    namespaceRef: b.namespaceRef,
    agentRef: b.agentRef,
    admittedRevisionRef: b.admittedRevisionRef,
    gatewayAssignmentRef: b.gatewayAssignmentRef,
    runtimeGeneration: b.hostRuntimeGeneration,
    nativeConfigRef: b.nativeConfigRef,
    nativeConfigJson: "{}",
    configDigest: b.configDigest,
    statePaths: {
      root: "/fixture/root",
      gatewayPrivate: "/fixture/private",
      workspace: "/fixture/workspace",
      sessionProjection: "/fixture/sessions",
    },
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    modules: b.modules,
    startupDeadlineMs: 1000,
    shutdownDeadlineMs: 1000,
  };
  const material = {
    input: {
      configuration: c,
      dependencies: {
        modules: [],
        authorizeOperation: async () => undefined,
        consumeAttempt: async () => undefined,
        reauthorizeOutput: async () => undefined,
      },
      slack: {},
      teams: {},
    },
    assertCurrent() {
      events.push("material-fence");
    },
    async close() {
      events.push("material-close");
      return "finished";
    },
  };
  const grant = {
    binding: b,
    signal: revoke.signal,
    async recheckCurrent() {
      events.push("current");
    },
    assertCurrent() {
      events.push("fence");
    },
    async readClaim() {
      events.push("claim-read");
      return "current";
    },
    async borrowMaterial() {
      events.push("borrow");
      return material;
    },
    async close() {
      events.push("grant-close");
      return "finished";
    },
  };
  const host = {
    configuration: c,
    startupSettled: readiness.promise,
    status() {
      return {
        phase: "starting",
        runtimeGeneration: 19,
        admittedRevisionRef: b.admittedRevisionRef,
      };
    },
    quiesce() {
      events.push("quiesce");
    },
    async close() {
      events.push("host-close");
      readiness.resolve({
        phase: "closed",
        runtimeGeneration: 19,
        admittedRevisionRef: b.admittedRevisionRef,
        cleanup: "finished",
      });
      return { cleanup: "finished", termination: "unknown" };
    },
  };
  let hostOwned = false;
  const prepared = {
    start() {
      events.push("start");
      hostOwned = true;
      return host;
    },
    async close() {
      events.push("prepared-close");
      return hostOwned ? host.close() : { cleanup: "finished" };
    },
  };
  const source = {
    async enroll() {
      events.push("enroll");
      return grant;
    },
  };
  const adapter = {
    async prepare() {
      events.push("prepare");
      return prepared;
    },
  };
  return {
    events,
    revoke,
    binding: b,
    readiness,
    material,
    grant,
    host,
    prepared,
    source,
    adapter,
    ready() {
      readiness.resolve({
        phase: "ready",
        runtimeGeneration: 19,
        admittedRevisionRef: b.admittedRevisionRef,
      });
    },
  };
}

// Storage and authority are controlled collaborators. These exercise the real owner
// and phase, not PostgreSQL, NativeIAM, physical settlement or production authentication.
export async function controlledOwner() {
  const { createGatewayStartupOwnerV1, GatewayStartupOwnerPhaseV1, parseGatewayStartupEventV1 } =
    await import("../../../packages/occ/src/gateway-startup-v1/owner.ts");
  const { RepositoryTransactionLifetime } =
    await import("../../../packages/occ/src/ports/transaction.ts");
  let retained = {
    head: {
      version: 0,
      processGeneration: 0,
      latestOperationRef: null,
      startup: null,
      recordVersion: 0,
      state: "empty",
    },
    events: new Map(),
    audits: [],
  };
  let sequence = 0,
    tail = Promise.resolve();
  const events = [];
  const options = {
    terminal: "committed",
    failAudit: false,
    beforeFinalize: undefined,
    query: async () => ({ rows: [], rowCount: 0 }),
    current: true,
  };
  const { startup: _s, createEffectRef: _e, ...selected } = binding();
  const lease = (label) => ({
    assertCurrent() {
      events.push(`${label}-fence`);
      if (!options.current) throw Error("controlled currentness loss");
    },
    async release() {
      events.push(`${label}-release`);
    },
  });
  const participants = {
    authority: {
      async consume(invocation, command, bounds, unit, io) {
        io.assertActive();
        events.push("account");
        if (invocation !== token) throw Error("unregistered controlled invocation");
        return {
          ...lease("account"),
          attribution: {
            actorId: "actor-fixture",
            requestRef: bounds.requestRef,
            decisionRef: "decision-fixture",
          },
        };
      },
    },
    selection: {
      async resolveLocked() {
        events.push("selection");
        return { ...lease("selection"), selected };
      },
    },
    process: {
      async requireDisposition(command, previous) {
        events.push("disposition");
        return {
          ...lease("process"),
          predecessor: {
            disposition: command.predecessorDisposition,
            previousStartup: previous?.binding.startup ?? null,
            processOwner: { recordRef: "physical-owner", recordVersion: 1 },
            settlement: { recordRef: "physical-settlement", recordVersion: 1 },
          },
        };
      },
      async requireCurrent() {
        events.push("process-current");
        return lease("process");
      },
    },
    audit: {
      async append(event, attribution, unit, io) {
        io.assertActive();
        events.push("audit");
        if (options.failAudit) throw Error("controlled audit failure");
        unit.controlledDraft.audits.push({ event: event.auditEventId, actor: attribution.actorId });
      },
    },
    allocate(kind) {
      events.push(`allocate-${kind}`);
      return `${kind}-${++sequence}`;
    },
  };
  const transaction = {
    run(command, bounds, work) {
      const invocation = tail.then(async () => {
        const draft = structuredClone(retained);
        const lifetime = new RepositoryTransactionLifetime();
        const phase = new GatewayStartupOwnerPhaseV1(lifetime, options.query);
        const active = (io) => io.assertActive();
        const backend = {
          async lockHead(io) {
            active(io);
            events.push("head");
            return draft.head;
          },
          async readHead(io) {
            active(io);
            return draft.head;
          },
          async findOperation(io, ref) {
            active(io);
            return draft.events.get(ref);
          },
          async readAcceptance(io, target) {
            active(io);
            return draft.events.get(target.operationRef)?.acceptance;
          },
          async findSubmission(io, target) {
            active(io);
            return [...draft.events.values()].find(
              (e) => e.kind === "submit-create" && e.startup.operationRef === target.operationRef,
            );
          },
          async findClaim(io, target) {
            active(io);
            return [...draft.events.values()].find(
              (e) => e.kind === "consume-startup" && e.startup.operationRef === target.operationRef,
            );
          },
          async append(io, event) {
            active(io);
            const checked = parseGatewayStartupEventV1(event);
            if (draft.events.has(checked.command.operationRef))
              throw Error("duplicate controlled record");
            draft.events.set(checked.command.operationRef, checked);
          },
          async advanceHead(io, expected, event) {
            active(io);
            draft.head = {
              version: event.afterHeadVersion,
              processGeneration: event.startup.processGeneration,
              latestOperationRef: event.command.operationRef,
              startup: event.startup,
              recordVersion: event.afterRecordVersion,
              state: {
                "accept-startup": "accepted",
                "submit-create": "create-submitted",
                "consume-startup": "consumed",
                withdraw: "withdrawn",
              }[event.kind],
            };
          },
        };
        let dispatch = false;
        let acknowledged = false;
        let terminal = "rolled-back";
        let response = { kind: "unknown" };
        try {
          await work({
            installationId: binding().startup.installationId,
            phase,
            backend,
            policy: {},
            controlledDraft: draft,
          });
          await options.beforeFinalize?.(phase);
          await phase.drainAccepted();
          await lifetime.finish();
          const completion = phase.finalize();
          if (completion.kind === "rollback") {
            response = { kind: "rolled-back", response: completion.response };
          } else {
            phase.markCommitDispatched();
            dispatch = true;
            terminal = options.terminal;
            events.push("commit-dispatched");
            if (options.terminal === "committed") {
              retained = draft;
              phase.observeCommitAcknowledgement("COMMIT");
              acknowledged = true;
            }
            if (options.terminal === "commit-unknown") retained = draft;
            response =
              options.terminal === "committed"
                ? { kind: "committed", response: completion.provisional }
                : options.terminal === "commit-rejected"
                  ? { kind: "rolled-back", response: { kind: "unavailable" } }
                  : { kind: "unknown" };
          }
        } catch (error) {
          phase.poison(error);
          events.push("failed");
          terminal = acknowledged ? "committed" : dispatch ? "commit-unknown" : "rolled-back";
          response = { kind: "unknown" };
        } finally {
          await phase.drainAccepted();
          await lifetime.finish();
          // Controlled transaction terminal settlement. Real PG client release
          // is separately exercised by the explicitly selected integration test.
          events.push("client-settled");
          events.push(`phase-terminal-${terminal}`);
          try {
            await phase.finishTerminal(terminal);
          } catch {
            response = { kind: "unknown" };
          }
        }
        return response;
      });
      tail = invocation.then(
        () => {},
        () => {},
      );
      return invocation;
    },
  };
  const token = Object.freeze({});
  const bounds = {
    requestRef: "request-fixture",
    deadline: "2099-01-01T00:00:00.000Z",
    signal: new AbortController().signal,
  };
  const owner = createGatewayStartupOwnerV1({ transaction, participants });
  const accept = {
    schemaVersion: 1,
    kind: "accept-startup",
    operationRef: "accept-fixture",
    expectedHead: null,
    selectedDefinition: selected.selection,
    predecessorDisposition: { recordRef: "initial-disposition", recordVersion: 1 },
  };
  return {
    owner,
    participants,
    transaction,
    options,
    events,
    selected,
    token,
    bounds,
    accept,
    retained: () => retained,
    execute: (command) => owner.execute(command, token, bounds),
  };
}
export function submissionCommand(accepted, operationRef = "submission-fixture") {
  const startup = accepted.record.binding.startup;
  return {
    schemaVersion: 1,
    kind: "submit-create",
    operationRef,
    startup,
    expectedHead: { version: accepted.head.version, startup, recordVersion: 1 },
    input: {
      binding: accepted.record.binding,
      target: {
        clusterRef: "cluster-fixture",
        namespace: { name: "namespace", uid: "namespace-uid", resourceVersion: "11" },
        deploymentName: "installation-gateway",
      },
      launchPlan: { recordRef: "launch-plan-fixture", recordVersion: 1 },
    },
  };
}
export function consumeCommand(accepted, submitted) {
  const startup = accepted.record.binding.startup;
  return {
    schemaVersion: 1,
    kind: "consume-startup",
    operationRef: "consume-fixture",
    startup,
    expectedHead: { version: submitted.event.afterHeadVersion, startup, recordVersion: 2 },
    recipient: {
      recipient: { recordRef: "recipient-fixture", recordVersion: 1 },
      process: { recordRef: "process-observation-fixture", recordVersion: 1 },
      incarnationRef: "incarnation-fixture",
      observation: { recordRef: "current-observation", recordVersion: 1 },
    },
  };
}
