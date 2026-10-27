-- OpenBot has no Main Agent anymore. Each Main Agent becomes a normal lasting Agent,
-- and it becomes the default Agent of its member. Its Sessions, memory and Grants stay.
-- A member gets a default Agent only when they do not have one yet.
WITH "main" AS (
	SELECT DISTINCT ON ("organization_id", "owner") "organization_id", "owner", "id"
	FROM "openbot_agent_records"
	WHERE "kind" = 'agent' AND "status" = 'main'
	ORDER BY "organization_id", "owner", "id"
)
INSERT INTO "openbot_settings" ("scope_kind", "scope_id", "document", "version", "updated_at")
SELECT
	'member',
	"organization_id" || '/' || "owner",
	jsonb_build_object('planApproval', NULL, 'defaultAgent', "id")::text,
	1,
	(extract(epoch FROM now()) * 1000)::bigint
FROM "main"
ON CONFLICT ("scope_kind", "scope_id") DO UPDATE SET
	"document" = jsonb_set("openbot_settings"."document"::jsonb, '{defaultAgent}', to_jsonb(EXCLUDED."document"::jsonb ->> 'defaultAgent'))::text,
	"version" = "openbot_settings"."version" + 1,
	"updated_at" = EXCLUDED."updated_at"
WHERE "openbot_settings"."document"::jsonb ->> 'defaultAgent' IS NULL;
--> statement-breakpoint
UPDATE "openbot_agent_records"
SET
	"status" = 'persistent',
	"body" = jsonb_set("body"::jsonb, '{kind}', '"persistent"')::text
WHERE "kind" = 'agent' AND "status" = 'main';
