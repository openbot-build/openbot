import { Schema } from "effect"

/** A record version guards a change against another writer. */
export const Version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
