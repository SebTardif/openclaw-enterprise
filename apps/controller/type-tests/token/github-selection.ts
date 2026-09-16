import type {
  GitHubAppSelectionV1,
  GitHubRepositoryWriteSelectionV1,
} from "../../src/providers/token/github/index.ts";

// Compile-only consumers preserve exact provider selection and immutable scope.
// These inputs create no authority and never invoke GitHub.
export function consumeGitHubSelections(): void {
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
