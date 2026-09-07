-- Add explicit Agent Gateway subjects while retaining historical Installation records.
-- Install with the matching startup backend, schema factory and transaction owner.
-- Both historical V1 and Agent V2 backends use their exact subject partition.
-- Relational legacy defaults preserve record JSON, canonical commands, operation
-- digests and historical process generations. No physical disposition is inferred.
BEGIN;
LOCK TABLE occ.gateway_startup_operations, occ.gateway_startup_heads IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations
 ADD COLUMN subject_version integer NOT NULL DEFAULT 1,
 ADD COLUMN subject_key text NOT NULL DEFAULT 'installation-v1',
 ADD COLUMN namespace_ref text,
 ADD COLUMN agent_ref text;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_heads
 ADD COLUMN subject_version integer NOT NULL DEFAULT 1,
 ADD COLUMN subject_key text NOT NULL DEFAULT 'installation-v1',
 ADD COLUMN namespace_ref text,
 ADD COLUMN agent_ref text;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations DROP CONSTRAINT gateway_startup_operations_startup_fk;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations DROP CONSTRAINT gateway_startup_operations_predecessor_fk;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_heads DROP CONSTRAINT gateway_startup_heads_latest_fk;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_heads DROP CONSTRAINT gateway_startup_heads_startup_fk;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations DROP CONSTRAINT gateway_startup_operation_scope;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations DROP CONSTRAINT gateway_startup_operation_version;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations DROP CONSTRAINT gateway_startup_head_version_unique;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_heads DROP CONSTRAINT gateway_startup_heads_pkey;
--> statement-breakpoint

DROP INDEX occ.gateway_startup_generation_unique;
--> statement-breakpoint

DROP INDEX occ.gateway_startup_submission_unique;
--> statement-breakpoint

DROP INDEX occ.gateway_startup_consume_unique;
--> statement-breakpoint

DROP INDEX occ.gateway_startup_withdraw_unique;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations
 ADD CONSTRAINT gateway_startup_operation_subject CHECK (((subject_version=1 AND subject_key='installation-v1' AND namespace_ref IS NULL AND agent_ref IS NULL)
 OR (subject_version=2 AND subject_key='agent-v2:'||agent_ref
 AND char_length(namespace_ref) BETWEEN 1 AND 512 AND octet_length(namespace_ref)<=2048
 AND char_length(agent_ref) BETWEEN 1 AND 512 AND octet_length(agent_ref)<=2048
 AND namespace_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')
 AND agent_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']'))) IS TRUE),
 ADD CONSTRAINT gateway_startup_operations_agent_owner FOREIGN KEY(namespace_ref,agent_ref) REFERENCES occ.agents(namespace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT gateway_startup_operation_scope UNIQUE(installation_id,subject_key,operation_ref),
 ADD CONSTRAINT gateway_startup_operation_version UNIQUE(installation_id,subject_key,operation_ref,after_head_version),
 ADD CONSTRAINT gateway_startup_head_version_unique UNIQUE(installation_id,subject_key,after_head_version);
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_heads
 ADD CONSTRAINT gateway_startup_heads_pkey PRIMARY KEY(installation_id,subject_key),
 ADD CONSTRAINT gateway_startup_head_subject CHECK (((subject_version=1 AND subject_key='installation-v1' AND namespace_ref IS NULL AND agent_ref IS NULL)
 OR (subject_version=2 AND subject_key='agent-v2:'||agent_ref
 AND char_length(namespace_ref) BETWEEN 1 AND 512 AND octet_length(namespace_ref)<=2048
 AND char_length(agent_ref) BETWEEN 1 AND 512 AND octet_length(agent_ref)<=2048
 AND namespace_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')
 AND agent_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']'))) IS TRUE),
 ADD CONSTRAINT gateway_startup_heads_agent_owner FOREIGN KEY(namespace_ref,agent_ref) REFERENCES occ.agents(namespace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT;
--> statement-breakpoint

CREATE UNIQUE INDEX gateway_startup_generation_unique ON occ.gateway_startup_operations(installation_id,subject_key,process_generation) WHERE kind='accept-startup';
--> statement-breakpoint

CREATE UNIQUE INDEX gateway_startup_submission_unique ON occ.gateway_startup_operations(installation_id,subject_key,startup_operation_ref) WHERE kind='submit-create';
--> statement-breakpoint

CREATE UNIQUE INDEX gateway_startup_consume_unique ON occ.gateway_startup_operations(installation_id,subject_key,startup_operation_ref) WHERE kind='consume-startup';
--> statement-breakpoint

CREATE UNIQUE INDEX gateway_startup_withdraw_unique ON occ.gateway_startup_operations(installation_id,subject_key,startup_operation_ref) WHERE kind='withdraw';
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations DROP CONSTRAINT gateway_startup_command_digest, ADD CONSTRAINT gateway_startup_command_digest CHECK ((CASE subject_version WHEN 1 THEN ((operation_digest=encode(sha256(convert_to('{"command":'||canonical_command||',"domain":"oce.installation-gateway.startup-operation.v1"}', 'UTF8')), 'hex')) IS TRUE) WHEN 2 THEN ((operation_digest=encode(sha256(convert_to('{"command":'||canonical_command||',"domain":"oce.agent-gateway.startup-operation.v2"}', 'UTF8')), 'hex')) IS TRUE) ELSE false END) IS TRUE);
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations DROP CONSTRAINT gateway_startup_record_core, ADD CONSTRAINT gateway_startup_record_core CHECK ((CASE subject_version WHEN 1 THEN ((record=jsonb_build_object('kind',kind,'command',jsonb_build_object('installationId',installation_id,'operationRef',operation_ref,'operationDigest',operation_digest,'startup',CASE WHEN kind='accept-startup' THEN 'null'::jsonb ELSE jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest) END),'canonicalCommand',canonical_command,'beforeHeadVersion',before_head_version,'afterHeadVersion',after_head_version,'beforeRecordVersion',before_record_version,'afterRecordVersion',after_record_version,'previousOperationRef',previous_operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'createEffectRef',create_effect_ref,'acceptance',record->'acceptance','submissionInput',record->'submissionInput','recipient',record->'recipient','withdrawalReason',record->'withdrawalReason','auditEventId',audit_event_id)) IS TRUE) WHEN 2 THEN ((record=jsonb_build_object('schemaVersion',2,'kind',kind,'command',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'operationRef',operation_ref,'operationDigest',operation_digest,'startup',CASE WHEN kind='accept-startup' THEN 'null'::jsonb ELSE jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest) END),'canonicalCommand',canonical_command,'beforeHeadVersion',before_head_version,'afterHeadVersion',after_head_version,'beforeRecordVersion',before_record_version,'afterRecordVersion',after_record_version,'previousOperationRef',previous_operation_ref,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'createEffectRef',create_effect_ref,'acceptance',record->'acceptance','submissionInput',record->'submissionInput','recipient',record->'recipient','withdrawalReason',record->'withdrawalReason','auditEventId',audit_event_id))) ELSE false END) IS TRUE);
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations DROP CONSTRAINT gateway_startup_command_core, ADD CONSTRAINT gateway_startup_command_core CHECK ((CASE subject_version WHEN 1 THEN ((CASE kind
 WHEN 'accept-startup' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'expectedHead',(canonical_command::jsonb)->'expectedHead','selectedDefinition',(canonical_command::jsonb)->'selectedDefinition','predecessorDisposition',(canonical_command::jsonb)->'predecessorDisposition')
 WHEN 'submit-create' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','input',record->'submissionInput')
 WHEN 'consume-startup' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','recipient',record->'recipient')
 WHEN 'withdraw' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','reason',record->'withdrawalReason') ELSE false END) IS TRUE) WHEN 2 THEN ((CASE kind
 WHEN 'accept-startup' THEN canonical_command::jsonb=jsonb_build_object('schemaVersion',2,'kind',kind,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'operationRef',operation_ref,'expectedHead',canonical_command::jsonb->'expectedHead','selectedDefinition',canonical_command::jsonb->'selectedDefinition','predecessorDisposition',canonical_command::jsonb->'predecessorDisposition')
 WHEN 'submit-create' THEN canonical_command::jsonb=jsonb_build_object('schemaVersion',2,'kind',kind,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'operationRef',operation_ref,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',canonical_command::jsonb->'expectedHead','input',record->'submissionInput')
 WHEN 'consume-startup' THEN canonical_command::jsonb=jsonb_build_object('schemaVersion',2,'kind',kind,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'operationRef',operation_ref,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',canonical_command::jsonb->'expectedHead','recipient',record->'recipient')
 WHEN 'withdraw' THEN canonical_command::jsonb=jsonb_build_object('schemaVersion',2,'kind',kind,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'operationRef',operation_ref,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',canonical_command::jsonb->'expectedHead','reason',record->'withdrawalReason')
 ELSE false END)) ELSE false END) IS TRUE);
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations DROP CONSTRAINT gateway_startup_variant, ADD CONSTRAINT gateway_startup_variant CHECK ((CASE subject_version WHEN 1 THEN ((CASE kind
 WHEN 'accept-startup' THEN startup_operation_ref=operation_ref AND startup_operation_digest=operation_digest
 AND record->'acceptance'=jsonb_build_object('binding',record#>'{acceptance,binding}','predecessor',record#>'{acceptance,predecessor}','auditEventId',audit_event_id)
 AND record#>'{acceptance,binding,startup}'=jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest)
 AND record#>'{acceptance,binding,createEffectRef}'=to_jsonb(create_effect_ref)
 AND record#>'{acceptance,binding,selection}'=(canonical_command::jsonb)->'selectedDefinition'
 AND record#>'{acceptance,predecessor,disposition}'=(canonical_command::jsonb)->'predecessorDisposition'
 AND record#>'{acceptance,predecessor}'=jsonb_build_object('disposition',record#>'{acceptance,predecessor,disposition}','previousStartup',record#>'{acceptance,predecessor,previousStartup}','processOwner',record#>'{acceptance,predecessor,processOwner}','settlement',record#>'{acceptance,predecessor,settlement}')
 AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb
 WHEN 'submit-create' THEN record->'acceptance'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb
 AND record->'submissionInput'=jsonb_build_object('binding',record#>'{submissionInput,binding}','target',record#>'{submissionInput,target}','launchPlan',record#>'{submissionInput,launchPlan}')
 AND record#>'{submissionInput,binding,startup}'=jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest) AND record#>'{submissionInput,binding,createEffectRef}'=to_jsonb(create_effect_ref)
 WHEN 'consume-startup' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb AND jsonb_typeof(record->'recipient')='object'
 WHEN 'withdraw' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->>'withdrawalReason' IN ('administrative','selection-withdrawn','recipient-revoked')
 ELSE false END) IS TRUE) WHEN 2 THEN ((CASE kind
 WHEN 'accept-startup' THEN startup_operation_ref=operation_ref AND startup_operation_digest=operation_digest
 AND record->'acceptance'=jsonb_build_object('binding',record#>'{acceptance,binding}','predecessor',(record#>'{acceptance,predecessor}'),'auditEventId',audit_event_id)
 AND ((record#>'{acceptance,binding}')=jsonb_build_object('schemaVersion',2,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'createEffectRef',create_effect_ref,'namespaceRef',namespace_ref,'agentRef',agent_ref,'configurationRef',(record#>'{acceptance,binding}')->'configurationRef','configurationVersion',(record#>'{acceptance,binding}')->'configurationVersion','profileRef',(record#>'{acceptance,binding}')->'profileRef','profileVersion',(record#>'{acceptance,binding}')->'profileVersion','admittedRevisionRef',(record#>'{acceptance,binding}')->'admittedRevisionRef','gatewayAssignmentRef',(record#>'{acceptance,binding}')->'gatewayAssignmentRef','hostRuntimeGeneration',(record#>'{acceptance,binding}')->'hostRuntimeGeneration','nativeConfigRef',(record#>'{acceptance,binding}')->'nativeConfigRef','configDigest',(record#>'{acceptance,binding}')->'configDigest','stateOwnership',(record#>'{acceptance,binding}')->'stateOwnership','stateSchemaVersion',(record#>'{acceptance,binding}')->'stateSchemaVersion','agentSchemaVersion',(record#>'{acceptance,binding}')->'agentSchemaVersion','protocolVersion',(record#>'{acceptance,binding}')->'protocolVersion','modules',(record#>'{acceptance,binding}')->'modules','startupDeadlineMs',(record#>'{acceptance,binding}')->'startupDeadlineMs','shutdownDeadlineMs',(record#>'{acceptance,binding}')->'shutdownDeadlineMs','selection',(record#>'{acceptance,binding}')->'selection','profileRefs',(record#>'{acceptance,binding}')->'profileRefs','admittedConfigurationDigest',(record#>'{acceptance,binding}')->'admittedConfigurationDigest') AND (((record#>'{acceptance,binding}')->'selection')=jsonb_build_object('manifestRef',((record#>'{acceptance,binding}')->'selection')->'manifestRef','manifestDigest',((record#>'{acceptance,binding}')->'selection')->'manifestDigest','admissionRef',((record#>'{acceptance,binding}')->'selection')->'admissionRef','admissionVersion',((record#>'{acceptance,binding}')->'selection')->'admissionVersion') AND (jsonb_typeof((((record#>'{acceptance,binding}')->'selection')->'manifestRef'))='string' AND char_length((((record#>'{acceptance,binding}')->'selection')->'manifestRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{acceptance,binding}')->'selection')->'manifestRef')#>>'{}')<=2048 AND ((((record#>'{acceptance,binding}')->'selection')->'manifestRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (jsonb_typeof((((record#>'{acceptance,binding}')->'selection')->'admissionRef'))='string' AND char_length((((record#>'{acceptance,binding}')->'selection')->'admissionRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{acceptance,binding}')->'selection')->'admissionRef')#>>'{}')<=2048 AND ((((record#>'{acceptance,binding}')->'selection')->'admissionRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND jsonb_typeof(((record#>'{acceptance,binding}')->'selection')->'manifestDigest')='string' AND (((record#>'{acceptance,binding}')->'selection')->>'manifestDigest') ~ '^sha256:[0-9a-f]{64}$' AND jsonb_typeof(((record#>'{acceptance,binding}')->'selection')->'admissionVersion')='number' AND (((record#>'{acceptance,binding}')->'selection')->>'admissionVersion')::numeric BETWEEN 1 AND 9007199254740991 AND mod((((record#>'{acceptance,binding}')->'selection')->>'admissionVersion')::numeric,1)=0) AND jsonb_typeof((record#>'{acceptance,binding}')->'profileRefs')='object' AND (record#>'{acceptance,binding}')->'profileRefs'=jsonb_build_object('provider',(record#>'{acceptance,binding}')#>'{profileRefs,provider}','runtime',(record#>'{acceptance,binding}')#>'{profileRefs,runtime}','identity',(record#>'{acceptance,binding}')#>'{profileRefs,identity}','containment',(record#>'{acceptance,binding}')#>'{profileRefs,containment}','storage',(record#>'{acceptance,binding}')#>'{profileRefs,storage}') AND jsonb_typeof((record#>'{acceptance,binding}')#>'{profileRefs,provider}')='object' AND jsonb_typeof((record#>'{acceptance,binding}')#>'{profileRefs,runtime}')='object' AND jsonb_typeof((record#>'{acceptance,binding}')#>'{profileRefs,identity}')='object' AND jsonb_typeof((record#>'{acceptance,binding}')#>'{profileRefs,containment}')='object' AND jsonb_typeof((record#>'{acceptance,binding}')#>'{profileRefs,storage}')='object' AND jsonb_typeof((record#>'{acceptance,binding}')->'admittedConfigurationDigest')='string' AND ((record#>'{acceptance,binding}')->>'admittedConfigurationDigest') ~ '^sha256:[0-9a-f]{64}$')
 AND record#>'{acceptance,binding,selection}'=canonical_command::jsonb->'selectedDefinition'
 AND (record#>'{acceptance,predecessor}')->'disposition'=canonical_command::jsonb->'predecessorDisposition'
 AND ((((record#>'{acceptance,predecessor}')->'disposition')=jsonb_build_object('recordRef',((record#>'{acceptance,predecessor}')->'disposition')->'recordRef','recordVersion',((record#>'{acceptance,predecessor}')->'disposition')->'recordVersion') AND (jsonb_typeof((((record#>'{acceptance,predecessor}')->'disposition')->'recordRef'))='string' AND char_length((((record#>'{acceptance,predecessor}')->'disposition')->'recordRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{acceptance,predecessor}')->'disposition')->'recordRef')#>>'{}')<=2048 AND ((((record#>'{acceptance,predecessor}')->'disposition')->'recordRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND jsonb_typeof(((record#>'{acceptance,predecessor}')->'disposition')->'recordVersion')='number' AND (((record#>'{acceptance,predecessor}')->'disposition')->>'recordVersion')::numeric BETWEEN 1 AND 9007199254740991 AND mod((((record#>'{acceptance,predecessor}')->'disposition')->>'recordVersion')::numeric,1)=0) AND (((record#>'{acceptance,predecessor}')->'processOwner')=jsonb_build_object('recordRef',((record#>'{acceptance,predecessor}')->'processOwner')->'recordRef','recordVersion',((record#>'{acceptance,predecessor}')->'processOwner')->'recordVersion') AND (jsonb_typeof((((record#>'{acceptance,predecessor}')->'processOwner')->'recordRef'))='string' AND char_length((((record#>'{acceptance,predecessor}')->'processOwner')->'recordRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{acceptance,predecessor}')->'processOwner')->'recordRef')#>>'{}')<=2048 AND ((((record#>'{acceptance,predecessor}')->'processOwner')->'recordRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND jsonb_typeof(((record#>'{acceptance,predecessor}')->'processOwner')->'recordVersion')='number' AND (((record#>'{acceptance,predecessor}')->'processOwner')->>'recordVersion')::numeric BETWEEN 1 AND 9007199254740991 AND mod((((record#>'{acceptance,predecessor}')->'processOwner')->>'recordVersion')::numeric,1)=0) AND (((record#>'{acceptance,predecessor}')->'settlement')=jsonb_build_object('recordRef',((record#>'{acceptance,predecessor}')->'settlement')->'recordRef','recordVersion',((record#>'{acceptance,predecessor}')->'settlement')->'recordVersion') AND (jsonb_typeof((((record#>'{acceptance,predecessor}')->'settlement')->'recordRef'))='string' AND char_length((((record#>'{acceptance,predecessor}')->'settlement')->'recordRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{acceptance,predecessor}')->'settlement')->'recordRef')#>>'{}')<=2048 AND ((((record#>'{acceptance,predecessor}')->'settlement')->'recordRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND jsonb_typeof(((record#>'{acceptance,predecessor}')->'settlement')->'recordVersion')='number' AND (((record#>'{acceptance,predecessor}')->'settlement')->>'recordVersion')::numeric BETWEEN 1 AND 9007199254740991 AND mod((((record#>'{acceptance,predecessor}')->'settlement')->>'recordVersion')::numeric,1)=0) AND CASE (record#>'{acceptance,predecessor}')->>'kind'
 WHEN 'complete-initial' THEN (record#>'{acceptance,predecessor}')=jsonb_build_object('kind','complete-initial','disposition',(record#>'{acceptance,predecessor}')->'disposition','previousStartup','null'::jsonb,'processOwner',(record#>'{acceptance,predecessor}')->'processOwner','settlement',(record#>'{acceptance,predecessor}')->'settlement')
 WHEN 'retired-agent' THEN (record#>'{acceptance,predecessor}')=jsonb_build_object('kind','retired-agent','disposition',(record#>'{acceptance,predecessor}')->'disposition','previousStartup',(canonical_command::jsonb)#>'{expectedHead,startup}','processOwner',(record#>'{acceptance,predecessor}')->'processOwner','settlement',(record#>'{acceptance,predecessor}')->'settlement') AND jsonb_typeof((record#>'{acceptance,predecessor}')->'previousStartup')='object'
 WHEN 'retired-installation' THEN (record#>'{acceptance,predecessor}')=jsonb_build_object('kind','retired-installation','disposition',(record#>'{acceptance,predecessor}')->'disposition','previousStartup',(record#>'{acceptance,predecessor}')->'previousStartup','historicalWithdrawal',(record#>'{acceptance,predecessor}')->'historicalWithdrawal','processOwner',(record#>'{acceptance,predecessor}')->'processOwner','settlement',(record#>'{acceptance,predecessor}')->'settlement')
 AND (record#>'{acceptance,predecessor}')->'historicalWithdrawal'=jsonb_build_object('installationId',installation_id,'operationRef',(record#>'{acceptance,predecessor}')#>'{historicalWithdrawal,operationRef}','operationDigest',(record#>'{acceptance,predecessor}')#>'{historicalWithdrawal,operationDigest}','startup',(record#>'{acceptance,predecessor}')->'previousStartup')
 AND jsonb_typeof((record#>'{acceptance,predecessor}')->'previousStartup')='object'
 ELSE false END)
 AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb
 WHEN 'submit-create' THEN record->'acceptance'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb
 AND record->'submissionInput'=jsonb_build_object('binding',record#>'{submissionInput,binding}','target',record#>'{submissionInput,target}','launchPlan',record#>'{submissionInput,launchPlan}')
 AND ((record#>'{submissionInput,binding}')=jsonb_build_object('schemaVersion',2,'startup',jsonb_build_object('schemaVersion',2,'subject',jsonb_build_object('kind','agent-gateway','installationId',installation_id,'namespaceRef',namespace_ref,'agentRef',agent_ref),'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'createEffectRef',create_effect_ref,'namespaceRef',namespace_ref,'agentRef',agent_ref,'configurationRef',(record#>'{submissionInput,binding}')->'configurationRef','configurationVersion',(record#>'{submissionInput,binding}')->'configurationVersion','profileRef',(record#>'{submissionInput,binding}')->'profileRef','profileVersion',(record#>'{submissionInput,binding}')->'profileVersion','admittedRevisionRef',(record#>'{submissionInput,binding}')->'admittedRevisionRef','gatewayAssignmentRef',(record#>'{submissionInput,binding}')->'gatewayAssignmentRef','hostRuntimeGeneration',(record#>'{submissionInput,binding}')->'hostRuntimeGeneration','nativeConfigRef',(record#>'{submissionInput,binding}')->'nativeConfigRef','configDigest',(record#>'{submissionInput,binding}')->'configDigest','stateOwnership',(record#>'{submissionInput,binding}')->'stateOwnership','stateSchemaVersion',(record#>'{submissionInput,binding}')->'stateSchemaVersion','agentSchemaVersion',(record#>'{submissionInput,binding}')->'agentSchemaVersion','protocolVersion',(record#>'{submissionInput,binding}')->'protocolVersion','modules',(record#>'{submissionInput,binding}')->'modules','startupDeadlineMs',(record#>'{submissionInput,binding}')->'startupDeadlineMs','shutdownDeadlineMs',(record#>'{submissionInput,binding}')->'shutdownDeadlineMs','selection',(record#>'{submissionInput,binding}')->'selection','profileRefs',(record#>'{submissionInput,binding}')->'profileRefs','admittedConfigurationDigest',(record#>'{submissionInput,binding}')->'admittedConfigurationDigest') AND (((record#>'{submissionInput,binding}')->'selection')=jsonb_build_object('manifestRef',((record#>'{submissionInput,binding}')->'selection')->'manifestRef','manifestDigest',((record#>'{submissionInput,binding}')->'selection')->'manifestDigest','admissionRef',((record#>'{submissionInput,binding}')->'selection')->'admissionRef','admissionVersion',((record#>'{submissionInput,binding}')->'selection')->'admissionVersion') AND (jsonb_typeof((((record#>'{submissionInput,binding}')->'selection')->'manifestRef'))='string' AND char_length((((record#>'{submissionInput,binding}')->'selection')->'manifestRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{submissionInput,binding}')->'selection')->'manifestRef')#>>'{}')<=2048 AND ((((record#>'{submissionInput,binding}')->'selection')->'manifestRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (jsonb_typeof((((record#>'{submissionInput,binding}')->'selection')->'admissionRef'))='string' AND char_length((((record#>'{submissionInput,binding}')->'selection')->'admissionRef')#>>'{}') BETWEEN 1 AND 512 AND octet_length((((record#>'{submissionInput,binding}')->'selection')->'admissionRef')#>>'{}')<=2048 AND ((((record#>'{submissionInput,binding}')->'selection')->'admissionRef')#>>'{}') !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND jsonb_typeof(((record#>'{submissionInput,binding}')->'selection')->'manifestDigest')='string' AND (((record#>'{submissionInput,binding}')->'selection')->>'manifestDigest') ~ '^sha256:[0-9a-f]{64}$' AND jsonb_typeof(((record#>'{submissionInput,binding}')->'selection')->'admissionVersion')='number' AND (((record#>'{submissionInput,binding}')->'selection')->>'admissionVersion')::numeric BETWEEN 1 AND 9007199254740991 AND mod((((record#>'{submissionInput,binding}')->'selection')->>'admissionVersion')::numeric,1)=0) AND jsonb_typeof((record#>'{submissionInput,binding}')->'profileRefs')='object' AND (record#>'{submissionInput,binding}')->'profileRefs'=jsonb_build_object('provider',(record#>'{submissionInput,binding}')#>'{profileRefs,provider}','runtime',(record#>'{submissionInput,binding}')#>'{profileRefs,runtime}','identity',(record#>'{submissionInput,binding}')#>'{profileRefs,identity}','containment',(record#>'{submissionInput,binding}')#>'{profileRefs,containment}','storage',(record#>'{submissionInput,binding}')#>'{profileRefs,storage}') AND jsonb_typeof((record#>'{submissionInput,binding}')#>'{profileRefs,provider}')='object' AND jsonb_typeof((record#>'{submissionInput,binding}')#>'{profileRefs,runtime}')='object' AND jsonb_typeof((record#>'{submissionInput,binding}')#>'{profileRefs,identity}')='object' AND jsonb_typeof((record#>'{submissionInput,binding}')#>'{profileRefs,containment}')='object' AND jsonb_typeof((record#>'{submissionInput,binding}')#>'{profileRefs,storage}')='object' AND jsonb_typeof((record#>'{submissionInput,binding}')->'admittedConfigurationDigest')='string' AND ((record#>'{submissionInput,binding}')->>'admittedConfigurationDigest') ~ '^sha256:[0-9a-f]{64}$')
 WHEN 'consume-startup' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb AND jsonb_typeof(record->'recipient')='object'
 WHEN 'withdraw' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->>'withdrawalReason' IN ('administrative','selection-withdrawn','recipient-revoked')
 ELSE false END)) ELSE false END) IS TRUE);
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations ADD CONSTRAINT gateway_startup_operations_startup_fk FOREIGN KEY(installation_id,subject_key,startup_operation_ref) REFERENCES occ.gateway_startup_operations(installation_id,subject_key,operation_ref) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_operations ADD CONSTRAINT gateway_startup_operations_predecessor_fk FOREIGN KEY(installation_id,subject_key,previous_operation_ref,before_head_version) REFERENCES occ.gateway_startup_operations(installation_id,subject_key,operation_ref,after_head_version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_heads ADD CONSTRAINT gateway_startup_heads_latest_fk FOREIGN KEY(installation_id,subject_key,latest_operation_ref,head_version) REFERENCES occ.gateway_startup_operations(installation_id,subject_key,operation_ref,after_head_version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

ALTER TABLE occ.gateway_startup_heads ADD CONSTRAINT gateway_startup_heads_startup_fk FOREIGN KEY(installation_id,subject_key,startup_operation_ref) REFERENCES occ.gateway_startup_operations(installation_id,subject_key,operation_ref) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION occ.guard_gateway_startup_operation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $gateway$
DECLARE
  h occ.gateway_startup_heads%ROWTYPE;
  p occ.gateway_startup_operations%ROWTYPE;
  a occ.gateway_startup_operations%ROWTYPE;
  expected_head jsonb;
  predecessor jsonb;
  legacy_acceptance occ.gateway_startup_operations%ROWTYPE;
  legacy_withdrawal occ.gateway_startup_operations%ROWTYPE;
  c jsonb := NEW.canonical_command::jsonb;
BEGIN
  SELECT * INTO h FROM occ.gateway_startup_heads
    WHERE installation_id=NEW.installation_id AND subject_key=NEW.subject_key FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Gateway startup head missing' USING ERRCODE='23514';
  END IF;
  IF NEW.subject_version IS DISTINCT FROM h.subject_version
     OR NEW.namespace_ref IS DISTINCT FROM h.namespace_ref
     OR NEW.agent_ref IS DISTINCT FROM h.agent_ref
     OR NEW.before_head_version IS DISTINCT FROM h.head_version
     OR NEW.previous_operation_ref IS DISTINCT FROM h.latest_operation_ref
     OR NEW.after_head_version IS DISTINCT FROM h.head_version+1
  THEN
    RAISE EXCEPTION 'Gateway startup predecessor mismatch' USING ERRCODE='23514';
  END IF;

  IF h.state='empty' THEN
    expected_head := 'null'::jsonb;
  ELSE
    SELECT * INTO p FROM occ.gateway_startup_operations
      WHERE installation_id=h.installation_id AND subject_key=h.subject_key
        AND operation_ref=h.latest_operation_ref;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Gateway startup predecessor missing' USING ERRCODE='23514';
    END IF;
    expected_head := jsonb_build_object(
      'version',h.head_version,'startup',p.record->'startup',
      'recordVersion',h.record_version);
  END IF;
  IF c->'expectedHead' IS DISTINCT FROM expected_head THEN
    RAISE EXCEPTION 'Gateway startup expectation mismatch' USING ERRCODE='23514';
  END IF;

  IF NEW.kind='accept-startup' THEN
    IF h.state NOT IN ('empty','withdrawn')
       OR NEW.process_generation IS DISTINCT FROM h.process_generation+1
       OR NEW.before_record_version<>0 OR NEW.after_record_version<>1
       OR NEW.startup_operation_ref IS DISTINCT FROM NEW.operation_ref
       OR NEW.startup_operation_digest IS DISTINCT FROM NEW.operation_digest
    THEN
      RAISE EXCEPTION 'Gateway startup allocation mismatch' USING ERRCODE='23514';
    END IF;
    IF NEW.subject_version=1 THEN
    IF NEW.record#>'{acceptance,predecessor,previousStartup}'
       IS DISTINCT FROM
       (CASE WHEN h.state='empty' THEN 'null'::jsonb ELSE p.record->'startup' END)
    THEN
      RAISE EXCEPTION 'Gateway startup disposition target mismatch'
        USING ERRCODE='23514';
    END IF;
    ELSE
      predecessor := NEW.record#>'{acceptance,predecessor}';
      IF h.state='empty' THEN
        CASE predecessor->>'kind'
        WHEN 'complete-initial' THEN
          IF predecessor->'previousStartup' IS DISTINCT FROM 'null'::jsonb THEN
            RAISE EXCEPTION 'Gateway startup initial disposition mismatch' USING ERRCODE='23514';
          END IF;
        WHEN 'retired-installation' THEN
          -- These immutable rows establish correspondence only. Genuine current
          -- physical retirement and closed late creation are owner participants.
          SELECT * INTO legacy_acceptance FROM occ.gateway_startup_operations
            WHERE installation_id=NEW.installation_id
              AND subject_version=1 AND subject_key='installation-v1'
              AND operation_ref=predecessor#>>'{previousStartup,operationRef}'
              AND kind='accept-startup';
          IF NOT FOUND OR legacy_acceptance.record->'startup' IS DISTINCT FROM predecessor->'previousStartup'
            OR legacy_acceptance.record#>>'{acceptance,binding,namespaceRef}' IS DISTINCT FROM NEW.namespace_ref
            OR legacy_acceptance.record#>>'{acceptance,binding,agentRef}' IS DISTINCT FROM NEW.agent_ref
          THEN
            RAISE EXCEPTION 'Gateway startup historical acceptance mismatch' USING ERRCODE='23514';
          END IF;
          SELECT * INTO legacy_withdrawal FROM occ.gateway_startup_operations
            WHERE installation_id=NEW.installation_id
              AND subject_version=1 AND subject_key='installation-v1'
              AND operation_ref=predecessor#>>'{historicalWithdrawal,operationRef}'
              AND kind='withdraw';
          IF NOT FOUND OR legacy_withdrawal.record->'command' IS DISTINCT FROM predecessor->'historicalWithdrawal'
            OR legacy_withdrawal.record->'startup' IS DISTINCT FROM legacy_acceptance.record->'startup'
            OR legacy_withdrawal.create_effect_ref IS DISTINCT FROM legacy_acceptance.create_effect_ref
          THEN
            RAISE EXCEPTION 'Gateway startup historical withdrawal mismatch' USING ERRCODE='23514';
          END IF;
        ELSE
          RAISE EXCEPTION 'Gateway startup initial predecessor kind mismatch' USING ERRCODE='23514';
        END CASE;
      ELSIF predecessor->>'kind' IS DISTINCT FROM 'retired-agent'
        OR predecessor->'previousStartup' IS DISTINCT FROM p.record->'startup'
      THEN
        RAISE EXCEPTION 'Gateway startup Agent predecessor mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSE
    IF h.state IN ('empty','withdrawn')
       OR NEW.startup_operation_ref IS DISTINCT FROM h.startup_operation_ref
       OR NEW.process_generation IS DISTINCT FROM h.process_generation
       OR NEW.before_record_version IS DISTINCT FROM h.record_version
       OR NEW.after_record_version IS DISTINCT FROM h.record_version+1
    THEN
      RAISE EXCEPTION 'Gateway startup transition mismatch' USING ERRCODE='23514';
    END IF;
    SELECT * INTO a FROM occ.gateway_startup_operations
      WHERE installation_id=NEW.installation_id AND subject_key=NEW.subject_key
        AND operation_ref=NEW.startup_operation_ref
        AND kind='accept-startup';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Gateway startup acceptance missing' USING ERRCODE='23514';
    END IF;
    IF NEW.record->'startup' IS DISTINCT FROM a.record->'startup'
       OR NEW.create_effect_ref IS DISTINCT FROM a.create_effect_ref
    THEN
      RAISE EXCEPTION 'Gateway startup identity mismatch' USING ERRCODE='23514';
    END IF;
    CASE NEW.kind
    WHEN 'submit-create' THEN
      IF h.state<>'accepted' OR h.record_version<>1
         OR NEW.record#>'{submissionInput,binding}'
           IS DISTINCT FROM a.record#>'{acceptance,binding}'
      THEN
        RAISE EXCEPTION 'Gateway startup submission mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'consume-startup' THEN
      IF h.state<>'create-submitted' OR h.record_version<>2
         OR p.kind<>'submit-create'
      THEN
        RAISE EXCEPTION 'Gateway startup consumption mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'withdraw' THEN
      IF h.state NOT IN ('accepted','create-submitted','consumed')
         OR h.record_version NOT IN (1,2,3)
      THEN
        RAISE EXCEPTION 'Gateway startup withdrawal mismatch' USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Gateway startup kind mismatch' USING ERRCODE='23514';
    END CASE;
  END IF;
  RETURN NEW;
END;
$gateway$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION occ.guard_gateway_startup_head() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $gateway$
DECLARE e occ.gateway_startup_operations%ROWTYPE; expected_state text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT (NEW.head_version=0 AND NEW.process_generation=0 AND NEW.latest_operation_ref IS NULL AND NEW.startup_operation_ref IS NULL AND NEW.record_version=0 AND NEW.state='empty') THEN
   RAISE EXCEPTION 'Gateway startup head must begin empty' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.installation_id IS DISTINCT FROM OLD.installation_id
 OR NEW.subject_version IS DISTINCT FROM OLD.subject_version
 OR NEW.subject_key IS DISTINCT FROM OLD.subject_key
 OR NEW.namespace_ref IS DISTINCT FROM OLD.namespace_ref
 OR NEW.agent_ref IS DISTINCT FROM OLD.agent_ref OR NEW.head_version IS DISTINCT FROM OLD.head_version+1 THEN
  RAISE EXCEPTION 'Gateway startup head mutation mismatch' USING ERRCODE='23514';
 END IF;
 SELECT * INTO e FROM occ.gateway_startup_operations WHERE installation_id=NEW.installation_id AND subject_key=NEW.subject_key AND operation_ref=NEW.latest_operation_ref;
 IF NOT FOUND THEN RAISE EXCEPTION 'Gateway startup event missing' USING ERRCODE='23514'; END IF;
 expected_state:=CASE e.kind WHEN 'accept-startup' THEN 'accepted' WHEN 'submit-create' THEN 'create-submitted' WHEN 'consume-startup' THEN 'consumed' ELSE 'withdrawn' END;
 IF e.subject_version IS DISTINCT FROM NEW.subject_version
 OR e.namespace_ref IS DISTINCT FROM NEW.namespace_ref OR e.agent_ref IS DISTINCT FROM NEW.agent_ref
 OR e.before_head_version IS DISTINCT FROM OLD.head_version OR e.previous_operation_ref IS DISTINCT FROM OLD.latest_operation_ref
 OR NEW.head_version IS DISTINCT FROM e.after_head_version OR NEW.process_generation IS DISTINCT FROM e.process_generation
 OR NEW.record_version IS DISTINCT FROM e.after_record_version OR NEW.startup_operation_ref IS DISTINCT FROM e.startup_operation_ref OR NEW.state IS DISTINCT FROM expected_state
 OR (e.kind<>'accept-startup' AND (e.before_record_version IS DISTINCT FROM OLD.record_version OR NEW.startup_operation_ref IS DISTINCT FROM OLD.startup_operation_ref OR NEW.process_generation IS DISTINCT FROM OLD.process_generation)) THEN
  RAISE EXCEPTION 'Gateway startup head/event mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$gateway$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION occ.check_gateway_startup_final_state() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $gateway$
DECLARE h occ.gateway_startup_heads%ROWTYPE; e occ.gateway_startup_operations%ROWTYPE; generation bigint; expected_state text;
BEGIN
 SELECT * INTO h FROM occ.gateway_startup_heads WHERE installation_id=NEW.installation_id AND subject_key=NEW.subject_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'Gateway startup head missing' USING ERRCODE='23514'; END IF;
 SELECT * INTO e FROM occ.gateway_startup_operations WHERE installation_id=NEW.installation_id AND subject_key=NEW.subject_key ORDER BY after_head_version DESC LIMIT 1;
 IF NOT FOUND THEN
  IF h.state<>'empty' OR h.head_version<>0 OR h.process_generation<>0 OR h.record_version<>0 OR h.latest_operation_ref IS NOT NULL OR h.startup_operation_ref IS NOT NULL THEN RAISE EXCEPTION 'Gateway startup empty history mismatch' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 expected_state:=CASE e.kind WHEN 'accept-startup' THEN 'accepted' WHEN 'submit-create' THEN 'create-submitted' WHEN 'consume-startup' THEN 'consumed' ELSE 'withdrawn' END;
 SELECT process_generation INTO generation FROM occ.gateway_startup_operations WHERE installation_id=NEW.installation_id AND subject_key=NEW.subject_key AND kind='accept-startup' ORDER BY process_generation DESC LIMIT 1;
 IF h.subject_version IS DISTINCT FROM e.subject_version
 OR h.namespace_ref IS DISTINCT FROM e.namespace_ref OR h.agent_ref IS DISTINCT FROM e.agent_ref
 OR h.head_version IS DISTINCT FROM e.after_head_version OR h.latest_operation_ref IS DISTINCT FROM e.operation_ref
 OR h.record_version IS DISTINCT FROM e.after_record_version OR h.startup_operation_ref IS DISTINCT FROM e.startup_operation_ref
 OR h.process_generation IS DISTINCT FROM e.process_generation OR h.process_generation IS DISTINCT FROM generation OR h.state IS DISTINCT FROM expected_state THEN
  RAISE EXCEPTION 'Gateway startup final history mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$gateway$;
--> statement-breakpoint

-- Original rewrite/delete/truncate and deferred final-state triggers remain.
-- CREATE OR REPLACE preserves function ownership and grants; explicitly retain
-- the original public revocations and application-role mutation boundaries.
REVOKE ALL ON FUNCTION occ.guard_gateway_startup_operation() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.guard_gateway_startup_head() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.check_gateway_startup_final_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION occ.reject_gateway_startup_rewrite() FROM PUBLIC;
REVOKE ALL ON occ.gateway_startup_operations,occ.gateway_startup_heads FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON occ.gateway_startup_operations FROM occ_app;
REVOKE DELETE,TRUNCATE ON occ.gateway_startup_heads FROM occ_app;
GRANT SELECT,INSERT ON occ.gateway_startup_operations TO occ_app;
GRANT SELECT,INSERT,UPDATE ON occ.gateway_startup_heads TO occ_app;
COMMIT;

