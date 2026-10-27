CREATE TABLE "openbot_developer_watches" (
	"namespace" text DEFAULT 'public',
	"kind" text,
	"resource_id" text,
	"execution_id" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"next_check_at" bigint NOT NULL,
	CONSTRAINT "openbot_developer_watches_pkey" PRIMARY KEY("namespace","kind","resource_id")
);
