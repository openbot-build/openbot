import { Effect } from "effect"
import * as Database from "../../src/database/Database.ts"
import { executionFailures } from "../../src/database/ExecutionSchema.ts"

/** The saved failure rows let tests check that one failed Turn is saved once. */
export const read = Effect.flatMap(Database.make, (database) =>
	database.select().from(executionFailures),
)
