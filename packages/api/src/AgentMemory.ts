import { Item, Session, Turn } from "@openbot-build/core"
import { Schema } from "effect"
import { EntryStatus } from "./Memory.ts"

/**
 * Agent memory is what one Agent learns over many Sessions.
 * Each Agent has one pool of entries. A memory Agent keeps the pool: it reads all of it,
 * learns new entries, and decides what goes into the work of the Agent.
 * Tags sort the entries. Some tags come from OpenBot and say where an entry comes from
 * and who may see it. Other tags name topics, and the memory Agent chooses them.
 * The memory does not follow a Timeline, so a Fork never changes it.
 */

/**
 * - `fact`: something that a Session shows, with its Items as sources.
 * - `observation`: what the memory Agent concluded from other entries.
 * - `pinned`: what a person told OpenBot to remember.
 */
export const Layer = Schema.Literals(["fact", "observation", "pinned"])
export type Layer = typeof Layer.Type

/**
 * A topic tag, like `testing` or `trip-planning`. It has no colon, because tags with a colon
 * belong to OpenBot: `from:`, `for:`, `session:`, `org:`, `channel:` and `app:`.
 */
export const TopicTag = Schema.String.check(
	Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
)
export type TopicTag = typeof TopicTag.Type

/** One Item in one Session that supports an entry. */
export const ItemSource = Schema.Struct({ session: Session.Id, item: Item.Id })
export type ItemSource = typeof ItemSource.Type
/** Another entry that supports an observation. */
export const EntrySource = Schema.Struct({ entry: Schema.String })
export type EntrySource = typeof EntrySource.Type
export const Source = Schema.Union([ItemSource, EntrySource])
export type Source = typeof Source.Type

export const Entry = Schema.Struct({
	id: Schema.String,
	layer: Layer,
	content: Schema.NonEmptyString,
	/** The tags of OpenBot and the topic tags. */
	tags: Schema.Array(Schema.String),
	sources: Schema.Array(Source),
	/** How sure the memory Agent is about an observation, from 0 to 1. */
	confidence: Schema.optionalKey(Schema.Finite),
	status: EntryStatus,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
	/** When a newer entry showed that this one is no longer true. The entry stays for history. */
	invalidatedAt: Schema.optionalKey(Schema.Finite),
})
export type Entry = typeof Entry.Type

/** The entries that the caller may see. `version` grows by one with each change of the pool. */
export const View = Schema.Struct({
	entries: Schema.Array(Entry),
	version: Schema.Natural,
})
export type View = typeof View.Type

/** A direct edit by a person. */
export const Edit = Schema.TaggedUnion({
	/** Adds a pinned entry about the caller. Only the caller sees it. */
	Remember: {
		content: Schema.NonEmptyString,
		tags: Schema.optionalKey(Schema.Array(TopicTag)),
	},
	/**
	 * Takes back what the caller gave to an entry. When the caller is the only person
	 * behind it, the entry is retracted. Otherwise the caller stops counting as one of its
	 * people, and the entry is no longer for the caller. It stays for the others.
	 */
	Forget: { id: Schema.NonEmptyString },
})
export type Edit = typeof Edit.Type

/** One change of the memory of an Agent. */
export const LogEntry = Schema.Struct({
	version: Schema.Natural,
	at: Schema.Finite,
	by: Schema.Literals(["memory_agent", "person", "promotion"]),
	ids: Schema.Array(Schema.String),
	/** Why the memory Agent made a change, when it shows more people an entry. */
	reason: Schema.optionalKey(Schema.String),
})
export type LogEntry = typeof LogEntry.Type

/**
 * The tags that a purge takes. Each one names people, Sessions, organizations or Channels,
 * so an owner can remove memory without reading it.
 */
export const PurgeTag = Schema.String.check(
	Schema.isPattern(/^(from|session|org|channel):[^\s]+$/),
)
export const PurgeRequest = Schema.Struct({ tag: PurgeTag })
export type PurgeRequest = typeof PurgeRequest.Type
export const PurgeResult = Schema.Struct({ removed: Schema.Natural })
export type PurgeResult = typeof PurgeResult.Type

/** The most money that the memory Agent may spend in one period, over all organizations. */
export const MemoryBudget = Schema.Struct({
	/** A day or a month in UTC, like the budgets of an organization. */
	period: Schema.Literals(["day", "month"]),
	/** In micro-USD. One US dollar is 1,000,000 micro-USD. */
	limitMicros: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type MemoryBudget = typeof MemoryBudget.Type

/** The settings of the memory Agent of one Agent. Without a limit, it has none. */
export const MemoryAgentSettings = Schema.Struct({
	/** Rules about privacy and sharing, in plain language. */
	instructions: Schema.String,
	/** The most tasks that the memory Agent runs at the same time on one server. */
	concurrency: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
	budget: Schema.optionalKey(MemoryBudget),
	revision: Schema.Natural,
})
export type MemoryAgentSettings = typeof MemoryAgentSettings.Type
export const UpdateMemoryAgentRequest = Schema.Struct({
	expected: Schema.Natural,
	instructions: Schema.optionalKey(
		Schema.String.check(Schema.isMaxLength(20000)),
	),
	/** `null` removes the limit. */
	concurrency: Schema.optionalKey(
		Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
	),
	/** `null` removes the limit. */
	budget: Schema.optionalKey(Schema.NullOr(MemoryBudget)),
})
export type UpdateMemoryAgentRequest = typeof UpdateMemoryAgentRequest.Type

/** What an Agent said with `confide`, and the answer that it got. */
export const Confession = Schema.Struct({
	id: Schema.String,
	session: Session.Id,
	turn: Turn.Id,
	text: Schema.String,
	reply: Schema.String,
	at: Schema.Finite,
})
export type Confession = typeof Confession.Type

/** What the memory Agent added to the input of one Turn, and the entries it used. */
export const Enrichment = Schema.Struct({
	session: Session.Id,
	turn: Turn.Id,
	/** The input as the model saw it. */
	text: Schema.String,
	/** The parts that the memory Agent added, in order. */
	inserted: Schema.Array(Schema.String),
	entries: Schema.Array(Schema.String),
	at: Schema.Finite,
})
export type Enrichment = typeof Enrichment.Type
