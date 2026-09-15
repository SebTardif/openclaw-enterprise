import type { CoreV1Api } from "@kubernetes/client-node";
import type { RepositoryBinding } from "@openclaw-enterprise/contracts";
import {
  GitHubAppTokenIssuerErrorV1,
  ProtectedGitHubCryptoV1,
  ProtectedGitHubTokenStoreV1,
  type GitHubAppMaterialV1,
  type PlatformStateStore,
  type ProtectedGitHubKeySelectionV1,
  type ProtectedGitHubStoreSelectionV1,
} from "@openclaw-enterprise/occ";
import {
  createProtectedKubernetesGitHubAppMaterialV1,
  type ProtectedKubernetesGitHubAppSourceV1,
} from "../drivers/secret/kubernetes/protected-github-app-material.ts";

/** Operator-selected correspondence between an admitted logical Secret and its
 * separately sealed, immutable App material. Ordinary Secret values and Agent
 * request fields cannot select this source. */
export interface ProtectedGitHubCredentialSelection {
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly appId: number;
  readonly installationId: number;
  readonly repositoryId: number;
  readonly source: ProtectedKubernetesGitHubAppSourceV1;
  readonly masterKey: ProtectedGitHubKeySelectionV1;
  readonly tokenStore: ProtectedGitHubStoreSelectionV1;
}

function unavailable(): never {
  throw new GitHubAppTokenIssuerErrorV1();
}

/** Constructs the protected material owners for the original repository Work
 * constructor. It grants no Work dispatch authority and does not create a
 * second token issuer. The caller must stop/join Work before closing these
 * owners, so unknown mint/revoke effects retain their original settlement path.
 *
 * TODO(repository checkout): consume this owner in the selected production Work
 * construction once its original State/native sources are connected. */
export async function prepareProtectedGitHubCredentials(options: {
  readonly state: PlatformStateStore;
  readonly client: Pick<CoreV1Api, "readNamespace" | "readNamespacedSecret">;
  readonly selection: ProtectedGitHubCredentialSelection;
  readonly clock: () => number;
}) {
  const selection = structuredClone(options.selection);
  const read = options.state.read.bind(options.state);
  const source = selection.source;
  let closed = false;

  async function readCurrentBinding(): Promise<Readonly<RepositoryBinding>> {
    if (closed) unavailable();
    return read(async (view) => {
      const binding = await view.repositoryBindings.findBinding(
        source.namespaceId,
        selection.bindingId,
      );
      const secret = await view.secrets.findSecret(source.namespaceId, source.secretId);
      if (
        closed ||
        !binding ||
        !secret ||
        binding.generation !== selection.bindingGeneration ||
        binding.appId !== selection.appId ||
        binding.installationId !== selection.installationId ||
        !binding.repositoryIds.includes(selection.repositoryId) ||
        binding.keySecretRef.namespaceId !== source.namespaceId ||
        binding.keySecretRef.id !== source.secretId ||
        source.keyIdentity.bindingRef !== binding.id ||
        secret.driverId !== source.driverId
      )
        unavailable();
      return binding;
    });
  }

  await readCurrentBinding();
  const crypto = new ProtectedGitHubCryptoV1(selection.masterKey);
  let store: ProtectedGitHubTokenStoreV1 | undefined;
  let sourceMaterial: GitHubAppMaterialV1 | undefined;
  const close = () => {
    closed = true;
    sourceMaterial?.close();
    store?.close();
    crypto.close();
  };
  try {
    crypto.assertAvailable();
    store = new ProtectedGitHubTokenStoreV1(selection.tokenStore);
    store.assertSeparateKeySource(crypto);
    sourceMaterial = createProtectedKubernetesGitHubAppMaterialV1({
      client: options.client,
      source,
      crypto,
      clock: options.clock,
    });
    const materialOwner = sourceMaterial;
    const material: GitHubAppMaterialV1 = Object.freeze<GitHubAppMaterialV1>({
      async withJwt(identity, bounds, consume) {
        await readCurrentBinding();
        return materialOwner.withJwt(identity, bounds, async (jwt, assertMaterialCurrent) => {
          await readCurrentBinding();
          assertMaterialCurrent();
          return consume(jwt, () => {
            if (closed) unavailable();
            assertMaterialCurrent();
          });
        });
      },
      close,
    });
    return Object.freeze({
      key: Object.freeze({ ...source.keyIdentity }),
      repositoryId: selection.repositoryId,
      installationId: selection.installationId,
      material,
      crypto,
      store,
      close,
    });
  } catch (error) {
    close();
    throw error;
  }
}
