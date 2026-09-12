# Git object store testing

Run the input and metadata checks with Node.js 24 or newer:

```sh
node --test tests/conformance/git-object-store-contract.test.mjs
```

The storage tests also need an explicitly selected local Git binary. Choose a
trusted build with collision-detecting SHA-1 and set:

- `OCE_GIT_STORE_TEST_GIT_PATH`: absolute executable path without symlink components.
- `OCE_GIT_STORE_TEST_GIT_SHA256`: its lowercase SHA-256 digest.
- `OCE_GIT_STORE_TEST_GIT_OWNER_UID`: its numeric owner UID.

Then run:

```sh
node --test tests/conformance/git-object-store.test.mjs
```

The tests validate the selected binary's digest and ownership. Selecting a digest
does not verify the build's collision-detection support. With all settings absent,
Git-dependent tests skip; a partial or malformed selection fails. Do not count a
run with skips as successful storage verification.

## Coverage

The storage tests use real Git to create objects and import the emitted pack.
They cover capture, reopen, independent returned buffers, graph completeness,
ancestry, malformed objects, unsupported paths, size and expansion limits,
cancellation, filesystem validation, corruption, interrupted writes, and reuse
of valid packs produced with different compression settings.
Temporary repositories and storage directories are removed after each test.

The input tests cover immutable metadata copies, rejected executable object
properties, bounded data, and valid snapshot descriptors. They run in the normal
conformance lane. The `git-object-store` lane owns the real-Git tests and requires
all three executable settings. It remains outside automated groups until a
suitable Git fixture is provisioned; a green aggregate does not prove this lane ran.

## Troubleshooting

Run on Linux with `/proc` available. Fixtures create private directories under
the current user's home. These temporary directories verify local file behavior,
not persistence across deployment replacement.

An executable rejection can mean a symlink in its path, unexpected ownership,
a digest mismatch, or group/other write permissions. Verify the selected binary
and its settings. A snapshot rejection can also mean an unsupported historical
filename, missing ancestor, or an exceeded graph limit; see the
[store reference](../reference/git-object-store.md).
