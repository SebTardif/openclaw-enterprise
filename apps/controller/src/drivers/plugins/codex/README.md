# Codex plugin catalog

The Codex plugin catalog driver reads one reviewed inventory artifact generated
from the pinned Codex app-server `plugin/list` response. The artifact is a
credential-free snapshot for the controller release; it does not prove that a
target Agent account can install or run a plugin.

The expected runtime version is Codex `0.152.1`, matching
`deploy/runtime/Dockerfile`. Missing, malformed, empty without explicit review,
or version-mismatched inventory is unavailable to the API layer and must be
reported as `DEPENDENCY_UNAVAILABLE`.

Regenerate the artifact with `scripts/generate-codex-plugin-inventory.mjs`
against the pinned app-server and keep raw evidence outside the repository.
