import type {
  createGitHubAppTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
  createGitHubAppWriteTokenIssuerV1,
  GitHubAppTokenIssuerOptionsV1,
  GitHubAppTokenRevokerOptionsV1,
  GitHubAppWriteTokenIssuerOptionsV1,
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
