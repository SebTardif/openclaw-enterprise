-- The application has no broad IAM UPDATE/DELETE privilege. This function only
-- holds the complete existing policy writer set until its caller transaction ends.
CREATE FUNCTION occ.lock_workload_profile_iam() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  LOCK TABLE occ.iam_identities, occ.iam_roles, occ.iam_groups,
    occ.iam_group_memberships, occ.iam_access_bindings, occ.iam_restrictions
    IN SHARE MODE;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION occ.lock_workload_profile_iam() OWNER TO occ_migrator;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.lock_workload_profile_iam() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.lock_workload_profile_iam() TO occ_app;
