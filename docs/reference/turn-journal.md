# Turn journal contract

The versioned turn journal defines the OCC boundary for shared Agent admission,
execution consumption, completed-context publication and delivery. It includes
strict value decoders, pure consistency classifiers and a callback wrapper that
keeps initiation behind the outer transaction commit. PostgreSQL and explicitly
configured process-local memory implementations use the same journal protocol.
Integration with the actual channel, runtime and canonical-store owners remains
required before either implementation can operate a shared Agent.

## Reference chapters

- [Journal storage and admission](turn-journal/admission.md): One journal and two storage authorities; Admission and native acknowledgement.
- [Journal dispatch and selected execution](turn-journal/execution.md): Dispatch and commit visibility; Selected native execution retention.
- [Journal completion and delivery](turn-journal/completion-delivery.md): Completion, cancellation and release; Delivery; Values and verification.
