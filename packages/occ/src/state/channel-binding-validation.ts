import { ResourceConflictError } from "../errors.ts";
import type { ChannelBindingListOptions } from "../ports/repositories/channel-bindings.ts";

export function validateChannelBindingList(options: ChannelBindingListOptions): void {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 101 ||
    (options.afterId !== undefined && !/^(chi|chh|cha)_[0-9a-f-]{36}$/.test(options.afterId))
  )
    throw new ResourceConflictError("The channel binding list bounds are invalid.");
}
