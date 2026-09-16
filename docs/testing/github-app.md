# GitHub App token issuer tests

Verify the GitHub App issuer against GitHub using an authorized test installation
and private repository. This creates one short-lived, read-only installation
token and revokes that exact token. It does not modify repository contents or
create an App, installation, repository, or production credential binding.

## Prepare and run

Use Node.js 24+ and the workspace dependencies described in the
[testing requirements](README.md#requirements-and-credentials). Select an existing
GitHub App installed on the private test repository with **Contents: read** and
**Metadata: read** permission. The App may have broader permissions; the issuer
requests only these two read permissions for the single selected repository.

Place the App's RSA private key in a private file outside the checkout, readable
only by the test runner. Supply the following inputs through an authorized
credential manager or a private environment file, without printing their values:

| Variable                               | Requirement                                                     |
| -------------------------------------- | --------------------------------------------------------------- |
| `OCC_TEST_GITHUB_APP_REAL`             | Set to `1` to select the live case.                             |
| `OCC_TEST_GITHUB_APP_CLIENT_ID`        | App client ID used as the JWT issuer.                           |
| `OCC_TEST_GITHUB_APP_PRIVATE_KEY_PATH` | Absolute path to the private RSA PEM file outside the checkout. |
| `OCC_TEST_GITHUB_APP_INSTALLATION_ID`  | Positive integer installation ID.                               |
| `OCC_TEST_GITHUB_APP_REPOSITORY_ID`    | Positive integer ID of the private test repository.             |
| `OCC_TEST_GITHUB_APP_REPOSITORY`       | Exact `owner/name` of that repository.                          |

```sh
OCC_TEST_GITHUB_APP_REAL=1 \
  node --env-file="$TEST_ENV_FILE" \
  --test tests/integration/github-app-token-issuer-real.test.mjs
```

The expected result is **one passing test, zero skips**. Without the opt-in the
case skips; when selected, missing or invalid inputs fail before dispatch. The
runner must reach `https://api.github.com` directly. It uses the production issuer
endpoint, with no alternate host, ambient proxy, redirect, or retry.

## What the case proves

The test calls the public `TokenIssuerV1` implementation with real RSA material
and a fixed read scope. It settles the original mint result, checks the token's
live repository inventory contains only the selected private repository, closes
the App signing material, and uses the separate `TokenRevokerV1` to revoke the
original custody handle. A subsequent authenticated read must return HTTP 401.

The custody fixture copies token bytes into test-process memory and authenticates
original handle identity. Its currentness assertion represents only this test's
lifetime. Neither is production authority or durable protected custody. This
case establishes live provider compatibility only when it actually passes; it
does not establish production startup, Work authorization, regular Agent reads,
verified checkout, Harness admission, or recovery after a process crash.

Use the [local protocol suites](local.md#github-app-token-issuer-protocol) for
controlled scope refusal, response loss, cancellation, and late-settlement cases.
The [issuer reference](../reference/github-app-token-issuer.md#integration-and-verification)
retains the separate production workflow requirements.

## Cleanup and failures

The test settles the original mint before cleanup and tracks every captured
handle, including material from an unacceptable response. Its `finally` cleanup
attempts revocation of each token that has not already had a revoke attempt, then
wipes test-owned mutable token and PEM buffers. Revocation requires a confirmed
HTTP 204; a dispatched unknown result fails the case and is never automatically
replayed. Closing the App material does not prevent exact-token cleanup.

A lost mint response can leave an issued token whose bytes were never captured.
A terminated process can also prevent cleanup. Such a run has an unresolved
credential outcome: retain that fact, investigate through the authorized App
owner, and account for expiry before repeating the test. GitHub installation
tokens normally expire after one hour. Local cleanup cannot prove erasure of
immutable JavaScript strings or copies held by the crypto runtime.

For setup failures, check the selected key, client ID, installation and exact
repository IDs privately. For provider failures, verify installation access and
App permissions through the authorized owner. Do not attach key material, token
bytes, authorization headers, or raw provider response bodies to test reports.

The `github-app` suite lane is registered for explicit local selection. It has
no GitHub Actions entrypoint and belongs to neither the `ci` nor `full` group;
a green `CI Required` check does not establish live App-key coverage.
