# Codex plugin catalog

The Codex plugin catalog driver reads one reviewed inventory artifact generated
from the pinned Codex app-server `plugin/list` response. The artifact is a
credential-free snapshot for the controller release; it does not prove that a
target Agent account can install or run a plugin.

The expected catalog source version is Codex `0.153.4`. Missing, malformed, or
version-mismatched inventory is unavailable to the API layer and must be
reported as `DEPENDENCY_UNAVAILABLE`.
A bundled `plugins: []` artifact is valid only after the generator and release
review have established the expected marketplace was present and intentionally
empty.

Regenerate the artifact with `scripts/generate-codex-plugin-inventory.mjs`
against the pinned app-server and keep raw evidence outside the repository. The
current reviewed artifact includes only `openai-curated-remote` entries from
the direct `plugin/list` response. Local-path marketplaces such as bundled,
primary runtime, and internal-testing entries are excluded. Every artifact `id` is `<PluginSummary.id>#<remotePluginId>` so the selection key stays stable if Codex later adds or removes another entry with the same `PluginSummary.id`.
