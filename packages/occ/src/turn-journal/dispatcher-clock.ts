/** Consumer access to the original transaction owner's dispatch clock. Issuance
 * and binding require that owner's actual known-COMMIT, single-taken claim;
 * this module exposes no clock or initiation-owner constructor. */
export {
  sampleDispatchClock,
  takeDispatchClockForExecution,
  transferDispatchDeadline,
  type RetainedDispatchDeadline,
} from "./transaction-guard.ts";
