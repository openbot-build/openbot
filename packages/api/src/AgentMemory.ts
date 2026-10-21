import { Item, Session } from "@openbot-build/core"
import { Schema } from "effect"
import { EntryStatus, Kind as SessionKind } from "./Memory.ts"

/**
 * Agent memory is what one Agent learns over many Sessions.
 * It keeps only lasting experience: how to do things, what people like, and what was decided.
 * It does not follow a Timeline, so a Fork never changes it.
 */
export const Kind = SessionKind.pick(["procedure", "preference", "decision"])
export type Kind = typeof Kind.Type
/** One Item in one Session that supports an entry. */
export const Source = Schema.Struct({ session: Session.Id, item: Item.Id })
export type Source = typeof Source.Type
export const Entry = Schema.Struct({
	key: Schema.NonEmptyString,
	content: Schema.NonEmptyString,
	kind: Kind,
	sources: Schema.Array(Source),
	updatedAt: Schema.Finite,
	status: EntryStatus,
})
export type Entry = typeof Entry.Type
/** The entries of one Agent. `version` grows by one with each change. */
export const State = Schema.Struct({
	entries: Schema.Record(Schema.String, Entry),
	version: Schema.Natural,
})
export type State = typeof State.Type

/** A direct edit by a person. */
export const Edit = Schema.TaggedUnion({
	Remember: {
		key: Schema.NonEmptyString,
		content: Schema.NonEmptyString,
		kind: Kind,
	},
	Forget: { key: Schema.NonEmptyString },
})
export type Edit = typeof Edit.Type

/** One change in the log of an Agent memory. */
export const LogEntry = Schema.Struct({
	version: Schema.Natural,
	at: Schema.Finite,
	by: Schema.Literals(["consolidation", "person", "promotion"]),
	keys: Schema.Array(Schema.String),
})
export type LogEntry = typeof LogEntry.Type
