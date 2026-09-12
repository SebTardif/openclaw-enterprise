# Publication coordinator testing

Use Node.js 24 or newer and the three Git executable settings described in
[Git object store testing](git-object-store.md), then run:

```sh
node --test tests/conformance/repository-publication-v1.test.mjs
```

The `repository-publication` lane in `scripts/ci/test-suites.json` owns this file.
It requires those executable settings and remains outside automated groups.
With no selection, direct Node execution skips Git-dependent cases; partial
selection fails. A run with skips does not verify the full coordinator suite.

## What the tests establish

The tests execute the real request decoders, local policy predicate, candidate
digest, and `RepositoryPublicationOwnerV1`. Controlled Work, State, and dispatcher
collaborators supply accepted or refused operations and delayed outcomes. The
coordinator must preserve call identity, check supplied records, keep push/PR
ordering, and wait for accepted work and retained results during cleanup.

The malformed-submission cases cover missing or throwing `drained` fields with
fulfilled and rejected result promises, including settlement after prepared
request cleanup. These protect the actual coordinator's result-retention logic.
The Git-backed cases use the real snapshot store; temporary directories are
removed after the component and store close.

The suite does not authenticate a human, run a publication database journal,
acquire a production credential, or send to GitHub. Positive application proof
must connect the actual controller, Work, IAM/State, and native dispatcher.
An external GitHub fixture can verify that integration's request/response behavior;
controlled internal collaborators cannot replace it.

See [the coordinator reference](../reference/repository-publication-v1.md) for
its API, current policy limitations, and cleanup behavior.
