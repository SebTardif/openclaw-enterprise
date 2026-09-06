import { Check } from "typebox/value";
import { InstallationId } from "@openclaw-enterprise/contracts/api/common";
import type { LifecycleStatusReadPortV1 } from "./handler-ports-v1.ts";
import type { LifecycleReadCallV1 } from "./ports-v1.ts";
import { createSanitizedLifecycleStatusReaderV1 } from "./status-reader-v1.ts";
import {
  parseLifecycleStatusReadRequestV1,
  type LifecycleStatusReadMethodV1,
  type LifecycleStatusReadRequestV1,
  type LifecycleStatusReadResultV1,
} from "./status-projector-v1.ts";

export interface LifecycleStatusServiceOptionsV1 {
  /** Resolve the Installation from the owning controller/store, never a request.
   * Its identifier is private composition custody, not an authorization result. */
  readonly resolveInstallationId: () => string | undefined;
  /** Only the original authorized reader may supply production results. It must
   * verify the private invocation, current account/selected IAM and exact Agent
   * read at disclosure, including every page and its own awaited operations. */
  readonly resolveSource: () => LifecycleStatusReadPortV1 | undefined;
}

const unavailable = Object.freeze({ kind: "unavailable" as const });

/** Server-scoped consumption of the existing lifecycle reader and sanitizer.
 * The public requests contain Namespace/Agent identifiers; Installation remains
 * with the owning controller and actual source. Composition identity checks only
 * suppress a result after replacement. They do not verify source provenance or
 * implement the missing account/currentness guard. No result is cached and no
 * operation, page, provider effect or admission is retried.
 */
export function createLifecycleStatusServiceV1(
  options: LifecycleStatusServiceOptionsV1,
): LifecycleStatusReadPortV1 {
  async function read<K extends LifecycleStatusReadMethodV1>(
    method: K,
    input: unknown,
    call: LifecycleReadCallV1,
    invoke: (
      reader: LifecycleStatusReadPortV1,
      request: LifecycleStatusReadRequestV1<K>,
    ) => Promise<LifecycleStatusReadResultV1<K>>,
  ): Promise<LifecycleStatusReadResultV1<K>> {
    try {
      const request = parseLifecycleStatusReadRequestV1(method, input);
      const signal = call.signal;
      if (signal.aborted) return unavailable;
      const installationId = options.resolveInstallationId();
      if (!Check(InstallationId, installationId)) return unavailable;
      const source = options.resolveSource();
      if (!source) return unavailable;
      const result = await invoke(createSanitizedLifecycleStatusReaderV1(source), request);
      if (
        signal.aborted ||
        call.signal !== signal ||
        options.resolveInstallationId() !== installationId ||
        options.resolveSource() !== source
      )
        return unavailable;
      return result;
    } catch {
      return unavailable;
    }
  }

  return Object.freeze({
    readStatus: (scope, call) =>
      read("readStatus", scope, call, (reader, request) => reader.readStatus(request, call)),
    readOperation: (request, call) =>
      read("readOperation", request, call, (reader, parsed) => reader.readOperation(parsed, call)),
    listOperations: (request, call) =>
      read("listOperations", request, call, (reader, parsed) =>
        reader.listOperations(parsed, call),
      ),
    readCapability: (scope, call) =>
      read("readCapability", scope, call, (reader, request) =>
        reader.readCapability(request, call),
      ),
  } satisfies LifecycleStatusReadPortV1);
}
