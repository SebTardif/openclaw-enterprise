# Runtime effect contract examples

`producer.ts` and `lifecycle-consumer.ts` are independent consumers of the public
contracts package. The producer validates calls/results around injected real
ports; it does not simulate a provider. The lifecycle example classifies unknown
results as exact readback work and separately checks provider-fence and prior-writer
barrier observations before requesting a conditional route effect.

Each example has its own strict TypeScript project with library checking enabled.
`type-negatives.ts` checks that ordinary caller JSON and generic fence/Ready flags
cannot represent the required types. `vectors.mjs` contains representation data
for the conformance suite. Those records are synthetic, not authenticated runtime
facts. No fixture implements Kubernetes fencing or a replacement effect journal.

See [Runtime effects V1](../../../docs/reference/runtime-effects.md) for commands,
limits, exact ownership rules and required downstream runtime qualification.
