CREATE TABLE "openbot_api_keys" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL UNIQUE,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	"last_used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "openbot_app_authorizations" (
	"id" text PRIMARY KEY,
	"owner" text NOT NULL,
	"connection_id" text NOT NULL,
	"revision" integer NOT NULL,
	"expires_at" bigint NOT NULL,
	"return_to" text NOT NULL,
	"status" text NOT NULL,
	"callback" text,
	"reason" text,
	"issuer" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_app_connections" (
	"owner" text,
	"id" text,
	"name" text NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	"verification" text,
	CONSTRAINT "openbot_app_connections_pkey" PRIMARY KEY("owner","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_app_drafts" (
	"owner" text,
	"id" text,
	"body" text NOT NULL,
	CONSTRAINT "openbot_app_drafts_pkey" PRIMARY KEY("owner","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_app_index_entries" (
	"namespace" text DEFAULT 'public',
	"card_url" text,
	"body" text NOT NULL,
	CONSTRAINT "openbot_app_index_entries_pkey" PRIMARY KEY("namespace","card_url")
);
--> statement-breakpoint
CREATE TABLE "openbot_app_index_jobs" (
	"namespace" text DEFAULT 'public',
	"card_url" text,
	"next_check_at" bigint NOT NULL,
	"lease_until" bigint DEFAULT 0 NOT NULL,
	"claim" text,
	"check" text,
	"generation" text DEFAULT '' NOT NULL,
	"completed_generation" text,
	"sources" text DEFAULT '[]' NOT NULL,
	"requested_at" bigint DEFAULT 0 NOT NULL,
	"started_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "openbot_app_index_jobs_pkey" PRIMARY KEY("namespace","card_url")
);
--> statement-breakpoint
CREATE TABLE "openbot_app_index_results" (
	"namespace" text,
	"card_url" text,
	"generation" text,
	"check" text NOT NULL,
	"finished_at" bigint NOT NULL,
	CONSTRAINT "openbot_app_index_results_pkey" PRIMARY KEY("namespace","card_url","generation")
);
--> statement-breakpoint
CREATE TABLE "openbot_app_invocations" (
	"owner" text,
	"id" text,
	"session" text NOT NULL,
	"status" text NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "openbot_app_invocations_pkey" PRIMARY KEY("owner","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_app_records" (
	"owner" text,
	"card_url" text,
	"body" text NOT NULL,
	CONSTRAINT "openbot_app_records_pkey" PRIMARY KEY("owner","card_url")
);
--> statement-breakpoint
CREATE TABLE "openbot_app_secrets" (
	"owner" text,
	"kind" text,
	"id" text,
	"connection_id" text NOT NULL,
	"body" text NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "openbot_app_secrets_pkey" PRIMARY KEY("owner","kind","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_memory_contents" (
	"namespace" text,
	"id" text,
	"message" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "openbot_memory_contents_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_records" (
	"kind" text,
	"id" text,
	"owner" text NOT NULL,
	"scope" text NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "openbot_developer_records_pkey" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_session_references" (
	"namespace" text,
	"id" text,
	"body" text NOT NULL,
	"head" text NOT NULL,
	"archived" integer NOT NULL,
	"status" text NOT NULL,
	"turn" text,
	"response" text,
	"response_summary" text,
	"revision" integer NOT NULL,
	CONSTRAINT "openbot_session_references_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_memory_versions" (
	"namespace" text,
	"id" text,
	"schema_version" text NOT NULL,
	"parents" text NOT NULL,
	"snapshot_format" integer NOT NULL,
	"value" text NOT NULL,
	"history" text NOT NULL,
	CONSTRAINT "openbot_memory_versions_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_auth_account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_auth_session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_auth_user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_auth_verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "openbot_api_keys_owner" ON "openbot_api_keys" ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "openbot_app_invocations_session" ON "openbot_app_invocations" ("owner","session");--> statement-breakpoint
CREATE INDEX "openbot_developer_records_owner" ON "openbot_developer_records" ("kind","owner");--> statement-breakpoint
CREATE INDEX "openbot_developer_records_scope" ON "openbot_developer_records" ("kind","scope");--> statement-breakpoint
CREATE INDEX "openbot_session_references_list" ON "openbot_session_references" ("namespace","archived","id");--> statement-breakpoint
CREATE INDEX "openbot_auth_account_userId_idx" ON "openbot_auth_account" ("user_id");--> statement-breakpoint
CREATE INDEX "openbot_auth_session_userId_idx" ON "openbot_auth_session" ("user_id");--> statement-breakpoint
CREATE INDEX "openbot_auth_verification_identifier_idx" ON "openbot_auth_verification" ("identifier");--> statement-breakpoint
ALTER TABLE "openbot_api_keys" ADD CONSTRAINT "openbot_api_keys_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_auth_account" ADD CONSTRAINT "openbot_auth_account_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_auth_session" ADD CONSTRAINT "openbot_auth_session_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;