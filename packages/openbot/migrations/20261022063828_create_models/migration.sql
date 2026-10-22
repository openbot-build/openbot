CREATE TABLE "openbot_models" (
	"owner_kind" text,
	"owner_id" text,
	"id" text,
	"name" text NOT NULL,
	"reasoning_efforts" text NOT NULL,
	"service_tiers" text NOT NULL,
	"context_window" integer,
	"max_output_tokens" integer,
	"availability" text,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_models_pkey" PRIMARY KEY("owner_kind","owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_provider_models" (
	"provider_id" text,
	"model_owner_kind" text NOT NULL,
	"model_owner_id" text NOT NULL,
	"model_id" text,
	"position" integer NOT NULL,
	"upstream" text,
	"reasoning_efforts" text,
	"service_tiers" text,
	"context_window" integer,
	"max_output_tokens" integer,
	CONSTRAINT "openbot_provider_models_pkey" PRIMARY KEY("provider_id","model_id")
);
--> statement-breakpoint
CREATE INDEX "openbot_provider_models_model" ON "openbot_provider_models" ("model_owner_kind","model_owner_id","model_id");--> statement-breakpoint
ALTER TABLE "openbot_provider_models" ADD CONSTRAINT "openbot_provider_models_qZbknltcK36j_fkey" FOREIGN KEY ("provider_id") REFERENCES "openbot_model_providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_provider_models" ADD CONSTRAINT "openbot_provider_models_djHzaMEMR1ox_fkey" FOREIGN KEY ("model_owner_kind","model_owner_id","model_id") REFERENCES "openbot_models"("owner_kind","owner_id","id") ON DELETE RESTRICT;