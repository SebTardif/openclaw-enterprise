# Credential gateway destination selection checks

Run the selector checks from the repository root with Node.js 24 or newer:

```sh
node --test tests/conformance/credential-gateway-destination.test.mjs
```

The suite imports the actual TypeScript destination selector and supplies controlled
DNS observations through its resolver factory. It checks numeric selection and
refusal behavior without contacting GitHub or replacing the selector implementation.

## Component contract

`createDestinationSelector(config, factory)` retains a deep frozen copy of one to
three numeric trusted DNS servers, ports from 1 to 65535, and an integer lookup
budget from 1 to 5000 milliseconds. Private infrastructure DNS servers are allowed.
Hostnames, scoped addresses, brackets and whitespace are refused in server addresses.
Configuration fields must be own data properties; accessors and sparse arrays are refused.
The factory is the production seam for a configured native resolver.

Each `select(hostname, { signal, deadline })` requires the exact `github.com` or
`api.github.com` name, an unwrapped native AbortSignal and a safe integer epoch deadline in
milliseconds. Transparent and revocable signal Proxies, subclasses, and own
constructor, aborted, reason or dispatchEvent overrides are unsupported and refused
with fixed `invalid-bounds` before resolver effects. It creates a fresh resolver and starts one A and one AAAA query.
Only ENODATA means an empty family; other DNS errors refuse the selection.
The selector copies each family's answers at settlement and validates every record
before preferring the first A answer, otherwise the first AAAA answer.

Limits are 32 records per family, 64 records in total and 45 characters per address.
A malformed, wrong-family or denied address refuses the complete answer set.
The result is a frozen `{ hostname, address, family, port: 443 }` value. There is no
cache, alternate-address retry or second lookup.

The conservative `github-public-destination-v1` policy denies IPv4 special-purpose,
private, loopback, link-local, documentation, multicast and reserved intervals.
IPv6 must be within `2000::/3`, excluding `2001::/23`, `2001:db8::/32`,
`2002::/16`, `2620:4f:8000::/48` and `3fff::/20`. Mapped, compatible and
translation addresses, embedded dotted IPv4 text, zones, URLs and port forms are
refused. Globally reachable special-service exceptions remain denied.

Pre-aborted or expired calls refuse before creating a resolver. The shorter of the
remaining epoch budget and lookup budget becomes a monotonic time limit. Abort,
epoch expiry and monotonic expiry are checked before returning. Completion or
refusal cancels only that call's resolver and removes its timer and abort listener.
A private native dependent signal isolates subscription and disposal from caller
method mutations; its cancellation subscription resists `stopImmediatePropagation`.
Signal observation and disposal errors cannot strand settlement or cancellation.
Late DNS outcomes are consumed and cannot change the result. The factory and native
resolver methods must return promptly; JavaScript timers cannot preempt synchronous
blocking code.

## Coverage and acceptance limits

Boundary vectors exercise both ends of every denied interval and neighboring
public addresses, including the IPv6 global envelope. Additional cases exercise
mixed public/private answers, syntax and family refusal, oversized answers,
ENODATA and other failures, hostile descriptor traps, revoked bounds and signal
Proxies (including revocation after selection starts), throwing native constructor
fields, suppressed abort propagation, signal method mutations, throwing disposal,
malformed runtime operands, immutable configuration
and answers, abort/deadline races, late rejections and independent cancellation.

These are selector component checks with substituted DNS observations. Actual
configured DNS exchange requires the native resolver integration suite. Upstream
socket address pinning, fixed Host/SNI, independent public TLS trust, certificate
refusal, current authority and final submission admission require the real upstream
transport and its integration tests. A numeric destination is data and grants no
authority to submit a request.

The suite needs explicit enrollment in the central
[CI suite map](../../scripts/ci/test-suites.json) before claiming selected CI coverage.
The application entry point, regular Agent caller, executable lifecycle, installed
backend, containment and live provider remain separate required acceptance.
A scoped compile of this module does not establish application build enrollment.
See [CI coverage](ci.md) and the [testing guide](README.md) for proof accounting.

## Troubleshooting

`invalid-config`, `invalid-host` and `invalid-bounds` indicate refused operands.
`address-denied` includes malformed or overlength address text; `answer-limit`
indicates too many records. `dns-failure` includes non-ENODATA resolver failures and
malformed answer containers; `empty-answer` means both validated families are empty.
`aborted` and `deadline` never produce a usable destination. Errors use fixed codes
and messages without including DNS details or caller input.
