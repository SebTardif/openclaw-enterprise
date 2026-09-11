# Runtime authority interfaces

`@openclaw-enterprise/contracts` exports the versioned local
`RuntimeAssignmentAuthorityV1` interface and strict structural parsers for its
requests and results. The interface separates immutable runtime identity,
versioned evidence, purpose-specific currentness, and retained operation receipts.

OCC now persists immutable runtime binding, separately versioned evidence,
retirement and exact operation receipts in its existing memory and PostgreSQL
state adapters. The local service boundary denies mutations and positive purpose
resolution until its observation and acceptance dependencies are integrated.
An optional controller-owned native transport supports authenticated exact
historical readback and a separately admitted initial Harness bind request after
explicit human operator admission. The bind service still rejects unavailable
authoritative inputs without writing a binding. This transport does not
implement runtime effects. Current controller deployment
behavior is described in [Controller reconciliation](controller.md).

## Reference chapters

- [Runtime binding persistence and acceptance](runtime-authority/binding.md): Current persistence and service boundary; Preparing an observed binding candidate; Verify the implemented storage slice.
- [Operator-admitted runtime service trust](runtime-authority/service-trust.md): Operator-admitted service trust.
- [Runtime authority values and currentness](runtime-authority/contract.md): Binding and evidence; Purpose-specific results; Trusted context and exact outcomes; Verification and remaining implementation.

## Imported surface

```ts
import {
  parseRuntimeAuthorityV1,
  parseRuntimeAuthorityJsonV1,
  parseRuntimeMutationResultV1,
  canonicalRuntimeAuthorityMutationV1,
  type RuntimeAssignmentAuthorityV1,
  type RuntimeAuthorityContextFactoryV1,
} from "@openclaw-enterprise/contracts";
```

| Method           | Required meaning                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bind`           | Record one exact provider instance against an existing allocation under lifecycle and record version checks. The binding cannot be changed in place.               |
| `recordEvidence` | Append a separately versioned runtime or identity observation. New receipt time cannot make an old source observation fresh.                                       |
| `resolve`        | Evaluate one exact assignment and purpose using current authoritative state and independently verified service context.                                            |
| `retire`         | Withdraw the assignment's authority while retaining its exact cleanup responsibility. This does not assert physical termination or provider credential revocation. |
| `readOperation`  | Read the exact retained mutation outcome using its original operation identity, scope, kind, and canonical payload digest.                                         |

Existing `RuntimeAllocation`, `RuntimeIntent`, `RuntimeScope`, and related value
types retain their fields and OCC state-module imports. The allocation's
`bindingCondition: "unbound"` records its original inert allocation. A separate
binding projection supplies later instance identity; it does not rewrite that
allocation field or create another intent authority.
