CREATE TABLE "openbot_member_signup_exclusions" (
	"organization_id" text,
	"user_id" text,
	"removed_at" bigint NOT NULL,
	CONSTRAINT "openbot_member_signup_exclusions_pkey" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "openbot_member_signup_exclusions_user" ON "openbot_member_signup_exclusions" ("user_id");--> statement-breakpoint
ALTER TABLE "openbot_member_signup_exclusions" ADD CONSTRAINT "openbot_member_signup_exclusions_VaiQ841vbEjc_fkey" FOREIGN KEY ("organization_id") REFERENCES "openbot_organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "openbot_member_signup_exclusions" ADD CONSTRAINT "openbot_member_signup_exclusions_7o0vmnR20VtS_fkey" FOREIGN KEY ("user_id") REFERENCES "openbot_auth_user"("id") ON DELETE CASCADE;