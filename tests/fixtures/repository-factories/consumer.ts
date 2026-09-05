import type { PlatformReadView } from "@openclaw-enterprise/occ/ports/platform-read-view";
import type { PlatformUnitOfWork } from "@openclaw-enterprise/occ/ports/platform-unit-of-work";
import type {
  RepositoryFactory,
  QueryRepositoryFactoryContext,
} from "@openclaw-enterprise/occ/ports/repository-factory";
import type { ConfigurationReadRepository } from "@openclaw-enterprise/occ/ports/repositories/configuration";
import type { PlatformStateStore } from "@openclaw-enterprise/occ/ports/transaction";
import { queryConfigurationReader, memoryConfigurationReader } from "./producer.ts";

export async function consume(store: PlatformStateStore) {
  return store.read(async (read: PlatformReadView) => read.namespaces.listNamespaces());
}
export function mutableProjection(unit: PlatformUnitOfWork): ConfigurationReadRepository {
  return unit.configurations;
}
export const producer: RepositoryFactory<
  Parameters<typeof queryConfigurationReader>[0],
  ConfigurationReadRepository
> = queryConfigurationReader;
export function forbiddenCapabilities(
  backend: QueryRepositoryFactoryContext,
  snapshot: Parameters<typeof memoryConfigurationReader>[0],
  read: PlatformReadView,
) {
  // @ts-expect-error Repository factories cannot acquire clients.
  backend.pool.connect();
  // @ts-expect-error A query capability has no independent commit method.
  backend.query.commit();
  // @ts-expect-error A borrowed lifetime cannot close the owner's transaction.
  backend.transaction.finish();
  // @ts-expect-error A domain snapshot does not contain unrelated resource maps.
  snapshot.snapshot.agents.clear();
  // @ts-expect-error Read projections cannot mutate resources.
  read.namespaces.lockNamespace("namespace");
  // @ts-expect-error Scope comes from composition and is immutable.
  backend.scope.installationId = "foreign";
}
