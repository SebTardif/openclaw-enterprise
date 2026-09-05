import type {
  CreateChannelInstallation,
  CreateChannelHumanBinding,
  CreateChannelAgentBinding,
  ChangeChannelBindingStatus,
} from "@openclaw-enterprise/contracts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ResourceConflictError,
  ChannelBindingInvalidError,
  ChannelBindingNotFoundError,
  type ChannelBindingService,
} from "@openclaw-enterprise/occ";

const operations = [
  "createChannelInstallation",
  "getChannelInstallation",
  "listChannelInstallations",
  "setChannelInstallationStatus",
  "createChannelHumanBinding",
  "getChannelHumanBinding",
  "listChannelHumanBindings",
  "setChannelHumanBindingStatus",
  "createChannelAgentBinding",
  "getChannelAgentBinding",
  "listChannelAgentBindings",
  "setChannelAgentBindingStatus",
] as const;
export type ChannelBindingOperationId = (typeof operations)[number];
export function isChannelBindingOperation(
  operationId: string,
): operationId is ChannelBindingOperationId {
  return (operations as readonly string[]).includes(operationId);
}

/** Called only after the central API admits credentials and validates the route schema. */
export async function performChannelBindingOperation(
  service: ChannelBindingService,
  operationId: ChannelBindingOperationId,
  context: Parameters<ChannelBindingService["createInstallation"]>[0],
  input: { params?: unknown; query?: unknown; body?: unknown },
) {
  const params = (input.params ?? {}) as Record<string, string>;
  const query = (input.query ?? {}) as { limit?: string; cursor?: string };
  const page = {
    ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };
  const handlers = {
    createChannelInstallation: () =>
      service.createInstallation(context, input.body as CreateChannelInstallation),
    getChannelInstallation: () => service.getInstallation(context, params.channelInstallationId!),
    listChannelInstallations: () => service.listInstallations(context, page),
    setChannelInstallationStatus: () =>
      service.setInstallationStatus(
        context,
        params.channelInstallationId!,
        input.body as ChangeChannelBindingStatus,
      ),
    createChannelHumanBinding: () =>
      service.createHumanBinding(
        context,
        params.channelInstallationId!,
        input.body as CreateChannelHumanBinding,
      ),
    getChannelHumanBinding: () =>
      service.getHumanBinding(context, params.channelInstallationId!, params.bindingId!),
    listChannelHumanBindings: () =>
      service.listHumanBindings(context, params.channelInstallationId!, page),
    setChannelHumanBindingStatus: () =>
      service.setHumanBindingStatus(
        context,
        params.channelInstallationId!,
        params.bindingId!,
        input.body as ChangeChannelBindingStatus,
      ),
    createChannelAgentBinding: () =>
      service.createAgentBinding(
        context,
        params.channelInstallationId!,
        input.body as CreateChannelAgentBinding,
      ),
    getChannelAgentBinding: () =>
      service.getAgentBinding(context, params.channelInstallationId!, params.bindingId!),
    listChannelAgentBindings: () =>
      service.listAgentBindings(context, params.channelInstallationId!, page),
    setChannelAgentBindingStatus: () =>
      service.setAgentBindingStatus(
        context,
        params.channelInstallationId!,
        params.bindingId!,
        input.body as ChangeChannelBindingStatus,
      ),
  } satisfies Record<ChannelBindingOperationId, () => Promise<unknown>>;
  try {
    return await handlers[operationId]();
  } catch (error) {
    if (
      error instanceof AuthorizationDeniedError ||
      error instanceof DependencyUnavailableError ||
      error instanceof ResourceConflictError ||
      error instanceof ChannelBindingInvalidError ||
      error instanceof ChannelBindingNotFoundError
    )
      throw error;
    throw new DependencyUnavailableError(
      "The channel binding state or audit dependency is unavailable.",
    );
  }
}
