CREATE TABLE "openbot_agent_memories" (
	"organization_id" text,
	"home_agent" text,
	"id" text,
	"layer" text NOT NULL,
	"content" text NOT NULL,
	"sources" text NOT NULL,
	"confidence" double precision,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"invalidated_at" bigint,
	CONSTRAINT "openbot_agent_memories_pkey" PRIMARY KEY("organization_id","home_agent","id")
);
--> statement-breakpoint
CREATE TABLE "openbot_agent_memory_tags" (
	"organization_id" text,
	"home_agent" text,
	"memory_id" text,
	"tag" text,
	CONSTRAINT "openbot_agent_memory_tags_pkey" PRIMARY KEY("organization_id","home_agent","memory_id","tag")
);
--> statement-breakpoint
CREATE INDEX "openbot_agent_memories_updated" ON "openbot_agent_memories" ("organization_id","home_agent","updated_at");--> statement-breakpoint
CREATE INDEX "openbot_agent_memory_tags_tag" ON "openbot_agent_memory_tags" ("organization_id","home_agent","tag");--> statement-breakpoint
ALTER TABLE "openbot_agent_memory_tags" ADD CONSTRAINT "openbot_agent_memory_tags_YrFI5OUT2NzX_fkey" FOREIGN KEY ("organization_id","home_agent","memory_id") REFERENCES "openbot_agent_memories"("organization_id","home_agent","id") ON DELETE CASCADE;