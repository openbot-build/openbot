CREATE TABLE "openbot_budgets" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"period" text NOT NULL,
	"limit_micros" bigint NOT NULL,
	"mode" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_credit_grants" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"amount_micros" bigint NOT NULL,
	"note" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_model_prices" (
	"id" text PRIMARY KEY,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"effective_from" bigint NOT NULL,
	"input_uncached" bigint NOT NULL,
	"input_cache_read" bigint NOT NULL,
	"input_cache_write" bigint NOT NULL,
	"output" bigint NOT NULL,
	"output_reasoning" bigint,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_organization_credits" (
	"organization_id" text PRIMARY KEY,
	"enabled" boolean NOT NULL,
	"balance_micros" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_rate_windows" (
	"key" text,
	"window_start" bigint,
	"count" integer NOT NULL,
	CONSTRAINT "openbot_rate_windows_pkey" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "openbot_usage_events" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"source" text NOT NULL,
	"session_id" text,
	"turn_id" text,
	"agent_id" text,
	"user_id" text,
	"token_id" text,
	"provider_id" text NOT NULL,
	"provider_owner" text NOT NULL,
	"model_id" text NOT NULL,
	"input_uncached" bigint NOT NULL,
	"input_cache_read" bigint NOT NULL,
	"input_cache_write" bigint NOT NULL,
	"output_text" bigint NOT NULL,
	"output_reasoning" bigint NOT NULL,
	"price_id" text,
	"cost_micros" bigint NOT NULL,
	"charged" boolean NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_budgets_scope" ON "openbot_budgets" ("organization_id","scope_kind","scope_id","period");--> statement-breakpoint
CREATE INDEX "openbot_credit_grants_list" ON "openbot_credit_grants" ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "openbot_model_prices_current" ON "openbot_model_prices" ("provider_id","model_id","effective_from");--> statement-breakpoint
CREATE INDEX "openbot_rate_windows_start" ON "openbot_rate_windows" ("window_start");--> statement-breakpoint
CREATE INDEX "openbot_usage_events_time" ON "openbot_usage_events" ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "openbot_usage_events_user" ON "openbot_usage_events" ("organization_id","user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "openbot_usage_events_agent" ON "openbot_usage_events" ("organization_id","agent_id","occurred_at");--> statement-breakpoint
CREATE INDEX "openbot_usage_events_token" ON "openbot_usage_events" ("organization_id","token_id","occurred_at");--> statement-breakpoint
ALTER TABLE "openbot_budgets" ADD CONSTRAINT "openbot_budgets_organization_id_openbot_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_credit_grants" ADD CONSTRAINT "openbot_credit_grants_8iZ7iXUXRB6q_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_model_prices" ADD CONSTRAINT "openbot_model_prices_iPxIo8Z8Rbpd_fkey" FOREIGN KEY ("provider_id") REFERENCES "openbot_model_providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_organization_credits" ADD CONSTRAINT "openbot_organization_credits_qEhMl9VVuuDt_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;