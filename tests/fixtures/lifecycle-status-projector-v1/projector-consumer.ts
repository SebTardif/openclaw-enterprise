import {
  projectLifecycleStatusReadV1,
  type LifecycleStatusReadMethodV1,
  type LifecycleStatusReadRequestV1,
  type LifecycleStatusReadResultV1,
} from "@openclaw-enterprise/occ/lifecycle/status-projector-v1";

/** A server-side pure projection consumer. The result supplies public data or
 * a closed failure; it establishes neither source custody nor read authority.
 */
export function projectLifecycleReadForConsumerV1<K extends LifecycleStatusReadMethodV1>(
  method: K,
  request: LifecycleStatusReadRequestV1<NoInfer<K>>,
  input: unknown,
): LifecycleStatusReadResultV1<K> {
  return projectLifecycleStatusReadV1(method, request, input);
}
