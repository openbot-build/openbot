import { MemoryLogs } from "./MemoryLogs.ts"
import { Bots as BotsApi } from "@openbot-build/domain"
import * as Failures from "../errors/Failures.ts"
import * as Memory from "../plugins/memory/BotMemory.ts"
import * as Audience from "../plugins/memory/Audience.ts"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Option,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { Hex } from "effect/encoding"
import { BotRecords } from "./BotRecords.ts"
import * as MemoryRecords from "./MemoryRecords.ts"

/** A linked Bot uses the memory of its source. */
export const homeOf = (organizationId: string, bot: BotsApi.Bot): Home =>
	bot.source ?? { organizationId, bot: bot.id }

/** One memory pool: the Bot and its organization. */
export interface Home {
	readonly organizationId: string
	readonly bot: BotsApi.BotId
}

export interface LearningContext {
	readonly topics: ReadonlyArray<{
		readonly topic: string
		readonly count: number
	}>
	readonly memory: ReadonlyArray<
		Pick<Memory.Entry, "id" | "layer" | "tags" | "content">
	>
}

export interface Learning {
	readonly evidence: ReadonlyArray<Memory.Evidence>
	readonly operations: ReadonlyArray<Memory.Operation>
	readonly now: number
	readonly ids: ReadonlyArray<string>
}

/** Makes the id of a new memory entry. */
export const newId = (crypto: Crypto.Crypto) =>
	crypto.randomUUIDv4({ format: "bytes" }).pipe(
		// A platform without secure random numbers is broken.
		Effect.orDie,
		Effect.map((uuid) => "mem_" + Hex.encode(uuid)),
	)

const unavailable = (message: string) =>
	Failures.replace(message, () => BotsApi.BotStorageUnavailable.make({}))

/** Memory owns access checks, content reads, and changes to its entries. */
export const make = Effect.gen(function* () {
	const records = yield* BotRecords
	const crypto = yield* Crypto.Crypto
	const data = yield* MemoryRecords.make
	const { changes: logs } = yield* MemoryLogs
	const versions = records.collection(
		"memory_pool",
		Schema.Struct({ version: Schema.Natural }),
	)
	const version = (home: Home) =>
		versions
			.find(home.organizationId, home.bot)
			.pipe(
				Effect.map(
					Option.match({ onNone: () => 0, onSome: (value) => value.version }),
				),
			)
	const bump = (
		home: Home,
		ids: ReadonlyArray<string>,
		by: Memory.LogEntry["by"],
		reasons: ReadonlyArray<string>,
	) =>
		Effect.gen(function* () {
			const next = (yield* version(home)) + 1
			const now = yield* Clock.currentTimeMillis
			yield* versions.put(
				{
					organizationId: home.organizationId,
					id: home.bot,
					owner: home.bot,
					scope: "",
					status: "",
				},
				{ version: next },
			)
			yield* logs.put(
				{
					organizationId: home.organizationId,
					id: home.bot + ":" + pipe(String(next), Str.padStart(12, "0")),
					owner: home.bot,
					scope: "",
					status: "",
				},
				{
					bot: home.bot,
					entry: {
						version: next,
						at: now,
						by,
						ids,
						...(reasons.length === 0
							? {}
							: { reason: Arr.join(reasons, "\n") }),
					},
				},
			)
		})
	const persist = (
		home: Home,
		changes: ReadonlyArray<Memory.Change>,
		by: Memory.LogEntry["by"],
		reasons: ReadonlyArray<string> = [],
	) =>
		Effect.gen(function* () {
			const ids = Arr.map(changes, (change) => change.metadata.id)
			if (ids.length > 0) {
				yield* Effect.forEach(changes, (change) => data.write(home, change), {
					discard: true,
				})
				yield* bump(home, ids, by, reasons)
			}
			return ids
		})
	const visible = (
		home: Home,
		viewer: Audience.Viewer,
		tags: ReadonlyArray<string> = [],
		active = false,
	) =>
		Effect.gen(function* () {
			const roots = Arr.filter(
				yield* data.metadata(home, { viewer, tags }),
				(entry) => !active || Memory.isActive(entry),
			)
			const allowed = Memory.visible(yield* data.closure(home, roots), viewer)
			return Arr.filter(roots, allowed)
		})
	const view = (
		home: Home,
		viewer: Audience.Viewer,
		tags: ReadonlyArray<string> = [],
	) =>
		data
			.read(
				home,
				Effect.gen(function* () {
					const entries = yield* visible(home, viewer, tags)
					return {
						entries: Arr.map(
							yield* data.contents(home, entries),
							Memory.publicEntry,
						),
						version: yield* version(home),
					}
				}),
			)
			.pipe(unavailable("The memory of a Bot could not be read."))
	const context = (home: Home, viewer: Audience.Viewer, maxLength: number) =>
		data
			.read(
				home,
				Effect.gen(function* () {
					const entries = yield* visible(home, viewer, [], true)
					const hasEntries = entries.length > 0
					let text = ""
					let ids: ReadonlyArray<string> = []
					for (const batch of Arr.chunksOf(entries, 32)) {
						const sealed = yield* data.sealedContent(
							home,
							Arr.map(batch, (entry) => entry.id),
						)
						for (const entry of batch) {
							const opened = yield* data.openContent(home, entry, sealed)
							const line = Memory.render([opened], Number.MAX_SAFE_INTEGER)
							const next = text.length === 0 ? line : text + "\n" + line
							if (next.length > maxLength) return { text, ids, hasEntries }
							text = next
							ids = [...ids, entry.id]
						}
					}
					return { text, ids, hasEntries }
				}),
			)
			.pipe(unavailable("The memory context could not be read."))
	const validateReferences = (
		home: Home,
		viewer: Audience.Viewer,
		ids: ReadonlyArray<string>,
	) =>
		data
			.read(
				home,
				Effect.gen(function* () {
					const targets = Arr.dedupe(ids)
					const entries = yield* data.metadata(home, { ids: targets })
					if (entries.length !== targets.length) return false
					const allowed = Memory.visible(
						yield* data.closure(home, entries),
						viewer,
					)
					return Arr.every(
						entries,
						(entry) => Memory.isActive(entry) && allowed(entry),
					)
				}),
			)
			.pipe(unavailable("The memory sources could not be checked."))
	const learningContext = (
		home: Home,
	): Effect.Effect<LearningContext, BotsApi.BotStorageUnavailable> =>
		data
			.read(
				home,
				Effect.gen(function* () {
					const entries = Memory.learnable(yield* data.metadata(home))
					const counts = Arr.reduce(
						Arr.flatMap(entries, Memory.topicsOf),
						HashMap.empty<string, number>(),
						(map, topic) =>
							HashMap.set(
								map,
								topic,
								Option.getOrElse(HashMap.get(map, topic), () => 0) + 1,
							),
					)
					return {
						topics: Arr.map(HashMap.toEntries(counts), ([topic, count]) => ({
							topic,
							count,
						})),
						memory: Arr.map(
							yield* data.contents(home, Arr.take(entries, 300)),
							({ id, layer, tags, content }) => ({ id, layer, tags, content }),
						),
					}
				}),
			)
			.pipe(unavailable("The memory for learning could not be read."))
	const applyLearning = (home: Home, input: Learning) =>
		data
			.change(
				home,
				Effect.gen(function* () {
					const targets = Arr.dedupe(
						Arr.flatMap(input.operations, (operation) => {
							switch (operation._tag) {
								case "AddObservation":
									return operation.supports
								case "Invalidate":
								case "Retag":
								case "Widen":
									return [operation.id]
								default:
									return []
							}
						}),
					)
					const topics = Arr.dedupe(
						Arr.flatMap(input.operations, (operation) =>
							operation._tag === "RenameTopic" ? [operation.from] : [],
						),
					)
					const roots = [
						...(yield* data.metadata(home, { ids: targets })),
						...Arr.flatten(
							yield* Effect.forEach(topics, (tag) =>
								data.metadata(home, { tags: [tag] }),
							),
						),
					]
					const metadata = yield* data.closure(home, roots)
					const applied = Memory.apply({ ...input, metadata })
					return {
						changedIds: yield* persist(
							home,
							applied.changes,
							"memory_bot",
							applied.reasons,
						),
						rejected: applied.rejected,
					}
				}),
			)
			.pipe(unavailable("The memory plan could not be saved."))
	const edit = (home: Home, person: Memory.Person, command: Memory.Edit) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const id = yield* newId(crypto)
			const changed = yield* data
				.change(
					home,
					Effect.gen(function* () {
						const roots =
							command._tag === "Remember"
								? []
								: yield* data.metadata(home, { ids: [command.id] })
						const metadata = yield* data.closure(home, roots)
						const change = Memory.edit({
							metadata,
							person,
							change: command,
							now,
							id,
						})
						if (Option.isNone(change)) return false
						yield* persist(home, [change.value], "person")
						return true
					}),
				)
				.pipe(unavailable("The memory change could not be saved."))
			if (!changed)
				return yield* BotsApi.BotConflict.make({
					message: "No active memory entry with this id is for you.",
				})
			return yield* view(home, {
				organizationId: person.organizationId,
				person: person.userId,
			})
		})
	const log = (home: Home, viewer: Audience.Viewer) =>
		data
			.read(
				home,
				Effect.gen(function* () {
					const seen = HashSet.fromIterable(
						Arr.map(yield* visible(home, viewer), (entry) => entry.id),
					)
					const entries = yield* logs.list(home.organizationId, {
						owner: home.bot,
					})
					return Arr.flatMap(entries, (logged) => {
						const ids = Arr.filter(logged.entry.ids, (id) =>
							HashSet.has(seen, id),
						)
						// A reason can name entries that the viewer may not see.
						const { reason: _, ...entry } = logged.entry
						return ids.length === 0 ? [] : [{ ...entry, ids }]
					})
				}),
			)
			.pipe(unavailable("The memory log could not be read."))
	const purge = (home: Home, tag: string) =>
		data
			.change(
				home,
				Effect.gen(function* () {
					const ids = yield* data.purge(home, tag)
					if (ids.length > 0) yield* bump(home, ids, "person", [])
					return ids.length
				}),
			)
			.pipe(unavailable("The memory entries of a tag could not be removed."))
	return {
		view,
		context,
		validateReferences,
		learningContext,
		applyLearning,
		edit,
		log,
		purge,
	}
})

export class BotMemories extends Context.Service<
	BotMemories,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/bots/BotMemories") {}
export const layer = Layer.effect(BotMemories, make)
