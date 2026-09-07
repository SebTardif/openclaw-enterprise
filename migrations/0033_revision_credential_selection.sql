-- The original decoded credential record belongs to the FIRST immutable revision
-- INSERT. This migration adds metadata validation only, no authority or backfill.
-- Existing0001 immutability,0013 admission predicates and0019 shape/canonical
-- functions remain unchanged. Original CRD82e closed schema is embedded below;
-- ProviderId receives its JS whitespace/UTF16 refinement after generic shape.
CREATE FUNCTION occ.revision_credential_selection_valid_v1(
  value jsonb, namespace_id text, agent_id text, revision_id text
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $credential$
DECLARE
  definition CONSTANT jsonb := $definition${"type":"object","required":["schemaVersion","scope","revisionId","association","model","repository","materialSelection","channels"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"revisionId":{"type":"string","pattern":"^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"association":{"type":"object","required":["selection","profileRefs","admittedConfigurationDigest"],"properties":{"selection":{"type":"object","required":["manifestRef","manifestDigest","admissionRef","admissionVersion"],"properties":{"manifestRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","minLength":36,"maxLength":36},"manifestDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$","minLength":71,"maxLength":71},"admissionRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","minLength":36,"maxLength":36},"admissionVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"profileRefs":{"type":"object","required":["provider","runtime","identity","containment","storage"],"properties":{"provider":{"type":"object","required":["ref","version","contentDigest"],"properties":{"ref":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","minLength":36,"maxLength":36},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$","minLength":71,"maxLength":71}},"additionalProperties":false},"runtime":{"type":"object","required":["ref","version","contentDigest"],"properties":{"ref":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","minLength":36,"maxLength":36},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$","minLength":71,"maxLength":71}},"additionalProperties":false},"identity":{"type":"object","required":["ref","version","contentDigest"],"properties":{"ref":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","minLength":36,"maxLength":36},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$","minLength":71,"maxLength":71}},"additionalProperties":false},"containment":{"type":"object","required":["ref","version","contentDigest"],"properties":{"ref":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","minLength":36,"maxLength":36},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$","minLength":71,"maxLength":71}},"additionalProperties":false},"storage":{"type":"object","required":["ref","version","contentDigest"],"properties":{"ref":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$","minLength":36,"maxLength":36},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$","minLength":71,"maxLength":71}},"additionalProperties":false}},"additionalProperties":false},"admittedConfigurationDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$","minLength":71,"maxLength":71}},"additionalProperties":false},"model":{"type":"object","required":["schemaVersion","scope","profile","binding","accountLink","upstreamWorkspaceRef","invocationProfile","custody","setup"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"profile":{"type":"object","required":["schemaVersion","scope","profile","providerId","account","transport","kind","mode","modelProfile","credentialClass"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"profile":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"providerId":{"type":"string","minLength":1,"maxLength":200},"account":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"transport":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"kind":{"type":"string","const":"model"},"mode":{"type":"string","const":"mediated"},"modelProfile":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"credentialClass":{"enum":["workload-federation","trusted-login","api-key"]}},"additionalProperties":false},"binding":{"type":"object","required":["schemaVersion","scope","bindingRef","bindingVersion","secretId","secretVersion","providerId","account","driverId","backendBindingRef"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"bindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"bindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"secretId":{"type":"string","pattern":"^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"secretVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"providerId":{"type":"string","minLength":1,"maxLength":200},"account":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"driverId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"backendBindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"}},"additionalProperties":false},"accountLink":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"upstreamWorkspaceRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"invocationProfile":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"custody":{"type":"string","const":"external-protected-owner"},"setup":{"anyOf":[{"type":"object","required":["kind","invocationMaterial","rotationOwnerRef","lifecycleProfile"],"properties":{"kind":{"type":"string","const":"api-key-import"},"invocationMaterial":{"type":"string","const":"api-key"},"rotationOwnerRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"lifecycleProfile":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false}},"additionalProperties":false},{"type":"object","required":["kind","invocationMaterial","refreshOwnerRef","lifecycleProfile"],"properties":{"kind":{"enum":["trusted-login","workload-federation"]},"invocationMaterial":{"type":"string","const":"access-token-and-account-context"},"refreshOwnerRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"lifecycleProfile":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false}},"additionalProperties":false}]}},"additionalProperties":false},"repository":{"type":"object","required":["profile","binding","grant"],"properties":{"profile":{"type":"object","required":["schemaVersion","scope","profile","providerId","account","transport","kind","mode","providerInstallationRef","permissionProfile","credentialClass"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"profile":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"providerId":{"type":"string","minLength":1,"maxLength":200},"account":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"transport":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"kind":{"type":"string","const":"repository"},"mode":{"enum":["native","mediated","history-isolated"]},"providerInstallationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"permissionProfile":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"credentialClass":{"type":"string","const":"installation-token"}},"additionalProperties":false},"binding":{"type":"object","required":["schemaVersion","scope","bindingRef","bindingVersion","secretId","secretVersion","providerId","account","driverId","backendBindingRef"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"bindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"bindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"secretId":{"type":"string","pattern":"^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"secretVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"providerId":{"type":"string","minLength":1,"maxLength":200},"account":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"driverId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"backendBindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"}},"additionalProperties":false},"grant":{"type":"object","required":["providerInstallationRef","repositoryIds","permissions","permissionProfile"],"properties":{"providerInstallationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"repositoryIds":{"type":"array","items":{"type":"string","pattern":"^[1-9][0-9]{0,19}$"},"minItems":1,"maxItems":20,"uniqueItems":true},"permissions":{"type":"array","items":{"type":"object","required":["name","access"],"properties":{"name":{"enum":["metadata","contents","issues","pull_requests"]},"access":{"enum":["read","write"]}},"additionalProperties":false},"minItems":1,"maxItems":8,"uniqueItems":true},"permissionProfile":{"type":"object","required":["ref","version","digest"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false}},"additionalProperties":false}},"additionalProperties":false},"materialSelection":{"type":"object","required":["recordRef","recordVersion"],"properties":{"recordRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"recordVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"channels":{"type":"array","items":{"anyOf":[{"type":"object","required":["kind","moduleId","profileRef","bot","app"],"properties":{"kind":{"type":"string","const":"slack"},"moduleId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"profileRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"bot":{"type":"object","required":["ref","version"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"app":{"type":"object","required":["ref","version"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false}},"additionalProperties":false},{"type":"object","required":["kind","moduleId","profileRef","credential"],"properties":{"kind":{"type":"string","const":"teams"},"moduleId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"profileRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"credential":{"type":"object","required":["ref","version"],"properties":{"ref":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9][A-Za-z0-9._:/-]*$"},"version":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false}},"additionalProperties":false}]},"minItems":1,"maxItems":2}},"additionalProperties":false}$definition$::jsonb;
  installation_count bigint; installation_id text; provider text; previous text;
  current_text text; item jsonb; role_count bigint; distinct_roles bigint;
  channel_count integer; distinct_kinds bigint; distinct_modules bigint;
  utf16_length bigint;
BEGIN
  IF value IS NULL OR NOT occ.runtime_authority_shape(value,definition) THEN RETURN false; END IF;
  IF octet_length(occ.runtime_authority_canonical(value))>65536 THEN RETURN false; END IF;
  SELECT count(*),min(id) INTO installation_count,installation_id FROM occ.installation;
  IF installation_count<>1 OR value#>>'{scope,installationId}' IS DISTINCT FROM installation_id
    OR value#>>'{scope,namespaceId}' IS DISTINCT FROM namespace_id
    OR value#>>'{scope,agentId}' IS DISTINCT FROM agent_id
    OR value->>'revisionId' IS DISTINCT FROM revision_id THEN RETURN false; END IF;
  -- The only non-ASCII bounded strings in this closed shape are ProviderIds.
  -- PostgreSQL text already refuses NUL/unpaired surrogates. Count UTF16 units,
  -- reject exactly the source control/line-separator range and ECMAScript trim set.
  FOREACH provider IN ARRAY ARRAY[value #>> '{model,profile,providerId}', value #>> '{model,binding,providerId}', value #>> '{repository,profile,providerId}', value #>> '{repository,binding,providerId}'] LOOP
    SELECT coalesce(sum(CASE WHEN ascii(c)>65535 THEN 2 ELSE 1 END),0)
      INTO utf16_length FROM regexp_split_to_table(provider,'') AS chars(c);
    IF utf16_length NOT BETWEEN 1 AND 200
      OR btrim(provider,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>provider
      OR translate(provider,(SELECT string_agg(chr(n),'') FROM generate_series(1,31) AS codes(n))||chr(127)||chr(8232)||chr(8233),'')<>provider
      THEN RETURN false; END IF;
  END LOOP;
  IF value->'scope' IS DISTINCT FROM value#>'{model,scope}'
    OR value->'scope' IS DISTINCT FROM value#>'{model,profile,scope}'
    OR value->'scope' IS DISTINCT FROM value#>'{model,binding,scope}'
    OR value->'scope' IS DISTINCT FROM value#>'{repository,profile,scope}'
    OR value->'scope' IS DISTINCT FROM value#>'{repository,binding,scope}'
    OR value#>'{model,profile,providerId}' IS DISTINCT FROM value#>'{model,binding,providerId}'
    OR value#>'{model,profile,account}' IS DISTINCT FROM value#>'{model,binding,account}'
    OR value#>'{repository,profile,providerId}' IS DISTINCT FROM value#>'{repository,binding,providerId}'
    OR value#>'{repository,profile,account}' IS DISTINCT FROM value#>'{repository,binding,account}'
    OR value#>'{repository,profile,providerInstallationRef}' IS DISTINCT FROM value#>'{repository,grant,providerInstallationRef}'
    OR value#>'{repository,profile,permissionProfile}' IS DISTINCT FROM value#>'{repository,grant,permissionProfile}'
    OR value#>>'{model,profile,credentialClass}' IS DISTINCT FROM
      (CASE WHEN value#>>'{model,setup,kind}'='api-key-import' THEN 'api-key' ELSE value#>>'{model,setup,kind}' END)
    THEN RETURN false; END IF;
  SELECT count(*),count(DISTINCT entry->>'ref') INTO role_count,distinct_roles
    FROM jsonb_each(value#>'{association,profileRefs}') AS roles(name,entry);
  IF role_count<>5 OR distinct_roles<>5 THEN RETURN false; END IF;
  previous := NULL;
  FOR current_text IN SELECT jsonb_array_elements_text(value#>'{repository,grant,repositoryIds}') LOOP
    IF previous IS NOT NULL AND previous COLLATE "C">=current_text COLLATE "C" THEN RETURN false; END IF;
    previous := current_text;
  END LOOP;
  previous := NULL;
  FOR item IN SELECT jsonb_array_elements(value#>'{repository,grant,permissions}') LOOP
    current_text := item->>'name';
    IF (current_text='metadata' AND item->>'access'<>'read')
      OR (previous IS NOT NULL AND previous COLLATE "C">=current_text COLLATE "C") THEN RETURN false; END IF;
    previous := current_text;
  END LOOP;
  channel_count := jsonb_array_length(value->'channels');
  SELECT count(DISTINCT entry->>'kind'),count(DISTINCT entry->>'moduleId')
    INTO distinct_kinds,distinct_modules FROM jsonb_array_elements(value->'channels') AS channels(entry);
  IF distinct_kinds<>channel_count OR distinct_modules<>channel_count
    OR (channel_count=2 AND value#>>'{channels,0,kind}'<>'slack') THEN RETURN false; END IF;
  FOR item IN SELECT jsonb_array_elements(value->'channels') LOOP
    IF item->>'kind'='slack' AND item#>'{bot,ref}'=item#>'{app,ref}' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR check_violation THEN RETURN false;
END;
$credential$;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_admitted_snapshot;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
  admitted_spec ?& ARRAY[
    'configuration_id', 'configuration_kind', 'configuration_generation',
    'draft_spec', 'harness', 'compute'
  ]
  AND admitted_spec
    - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
    - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id'
    - 'secret_driver_id' - 'secret_bindings' - 'service_account' - 'credential_workload_selection' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec->'configuration_id') = 'string'
  AND (admitted_spec->>'configuration_id')
    ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND jsonb_typeof(admitted_spec->'configuration_kind') = 'string'
  AND admitted_spec->>'configuration_kind' = 'agent'
  AND jsonb_typeof(admitted_spec->'configuration_generation') = 'number'
  AND (admitted_spec->>'configuration_generation')::numeric
    BETWEEN 1 AND 9007199254740991
  AND mod((admitted_spec->>'configuration_generation')::numeric, 1) = 0
  AND jsonb_typeof(admitted_spec->'draft_spec') = 'object'
  AND jsonb_typeof(admitted_spec->'harness') = 'object'
  AND (admitted_spec->'harness') ?& ARRAY['id', 'version', 'mode']
  AND (admitted_spec->'harness') - 'id' - 'version' - 'mode' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec #> '{harness,id}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{harness,id}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{harness,version}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{harness,version}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{harness,mode}') = 'string'
  AND (admitted_spec #>> '{harness,mode}') IN ('embedded', 'dedicated')
  AND jsonb_typeof(admitted_spec->'compute') = 'object'
  AND (admitted_spec->'compute') ?& ARRAY['id', 'implementation']
  AND (admitted_spec->'compute') - 'id' - 'implementation' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec #> '{compute,id}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{compute,id}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{compute,implementation}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{compute,implementation}'), '') <> ''
  AND (
    NOT (admitted_spec ? 'sandbox_driver_id')
    OR (
      jsonb_typeof(admitted_spec->'sandbox_driver_id') = 'string'
      AND COALESCE(btrim(admitted_spec->>'sandbox_driver_id'), '') <> ''
    )
  )
  AND (
    NOT (admitted_spec ? 'secret_driver_id')
    OR (
      jsonb_typeof(admitted_spec->'secret_driver_id') = 'string'
      AND COALESCE(btrim(admitted_spec->>'secret_driver_id'), '') <> ''
    )
  )
  AND (
    NOT (admitted_spec ? 'secret_bindings')
    OR occ.secret_bindings_are_valid(admitted_spec->'secret_bindings', namespace_id)
  )
  AND (
    NOT (admitted_spec ? 'service_account')
    OR (
      jsonb_typeof(admitted_spec->'service_account') = 'object'
      AND (admitted_spec->'service_account') ?& ARRAY['id', 'credential']
      AND (admitted_spec->'service_account')
        - 'id' - 'credential' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,id}') = 'string'
      AND (admitted_spec #>> '{service_account,id}')
        ~ '^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(admitted_spec #> '{service_account,credential}') = 'object'
      AND (admitted_spec #> '{service_account,credential}') ?& ARRAY['kind', 'secretRef']
      AND (admitted_spec #> '{service_account,credential}')
        - 'kind' - 'secretRef' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,kind}') = 'string'
      AND (admitted_spec #>> '{service_account,credential,kind}')
        IN ('api_key', 'access_token')
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef}') = 'object'
      AND (admitted_spec #> '{service_account,credential,secretRef}')
        ?& ARRAY['name', 'key']
      AND (admitted_spec #> '{service_account,credential,secretRef}')
        - 'name' - 'key' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef,name}')
        = 'string'
      AND char_length(admitted_spec #>> '{service_account,credential,secretRef,name}')
        BETWEEN 1 AND 253
      AND (admitted_spec #>> '{service_account,credential,secretRef,name}')
        ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef,key}')
        = 'string'
      AND char_length(admitted_spec #>> '{service_account,credential,secretRef,key}')
        BETWEEN 1 AND 253
      AND (admitted_spec #>> '{service_account,credential,secretRef,key}')
        ~ '^[-._a-zA-Z0-9]+$'
      AND (admitted_spec #>> '{service_account,credential,secretRef,key}')
        NOT IN ('.', '..')
    )
  )
);
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_credential_selection CHECK (
  NOT (admitted_spec ? 'credential_workload_selection')
  OR occ.revision_credential_selection_valid_v1(admitted_spec->'credential_workload_selection',namespace_id,agent_id,id)
);
