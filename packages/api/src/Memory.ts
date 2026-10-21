import { Item } from "@openbot-build/core"
import { Schema } from "effect"

/** The learned memory of one Session. It follows the Timeline of the Session. */
export const Kind = Schema.Literals([
	"fact",
	"decision",
	"preference",
	"procedure",
	"hypothesis",
])
export type Kind = typeof Kind.Type
/** A `retracted` entry is kept, so later runs do not learn it again. */
export const EntryStatus = Schema.Literals(["active", "retracted"])
export type EntryStatus = typeof EntryStatus.Type
export const Entry = Schema.Struct({
	key: Schema.NonEmptyString,
	content: Schema.NonEmptyString,
	kind: Kind,
	sources: Schema.Array(Item.Id),
	updatedAt: Schema.Finite,
	status: EntryStatus,
})
export type Entry = typeof Entry.Type
export const State = Schema.Struct({
	entries: Schema.Record(Schema.String, Entry),
	processed: Schema.Array(Item.Id),
})
export type State = typeof State.Type

/** A direct edit of one entry. */
export const Edit = Schema.TaggedUnion({
	Remember: {
		key: Schema.NonEmptyString,
		content: Schema.NonEmptyString,
		kind: Kind,
	},
	Forget: { key: Schema.NonEmptyString },
})
export type Edit = typeof Edit.Type

/** The memory switches for one Turn. The host decides their values. */
export const Settings = Schema.Struct({
	/** Add the active entries to the model instructions. */
	use: Schema.Boolean,
	/** Learn new entries after the Turn completes. */
	generate: Schema.Boolean,
})
export type Settings = typeof Settings.Type
