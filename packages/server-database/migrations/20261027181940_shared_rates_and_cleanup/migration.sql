CREATE TABLE "openbot_token_buckets" (
	"organization_id" text,
	"kind" text,
	"subject_id" text,
	"level" double precision NOT NULL,
	"updated_at" double precision NOT NULL,
	"tokens_per_second" double precision NOT NULL,
	"burst_tokens" double precision NOT NULL,
	CONSTRAINT "openbot_token_buckets_pkey" PRIMARY KEY("organization_id","kind","subject_id")
);
--> statement-breakpoint
ALTER TABLE "openbot_developer_tests" DROP COLUMN "cleanup_token";--> statement-breakpoint
ALTER TABLE "openbot_developer_tests" DROP COLUMN "cleanup_lease_until";