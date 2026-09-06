import type { LifecycleStatusReadPortV1 } from "./handler-ports-v1.ts";
import type { LifecycleReadCallV1 } from "./ports-v1.ts";
import {
  parseLifecycleStatusReadRequestV1,
  projectLifecycleStatusReadV1,
  type LifecycleStatusReadMethodV1,
  type LifecycleStatusReadRequestV1,
  type LifecycleStatusReadResultV1,
} from "./status-projector-v1.ts";

const unavailable = Object.freeze({ kind: "unavailable" as const });

/** Sanitizes the existing authorized reader's public results. The actual source
 * must verify request/Installation custody and fresh exact Agent-read authority
 * at its disclosure boundary, including around its own waits. A supplied port's
 * shape and a successful projection do not qualify that source or grant access.
 *
 * Each invocation forwards the same original call to exactly one source method;
 * there is no authorization/result cache, automatic page walk or mutation retry.
 * Source exceptions and cancellation disclose no retained result or error body.
 * TODO: compose with the actual authorized lifecycle reader when its repository,
 * current-account guard and management route implementation are available.
 */
export function createSanitizedLifecycleStatusReaderV1(
  source: LifecycleStatusReadPortV1 | undefined,
): LifecycleStatusReadPortV1 {
  async function read<K extends LifecycleStatusReadMethodV1>(
    method: K,
    input: unknown,
    call: LifecycleReadCallV1,
    invoke: (request: LifecycleStatusReadRequestV1<K>) => Promise<unknown>,
  ): Promise<LifecycleStatusReadResultV1<K>> {
    try {
      const request = parseLifecycleStatusReadRequestV1(method, input);
      const signal = call.signal;
      if (!source || signal.aborted) return unavailable;
      const result = await invoke(request);
      if (signal.aborted || call.signal !== signal) return unavailable;
      return projectLifecycleStatusReadV1(method, request, result);
    } catch {
      return unavailable;
    }
  }

  return Object.freeze({
    readStatus: (scope, call) =>
      read("readStatus", scope, call, (request) => source!.readStatus(request, call)),
    readOperation: (request, call) =>
      read("readOperation", request, call, (parsed) => source!.readOperation(parsed, call)),
    listOperations: (request, call) =>
      read("listOperations", request, call, (parsed) => source!.listOperations(parsed, call)),
    readCapability: (scope, call) =>
      read("readCapability", scope, call, (request) => source!.readCapability(request, call)),
  } satisfies LifecycleStatusReadPortV1);
}
