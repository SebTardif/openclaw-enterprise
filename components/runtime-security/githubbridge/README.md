# Native GitHub mediation bridge

The `oce-github-mediation` command owns authenticated Unix-socket sessions and
private parent framing for GitHub metadata and Git reads. The parent retains Work
authorization and protected credential ownership.

See the [native read reference](../../../docs/reference/native-github-read.md)
for behavior and remaining checkout integration, and the
[test guide](../../../docs/testing/native-github-read.md) for component proof and
required regular Agent workflow acceptance.
