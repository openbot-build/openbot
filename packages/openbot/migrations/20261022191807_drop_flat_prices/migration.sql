ALTER TABLE "openbot_model_prices" DROP COLUMN "input_uncached";--> statement-breakpoint
ALTER TABLE "openbot_model_prices" DROP COLUMN "input_cache_read";--> statement-breakpoint
ALTER TABLE "openbot_model_prices" DROP COLUMN "input_cache_write";--> statement-breakpoint
ALTER TABLE "openbot_model_prices" DROP COLUMN "output";--> statement-breakpoint
ALTER TABLE "openbot_model_prices" DROP COLUMN "output_reasoning";--> statement-breakpoint
ALTER TABLE "openbot_model_prices" ALTER COLUMN "schedule" SET NOT NULL;