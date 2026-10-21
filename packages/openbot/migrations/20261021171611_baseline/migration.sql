CREATE TABLE "openbot_agent_records" (
	"kind" text,
	"organization_id" text,
	"id" text,
	"owner" text NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "openbot_agent_records_pkey" PRIMARY KEY("kind","organization_id","id")
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
CREATE TABLE "openbot_audit_logs" (
	"sequence" bigserial PRIMARY KEY,
	"organization_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actor" text NOT NULL,
	"resource" text NOT NULL,
	"details" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_timeline_contents" (
	"namespace" text,
	"id" text,
	"message" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "openbot_timeline_contents_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_apps" (
	"namespace" text DEFAULT 'public',
	"card_url" text,
	"candidate" text NOT NULL,
	"next_check_at" bigint NOT NULL,
	"lease_until" bigint DEFAULT 0 NOT NULL,
	"monitor_token" text,
	"monitor_revision" integer DEFAULT 0 NOT NULL,
	"monitor_issues" text DEFAULT '[]' NOT NULL,
	CONSTRAINT "openbot_developer_apps_pkey" PRIMARY KEY("namespace","card_url")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_claims" (
	"namespace" text DEFAULT 'public',
	"id" text,
	"owner" text NOT NULL,
	"scope_key" text NOT NULL,
	"scope" text NOT NULL,
	"token" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "openbot_developer_claims_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_index_requests" (
	"namespace" text DEFAULT 'public',
	"id" text,
	"owner" text NOT NULL,
	"card_url" text NOT NULL,
	"generation" text NOT NULL,
	"accepted_at" bigint NOT NULL,
	CONSTRAINT "openbot_developer_index_requests_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_invitations" (
	"namespace" text DEFAULT 'public',
	"id" text,
	"proof_id" text NOT NULL,
	"owner" text NOT NULL,
	"role" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"status" text NOT NULL,
	"accepted_by" text,
	CONSTRAINT "openbot_developer_invitations_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_members" (
	"namespace" text DEFAULT 'public',
	"id" text,
	"proof_id" text NOT NULL,
	"owner" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "openbot_developer_members_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_notices" (
	"namespace" text DEFAULT 'public',
	"id" text,
	"owner" text NOT NULL,
	"card_url" text,
	"kind" text NOT NULL,
	"issue" text,
	"reason" text,
	"report_id" text,
	"created_at" bigint NOT NULL,
	"read_at" bigint,
	CONSTRAINT "openbot_developer_notices_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_proofs" (
	"namespace" text DEFAULT 'public',
	"id" text,
	"owner" text NOT NULL,
	"scope_key" text NOT NULL,
	"scope" text NOT NULL,
	"token" text NOT NULL,
	"transition" integer NOT NULL,
	"status" text NOT NULL,
	"confirmed_at" bigint,
	"valid_until" bigint NOT NULL,
	"next_verification_at" bigint NOT NULL,
	"reason" text,
	CONSTRAINT "openbot_developer_proofs_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_reports" (
	"namespace" text DEFAULT 'public',
	"id" text,
	"owner" text,
	"card_url" text NOT NULL,
	"checked_at" bigint NOT NULL,
	"report" text NOT NULL,
	CONSTRAINT "openbot_developer_reports_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_subscriptions" (
	"namespace" text DEFAULT 'public',
	"owner" text,
	"card_url" text,
	"enabled" boolean NOT NULL,
	CONSTRAINT "openbot_developer_subscriptions_pkey" PRIMARY KEY("namespace","owner","card_url")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_test_flows" (
	"namespace" text DEFAULT 'public',
	"flow_id" text,
	"test_id" text NOT NULL,
	"owner" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"value" text NOT NULL,
	"body" text,
	"callback" text,
	"consumed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "openbot_developer_test_flows_pkey" PRIMARY KEY("namespace","flow_id")
);
--> statement-breakpoint
CREATE TABLE "openbot_developer_tests" (
	"namespace" text DEFAULT 'public',
	"id" text,
	"owner" text NOT NULL,
	"card_url" text NOT NULL,
	"status" text NOT NULL,
	"cleanup" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"value" text NOT NULL,
	"resource_metadata_url" text,
	"cleanup_token" text,
	"cleanup_lease_until" bigint DEFAULT 0 NOT NULL,
	"private_state" text,
	CONSTRAINT "openbot_developer_tests_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_members" (
	"organization_id" text,
	"user_id" text,
	"email" text,
	"name" text,
	"status" text NOT NULL,
	"roles" text NOT NULL,
	"policies" text NOT NULL,
	"joined_at" bigint NOT NULL,
	CONSTRAINT "openbot_members_pkey" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "openbot_model_providers" (
	"id" text PRIMARY KEY,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"endpoint" text,
	"api_key" text NOT NULL,
	"api_key_hint" text,
	"models" text NOT NULL,
	"availability" text,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_organization_domains" (
	"organization_id" text,
	"domain" text,
	"token" text NOT NULL,
	"verified_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "openbot_organization_domains_pkey" PRIMARY KEY("organization_id","domain")
);
--> statement-breakpoint
CREATE TABLE "openbot_organizations" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_platform_admins" (
	"email" text PRIMARY KEY,
	"user_id" text UNIQUE,
	"added_at" bigint NOT NULL
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
CREATE TABLE "openbot_roles" (
	"organization_id" text,
	"id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"policies" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_roles_pkey" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_settings" (
	"scope_kind" text,
	"scope_id" text,
	"document" text NOT NULL,
	"version" integer NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_settings_pkey" PRIMARY KEY("scope_kind","scope_id")
);
--> statement-breakpoint
CREATE TABLE "openbot_sso_connections" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"client_secret_hint" text,
	"domains" text NOT NULL,
	"enforce" boolean NOT NULL,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_tokens" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL UNIQUE,
	"policies" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	"last_used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "openbot_timeline_versions" (
	"namespace" text,
	"id" text,
	"schema_version" text NOT NULL,
	"parents" text NOT NULL,
	"snapshot_format" integer NOT NULL,
	"value" text NOT NULL,
	"history" text NOT NULL,
	CONSTRAINT "openbot_timeline_versions_pkey" PRIMARY KEY("namespace","id")
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
CREATE INDEX "openbot_agent_records_owner" ON "openbot_agent_records" ("kind","organization_id","owner");--> statement-breakpoint
CREATE INDEX "openbot_agent_records_scope" ON "openbot_agent_records" ("kind","organization_id","scope");--> statement-breakpoint
CREATE INDEX "openbot_agent_records_status" ON "openbot_agent_records" ("kind","status");--> statement-breakpoint
CREATE INDEX "openbot_app_invocations_session" ON "openbot_app_invocations" ("owner","session");--> statement-breakpoint
CREATE INDEX "openbot_audit_logs_list" ON "openbot_audit_logs" ("organization_id","sequence");--> statement-breakpoint
CREATE INDEX "openbot_audit_logs_actor" ON "openbot_audit_logs" ("organization_id","actor_user_id","sequence");--> statement-breakpoint
CREATE INDEX "openbot_developer_apps_due" ON "openbot_developer_apps" ("namespace","next_check_at","lease_until");--> statement-breakpoint
CREATE INDEX "openbot_developer_claims_owner" ON "openbot_developer_claims" ("namespace","owner");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_developer_index_requests_generation" ON "openbot_developer_index_requests" ("namespace","owner","card_url","generation");--> statement-breakpoint
CREATE INDEX "openbot_developer_invitations_proof" ON "openbot_developer_invitations" ("namespace","proof_id");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_developer_members_proof_owner" ON "openbot_developer_members" ("namespace","proof_id","owner");--> statement-breakpoint
CREATE INDEX "openbot_developer_members_owner" ON "openbot_developer_members" ("namespace","owner");--> statement-breakpoint
CREATE INDEX "openbot_developer_notices_owner" ON "openbot_developer_notices" ("namespace","owner","created_at","id");--> statement-breakpoint
CREATE INDEX "openbot_developer_proofs_owner" ON "openbot_developer_proofs" ("namespace","owner");--> statement-breakpoint
CREATE INDEX "openbot_developer_proofs_due" ON "openbot_developer_proofs" ("namespace","status","next_verification_at");--> statement-breakpoint
CREATE INDEX "openbot_developer_reports_owner" ON "openbot_developer_reports" ("namespace","owner","checked_at","id");--> statement-breakpoint
CREATE INDEX "openbot_developer_reports_app" ON "openbot_developer_reports" ("namespace","card_url","checked_at","id");--> statement-breakpoint
CREATE INDEX "openbot_developer_test_flows_test" ON "openbot_developer_test_flows" ("namespace","test_id");--> statement-breakpoint
CREATE INDEX "openbot_developer_test_flows_open" ON "openbot_developer_test_flows" ("namespace","expires_at") WHERE "body" IS NOT NULL OR "callback" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "openbot_developer_tests_owner" ON "openbot_developer_tests" ("namespace","owner");--> statement-breakpoint
CREATE INDEX "openbot_developer_tests_open" ON "openbot_developer_tests" ("namespace","expires_at") WHERE "cleanup" <> 'Complete';--> statement-breakpoint
CREATE INDEX "openbot_model_providers_owner" ON "openbot_model_providers" ("owner_kind","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_organization_domains_verified" ON "openbot_organization_domains" ("domain") WHERE "verified_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "openbot_session_references_list" ON "openbot_session_references" ("namespace","archived","id");--> statement-breakpoint
CREATE INDEX "openbot_sso_connections_organization" ON "openbot_sso_connections" ("organization_id");--> statement-breakpoint
CREATE INDEX "openbot_tokens_owner" ON "openbot_tokens" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "openbot_auth_account_userId_idx" ON "openbot_auth_account" ("user_id");--> statement-breakpoint
CREATE INDEX "openbot_auth_session_userId_idx" ON "openbot_auth_session" ("user_id");--> statement-breakpoint
CREATE INDEX "openbot_auth_verification_identifier_idx" ON "openbot_auth_verification" ("identifier");--> statement-breakpoint
ALTER TABLE "openbot_developer_invitations" ADD CONSTRAINT "openbot_developer_invitations_syY7e9iPktkd_fkey" FOREIGN KEY ("namespace","proof_id") REFERENCES "openbot_developer_proofs"("namespace","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_developer_members" ADD CONSTRAINT "openbot_developer_members_xpS4GhBwzZLS_fkey" FOREIGN KEY ("namespace","proof_id") REFERENCES "openbot_developer_proofs"("namespace","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_developer_proofs" ADD CONSTRAINT "openbot_developer_proofs_PQq5YDEc675j_fkey" FOREIGN KEY ("namespace","id") REFERENCES "openbot_developer_claims"("namespace","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_developer_test_flows" ADD CONSTRAINT "openbot_developer_test_flows_fJym73jTZXuD_fkey" FOREIGN KEY ("namespace","test_id") REFERENCES "openbot_developer_tests"("namespace","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_members" ADD CONSTRAINT "openbot_members_organization_id_openbot_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_members" ADD CONSTRAINT "openbot_members_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_organization_domains" ADD CONSTRAINT "openbot_organization_domains_OR5nkEE0qNgc_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_platform_admins" ADD CONSTRAINT "openbot_platform_admins_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "openbot_roles" ADD CONSTRAINT "openbot_roles_organization_id_openbot_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_sso_connections" ADD CONSTRAINT "openbot_sso_connections_GKfeJctzB5DC_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_tokens" ADD CONSTRAINT "openbot_tokens_organization_id_openbot_organizations_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_tokens" ADD CONSTRAINT "openbot_tokens_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_auth_account" ADD CONSTRAINT "openbot_auth_account_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_auth_session" ADD CONSTRAINT "openbot_auth_session_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;