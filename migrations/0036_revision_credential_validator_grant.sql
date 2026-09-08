-- Application revision inserts evaluate this read-only, SECURITY INVOKER CHECK
-- validator using the application's existing table and helper privileges.
GRANT EXECUTE ON FUNCTION
  occ.revision_credential_selection_valid_v1(jsonb, text, text, text)
TO occ_app;
