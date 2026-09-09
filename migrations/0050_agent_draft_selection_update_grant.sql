-- The optional Agent draft selection is editable data. Current profile
-- admission and FIRST-INSERT revision Use remain with their original owners.
-- Preserve column-scoped app access; do not grant table-wide Agent UPDATE.
GRANT UPDATE (workload_profile_selection) ON occ.agents TO occ_app;
