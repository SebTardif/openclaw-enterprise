import {
  runtimeResourceAccountingV1,
  type RuntimeResourceAccountingEnvelopeV1,
  type RuntimeResourceAccountingResultV1,
  type RuntimeResourceAccountingV1,
} from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";

/** Producer compiles against the exact public leaf and forwards a parsed snapshot. */
export function produceAccounting(
  input: unknown,
  consume: (envelope: RuntimeResourceAccountingEnvelopeV1) => RuntimeResourceAccountingResultV1,
  port: RuntimeResourceAccountingV1 = runtimeResourceAccountingV1,
): RuntimeResourceAccountingResultV1 {
  const envelope = port.parse(input);
  return consume(envelope);
}

/** No producer-side defaults are injected between parsing and validation. */
export function validateProducedAccounting(
  input: unknown,
  port: RuntimeResourceAccountingV1 = runtimeResourceAccountingV1,
): RuntimeResourceAccountingResultV1 {
  return produceAccounting(input, (envelope) => port.validate(envelope), port);
}

export function providerRequestBudget(
  remainingMs: number,
  purposeMaxMs: number,
  port: RuntimeResourceAccountingV1 = runtimeResourceAccountingV1,
): number {
  return port.deadlineBudget("providerRequestMaxMs", remainingMs, purposeMaxMs);
}
