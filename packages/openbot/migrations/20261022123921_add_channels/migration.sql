CREATE TABLE "openbot_channel_conversations" (
	"organization_id" text NOT NULL,
	"channel_id" text,
	"conversation_key" text,
	"kind" text NOT NULL,
	"title" text,
	"session" text NOT NULL,
	"owner" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "openbot_channel_conversations_pkey" PRIMARY KEY("channel_id","conversation_key")
);
--> statement-breakpoint
CREATE TABLE "openbot_channel_deliveries" (
	"id" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"session" text,
	"turn" text,
	"request" text,
	"body" text NOT NULL,
	"ref" text,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" bigint NOT NULL,
	"claim" text,
	"lease_until" bigint DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_channel_identities" (
	"organization_id" text NOT NULL,
	"channel_id" text,
	"external_user_id" text,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "openbot_channel_identities_pkey" PRIMARY KEY("channel_id","external_user_id")
);
--> statement-breakpoint
CREATE TABLE "openbot_channel_inbox" (
	"organization_id" text NOT NULL,
	"channel_id" text,
	"event_id" text,
	"conversation_key" text NOT NULL,
	"event" text NOT NULL,
	"received_at" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" bigint NOT NULL,
	"claim" text,
	"lease_until" bigint DEFAULT 0 NOT NULL,
	"done_at" bigint,
	CONSTRAINT "openbot_channel_inbox_pkey" PRIMARY KEY("channel_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "openbot_channel_links" (
	"code_hash" text PRIMARY KEY,
	"organization_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "openbot_channels" (
	"organization_id" text,
	"id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"agent" text NOT NULL,
	"actor" text NOT NULL,
	"enabled" boolean NOT NULL,
	"link_path" text,
	"credentials" text NOT NULL,
	"hints" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_channels_pkey" PRIMARY KEY("organization_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_channel_conversations_session" ON "openbot_channel_conversations" ("session");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_channel_deliveries_turn" ON "openbot_channel_deliveries" ("session","turn");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_channel_deliveries_request" ON "openbot_channel_deliveries" ("channel_id","request");--> statement-breakpoint
CREATE INDEX "openbot_channel_deliveries_due" ON "openbot_channel_deliveries" ("next_at") WHERE "state" = 'pending';--> statement-breakpoint
CREATE INDEX "openbot_channel_identities_user" ON "openbot_channel_identities" ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "openbot_channel_inbox_open" ON "openbot_channel_inbox" ("channel_id","conversation_key","received_at") WHERE "done_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_channels_id" ON "openbot_channels" ("id");--> statement-breakpoint
ALTER TABLE "openbot_channel_conversations" ADD CONSTRAINT "openbot_channel_conversations_qUcGuZe5tlRN_fkey" FOREIGN KEY ("organization_id","channel_id") REFERENCES "openbot_channels"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_channel_deliveries" ADD CONSTRAINT "openbot_channel_deliveries_j0PlxMGVfTqR_fkey" FOREIGN KEY ("organization_id","channel_id") REFERENCES "openbot_channels"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_channel_identities" ADD CONSTRAINT "openbot_channel_identities_user_id_openbot_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_channel_identities" ADD CONSTRAINT "openbot_channel_identities_IDJduQQCxk5t_fkey" FOREIGN KEY ("organization_id","channel_id") REFERENCES "openbot_channels"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_channel_inbox" ADD CONSTRAINT "openbot_channel_inbox_YVzYaDImkhJ3_fkey" FOREIGN KEY ("organization_id","channel_id") REFERENCES "openbot_channels"("organization_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_channel_links" ADD CONSTRAINT "openbot_channel_links_dT23BIuhQbBo_fkey" FOREIGN KEY ("organization_id","channel_id") REFERENCES "openbot_channels"("organization_id","id") ON DELETE CASCADE;