-- Agent memory is now one pool of tagged entries for each Agent, kept by a memory Agent.
-- The memory for each person had no tags, so OpenBot does not use it any more.
-- Each Agent starts with an empty pool.
DELETE FROM "openbot_agent_records" WHERE "kind" IN ('person_memory', 'person_memory_log');
