-- The execution mode `default` is now called `build`. The Session keeps its mode in
-- its settings, and each Turn keeps a copy. Both live in the JSON body of the Session.
-- A body that went through jsonb has a space after each colon, so the pattern allows one.
UPDATE "openbot_session_references"
SET "body" = regexp_replace("body", '"mode":\s*"default"', '"mode":"build"', 'g')
WHERE "body" ~ '"mode":\s*"default"';
--> statement-breakpoint
-- The organization settings have a new field, planApproval. Stored documents do not
-- have it yet, so this migration adds the default: the decider above the Agent answers,
-- and after one day without an answer the plan stays a plan.
UPDATE "openbot_settings"
SET "document" = (
	("document"::jsonb)
	|| '{"planApproval": {"approver": "chain", "timeoutMs": 86400000, "onTimeout": "stay"}}'::jsonb
)::text
WHERE "scope_kind" = 'organization'
	AND ("document"::jsonb) -> 'planApproval' IS NULL;
