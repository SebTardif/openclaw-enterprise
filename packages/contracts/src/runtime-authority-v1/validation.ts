import {
  RUNTIME_AUTHORITY_LIMITS_V1,
  type BindRuntimeV1,
  type RuntimeBindingV1,
  type RuntimeMutationResultV1,
  type RuntimeAuthoritySchemaNameV1,
  type RuntimeAuthorityValueV1,
} from "./schemas.ts";
import { reject } from "./json.ts";

type Receipt = Extract<RuntimeMutationResultV1, { receipt: unknown }>["receipt"];

/**
 * These checks run after schema validation. Current freshness needs the authority
 * clock/store; callers must separately authenticate and verify observation provenance.
 */
function timestamp(value: string, field: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value)
    reject(`${field} must be a real UTC timestamp with millisecond precision`);
  return time;
}

function validateObservationWindow(source: number, received: number, valid: number): void {
  if (source > received + RUNTIME_AUTHORITY_LIMITS_V1.clockUncertaintyMaxMs)
    reject("observation source time exceeds receipt time plus clock uncertainty");
  if (valid < source || valid > source + RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs)
    reject("binding validity must end within 15 seconds of its source observation");
}

function validateBinding(binding: RuntimeBindingV1): void {
  const names = binding.imageDigests.map((entry) => entry.name);
  if (new Set(names).size !== names.length) reject("binding image names must be unique");
  if (names.some((name, index) => index > 0 && names[index - 1]! >= name))
    reject("binding image names must be sorted");
}

function validateBind(input: BindRuntimeV1): void {
  validateBinding(input.binding);
  const observation = input.observation;
  validateObservationWindow(
    timestamp(observation.sourceObservedAt, "sourceObservedAt"),
    timestamp(observation.receivedAt, "receivedAt"),
    timestamp(observation.validUntil, "validUntil"),
  );
  if (input.binding.component !== input.target.component)
    reject("binding component must match its target");
  if (input.expectedLifecycleGeneration !== input.target.lifecycleGeneration)
    reject("bind lifecycle generation must match its target");
}

function validateReceipt(receipt: Receipt): void {
  timestamp(receipt.committedAt, "committedAt");
  const outcome = receipt.outcome;
  if (outcome.kind !== receipt.operationKind)
    reject("receipt outcome kind must match its operation kind");
  if (outcome.kind === "bind") validateBinding(outcome.binding);
}

function validateAssignmentRecord(record: RuntimeAuthorityValueV1<"assignmentRecord">): void {
  timestamp(record.allocation.createdAt, "createdAt");
  if (record.binding.status === "bound") {
    validateBinding(record.binding.instance);
    if (record.binding.instance.component !== record.allocation.component)
      reject("binding component must match its allocation");
    if (record.authority.state === "allocated") reject("allocated authority cannot be bound");
  } else if (record.authority.state === "bound") {
    reject("bound authority requires a binding");
  }
}

/** Explicit schema dispatch keeps each cross-field rule with its record type. */
const validators: {
  [K in RuntimeAuthoritySchemaNameV1]: (value: RuntimeAuthorityValueV1<K>) => void;
} = {
  assignmentRecord: validateAssignmentRecord,
  binding: validateBinding,
  bind: validateBind,
  mutation: validateBind,
  mutationResult: (value) => {
    if ("receipt" in value) validateReceipt(value.receipt);
  },
  exactOperation: () => {},
  operationState: (value) => {
    if (value.result === "committed") validateReceipt(value.receipt);
  },
};

export function validateRuntimeAuthority<K extends RuntimeAuthoritySchemaNameV1>(
  kind: K,
  value: RuntimeAuthorityValueV1<K>,
): void {
  validators[kind](value);
}
