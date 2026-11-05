ALTER TABLE "openbot_model_prices" ADD COLUMN "schedule" text;--> statement-breakpoint
-- Each old price becomes one tier for all input sizes, at all times.
UPDATE "openbot_model_prices" SET "schedule" = json_build_object(
	'timeZone', 'UTC',
	'tiers', json_build_array(json_build_object(
		'upToInputTokens', NULL,
		'inputUncached', "input_uncached",
		'inputCacheRead', "input_cache_read",
		'inputCacheWrite', "input_cache_write",
		'output', "output",
		'outputReasoning', "output_reasoning"
	)),
	'periods', json_build_array()
)::text;
