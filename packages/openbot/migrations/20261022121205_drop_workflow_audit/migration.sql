-- Workflows are gone, and so are their audit actions. The audit log cannot read
-- entries with an action that it does not know, so this migration removes them.
DELETE FROM "openbot_audit_logs" WHERE "action" LIKE 'workflow.%';
