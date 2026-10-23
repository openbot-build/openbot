-- Agent memory is now kept for each person. The old memory of each Agent was not kept
-- for a person, so OpenBot does not use it any more. Each Agent starts with an empty
-- memory about each person.
DELETE FROM "openbot_agent_records" WHERE "kind" IN ('memory', 'memory_log');
