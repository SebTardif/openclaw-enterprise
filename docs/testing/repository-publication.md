# Repository publication component testing

The conformance files use Node's built-in test runner and TypeScript stripping:

```sh
node --experimental-strip-types --test \
  tests/conformance/repository-publication-v1.test.mjs \
  tests/conformance/repository-publication-v1-git-objects.test.mjs
```

The Git cases require four explicit environment selections:

- `OCE_PUBLICATION_TEST_GIT_PATH`: absolute path to the selected Git executable.
- `OCE_PUBLICATION_TEST_GIT_SHA256`: exact lowercase SHA-256 of that executable.
- `OCE_PUBLICATION_TEST_GIT_OWNER_UID`: its expected numeric owner UID.
- `OCE_PUBLICATION_TEST_ARTIFACT_BUDGET_BYTES`: finite budget for the test's
  measured fixture artifacts.

With all four absent, Git-dependent cases report unavailable skips. Partial or
malformed selection fails. Select a Git build with collision detection; the
tests do not install or discover a replacement. Tests measure apparent and
allocated fixture bytes after Git commands and before cleanup. These are sampled
measurements, not continuous observation of every transient file.

These checks exercise real local Git objects, retained custody, closed data
contracts, and explicitly labeled application refusal and lifecycle controls.
Controlled internal operands and sequences establish only those component
behaviors. They establish no genuine Work authority, State approval or commit,
credential release, or upstream publication. Complete verification must compose the actual
Work, State/IAM, and dispatcher owners, including separate push and draft-PR
claims, current-authority leases, exact outcome attribution, and recovery. No
test in this component performs live publication.

## CI registration

The `repository-publication` lane in `scripts/ci/test-suites.json` owns both files
and requires all four fixture selections. It is excluded from automated groups
until a reviewed collision-detecting Git build is provisioned. The lane runner
rejects skipped tests; an unselected direct Node run does not qualify Git custody.

## Storage and troubleshooting

Run on Linux with `/proc` available. Tests create mode `0700` directories under
the current user home and remove only their own fixtures after closing custody.
These temporary files prove local retention and reopen behavior, not production
volume durability. Select a total artifact budget of 2097152 bytes.

A partial fixture selection fails before testing. A refused executable can mean
its path contains a symlink, its owner differs, its bytes do not match the pin,
or its mode permits group/other writes. Recheck the selected trusted build and
its ownership; do not weaken custody validation to make a test pass.

See [the component reference](../reference/repository-publication-v1.md) for
persistent storage requirements and unavailable authority suppliers.
