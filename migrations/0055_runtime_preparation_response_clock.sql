-- SDK receipt and submission timestamps originate from independent host clocks.
-- Preserve response identity and finite timestamps without ordering those clocks.
CREATE OR REPLACE FUNCTION occ.immutable_runtime_preparation_response_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Runtime preparation response is immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM occ.runtime_preparation_submissions submitted
      JOIN occ.runtime_preparation_operations child ON child.child_effect_ref=submitted.effect_ref
    WHERE submitted.effect_ref=NEW.effect_ref
      AND child.canonical_request::jsonb->'child'->'providerTarget'->>'apiKind'='Deployment'
      AND child.canonical_request::jsonb->'child'->'providerTarget'->>'name'=NEW.deployment_name
      AND (child.canonical_request::jsonb->'child'->'predicate'->>'kind'='expected-absent'
        OR child.canonical_request::jsonb->'child'->'predicate'->>'uid'=NEW.deployment_uid)
  ) THEN RAISE EXCEPTION 'Runtime preparation response differs from submitted child' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
