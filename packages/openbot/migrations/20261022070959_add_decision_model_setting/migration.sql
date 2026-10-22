-- The organization settings have a new field, decisionModel. Stored documents
-- do not have it yet, so this migration adds it as null. Null means that the
-- organization has no decision model.
UPDATE "openbot_settings"
SET "document" = (("document"::jsonb) || '{"decisionModel": null}'::jsonb)::text
WHERE "scope_kind" = 'organization'
	-- A missing key gives SQL NULL. A key with a JSON null gives the JSON value null.
	AND ("document"::jsonb) -> 'decisionModel' IS NULL;
