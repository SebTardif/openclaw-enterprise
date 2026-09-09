import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import type { GatewayStartupBindingV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import type { GatewayCompositionInput } from "./composition.ts";
import {
  GATEWAY_MATERIAL_LIMITS_V1,
  GatewayMaterialUnavailableV1,
  createGatewayMaterialCustodyV1,
  assertGatewayMaterialCurrentV1,
  type GatewayMaterialOwnedLeaseV1,
  type GatewayMaterialCleanupV1,
} from "./startup-material-custody.ts";

type SlackProfile = NonNullable<GatewayCompositionInput["slack"]>["options"]["profile"];
type TeamsProfile = NonNullable<GatewayCompositionInput["teams"]>["ingress"]["profile"];
type MaterialVersion = Readonly<{ ref: string; version: number }>;

/** Nonsecret expectations captured from original owners, never startup authority. */
export type GatewayMaterialSelectionV1 = Readonly<{
  binding: GatewayStartupBindingV1;
  recipientRef: string;
  recipientIncarnation: string;
  statePaths: GatewayCompositionInput["configuration"]["statePaths"];
  slack: Readonly<{
    moduleId: string;
    profile: SlackProfile;
    botUserId: string;
    botCredential: MaterialVersion;
    appCredential: MaterialVersion;
  }> | null;
  teams: Readonly<{
    moduleId: string;
    profile: TeamsProfile;
    credential: MaterialVersion;
    teamRef: string;
    serviceUrl: string;
    messagingEndpoint: `/${string}`;
    listener: NonNullable<GatewayCompositionInput["teams"]>["listener"];
  }> | null;
}>;

function unavailable(): never {
  throw new GatewayMaterialUnavailableV1();
}

function version(value: MaterialVersion): void {
  if (
    typeof value.ref !== "string" ||
    value.ref.length < 1 ||
    value.ref.length > 200 ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  )
    unavailable();
}

function materialBytes(value: string): number {
  // In Unicode mode, the surrogate range matches only unpaired UTF-16 code units.
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > GATEWAY_MATERIAL_LIMITS_V1.itemBytes ||
    value.includes("\0") ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    unavailable();
  // UTF-16 length is bounded above before either content scan or byte count.
  const count = Buffer.byteLength(value, "utf8");
  if (count > GATEWAY_MATERIAL_LIMITS_V1.itemBytes) unavailable();
  return count;
}

/** Complete local data correspondence only. Current authority, protected source,
 * immutable versions and path ownership must already be supplied by their owners.
 * No returned value from this function can enroll a recipient or authorize use. */
export function inspectGatewayMaterialInputV1(
  selected: GatewayMaterialSelectionV1,
  observed: GatewayMaterialSelectionV1,
  input: GatewayCompositionInput,
): Readonly<{ slackMaterialBytes: number }> {
  try {
    if (!isDeepStrictEqual(selected, observed)) unavailable();
    if (!selected.recipientRef || !selected.recipientIncarnation) unavailable();
    if (
      selected.slack === undefined ||
      selected.teams === undefined ||
      input.slack === undefined ||
      input.teams === undefined ||
      (selected.slack === null) !== (input.slack === null) ||
      (selected.teams === null) !== (input.teams === null)
    )
      unavailable();
    if (selected.slack !== null) {
      version(selected.slack.botCredential);
      version(selected.slack.appCredential);
    }
    if (selected.teams !== null) version(selected.teams.credential);
    const binding = selected.binding;
    const config = input.configuration;
    const expected = {
      schemaVersion: 1,
      installationRef: binding.startup.installationId,
      namespaceRef: binding.namespaceRef,
      agentRef: binding.agentRef,
      admittedRevisionRef: binding.admittedRevisionRef,
      gatewayAssignmentRef: binding.gatewayAssignmentRef,
      runtimeGeneration: binding.hostRuntimeGeneration,
      nativeConfigRef: binding.nativeConfigRef,
      nativeConfigJson: config.nativeConfigJson,
      configDigest: binding.configDigest,
      statePaths: selected.statePaths,
      stateSchemaVersion: binding.stateSchemaVersion,
      agentSchemaVersion: binding.agentSchemaVersion,
      protocolVersion: binding.protocolVersion,
      modules: binding.modules,
      startupDeadlineMs: binding.startupDeadlineMs,
      shutdownDeadlineMs: binding.shutdownDeadlineMs,
    };
    if (
      !isDeepStrictEqual(config, expected) ||
      typeof config.nativeConfigJson !== "string" ||
      config.configDigest !==
        `sha256:${createHash("sha256").update(config.nativeConfigJson).digest("hex")}`
    )
      unavailable();
    const slack = input.slack;
    const teams = input.teams;
    if (
      slack !== null &&
      (selected.slack === null ||
        slack.id !== selected.slack.moduleId ||
        !isDeepStrictEqual(slack.options.profile, selected.slack.profile) ||
        slack.options.botUserId !== selected.slack.botUserId ||
        selected.slack.profile.installationRef !== binding.startup.installationId)
    )
      unavailable();
    if (
      teams !== null &&
      (selected.teams === null ||
        teams.id !== selected.teams.moduleId ||
        !isDeepStrictEqual(teams.ingress.profile, selected.teams.profile) ||
        teams.ingress.credentialRef !== selected.teams.credential.ref ||
        teams.ingress.teamRef !== selected.teams.teamRef ||
        teams.ingress.serviceUrl !== selected.teams.serviceUrl ||
        teams.ingress.messagingEndpoint !== selected.teams.messagingEndpoint ||
        !isDeepStrictEqual(teams.listener, selected.teams.listener) ||
        selected.teams.profile.installationRef !== binding.startup.installationId)
    )
      unavailable();
    const external = input.dependencies.modules;
    if (
      external.length !== 3 ||
      ["identity", "harness", "persistence"].some(
        (kind) => external.filter((module) => module.kind === kind).length !== 1,
      )
    )
      unavailable();
    const modules = [
      ...external,
      ...(slack === null
        ? []
        : [
            {
              id: slack.id,
              kind: "channel",
              profileRef: slack.options.profile.adapterProfileRef,
            },
          ]),
      ...(teams === null
        ? []
        : [
            {
              id: teams.id,
              kind: "channel",
              profileRef: teams.ingress.profile.adapterProfileRef,
            },
          ]),
    ];
    if (
      binding.modules.length !== modules.length ||
      new Set(modules.map((module) => module.id)).size !== modules.length ||
      new Set(binding.modules.map((module) => module.id)).size !== modules.length ||
      binding.modules.some(
        (expected) =>
          !modules.some(
            (module) =>
              module.id === expected.id &&
              module.kind === expected.kind &&
              module.profileRef === expected.profileRef,
          ),
      )
    )
      unavailable();
    if (
      external.some(
        (module) => typeof module.start !== "function" || typeof module.close !== "function",
      ) ||
      [
        input.dependencies.authorizeOperation,
        input.dependencies.consumeAttempt,
        input.dependencies.reauthorizeOutput,
        ...(slack === null
          ? []
          : [slack.options.assertCurrent, slack.options.authorizeOutput, slack.receiver.receive]),
        ...(teams === null
          ? []
          : [
              teams.ingress.getBotToken,
              teams.ingress.resolveReply,
              teams.ingress.authority.assertCurrent,
              teams.ingress.authority.resolveHuman,
              teams.ingress.authority.resolveConversation,
              teams.ingress.authority.readClock,
              teams.ingress.admission.assertCurrent,
              teams.ingress.admission.admit,
              teams.ingress.admission.consumeAttempt,
              teams.ingress.admission.reauthorizeOutput,
              teams.ingress.admission.isCompletionCommitted,
              teams.ingress.admission.reserveDelivery,
              teams.ingress.admission.recordDelivery,
              teams.ingress.admission.authorizeCancel,
              teams.ingress.admission.commitCancellation,
            ]),
      ].some((method) => typeof method !== "function")
    )
      unavailable();
    if (
      [
        slack?.options.receiveNonTurn,
        slack?.options.onHealth,
        teams?.ingress.admission.onNativeEvent,
      ].some((method) => method !== undefined && typeof method !== "function")
    )
      unavailable();
    const native = teams?.ingress.admission.native;
    if (
      native !== undefined &&
      (!native || typeof native.dispatch !== "function" || typeof native.cancel !== "function")
    )
      unavailable();
    const slackMaterialBytes =
      slack === null
        ? 0
        : materialBytes(slack.options.botToken) + materialBytes(slack.options.appToken);
    if (slackMaterialBytes > GATEWAY_MATERIAL_LIMITS_V1.bundleBytes) unavailable();
    return Object.freeze({ slackMaterialBytes });
  } catch {
    throw new GatewayMaterialUnavailableV1();
  }
}

/** Original protected source, already selected for one authenticated recipient.
 * This interface does not provide a physical secret reader or authenticate one. */
export interface GatewayMaterialSourceLeaseV1 extends GatewayMaterialOwnedLeaseV1 {
  readonly observed: GatewayMaterialSelectionV1;
  readonly input: GatewayCompositionInput;
  assertCurrent(): undefined;
  /** Conservative remaining original lease time, never a renewed local TTL. */
  remainingMs(): number;
}

export interface GatewayMaterialSourceV1 {
  assertCurrent(): undefined;
  remainingMs(): number;
  acquire(
    selection: GatewayMaterialSelectionV1,
    signal: AbortSignal,
  ): Promise<GatewayMaterialSourceLeaseV1>;
}

/** Captured by genuine Runtime composition after its sole confirmed claim.
 * None of these callbacks may be reconstructed from configuration or caller JSON. */
export interface GatewayMaterialRuntimeOwnerV1 {
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  remainingStartupMs(): number;
  /** Resolves only after pending preparation AND all native consumers settle.
   * The existing prepared/native owner initiates their close. This is a join,
   * not a second closer; rejection leaves material retained with unknown cleanup.
   * Pre-transfer failures must also settle any resources created by preparation. */
  joinConsumers(): Promise<void>;
}

/** Structural material lease consumed by the original local Runtime grant. */
export interface GatewayStartupMaterialBorrowV1 {
  readonly input: GatewayCompositionInput;
  assertCurrent(): undefined;
  close(): Promise<GatewayMaterialCleanupV1["cleanup"]>;
}

function freezeData<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** A one-use local borrower. This factory is internal trusted composition, not
 * an enrollment API. Production stays unavailable without the original source,
 * confirmed-claim owner and its genuine consumer-settlement join. */
function createBorrower(
  owner: GatewayMaterialRuntimeOwnerV1,
  selection: GatewayMaterialSelectionV1,
  source: GatewayMaterialSourceV1,
): Readonly<{
  borrowMaterial(): Promise<GatewayStartupMaterialBorrowV1>;
  close(): Promise<GatewayMaterialCleanupV1["cleanup"]>;
}> {
  // Snapshot data before any await, and capture original methods once. Immutable
  // correspondence prevents mutation; it does not manufacture source authority.
  let selected: GatewayMaterialSelectionV1;
  try {
    selected = freezeData(structuredClone(selection));
  } catch {
    return unavailable();
  }
  const parentSignal = owner.signal;
  const assertOwner = owner.assertCurrent.bind(owner);
  const startupRemaining = owner.remainingStartupMs.bind(owner);
  const joinConsumers = owner.joinConsumers.bind(owner);
  const assertSource = source.assertCurrent.bind(source);
  const sourceRemaining = source.remainingMs.bind(source);
  const acquire = source.acquire.bind(source);
  const controller = new AbortController();
  const custody = createGatewayMaterialCustodyV1(controller.signal);
  const pending = new Set<Promise<unknown>>();
  let used = false;
  let closing: Promise<GatewayMaterialCleanupV1["cleanup"]> | undefined;
  let original: GatewayMaterialSourceLeaseV1 | undefined;
  let leaseFence: (() => undefined) | undefined;
  let leaseRemaining: (() => number) | undefined;
  let tokenBusy = false;
  let slackBytes = 0;
  let acquisitionTimer: ReturnType<typeof setTimeout> | undefined;

  const invalidate = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  parentSignal.addEventListener("abort", invalidate, { once: true });
  custody.signal.addEventListener("abort", invalidate, { once: true });
  if (parentSignal.aborted) invalidate();

  function remaining(read: () => number): number {
    const value: unknown = read();
    if (value instanceof Promise) {
      void Promise.prototype.then.call(value, undefined, () => {});
      return unavailable();
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) unavailable();
    return value;
  }
  function assertCurrent(): undefined {
    try {
      custody.assertActive();
      if (closing || parentSignal.aborted) unavailable();
      assertGatewayMaterialCurrentV1(assertOwner);
      assertGatewayMaterialCurrentV1(assertSource);
      remaining(sourceRemaining);
      if (leaseFence) assertGatewayMaterialCurrentV1(leaseFence);
      if (leaseRemaining) remaining(leaseRemaining);
      custody.assertActive();
      return undefined;
    } catch {
      invalidate();
      return unavailable();
    }
  }

  function close(): Promise<GatewayMaterialCleanupV1["cleanup"]> {
    if (closing) return closing;
    let finish!: (result: GatewayMaterialCleanupV1["cleanup"]) => void;
    closing = new Promise((resolve) => {
      finish = resolve;
    });
    invalidate();
    if (acquisitionTimer) clearTimeout(acquisitionTimer);
    parentSignal.removeEventListener("abort", invalidate);
    void (async () => {
      try {
        // Never infer consumer settlement from a timer, invalidation, a Boolean,
        // or a parallel close call. A failed join cannot release borrowed bytes.
        const result = await joinConsumers();
        if (result !== undefined) {
          finish("unknown");
          return;
        }
        await Promise.allSettled([...pending]);
        finish((await custody.close()).cleanup);
      } catch {
        finish("unknown");
      }
    })();
    return closing;
  }

  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }

  async function borrowMaterial(): Promise<GatewayStartupMaterialBorrowV1> {
    if (used) unavailable();
    used = true;
    try {
      assertCurrent();
      const startedAt = performance.now();
      const deadline = Math.min(
        remaining(startupRemaining),
        remaining(sourceRemaining),
        GATEWAY_MATERIAL_LIMITS_V1.acquisitionMs,
      );
      const assertAcquiring = () => {
        assertCurrent();
        if (performance.now() - startedAt >= deadline) unavailable();
      };
      acquisitionTimer = setTimeout(invalidate, deadline);
      const acquired = track(
        custody.acquire((signal) => {
          assertAcquiring();
          return acquire(selected, signal);
        }),
      );
      // A timeout refuses promptly but keeps ownership of the original pending
      // acquisition. A late lease is still captured and released exactly once.
      original = await new Promise<GatewayMaterialSourceLeaseV1>((resolve, reject) => {
        const abort = () => reject(new GatewayMaterialUnavailableV1());
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
        void acquired
          .then(resolve, () => reject(new GatewayMaterialUnavailableV1()))
          .finally(() => controller.signal.removeEventListener("abort", abort));
      });
      assertAcquiring();
      leaseFence = original.assertCurrent.bind(original);
      leaseRemaining = original.remainingMs.bind(original);
      assertCurrent();
      remaining(startupRemaining);
      const raw = original.input;
      slackBytes = inspectGatewayMaterialInputV1(
        selected,
        original.observed,
        raw,
      ).slackMaterialBytes;
      // Snapshot every data value and capture the original callback implementations.
      // Native state paths are data here; the original source still owns their lease.
      const configuration = freezeData(structuredClone(raw.configuration));
      const captureSlack = (): GatewayCompositionInput["slack"] => {
        const slack = raw.slack;
        if (slack === null) return null;
        const slackAssert = slack.options.assertCurrent.bind(slack.options);
        return Object.freeze({
          ...slack,
          receiver: Object.freeze({
            ...slack.receiver,
            receive: slack.receiver.receive.bind(slack.receiver),
          }),
          options: Object.freeze({
            ...slack.options,
            profile: freezeData(structuredClone(slack.options.profile)),
            assertCurrent: () => {
              assertCurrent();
              assertGatewayMaterialCurrentV1(slackAssert);
              assertCurrent();
            },
            authorizeOutput: slack.options.authorizeOutput.bind(slack.options),
            ...(slack.options.receiveNonTurn === undefined
              ? {}
              : {
                  receiveNonTurn: slack.options.receiveNonTurn.bind(slack.options),
                }),
            ...(slack.options.onHealth === undefined
              ? {}
              : {
                  onHealth: slack.options.onHealth.bind(slack.options),
                }),
          }),
        });
      };
      const captureTeams = (): GatewayCompositionInput["teams"] => {
        const teams = raw.teams;
        if (teams === null) return null;
        const selectedTeams = selected.teams;
        if (selectedTeams === null) return unavailable();
        const getToken = teams.ingress.getBotToken.bind(teams.ingress);
        const teamsAssert = teams.ingress.authority.assertCurrent.bind(teams.ingress.authority);
        const admissionAssert = teams.ingress.admission.assertCurrent.bind(teams.ingress.admission);
        const admission = teams.ingress.admission;
        const native = admission.native;
        const tokenTarget = Object.freeze({
          credentialRef: selectedTeams.credential.ref,
          appId: selectedTeams.profile.recipientAppRef,
          tenantId: selectedTeams.profile.providerTenantRef,
          scope: "https://api.botframework.com/.default" as const,
        });
        return Object.freeze({
          ...teams,
          listener: freezeData(structuredClone(teams.listener)),
          ingress: Object.freeze({
            ...teams.ingress,
            resolveReply: teams.ingress.resolveReply.bind(teams.ingress),
            profile: freezeData(structuredClone(teams.ingress.profile)),
            authority: Object.freeze({
              ...teams.ingress.authority,
              assertCurrent: () => {
                assertCurrent();
                assertGatewayMaterialCurrentV1(teamsAssert);
                assertCurrent();
              },
              resolveHuman: teams.ingress.authority.resolveHuman.bind(teams.ingress.authority),
              resolveConversation: teams.ingress.authority.resolveConversation.bind(
                teams.ingress.authority,
              ),
              readClock: teams.ingress.authority.readClock.bind(teams.ingress.authority),
            }),
            admission: Object.freeze({
              ...admission,
              admit: admission.admit.bind(admission),
              consumeAttempt: admission.consumeAttempt.bind(admission),
              reauthorizeOutput: admission.reauthorizeOutput.bind(admission),
              isCompletionCommitted: admission.isCompletionCommitted.bind(admission),
              reserveDelivery: admission.reserveDelivery.bind(admission),
              recordDelivery: admission.recordDelivery.bind(admission),
              authorizeCancel: admission.authorizeCancel.bind(admission),
              commitCancellation: admission.commitCancellation.bind(admission),
              ...(admission.onNativeEvent === undefined
                ? {}
                : {
                    onNativeEvent: admission.onNativeEvent.bind(admission),
                  }),
              ...(native === undefined
                ? {}
                : {
                    native: Object.freeze({
                      dispatch: native.dispatch.bind(native),
                      cancel: native.cancel.bind(native),
                    }),
                  }),
              assertCurrent: () => {
                assertCurrent();
                assertGatewayMaterialCurrentV1(admissionAssert);
                assertCurrent();
              },
            }),
            getBotToken: (request: Parameters<typeof getToken>[0], signal: AbortSignal) => {
              if (tokenBusy) return Promise.reject(new GatewayMaterialUnavailableV1());
              tokenBusy = true;
              const work = Promise.resolve().then(async () => {
                try {
                  assertCurrent();
                  if (signal.aborted || !isDeepStrictEqual(request, tokenTarget)) unavailable();
                  const joined = AbortSignal.any([signal, custody.signal]);
                  assertCurrent();
                  if (joined.aborted) unavailable();
                  const result = await getToken(tokenTarget, joined);
                  assertCurrent();
                  if (
                    joined.aborted ||
                    slackBytes + materialBytes(result) > GATEWAY_MATERIAL_LIMITS_V1.bundleBytes
                  )
                    unavailable();
                  return result;
                } catch {
                  return unavailable();
                } finally {
                  tokenBusy = false;
                }
              });
              return track(work);
            },
          }),
        });
      };
      const input: GatewayCompositionInput = Object.freeze({
        configuration,
        dependencies: Object.freeze({
          ...raw.dependencies,
          modules: Object.freeze(
            raw.dependencies.modules.map((module) =>
              Object.freeze({
                id: module.id,
                kind: module.kind,
                profileRef: module.profileRef,
                start: module.start.bind(module),
                close: module.close.bind(module),
              }),
            ),
          ),
          authorizeOperation: raw.dependencies.authorizeOperation.bind(raw.dependencies),
          consumeAttempt: raw.dependencies.consumeAttempt.bind(raw.dependencies),
          reauthorizeOutput: raw.dependencies.reauthorizeOutput.bind(raw.dependencies),
        }),
        slack: captureSlack(),
        teams: captureTeams(),
      });
      assertAcquiring();
      clearTimeout(acquisitionTimer);
      acquisitionTimer = undefined;
      return Object.freeze({ input, assertCurrent, close });
    } catch {
      invalidate();
      // Cleanup is tracked independently. Refusal never waits indefinitely for
      // a missing physical source or an unfinished original consumer.
      void close();
      return unavailable();
    }
  }
  return Object.freeze({ borrowMaterial, close });
}

/** See GatewayMaterialRuntimeOwnerV1: only original trusted composition supplies
 * these capabilities. Creating a borrower grants no startup or provider authority. */
export function createGatewayStartupMaterialBorrowerV1(
  owner: GatewayMaterialRuntimeOwnerV1,
  selection: GatewayMaterialSelectionV1,
  source: GatewayMaterialSourceV1,
): ReturnType<typeof createBorrower> {
  try {
    return createBorrower(owner, selection, source);
  } catch {
    return unavailable();
  }
}
