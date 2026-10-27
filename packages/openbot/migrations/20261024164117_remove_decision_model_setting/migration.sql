-- The organization settings no longer have decisionModel. A use of a model
-- names its own model, and some uses may take a decision model or a language
-- model. This migration takes the old key out of stored documents.
UPDATE "openbot_settings"
SET "document" = (("document"::jsonb) - 'decisionModel')::text
WHERE "scope_kind" = 'organization'
	AND ("document"::jsonb) ? 'decisionModel';
