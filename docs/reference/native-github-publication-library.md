# Native GitHub publication library

The `oce-native-egress` crate provides an in-process transport for one fixed Git
branch update or one fixed draft pull request. It prepares and submits each
request once, retaining remote observations separately from task retirement.
This reference covers the library; it establishes no executable, supervisor,
identity factory, deployment or live GitHub qualification.

Source:
[publication.rs](../../dataplane/services/oce-native-egress/src/publication.rs),
[publication_protocol.rs](../../dataplane/services/oce-native-egress/src/publication_protocol.rs)
and [git_pack.rs](../../dataplane/services/oce-native-egress/src/git_pack.rs).

## Construct the original owner

`PublicationTransport::new(broker, upstream, operation_timeout, maximum_pending)`
returns an `Arc<PublicationTransport>`. Supply a `BrokerConfig` with the protected
Unix socket, peer UID, trusted ancestor UIDs, service name, current client
identity/trust and RPC timing limits. Broker ALPN is exactly
`oce-github-publication-v1`. The upstream `Arc<rustls::ClientConfig>` must use
exactly `http/1.1` ALPN with early data disabled; resumption is disabled by the
transport. The nonzero operation timeout is at most 120 seconds and the pending
run limit is 1 through 64.

The original bootstrap retains these configurations and their owners. Their
values establish no Work or permission. Identity integration must verify the
exact broker identity and handle identity/trust withdrawal; upstream trust must
verify public GitHub certificates.

Inside Tokio, `serve_original(&session_ref)` returns a `PublicationRun` from the
original transport. The 32-character lowercase hexadecimal reference identifies
an already-enrolled native session and grants no authority. Duplicate references
remain refused after retirement; lifetime tombstones are capped at 4,096.

The native owner must recognize the actual candidate, captured graph, effect
and call, authorize the exact action, and consume its one-use authority
immediately before sending the committed credential response. Rust checks
correspondence and transport mechanics; comparison data cannot create capture
custody, approval, State admission or provider permission. Read permission cannot
stand in for publication permission.

## Fixed effects

| Effect   | Request                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Push     | One `POST` to `https://github.com/OWNER/REPO.git/git-receive-pack`, with one branch update command and the retained PACK. |
| Draft PR | One `POST` to `https://api.github.com/repos/OWNER/REPO/pulls`, with fixed base, head, title, body and `draft: true`.      |

The push uses expected-old compare-and-update; branch creation uses the zero
OID. A separate ancestry check requires the proposed commit to descend from an
existing old commit. The server precondition alone does not prove fast-forward.

The publication PACK contains complete SHA-1 commit, tree and blob objects
ordered by object ID. Validation checks checksums, contents, graph closure from
the proposed and base commits, metadata and ancestry. Delta entries, missing
objects, unreachable extras and unsupported tree entries are refused. Commit
tree and parent headers preserve LF delimiters and refuse CRLF. The original
capture owner must supply the genuine retained graph and PACK.

The native owner supplies the draft PR's corresponding confirmed push effect.
Push and PR creation are separate effects. Branch movement between them prevents
an atomic push-and-PR assertion.

Method, URL, headers and body are derived from the closed candidate. An Agent
cannot supply arbitrary receive-pack commands, destinations, bodies, tokens or
response sinks. There is no reconnect, automatic retry or redirect following.

## Preparation and limits

On one authenticated TLS-over-Unix session, Rust validates metadata and PACK and
establishes upstream TLS. Before accepting a committed credential, it reports the
request/body digests, body length and actual upstream certificate digest. The
token is a separate confidential frame suffix.

Git uses Basic authentication with fixed username `x-access-token`; draft PRs
use Bearer authentication. The transport checks request material, inflated
publication objects and response projections for the released token and its
transport spelling. Tokens are excluded from returned observations and
diagnostics. Directly owned sensitive buffers are erased. Maintained HTTP, TLS
and parser internals can retain transient copies; complete memory erasure is
not claimed.

| Bound                                    |            Limit |
| ---------------------------------------- | ---------------: |
| Broker metadata / token                  | 256 KiB / 16 KiB |
| PACK / object count                      |   80 MiB / 8,192 |
| Individual / total inflated object bytes |   8 MiB / 64 MiB |
| Upstream response body                   |            1 MiB |

Same-session checks cannot extend the original operation horizon. Malformed
replies, binding changes, channel loss and expiry refuse progress. Cancellation
stops and joins entered work; drainage can outlast the operation deadline.

## Observe, then retire

| API                             | Meaning                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `result(&run).await`            | Joins retained work and returns the original result when available, including a known observation after a join failure. |
| `RetiredPublication::inspect()` | Returns `call_ref`, `effect`, `action_digest` and `outcome` comparison data.                                            |
| `terminal_recorded()`           | Reports whether the matching final broker receipt was obtained, independently of the remote outcome.                    |
| `retire(&run).await`            | Cancels and joins the original run and children. Unexpected non-cancellation join failures remain sticky.               |
| `close().await`                 | Seals admission, cancels all retained runs and attempts every retirement.                                               |

A pushed outcome records the selected ref and old/new OIDs. An observed PR
retains its number, URL, repository, branches, OIDs and fields.
`draft-pr-created` requires an attributed response matching the fixed candidate;
otherwise an attributable PR remains attached to `unknown`. An explicit JSON
`null` description becomes empty; a missing description is refused.

A later broker failure cannot erase a captured observation. Preserve and deliver
it even when retirement fails. Neither a known result nor `terminal_recorded`
replaces successful retirement. The native integration must retain outcome
custody beyond operation-socket loss and complete the original observer handoff
before releasing its external responsibility.

Cancelling a `result`, `retire` or `close` await preserves the original task
handles. Resume on the same owner; another transport cannot use the run ticket.
A task panic remains a retirement failure on later calls. Keep the runtime and
original owners alive until cleanup settles. EOF, elapsed time and process exit
alone are not retirement receipts.

## Verify the component

From the repository root, with locked dependencies already available:

```sh
cargo +1.95.0 test --manifest-path dataplane/Cargo.toml --offline --locked \
  -p oce-native-egress --lib publication::tests:: -- --test-threads=1
cargo +1.95.0 test --manifest-path dataplane/Cargo.toml --offline --locked \
  -p oce-native-egress --lib publication::retirement_tests:: -- --test-threads=1
```

Socket tests need a Linux host permitting Unix sockets and loopback listeners.
Set `OCE_MEDIATION_TEST_SCRATCH` to a short, private, writable absolute directory;
generated broker paths must fit the Unix socket path limit. Missing host
permissions are a verification failure or explicit limitation.

The accepted retirement component passed four retirement cases and four distinct
original cancellation/ownership regressions, with no ignored cases. Coverage
includes an actual observed blocking-worker panic, preserved outcomes, concurrent
cleanup, cancelled-await recovery, stalled upstream-body cancellation and
rejection of another transport's run ticket. This focused run did not rerun
every publication test.

Broader tests cover fixed bodies, graph/ancestry refusal, commit delimiters,
credential canaries, TLS submission and PR attribution after terminal loss.
Controlled broker/GitHub peers use real Unix/TLS and TCP/TLS. This proves no live
provider, Work/State authorization, identity acquisition, supervisor handoff or
deployed publication.
