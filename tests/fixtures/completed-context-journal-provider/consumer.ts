import type { CompletedContextJournalOptions } from "@openclaw-enterprise/occ/turn-journal/completed-context";
import type { createCompletedStateStore } from "openclaw/plugin-sdk/completed-state";

type AcceptedJournalAdapter<Adapter extends CompletedContextJournalOptions["adapter"]> = Adapter;

/** Compile-only correspondence with the actual canonical provider factory.
 * This neither constructs its authority/database owner nor invokes the provider.
 */
export type CanonicalProviderAcceptedByJournal = AcceptedJournalAdapter<
  ReturnType<typeof createCompletedStateStore>
>;
