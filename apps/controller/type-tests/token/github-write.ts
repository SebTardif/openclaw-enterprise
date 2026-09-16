import type {
  createGitHubAppTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
  createGitHubAppWriteTokenIssuerV1,
  GitHubAppSelectionV1,
  GitHubAppTokenIssuerOptionsV1,
  GitHubAppTokenRevokerOptionsV1,
  GitHubAppWriteTokenIssuerOptionsV1,
  GitHubRepositoryWriteSelectionV1,
} from "../../src/providers/token/github/index.ts";

// Constructor inputs remain available through the public entry point while the
// shared provider options stay private. This fixture does not invoke an issuer.
export function consumeIssuerOptions(
  read: GitHubAppTokenIssuerOptionsV1,
  write: GitHubAppWriteTokenIssuerOptionsV1,
  revoker: GitHubAppTokenRevokerOptionsV1,
) {
  const readInput: Parameters<typeof createGitHubAppTokenIssuerV1>[0] = read;
  const writeInput: Parameters<typeof createGitHubAppWriteTokenIssuerV1>[0] = write;
  const revokerInput: Parameters<typeof createGitHubAppTokenRevokerV1>[0] = revoker;
  // @ts-expect-error The read constructor does not accept a write selection.
  const writeAsRead: Parameters<typeof createGitHubAppTokenIssuerV1>[0] = write;
  // @ts-expect-error The write constructor requires its exact write selection.
  const readAsWrite: Parameters<typeof createGitHubAppWriteTokenIssuerV1>[0] = read;
  // @ts-expect-error Keyless cleanup options cannot issue write credentials.
  const revokerAsWrite: Parameters<typeof createGitHubAppWriteTokenIssuerV1>[0] = revoker;
  return { readInput, writeInput, revokerInput, writeAsRead, readAsWrite, revokerAsWrite };
}

// Compile-only checks preserve the exact read and write selection boundaries.
export function consumeIssuerSelections() {
  const issuerRead: GitHubAppSelectionV1 = {
    key: {
      clientId: "example-app-client",
      bindingRef: "example-key-binding",
      immutableVersion: "example-key-version-1",
    },
    installationId: 202,
    repositories: [{ id: 303, fullName: "example-owner/example-repository" }],
    permissions: { metadata: "read", contents: "read" },
  };
  const issuerWrite: GitHubRepositoryWriteSelectionV1 = {
    key: issuerRead.key,
    installationId: issuerRead.installationId,
    repositories: issuerRead.repositories,
    permissions: { metadata: "read", contents: "write", pull_requests: "write" },
  };
  const { key: omittedWritekey, ...withoutWritekey } = issuerWrite;
  const { installationId: omittedWriteinstallationId, ...withoutWriteinstallationId } = issuerWrite;
  const { repositories: omittedWriterepositories, ...withoutWriterepositories } = issuerWrite;
  const { permissions: omittedWritepermissions, ...withoutWritepermissions } = issuerWrite;
  const missingPrPermission: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error The write tuple requires pull_requests:write.
    permissions: { metadata: "read", contents: "write" },
  };
  const unrelatedPermission: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error Checked permission literals reject unrelated scopes.
    permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" },
  };
  const wrongmetadataPermission: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error The write profile fixes metadata permission.
    permissions: { ...issuerWrite.permissions, metadata: "write" },
  };
  const wrongcontentsPermission: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error The write profile fixes contents permission.
    permissions: { ...issuerWrite.permissions, contents: "read" },
  };
  const wrongpull_requestsPermission: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error The write profile fixes pull_requests permission.
    permissions: { ...issuerWrite.permissions, pull_requests: "read" },
  };
  // @ts-expect-error Write selection retains exactly one supplier repository.
  const emptyRepositories: GitHubRepositoryWriteSelectionV1 = { ...issuerWrite, repositories: [] };
  const twoRepositories: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error Write selection retains exactly one supplier repository.
    repositories: [issuerRead.repositories[0], issuerRead.repositories[0]],
  };
  // @ts-expect-error Write selection requires key.
  const missingWritekey: GitHubRepositoryWriteSelectionV1 = withoutWritekey;
  // @ts-expect-error Write selection requires installationId.
  const missingWriteinstallationId: GitHubRepositoryWriteSelectionV1 = withoutWriteinstallationId;
  // @ts-expect-error Write selection requires repositories.
  const missingWriterepositories: GitHubRepositoryWriteSelectionV1 = withoutWriterepositories;
  // @ts-expect-error Write selection requires permissions.
  const missingWritepermissions: GitHubRepositoryWriteSelectionV1 = withoutWritepermissions;
  const broadenedIssuerRead: GitHubAppSelectionV1 = {
    ...issuerRead,
    // @ts-expect-error The original issuer selection remains read-only.
    permissions: { metadata: "read", contents: "write" },
  };
  const prIssuerRead: GitHubAppSelectionV1 = {
    ...issuerRead,
    // @ts-expect-error The original issuer read DTO has no PR permission.
    permissions: { metadata: "read", contents: "read", pull_requests: "write" },
  };
  const stringInstallation: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error Installation IDs retain the actual supplier numeric type.
    installationId: "202",
  };
  const incompleteKey: GitHubRepositoryWriteSelectionV1 = {
    ...issuerWrite,
    // @ts-expect-error Real supplier key identity requires immutableVersion.
    key: { clientId: "client", bindingRef: "binding" },
  };
  // @ts-expect-error Write permission values are immutable.
  issuerWrite.permissions.contents = "write";
  // @ts-expect-error Supplier repository tuples are immutable.
  issuerWrite.repositories.push(issuerRead.repositories[0]);
  // @ts-expect-error Supplier repository entries are immutable.
  issuerWrite.repositories[0].id = 404;
}
