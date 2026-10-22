-- Models were a JSON list in each provider. This migration copies them to their own table.
-- Each owner gets one model for each model ID. When two providers of one owner list the same
-- ID, the oldest provider gives the values of the model, and the links of the other providers
-- keep their own values as overrides. The model ID stays the same, so stored model selections
-- still work.
INSERT INTO "openbot_models" (
	"owner_kind", "owner_id", "id", "name", "reasoning_efforts", "service_tiers",
	"context_window", "max_output_tokens", "availability", "version", "created_at", "updated_at"
)
WITH "old" AS (
	SELECT
		p."id" AS "provider_id",
		p."owner_kind",
		p."owner_id",
		p."created_at",
		entry."value" AS "entry",
		entry."ordinality" AS "position"
	FROM "openbot_model_providers" p
	CROSS JOIN LATERAL jsonb_array_elements(p."models"::jsonb) WITH ORDINALITY AS entry("value", "ordinality")
)
SELECT DISTINCT ON (o."owner_kind", o."owner_id", o."entry"->>'id')
	o."owner_kind",
	o."owner_id",
	o."entry"->>'id',
	o."entry"->>'name',
	COALESCE(o."entry"->'reasoningEfforts', '[]'::jsonb)::text,
	COALESCE(o."entry"->'serviceTiers', '[]'::jsonb)::text,
	(o."entry"->>'contextWindow')::integer,
	(o."entry"->>'maxOutputTokens')::integer,
	-- The provider already decides which organizations can use it.
	CASE WHEN o."owner_kind" = 'platform' THEN '{"_tag":"All"}' END,
	1,
	o."created_at",
	o."created_at"
FROM "old" o
ORDER BY o."owner_kind", o."owner_id", o."entry"->>'id', o."created_at", o."provider_id", o."position";
--> statement-breakpoint
INSERT INTO "openbot_provider_models" (
	"provider_id", "model_owner_kind", "model_owner_id", "model_id", "position",
	"upstream", "reasoning_efforts", "service_tiers", "context_window", "max_output_tokens"
)
WITH "old" AS (
	SELECT
		p."id" AS "provider_id",
		p."owner_kind",
		p."owner_id",
		p."created_at",
		entry."value" AS "entry",
		entry."ordinality" AS "position"
	FROM "openbot_model_providers" p
	CROSS JOIN LATERAL jsonb_array_elements(p."models"::jsonb) WITH ORDINALITY AS entry("value", "ordinality")
)
SELECT DISTINCT ON (o."provider_id", o."entry"->>'id')
	o."provider_id",
	m."owner_kind",
	m."owner_id",
	m."id",
	o."position" - 1,
	NULL,
	CASE WHEN COALESCE(o."entry"->'reasoningEfforts', '[]'::jsonb) IS DISTINCT FROM m."reasoning_efforts"::jsonb
		THEN COALESCE(o."entry"->'reasoningEfforts', '[]'::jsonb)::text END,
	CASE WHEN COALESCE(o."entry"->'serviceTiers', '[]'::jsonb) IS DISTINCT FROM m."service_tiers"::jsonb
		THEN COALESCE(o."entry"->'serviceTiers', '[]'::jsonb)::text END,
	CASE WHEN (o."entry"->>'contextWindow')::integer IS DISTINCT FROM m."context_window"
		THEN (o."entry"->>'contextWindow')::integer END,
	CASE WHEN (o."entry"->>'maxOutputTokens')::integer IS DISTINCT FROM m."max_output_tokens"
		THEN (o."entry"->>'maxOutputTokens')::integer END
FROM "old" o
JOIN "openbot_models" m
	ON m."owner_kind" = o."owner_kind" AND m."owner_id" = o."owner_id" AND m."id" = o."entry"->>'id'
ORDER BY o."provider_id", o."entry"->>'id', o."position";
