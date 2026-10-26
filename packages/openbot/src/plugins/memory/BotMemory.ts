import { BotMemory as Api } from "@openbot-build/api"
import {
	Array as Arr,
	HashMap,
	HashSet,
	Option,
	pipe,
	Predicate,
	Schema,
} from "effect"
import * as Audience from "./Audience.ts"

/**
 * Bot memory is what one Bot learns over all its Chats: one pool of tagged entries,
 * kept by a memory Bot. The schemas are part of the HTTP contract, so they live in the api package.
 */
export const Layer = Api.Layer
export type Layer = Api.Layer
export const TopicTag = Api.TopicTag
export type TopicTag = Api.TopicTag
export const ItemSource = Api.ItemSource
export type ItemSource = Api.ItemSource
export const Source = Api.Source
export type Source = Api.Source
export const Entry = Api.Entry
export type Entry = Api.Entry
export const Edit = Api.Edit
export type Edit = Api.Edit
export const LogEntry = Api.LogEntry
export type LogEntry = Api.LogEntry

/** One Item that the memory Bot may learn from. */
export interface Evidence {
	readonly source: ItemSource
	readonly role: "user" | "assistant" | "tool"
	/** True for tool results from Apps. They are outside data. */
	readonly outside: boolean
	/** The tool, for a tool result. */
	readonly tool?: string
	/** The person of the Turn of the Item. */
	readonly author: string
	/** The organization of the Chat. */
	readonly organizationId: string
	/** Who saw the Item when it happened: the person, or the Channel group. */
	readonly audience: Audience.Audience
	/** The Channel of the Chat, when it has one. */
	readonly channel?: string
	readonly text: string
}

/** The tags of OpenBot for one Item. */
export const evidenceTags = (evidence: Evidence): ReadonlyArray<string> => [
	Audience.fromTag(evidence.author),
	Audience.chatTag(evidence.source.chat),
	Audience.orgTag(evidence.organizationId),
	Audience.forTag(evidence.audience),
	...(evidence.channel === undefined
		? []
		: [Audience.channelTag(evidence.channel)]),
	...(evidence.outside && evidence.tool !== undefined
		? [Audience.appTag(evidence.tool)]
		: []),
]

export const isActive = (entry: Entry) =>
	entry.status === "active" && entry.invalidatedAt === undefined
export const topicsOf = (entry: Entry) =>
	Arr.filter(entry.tags, Predicate.not(Audience.isSystem))

/** One change that the memory Bot asks for. `ref` names a new entry within one answer. */
export const Operation = Schema.TaggedUnion({
	AddFact: {
		ref: Schema.String,
		content: Schema.NonEmptyString,
		topics: Schema.Array(TopicTag),
		sources: Schema.Array(ItemSource).check(Schema.isMinLength(1)),
	},
	AddObservation: {
		ref: Schema.String,
		content: Schema.NonEmptyString,
		topics: Schema.Array(TopicTag),
		/** Entry ids, or the `ref` of a new entry in the same answer. */
		supports: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
		confidence: Schema.Finite,
	},
	Invalidate: { id: Schema.String, reason: Schema.NonEmptyString },
	Retag: {
		id: Schema.String,
		add: Schema.Array(TopicTag),
		remove: Schema.Array(TopicTag),
	},
	/** `bot`, `person:<userId>` or `channel:<channelId>`. */
	Widen: {
		id: Schema.String,
		audience: Schema.String,
		reason: Schema.NonEmptyString,
	},
	RenameTopic: { from: TopicTag, to: TopicTag },
})
export type Operation = typeof Operation.Type
export const Plan = Schema.Struct({ operations: Schema.Array(Operation) })
export type Plan = typeof Plan.Type

export interface Applied {
	/** The new and changed entries. */
	readonly entries: ReadonlyArray<Entry>
	/** Why entries were shown to more people. */
	readonly reasons: ReadonlyArray<string>
	/** How many operations broke a rule and were left out. */
	readonly rejected: number
}

/**
 * Checks and applies the operations of the memory Bot. Each one that breaks a rule is left out:
 * - A fact needs sources from the evidence, and not only results from Apps.
 * - An observation needs active entries as support. Its tags of OpenBot come from them.
 * - Only people change pinned and retracted entries.
 * - Tags of OpenBot change only with Widen, and Widen keeps a reason.
 */
export const apply = (input: {
	readonly pool: ReadonlyArray<Entry>
	readonly evidence: ReadonlyArray<Evidence>
	readonly operations: ReadonlyArray<Operation>
	readonly now: number
	readonly id: () => string
}): Applied => {
	// `HashMap` compares the sources by value.
	const known = HashMap.fromIterable(
		Arr.map(input.evidence, (entry) => [entry.source, entry] as const),
	)
	const step = (
		state: {
			readonly entries: HashMap.HashMap<string, Entry>
			readonly changed: HashSet.HashSet<string>
			readonly refs: HashMap.HashMap<string, string>
			readonly reasons: ReadonlyArray<string>
			readonly rejected: number
		},
		operation: Operation,
	): typeof state => {
		const reject = { ...state, rejected: state.rejected + 1 }
		const put = (entry: Entry, reason?: string) => ({
			...state,
			entries: HashMap.set(state.entries, entry.id, entry),
			changed: HashSet.add(state.changed, entry.id),
			reasons:
				reason === undefined ? state.reasons : [...state.reasons, reason],
		})
		const resolve = (id: string) =>
			Option.getOrElse(HashMap.get(state.refs, id), () => id)
		// The memory Bot may change only active entries that it learned itself.
		const own = (id: string) =>
			HashMap.get(state.entries, resolve(id)).pipe(
				Option.filter((entry) => isActive(entry) && entry.layer !== "pinned"),
			)
		switch (operation._tag) {
			case "AddFact": {
				const sources = Option.all(
					Arr.map(operation.sources, (source) => HashMap.get(known, source)),
				)
				if (Option.isNone(sources)) return reject
				const evidence = sources.value
				// Content from an App must not become memory by itself.
				if (Arr.every(evidence, (source) => source.outside)) return state
				const id = input.id()
				return {
					...put({
						id,
						layer: "fact",
						content: operation.content,
						tags: Arr.dedupe([
							...Audience.combine(Arr.map(evidence, evidenceTags)),
							...operation.topics,
						]),
						sources: Arr.dedupe(operation.sources),
						status: "active",
						createdAt: input.now,
						updatedAt: input.now,
					}),
					refs: HashMap.set(state.refs, operation.ref, id),
				}
			}
			case "AddObservation": {
				const supports = Option.all(
					Arr.map(operation.supports, (id) =>
						HashMap.get(state.entries, resolve(id)).pipe(
							Option.filter(isActive),
						),
					),
				)
				if (Option.isNone(supports)) return reject
				const found = supports.value
				const id = input.id()
				return {
					...put({
						id,
						layer: "observation",
						content: operation.content,
						tags: Arr.dedupe([
							...Audience.combine(Arr.map(found, (entry) => entry.tags)),
							...operation.topics,
						]),
						sources: pipe(
							found,
							Arr.map((entry) => entry.id),
							Arr.dedupe,
							Arr.map((entry) => ({ entry })),
						),
						confidence: Math.min(1, Math.max(0, operation.confidence)),
						status: "active",
						createdAt: input.now,
						updatedAt: input.now,
					}),
					refs: HashMap.set(state.refs, operation.ref, id),
				}
			}
			case "Invalidate":
				return Option.match(own(operation.id), {
					onNone: () => reject,
					onSome: (entry) =>
						put({ ...entry, invalidatedAt: input.now, updatedAt: input.now }),
				})
			case "Retag":
				return Option.match(own(operation.id), {
					onNone: () => reject,
					onSome: (entry) =>
						put({
							...entry,
							tags: Arr.dedupe([
								...Arr.difference(entry.tags, operation.remove),
								...operation.add,
							]),
							updatedAt: input.now,
						}),
				})
			case "Widen":
				return Option.match(
					Option.all([
						own(operation.id),
						Audience.parseAudience(operation.audience),
					]),
					{
						onNone: () => reject,
						onSome: ([entry, audience]) =>
							put(
								{
									...entry,
									tags: Arr.dedupe([...entry.tags, Audience.forTag(audience)]),
									updatedAt: input.now,
								},
								`${entry.id} for ${operation.audience}: ${operation.reason}`,
							),
					},
				)
			case "RenameTopic":
				return pipe(
					HashMap.values(state.entries),
					Arr.filter(
						(entry) =>
							isActive(entry) &&
							entry.layer !== "pinned" &&
							entry.tags.includes(operation.from),
					),
					Arr.reduce(state, (current, entry) => {
						const next: Entry = {
							...entry,
							tags: Arr.dedupe(
								Arr.map(entry.tags, (tag) =>
									tag === operation.from ? operation.to : tag,
								),
							),
							updatedAt: input.now,
						}
						return {
							...current,
							entries: HashMap.set(current.entries, entry.id, next),
							changed: HashSet.add(current.changed, entry.id),
						}
					}),
				)
		}
	}
	const result = Arr.reduce(
		input.operations,
		{
			entries: HashMap.fromIterable(
				Arr.map(input.pool, (entry) => [entry.id, entry] as const),
			),
			changed: HashSet.empty<string>(),
			refs: HashMap.empty<string, string>(),
			reasons: [] as ReadonlyArray<string>,
			rejected: 0,
		},
		step,
	)
	return {
		entries: Arr.flatMap(Arr.fromIterable(result.changed), (id) =>
			Option.toArray(HashMap.get(result.entries, id)),
		),
		reasons: result.reasons,
		rejected: result.rejected,
	}
}

/** Who edits memory directly with the API. */
export interface Person {
	readonly userId: string
	readonly organizationId: string
}

/**
 * Applies a direct edit by a person. It gives the changed entry, or None when the entry
 * is not one that the person may see.
 */
export const edit = (input: {
	readonly pool: ReadonlyArray<Entry>
	readonly person: Person
	readonly change: Edit
	readonly now: number
	readonly id: () => string
}): Option.Option<Entry> => {
	const { person, change, now } = input
	if (change._tag === "Remember")
		return Option.some({
			id: input.id(),
			layer: "pinned",
			content: change.content,
			tags: Arr.dedupe([
				Audience.fromTag(person.userId),
				Audience.orgTag(person.organizationId),
				Audience.forTag(Audience.person(person.userId)),
				...(change.tags ?? []),
			]),
			sources: [],
			status: "active",
			createdAt: now,
			updatedAt: now,
		})
	return Arr.findFirst(input.pool, (entry) => entry.id === change.id).pipe(
		Option.filter(
			(entry) =>
				entry.status === "active" &&
				Audience.visible(entry.tags, {
					organizationId: person.organizationId,
					person: person.userId,
				}),
		),
		Option.map((entry): Entry => {
			const others = Arr.filter(
				Audience.peopleOf(entry.tags),
				(other) => other !== person.userId,
			)
			// When others stand behind the entry too, only the part of this person goes.
			return others.length === 0
				? { ...entry, status: "retracted", updatedAt: now }
				: {
						...entry,
						tags: Arr.filter(
							entry.tags,
							(tag) =>
								tag !== Audience.fromTag(person.userId) &&
								tag !== Audience.forTag(Audience.person(person.userId)),
						),
						updatedAt: now,
					}
		}),
	)
}

/** Entries as lines for a model: `[id] (topics) content`. */
export const render = (entries: ReadonlyArray<Entry>, maxLength: number) =>
	pipe(
		entries,
		Arr.map(
			(entry) =>
				`[${entry.id}]` +
				(topicsOf(entry).length === 0
					? ""
					: ` (${Arr.join(topicsOf(entry), ", ")})`) +
				` ${entry.content}`,
		),
		Arr.reduce(
			{ lines: [], full: false },
			(
				text: { readonly lines: ReadonlyArray<string>; readonly full: boolean },
				line,
			) =>
				text.full
					? text
					: Arr.join([...text.lines, line], "\n").length <= maxLength
						? { lines: [...text.lines, line], full: false }
						: { ...text, full: true },
		),
		(text) => Arr.join(text.lines, "\n"),
	)
