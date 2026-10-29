CREATE TABLE "openbot_access_events" (
	"id" text PRIMARY KEY,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"subject" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_account_states" (
	"user_id" text PRIMARY KEY,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_mapped_roles" (
	"provider_id" text,
	"organization_id" text,
	"user_id" text,
	"role" text,
	CONSTRAINT "openbot_mapped_roles_pkey" PRIMARY KEY("provider_id","organization_id","user_id","role")
);
--> statement-breakpoint
CREATE TABLE "openbot_registration_requests" (
	"id" text PRIMARY KEY,
	"provider_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_user_grants" (
	"email" text,
	"provider_id" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "openbot_user_grants_pkey" PRIMARY KEY("email","provider_id")
);
--> statement-breakpoint
ALTER TABLE "openbot_sso_connections" ADD COLUMN "access" text DEFAULT '{"trusted":false,"scopes":[],"groupsClaim":null,"requiredGroups":[],"mappings":[]}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_registration_identity" ON "openbot_registration_requests" ("provider_id","issuer","subject");--> statement-breakpoint
ALTER TABLE "openbot_account_states" ADD CONSTRAINT "openbot_account_states_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_mapped_roles" ADD CONSTRAINT "openbot_mapped_roles_Nil5hyZx7di8_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_mapped_roles" ADD CONSTRAINT "openbot_mapped_roles_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;
--> statement-breakpoint
INSERT INTO openbot_account_states (user_id, status) SELECT id, 'active' FROM openbot_auth_user ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE openbot_settings SET document = jsonb_set(jsonb_set(document::jsonb, '{organizationCreation}', '"platform_admins"'::jsonb), '{registration}', '{"selfService":"closed","emailSignIn":false,"invitations":"allow","sso":"closed","trustedSsoProviders":[],"allowedEmailDomains":[],"allowExternalInvitations":false,"provider":{"trusted":false,"scopes":[],"groupsClaim":null,"requiredGroups":[],"mappings":[]}}'::jsonb)::text WHERE scope_kind = 'platform';
