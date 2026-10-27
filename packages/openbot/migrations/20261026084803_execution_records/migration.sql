CREATE TABLE "openbot_cluster_locks" (
	"shard_id" varchar(50) PRIMARY KEY,
	"address" varchar(255) NOT NULL,
	"acquired_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_cluster_messages" (
	"id" bigint PRIMARY KEY,
	"rowid" bigserial,
	"message_id" varchar(255),
	"shard_id" varchar(50) NOT NULL,
	"entity_type" varchar(150) NOT NULL,
	"entity_id" varchar(255) NOT NULL,
	"kind" integer NOT NULL,
	"tag" varchar(50),
	"payload" text,
	"headers" text,
	"trace_id" varchar(32),
	"span_id" varchar(16),
	"sampled" boolean,
	"processed" boolean DEFAULT false NOT NULL,
	"request_id" bigint NOT NULL,
	"reply_id" bigint,
	"last_reply_id" bigint,
	"last_read" timestamp,
	"deliver_at" bigint
);
--> statement-breakpoint
CREATE TABLE "openbot_cluster_replies" (
	"id" bigint PRIMARY KEY,
	"rowid" bigserial,
	"kind" integer,
	"request_id" bigint NOT NULL,
	"payload" text NOT NULL,
	"sequence" integer,
	"acked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_cluster_runners" (
	"machine_id" serial PRIMARY KEY,
	"address" varchar(255) NOT NULL,
	"runner" text NOT NULL,
	"healthy" boolean DEFAULT true NOT NULL,
	"last_heartbeat" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openbot_execution_calls" (
	"namespace" text,
	"id" text,
	"execution_id" text NOT NULL,
	"step" text NOT NULL,
	"attempt" integer NOT NULL,
	"generation" integer NOT NULL,
	"retry" text NOT NULL,
	"status" text NOT NULL,
	"input" text NOT NULL,
	"result" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_execution_calls_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_execution_commands" (
	"namespace" text,
	"id" text,
	"execution_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"body" text NOT NULL,
	"kind" text NOT NULL,
	"sequence" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "openbot_execution_commands_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_execution_events" (
	"namespace" text,
	"execution_id" text,
	"sequence" bigint,
	"body" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "openbot_execution_events_pkey" PRIMARY KEY("namespace","execution_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "openbot_execution_outbox" (
	"namespace" text,
	"command_id" text,
	"execution_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"sent_at" bigint,
	CONSTRAINT "openbot_execution_outbox_pkey" PRIMARY KEY("namespace","command_id")
);
--> statement-breakpoint
CREATE TABLE "openbot_executions" (
	"namespace" text,
	"id" text,
	"workflow" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"identity" text NOT NULL,
	"input" text NOT NULL,
	"status" text NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"failure" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "openbot_executions_pkey" PRIMARY KEY("namespace","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_cluster_messages_message_id" ON "openbot_cluster_messages" ("message_id");--> statement-breakpoint
CREATE INDEX "openbot_cluster_messages_shard" ON "openbot_cluster_messages" ("shard_id","processed","last_read","deliver_at");--> statement-breakpoint
CREATE INDEX "openbot_cluster_messages_request" ON "openbot_cluster_messages" ("request_id");--> statement-breakpoint
CREATE INDEX "openbot_cluster_messages_rowid" ON "openbot_cluster_messages" ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_cluster_replies_exit" ON "openbot_cluster_replies" ("request_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_cluster_replies_sequence" ON "openbot_cluster_replies" ("request_id","sequence");--> statement-breakpoint
CREATE INDEX "openbot_cluster_replies_request" ON "openbot_cluster_replies" ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_cluster_runners_address" ON "openbot_cluster_runners" ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_execution_calls_step" ON "openbot_execution_calls" ("namespace","execution_id","step","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "openbot_execution_commands_key" ON "openbot_execution_commands" ("namespace","organization_id","user_id","key");--> statement-breakpoint
CREATE INDEX "openbot_execution_outbox_pending" ON "openbot_execution_outbox" ("created_at") WHERE "sent_at" is null;--> statement-breakpoint
CREATE INDEX "openbot_executions_resource" ON "openbot_executions" ("namespace","resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "openbot_executions_owner" ON "openbot_executions" ("namespace","organization_id","user_id");--> statement-breakpoint
ALTER TABLE "openbot_execution_calls" ADD CONSTRAINT "openbot_execution_calls_kTWBULaJWnS5_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_executions"("namespace","id");--> statement-breakpoint
ALTER TABLE "openbot_execution_commands" ADD CONSTRAINT "openbot_execution_commands_liqCy9DGkrfm_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_executions"("namespace","id");--> statement-breakpoint
ALTER TABLE "openbot_execution_events" ADD CONSTRAINT "openbot_execution_events_pbjxY3DHquvB_fkey" FOREIGN KEY ("namespace","execution_id") REFERENCES "openbot_executions"("namespace","id");--> statement-breakpoint
ALTER TABLE "openbot_execution_outbox" ADD CONSTRAINT "openbot_execution_outbox_GWA2ehVylThG_fkey" FOREIGN KEY ("namespace","command_id") REFERENCES "openbot_execution_commands"("namespace","id");