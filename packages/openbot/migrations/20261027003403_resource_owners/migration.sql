CREATE TABLE "openbot_resource_owners" (
	"namespace" text,
	"kind" text,
	"id" text,
	"lease" text NOT NULL,
	"node" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	CONSTRAINT "openbot_resource_owners_pkey" PRIMARY KEY("namespace","kind","id")
);
--> statement-breakpoint
CREATE INDEX "openbot_resource_owners_node" ON "openbot_resource_owners" ("node");