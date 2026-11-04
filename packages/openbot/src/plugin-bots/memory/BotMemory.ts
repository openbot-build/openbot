import { BotMemory as Api } from "@openbot-build/domain"

import {
	Array as Arr,
	Equal,
	HashMap,
	HashSet,
	Chunk,
	Option,
	pipe,
	Predicate,
	Schema,
	Struct,
} from "effect"
import * as Audience from "./Audience.ts"

/**
 * Bot memory is what one Bot learns over all its Chats: one pool of tagged entries,
 * kept by a memory Bot. The domain package owns its schemas.
 */
export const Layer = Api.Layer
export type Layer = Api.Layer
export const TopicTag = Api.TopicTag
export type TopicTag = Api.TopicTag
export const ItemSource = Api.ItemSource
export type ItemSource = Api.ItemSource
export const Source = Api.Source
export type Source = Api.Source
/** A source policy is the access rule saved by the host when an Item is learned. */
export const SourcePolicy = Schema.Struct({
	source: ItemSource,
	tags: Schema.Array(Schema.String),
})
export type SourcePolicy = typeof SourcePolicy.Type
/** Source policies stay inside the host. The public Entry has no such field. */
export const Entry = Schema.Struct({
	...Api.Entry.fields,
	sourcePolicies: Schema.optionalKey(Schema.Array(SourcePolicy)),
})
export type Entry = typeof Entry.Type
/** The data needed to check an entry, without its content. */
export const Metadata = Schema.Struct(Struct.omit(Entry.fields, ["content"]))
export type Metadata = typeof Metadata.Type

/** Content is set only when a change adds an entry. */
export interface Change {
	readonly metadata: Metadata
	readonly content?: string
}
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

export const isActive = (entry: Metadata) =>
	entry.status === "active" && entry.invalidatedAt === undefined
export const topicsOf = (entry: Metadata) =>
	Arr.filter(entry.tags, Predicate.not(Audience.isSystem))

/** Keep the private source policy out of API replies. */
export const publicEntry = ({
	sourcePolicies: _,
	...entry
}: Entry): Api.Entry => entry

/** Checks every source, including the old entries already in the pool. */
const allowed = (
	metadata: ReadonlyArray<Metadata>,
	tagsAllowed: (tags: ReadonlyArray<string>) => boolean,
) => {
	const entries = HashMap.fromIterable(
		Arr.map(metadata, (entry) => [entry.id, entry] as const),
	)
	let known = HashMap.empty<string, boolean>()
	type Step = { readonly entry: Metadata; readonly done: boolean }
	return (entry: Metadata): boolean => {
		let pending: Chunk.Chunk<Step> = Chunk.make({ entry, done: false })
		let path = HashSet.empty<string>()
		while (Chunk.isNonEmpty(pending)) {
			const { entry: current, done } = Chunk.headNonEmpty(pending)
			pending = Chunk.tailNonEmpty(pending)
			if (done) {
				path = HashSet.remove(path, current.id)
				known = HashMap.set(
					known,
					current.id,
					Arr.every(
						current.sources,
						(source) =>
							"entry" in source &&
							Option.getOrElse(HashMap.get(known, source.entry), () => false),
					),
				)
				continue
			}
			if (HashMap.has(known, current.id)) continue
			if (HashSet.has(path, current.id) || !tagsAllowed(current.tags)) {
				known = HashMap.set(known, current.id, false)
				continue
			}
			if (current.layer === "pinned") {
				known = HashMap.set(known, current.id, current.sources.length === 0)
				continue
			}
			if (current.layer === "fact") {
				const policies = current.sourcePolicies
				// Old facts have no source policy. Keep them hidden until they are rebuilt.
				known = HashMap.set(
					known,
					current.id,
					current.sources.length > 0 &&
						policies !== undefined &&
						policies.length > 0 &&
						Arr.every(current.sources, (source) =>
							Arr.some(policies, (policy) =>
								Equal.equals(policy.source, source),
							),
						) &&
						Arr.every(
							policies,
							(policy) =>
								tagsAllowed(policy.tags) &&
								Arr.some(current.sources, (source) =>
									Equal.equals(source, policy.source),
								),
						),
				)
				continue
			}
			const supports = Option.all(
				Arr.map(current.sources, (source) =>
					"entry" in source
						? HashMap.get(entries, source.entry).pipe(Option.filter(isActive))
						: Option.none(),
				),
			)
			if (Option.isNone(supports) || supports.value.length === 0) {
				known = HashMap.set(known, current.id, false)
				continue
			}
			path = HashSet.add(path, current.id)
			pending = Chunk.prepend(pending, { entry: current, done: true })
			for (const support of supports.value)
				pending = Chunk.prepend(pending, { entry: support, done: false })
		}
		return Option.getOrElse(HashMap.get(known, entry.id), () => false)
	}
}

/** An entry is readable only when its own rule and every source rule allow it. */
export const visible = (
	metadata: ReadonlyArray<Metadata>,
	viewer: Audience.Viewer,
) => allowed(metadata, (tags) => Audience.visible(tags, viewer))

/** The trusted learner also leaves out entries whose sources cannot be checked. */
export const learnable = (metadata: ReadonlyArray<Metadata>) => {
	const proven = allowed(metadata, () => true)
	return Arr.filter(metadata, (entry) => isActive(entry) && proven(entry))
}

const canWiden = (
	metadata: ReadonlyArray<Metadata>,
	entry: Metadata,
	audience: Audience.Audience,
) => {
	const organizations = Audience.orgsOf(entry.tags)
	return (
		organizations.length > 0 &&
		Arr.every(organizations, (organizationId) =>
			allowed(metadata, (tags) =>
				audience._tag === "Bot"
					? Audience.orgsOf(tags).includes(organizationId) &&
						Arr.some(
							Audience.audiencesOf(tags),
							(value) => value._tag === "Bot",
						)
					: Audience.visible(
							tags,
							audience._tag === "Person"
								? { organizationId, person: audience.id }
								: { organizationId, channel: audience.id },
						),
			)(entry),
		)
	)
}

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
	readonly changes: ReadonlyArray<Change>
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
	readonly metadata: ReadonlyArray<Metadata>
	readonly evidence: ReadonlyArray<Evidence>
	readonly operations: ReadonlyArray<Operation>
	readonly now: number
	/** One new id for each operation, in the same order. An operation that adds no entry leaves its id unused. */
	readonly ids: ReadonlyArray<string>
}): Applied => {
	// `HashMap` compares the sources by value.
	const known = HashMap.fromIterable(
		Arr.map(input.evidence, (entry) => [entry.source, entry] as const),
	)
	const step = (
		state: {
			readonly entries: HashMap.HashMap<string, Metadata>
			readonly contents: HashMap.HashMap<string, string>
			readonly changed: HashSet.HashSet<string>
			readonly refs: HashMap.HashMap<string, string>
			readonly reasons: ReadonlyArray<string>
			readonly rejected: number
		},
		operation: Operation,
		id: string,
	): typeof state => {
		const reject = { ...state, rejected: state.rejected + 1 }
		const put = (entry: Metadata, reason?: string, content?: string) => ({
			...state,
			entries: HashMap.set(state.entries, entry.id, entry),
			changed: HashSet.add(state.changed, entry.id),
			contents:
				content === undefined
					? state.contents
					: HashMap.set(state.contents, entry.id, content),
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
				return {
					...put(
						{
							id,
							layer: "fact",
							tags: Arr.dedupe([
								...Audience.combine(Arr.map(evidence, evidenceTags)),
								...operation.topics,
							]),
							sources: Arr.dedupe(operation.sources),
							sourcePolicies: Arr.map(evidence, (entry) => ({
								source: entry.source,
								tags: evidenceTags(entry),
							})),
							status: "active",
							createdAt: input.now,
							updatedAt: input.now,
						},
						undefined,
						operation.content,
					),
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
				return {
					...put(
						{
							id,
							layer: "observation",
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
						},
						undefined,
						operation.content,
					),
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
						onSome: ([entry, audience]) => {
							const next = {
								...entry,
								tags: Arr.dedupe([...entry.tags, Audience.forTag(audience)]),
								updatedAt: input.now,
							}
							return canWiden(
								Arr.fromIterable(HashMap.values(state.entries)),
								next,
								audience,
							)
								? put(
										next,
										`${entry.id} for ${operation.audience}: ${operation.reason}`,
									)
								: reject
						},
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
						const next: Metadata = {
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
		Arr.zip(input.operations, input.ids),
		{
			entries: HashMap.fromIterable(
				Arr.map(input.metadata, (entry) => [entry.id, entry] as const),
			),
			contents: HashMap.empty<string, string>(),
			changed: HashSet.empty<string>(),
			refs: HashMap.empty<string, string>(),
			reasons: [] as ReadonlyArray<string>,
			rejected: 0,
		},
		(state, [operation, id]) => step(state, operation, id),
	)
	return {
		changes: Arr.flatMap(Arr.fromIterable(result.changed), (id) =>
			Option.toArray(
				HashMap.get(result.entries, id).pipe(
					Option.map((metadata): Change => ({
						metadata,
						...Option.match(HashMap.get(result.contents, id), {
							onNone: () => ({}),
							onSome: (content) => ({ content }),
						}),
					})),
				),
			),
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
	readonly metadata: ReadonlyArray<Metadata>
	readonly person: Person
	readonly change: Edit
	readonly now: number
	readonly id: string
}): Option.Option<Change> => {
	const { person, change, now } = input
	if (change._tag === "Remember")
		return Option.some({
			metadata: {
				id: input.id,
				layer: "pinned",
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
			},
			content: change.content,
		})
	return Arr.findFirst(input.metadata, (entry) => entry.id === change.id).pipe(
		Option.filter(
			(entry) =>
				entry.status === "active" &&
				visible(input.metadata, {
					organizationId: person.organizationId,
					person: person.userId,
				})(entry),
		),
		Option.map((entry): Change => {
			const others = Arr.filter(
				Audience.peopleOf(entry.tags),
				(other) => other !== person.userId,
			)
			// When others stand behind the entry too, only the part of this person goes.
			return {
				metadata:
					others.length === 0
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
							},
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
