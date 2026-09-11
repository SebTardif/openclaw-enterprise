# External model egress packaging

See the [adapter flow](../flows/external-model-egress.md) for the implemented
request sequence and the required canonical authority boundary.

This component packages the selected DS-derived DNS admission and TLS custody
adapters as `oce-dnsgate` and `oce-egress`. The adapters run outside the untrusted
Agent. The DNS process owns narrowly scoped namespace firewall enforcement; the
TLS process alone receives the provider credential file. A separate canonical OCE
authority must authenticate the actual workload bearer, resolve its current
assignment, authorize the original turn and exact model operation, and own the
operation receipt.

The packaging is an implementation candidate for the external custody milestone.
It does not install the canonical authority, issue grants, configure an Agent, or
establish a supported production deployment. An available socket path, successful
image build, and passing packaging tests do not establish a provider-backed model
turn or a qualified sandbox. Missing authority prevents readiness and authorized
provider dispatch. The [platform design](../design.md) remains authoritative;
[repository access modes](../../specs/20-repository-access-modes.md) describe the
separate native Git/`gh` direction.

For build inputs, local setup, shutdown and recovery, and Kubernetes requirements,
see [deployment boundaries](../guides/deploy/model-egress.md). That chapter also owns packaging
verification and its limits.

## Supported adapter profile

The current profile has one recipient, `https://api.openai.com:443`, and one
operation, ordinary `POST /v1/responses` HTTP/SSE with an admitted turn carrier and
the actual workload bearer. Incoming connections use HTTPS. The provider key is
read only by the trusted TLS process after authorization and authenticated
upstream TLS. DNS admission selects the exact IPv4 address used for that socket;
there is no ordinary resolver fallback. IPv6 upstream transport is disabled in
this profile. CONNECT, WebSockets, compact, arbitrary origins, and a generic
credential substitution proxy are outside this profile.

This is the fixed OpenAI API provider-key profile. Separate experiments using an
existing Codex ChatGPT workload-identity credential do not configure this adapter
and are not a supported product path. Do not substitute a ChatGPT session or WIF
credential, change the recipient, or infer support from those probes.

### Request and admission bounds

The Rust TLS adapter accepts a declared request body of at most **16 MiB
(16,777,216 bytes)**. It rejects a larger `Content-Length` before reading the body
or contacting authority, DNS, or the provider. Capture reserves the declared
length fallibly once and checks accumulated bytes against both that length and
the ceiling. Request JSON also has a **20,000-value** and **64-level depth**
limit, checked during parsing before each value is materialized. The root is
depth zero and counts as one value; object keys do not count as values. Each
decoded metadata document receives its own structural budget. Large string
content remains supported up to the raw body ceiling. UTF-8, duplicate-aware
JSON, local operation checks, and the digest use the original bytes. Validation
must finish within the original five-second acquisition deadline before any
reservation or authority request begins.

Authority admission embeds the original body as a JSON string in a fixed
ten-field envelope. Its payload cap is **32 MiB + 64 KiB (33,619,968 bytes)**;
the four-byte length prefix is outside that cap. Validated raw JSON may nearly
double when escaped into this string. The other currently bounded fields require
at most 17,028 additional bytes. Admission counts the actual typed envelope with
an empty body, then adds the exact escaped-content byte count of the original
UTF-8 body. Serde emits the original envelope into one bounded, fallibly allocated
frame before opening the Unix connection. Counting and emission consume the same
original one-second RPC deadline; checks before, between, and after them gate
connection but do not preempt synchronous CPU work. Overflow or expiration
refuses before connection.
Ordinary TLS-adapter RPC requests retain their 2 MiB cap and replies retain
64 KiB. The DNS service's
separate 64 KiB protocol is unchanged.

The separately supplied canonical admission receiver must enforce the overall
frame ceiling before allocation and the method's bound before effects. A length
prefix alone does not identify the method. This repository supplies controlled
admission receivers for tests, not that canonical service. The separate
TypeScript Codex context and model-request parsers also enforce the 16 MiB raw
body ceiling. Their separate 8 KiB metadata, 64-level depth, and 20,000-value
limits remain in force; the native request parser now applies the same depth
and value-count semantics before constructing the JSON tree. The TypeScript
parsers are not wired into this Rust transport; end-to-end profile integration
remains incomplete.

Capture, admission work, and forwarding transfer the original zeroizing body
owner. Forwarding uses owner-backed `Bytes`; it does not create another complete
body buffer. The explicit body plus maximum admission frame accounts for at most
50,397,188 logical bytes per exchange. This is copy accounting, not a hard memory
bound: the full parsed JSON tree, parser scratch, allocation capacity, Hyper/TLS
buffers, process overhead, and concurrent exchanges are additional. The explicit
structural budgets prevent an accepted-size document from constructing millions
of small values before admission. The selected 256 MiB service budget and
per-Agent/generation limits still require separate enforcement and qualification.
Local packaging selects two active exchanges per TLS process;
the adapter accepts explicit configurations of up to eight. The process-local
limit does not enforce an Agent-wide limit across multiple service instances.

### Response deadlines and provider errors

The administrator must set `response_idle_timeout_ms` explicitly to an integer
from **100 through 300,000 milliseconds**. There is no omitted-field default.
The local packaging selects **300,000 milliseconds (five minutes)**. This is a
new finite progress-idle limit; suitability for live provider reasoning pauses
remains unqualified.

The idle interval starts at the original dispatch attempt, before the provider
HTTP send. Validated response headers and each nonempty, validated data frame
accepted for forwarding restart it. Empty frames, polling, TLS activity, invalid
SSE and authority or DNS renewals do not. Backpressure that prevents response
forwarding counts as idle. The clock therefore bounds first-response waiting and
forwarding progress; it does not distinguish a silent provider from a stalled
downstream reader.

Each dispatched exchange owns one additional resettable idle watchdog, joined
at cleanup. It shuts down both exact sockets independently of response polling
and the authority renewal worker. Socket closure does not mean that an already
running bounded authority RPC has settled; cleanup still joins that work. The
idle clock never extends an authority lease, DNS lease or the immutable original
operation deadline, and an elapsed idle interval cannot be revived by late data.

For provider HTTP **4xx or 5xx**, the adapter preserves the error status and
returns only `{"error":"provider_error"}` plus a newline, with fixed JSON and
connection headers. It forwards no arbitrary provider error body or headers,
which may echo injected credentials. It does not follow or forward redirects;
other unsupported status behavior is unchanged. These errors retain the
original **unknown** dispatched outcome, because the selected successful SSE
terminal was not observed. This is a bounded provider-error policy, not a
redaction guarantee for successful model output or arbitrary user content.

Three distinct process identities are required:

| Process                 | Linux UID | Authority and mounts                                                                                                                                      |
| ----------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DNS admission           | `0`       | Sole `NET_ADMIN` owner in the dedicated egress network namespace; writes its own admission socket directory.                                              |
| TLS custody             | `10002`   | No added capabilities; reads the admission and authority socket directories through read-only mounts; alone receives provider and incoming TLS key files. |
| Canonical OCE authority | `10003`   | No added capabilities; owns its authority socket directory and the real OCE identity, policy, audit, and persistence integrations.                        |

Socket paths are not identity credentials. The adapters check the actual peer UID
with `SO_PEERCRED`. The producer owns each socket directory; consumers cannot
unlink or replace its socket. Agent workloads receive neither directory, firewall
capabilities, nor provider key. Sharing a Pod or Docker network namespace does not
share provider file mounts.
