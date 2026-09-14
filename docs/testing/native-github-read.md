# Verify native GitHub read transport

Run from a prepared checkout with the selected Go and Rust toolchains and their
matching dependency caches. These tests exercise the native transport components.
They do not replace the required regular Agent checkout integration.

## Broker identity and transport

From `components/runtime-security`:

```sh
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go test -race ./githubbridge ./cmd/oce-github-mediation
```

The broker tests use disposable signed X.509 SVIDs supplied by an external
Workload API peer, actual identity-source and TLS implementations, and real local
Unix sockets. They verify authenticated request transport, currentness, wrong
peer and UID refusal, replay prevention, partial frames, blocked output,
credential-buffer cleanup and preservation of replacement sockets.

The test parent supplies protocol responses at the explicit parent boundary.
Those responses do not prove original State or Work authorization. The tests do
not install SPIRE or exercise Kubernetes attestation.

## Git listener

From `dataplane`, run the crate's selected tests with the prepared Cargo cache:

```sh
cargo test --offline -p oce-native-egress
```

The Git listener tests use actual local TLS connections and the production request,
Git protocol and pack validators. External GitHub and broker peers are controlled
fixtures. Allowed reads, another repository, write requests and interrupted-read
cleanup are transport proof. They do not prove live GitHub App credentials or
end-to-end Agent deployment.

## Required workflow acceptance

Before landing the connected feature, extend the regular configured Agent workflow
to prove:

1. Administrator-admitted repository and immutable commit reach the actual Work
   and protected credential owners.
2. The intended Agent receives a verified checkout before Harness startup.
3. Another repository, writes and credential inheritance by another Agent fail.
4. Revocation and interruption withdraw access and join native/token cleanup.

An external model service may be substituted at its service boundary. Keep OCE
admission, identity mapping, State, Work, credential construction and checkout
mechanisms real. Missing owner wiring is a source gap; unavailable GitHub
credentials or a Kubernetes deployment is a separate environment gap.
