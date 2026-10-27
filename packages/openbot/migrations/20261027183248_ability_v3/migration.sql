-- Ability 3 reads policies as JSON text. Policy columns already hold that
-- text. The platform document keeps its ceiling as a string from now on.
UPDATE openbot_settings
SET document = jsonb_set(
	document::jsonb,
	'{ceiling}',
	to_jsonb((document::jsonb -> 'ceiling')::text)
)::text
WHERE scope_kind = 'platform'
	AND jsonb_typeof(document::jsonb -> 'ceiling') = 'object';
