import { MemoryLogs } from "./MemoryLogs.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { PgClient } from "@effect/sql-pg"
import { BotMemory as Api } from "@openbot-build/domain"
import { Bots as BotsApi } from "@openbot-build/domain"
import * as Failures from "../errors/Failures.ts"
import * as BotMemory from "../plugins/memory/BotMemory.ts"
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
	Record as Rec,
	Schema,
	String as Str,
} from "effect"
import { Hex } from "effect/encoding"
import { BotRecords } from "./BotRecords.ts"

/**
 * Where the memory of a Bot lives. A linked Bot uses the memory of its source,
 * so everyone who uses a shared Bot adds to one pool.
 */
export const homeOf = (organizationId: string, bot: BotsApi.Bot): Home =>
	bot.source ?? { organizationId, bot: bot.id }

/** One memory pool: the Bot and its organization. */
export interface Home {
	readonly organizationId: string
	readonly bot: BotsApi.BotId
}

/** What one change of the pool writes. */
export interface Change<A> {
	readonly entries: ReadonlyArray<BotMemory.Entry>
	readonly by: BotMemory.LogEntry["by"]
	readonly reasons?: ReadonlyArray<string>
	readonly result: A
}

/** Makes the id of a new memory entry. */
export const newId = (crypto: Crypto.Crypto) =>
	crypto.randomUUIDv4({ format: "bytes" }).pipe(
		// A platform without secure random numbers is broken.
		Effect.orDie,
		Effect.map((uuid) => "mem_" + Hex.encode(uuid)),
	)

/** The pool of tagged memory entries of each Bot. It does not follow any Timeline. */
export class BotMemories extends Context.Service<
	BotMemories,
	{
		/** All entries of the pool, the most recently changed first. Only OpenBot reads it whole. */
		readonly pool: (
			home: Home,
		) => Effect.Effect<
			ReadonlyArray<BotMemory.Entry>,
			BotsApi.BotStorageUnavailable
		>
		/** The entries that a viewer may see, with all of `tags`. */
		readonly view: (
			home: Home,
			viewer: Audience.Viewer,
			tags?: ReadonlyArray<string>,
		) => Effect.Effect<Api.View, BotsApi.BotStorageUnavailable>
		/**
		 * Reads the newest pool under a lock, and writes what `run` returns. Do slow work like
		 * model calls before it, so that the lock is short and no edit gets lost.
		 */
		readonly change: <A, E, R>(
			home: Home,
			run: (
				pool: ReadonlyArray<BotMemory.Entry>,
			) => Effect.Effect<Change<A>, E, R>,
		) => Effect.Effect<A, E | BotsApi.BotStorageUnavailable, R>
		readonly edit: (
			home: Home,
			person: BotMemory.Person,
			command: BotMemory.Edit,
		) => Effect.Effect<
			Api.View,
			BotsApi.BotConflict | BotsApi.BotStorageUnavailable
		>
		/** The changes that touch entries the viewer may see, with only those ids. */
		readonly log: (
			home: Home,
			viewer: Audience.Viewer,
		) => Effect.Effect<
			ReadonlyArray<BotMemory.LogEntry>,
			BotsApi.BotStorageUnavailable
		>
		/** Removes every entry with one tag of OpenBot, and gives how many went. */
		readonly purge: (
			home: Home,
			tag: string,
		) => Effect.Effect<number, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/bots/BotMemories") {}

/** Fails with `BotStorageUnavailable` in place of a storage failure, and logs the failure. */
const storageUnavailable = (message: string) =>
	Failures.replace(message, () => BotsApi.BotStorageUnavailable.make({}))

const Sources = Schema.fromJsonString(Schema.Array(BotMemory.Source))
const encodeSources = Schema.encodeEffect(Sources)
const decodeSources = Schema.decodeUnknownEffect(Sources)
const decodeEntry = Schema.decodeUnknownEffect(BotMemory.Entry)

interface Row {
	readonly id: string
	readonly layer: string
	readonly content: string
	readonly sources: string
	readonly confidence: number | null
	readonly status: string
	readonly created_at: string | number
	readonly updated_at: string | number
	readonly invalidated_at: string | number | null
}

export const make: Effect.Effect<
	typeof BotMemories.Service,
	never,
	BotRecords | PgClient.PgClient | Crypto.Crypto | Secrets | MemoryLogs
> = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const records = yield* BotRecords
	const crypto = yield* Crypto.Crypto
	const secrets = yield* Secrets
	const bindContent = (home: Home, id: string) =>
		Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
			"bot-memory",
			home.organizationId,
			home.bot,
			id,
			"content",
		])
	const versions = records.collection(
		"memory_pool",
		Schema.Struct({ version: Schema.Natural }),
	)
	const sourcePolicies = records.collection(
		"memory_source_policy",
		Schema.Struct({
			entry: Schema.String,
			policies: Schema.Array(BotMemory.SourcePolicy),
		}),
	)
	const policyId = (home: Home, id: string) => JSON.stringify([home.bot, id])
	const { changes: logs } = yield* MemoryLogs
	const pool = (home: Home) =>
		Effect.gen(function* () {
			const policies = HashMap.fromIterable(
				Arr.map(
					yield* sourcePolicies.list(home.organizationId, { owner: home.bot }),
					(value) => [value.entry, value.policies] as const,
				),
			)
			const rows =
				yield* sql<Row>`SELECT id, layer, content, sources, confidence, status, created_at, updated_at, invalidated_at FROM openbot_bot_memories WHERE organization_id = ${home.organizationId} AND home_bot = ${home.bot} ORDER BY updated_at DESC, id`
			const tags = yield* sql<{
				memory_id: string
				tag: string
			}>`SELECT memory_id, tag FROM openbot_bot_memory_tags WHERE organization_id = ${home.organizationId} AND home_bot = ${home.bot} ORDER BY tag`
			const byEntry = Rec.map(
				Arr.groupBy(tags, (row) => row.memory_id),
				Arr.map((row) => row.tag),
			)
			return yield* Effect.forEach(rows, (row) =>
				Effect.gen(function* () {
					const sources = yield* decodeSources(row.sources)
					const content = yield* secrets.open(
						row.content,
						yield* bindContent(home, row.id),
					)
					return yield* decodeEntry({
						id: row.id,
						layer: row.layer,
						content,
						tags: Option.getOrElse(Rec.get(byEntry, row.id), () => []),
						sources,
						...Option.match(HashMap.get(policies, row.id), {
							onNone: () => ({}),
							onSome: (sourcePolicies) => ({ sourcePolicies }),
						}),
						...(row.confidence === null ? {} : { confidence: row.confidence }),
						status: row.status,
						createdAt: Number(row.created_at),
						updatedAt: Number(row.updated_at),
						...(row.invalidated_at === null
							? {}
							: { invalidatedAt: Number(row.invalidated_at) }),
					})
				}),
			)
		}).pipe(storageUnavailable("The memory of a Bot could not be read."))
	const version = (home: Home) =>
		versions
			.find(home.organizationId, home.bot)
			.pipe(
				Effect.map(Option.match({ onNone: () => 0, onSome: (v) => v.version })),
			)
	const writeEntry = (home: Home, entry: BotMemory.Entry) =>
		Effect.gen(function* () {
			// The entry has its type already, so its sources always encode.
			const sources = yield* encodeSources(entry.sources).pipe(Effect.orDie)
			const content = yield* secrets.seal(
				entry.content,
				yield* bindContent(home, entry.id),
			)
			yield* sql`INSERT INTO openbot_bot_memories (organization_id, home_bot, id, layer, content, sources, confidence, status, created_at, updated_at, invalidated_at) VALUES (${home.organizationId}, ${home.bot}, ${entry.id}, ${entry.layer}, ${content}, ${sources}, ${entry.confidence ?? null}, ${entry.status}, ${entry.createdAt}, ${entry.updatedAt}, ${entry.invalidatedAt ?? null}) ON CONFLICT (organization_id, home_bot, id) DO UPDATE SET layer = EXCLUDED.layer, content = EXCLUDED.content, sources = EXCLUDED.sources, confidence = EXCLUDED.confidence, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, invalidated_at = EXCLUDED.invalidated_at`
			yield* sql`DELETE FROM openbot_bot_memory_tags WHERE organization_id = ${home.organizationId} AND home_bot = ${home.bot} AND memory_id = ${entry.id}`
			if (entry.tags.length > 0)
				yield* sql`INSERT INTO openbot_bot_memory_tags ${sql.insert(
					Arr.map(Arr.dedupe(entry.tags), (tag) => ({
						organization_id: home.organizationId,
						home_bot: home.bot,
						memory_id: entry.id,
						tag,
					})),
				)}`
			if (entry.sourcePolicies === undefined)
				yield* sourcePolicies.remove(
					home.organizationId,
					policyId(home, entry.id),
				)
			else
				yield* sourcePolicies.put(
					{
						organizationId: home.organizationId,
						id: policyId(home, entry.id),
						owner: home.bot,
						scope: entry.id,
						status: "",
					},
					{ entry: entry.id, policies: entry.sourcePolicies },
				)
		}).pipe(storageUnavailable("A memory entry could not be written."))
	/** Gives the new version and writes its log entry. */
	const bump = (
		home: Home,
		ids: ReadonlyArray<string>,
		by: BotMemory.LogEntry["by"],
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
			return next
		})
	const locked = <A, E, R>(home: Home, operation: Effect.Effect<A, E, R>) =>
		records.transaction(
			"memory:" + home.organizationId + ":" + home.bot,
			operation,
		)
	const change: (typeof BotMemories.Service)["change"] = (home, run) =>
		locked(
			home,
			Effect.gen(function* () {
				const current = yield* pool(home)
				const changed = yield* run(current)
				if (changed.entries.length > 0) {
					yield* Effect.forEach(
						changed.entries,
						(entry) => writeEntry(home, entry),
						{ discard: true },
					)
					yield* bump(
						home,
						Arr.map(changed.entries, (entry) => entry.id),
						changed.by,
						changed.reasons ?? [],
					)
				}
				return changed.result
			}),
		)
	const view = (
		home: Home,
		viewer: Audience.Viewer,
		tags: ReadonlyArray<string> = [],
	) =>
		Effect.all([pool(home), version(home)]).pipe(
			Effect.map(([entries, current]) => ({
				entries: pipe(
					entries,
					Arr.filter(BotMemory.visible(entries, viewer)),
					Arr.filter((entry) =>
						Arr.every(tags, (tag) => entry.tags.includes(tag)),
					),
					Arr.map(BotMemory.publicEntry),
				),
				version: current,
			})),
		)
	return BotMemories.of({
		pool,
		view,
		change,
		edit: (home, person, command) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const id = yield* newId(crypto)
				const found = yield* change(home, (current) =>
					Effect.succeed(
						Option.match(
							BotMemory.edit({
								pool: current,
								person,
								change: command,
								now,
								id,
							}),
							{
								onNone: () => ({
									entries: [],
									by: "person" as const,
									result: false,
								}),
								onSome: (entry) => ({
									entries: [entry],
									by: "person" as const,
									result: true,
								}),
							},
						),
					),
				)
				if (!found)
					return yield* BotsApi.BotConflict.make({
						message: "No active memory entry with this id is for you.",
					})
				return yield* view(home, {
					organizationId: person.organizationId,
					person: person.userId,
				})
			}),
		log: (home, viewer) =>
			Effect.all([
				pool(home),
				logs.list(home.organizationId, { owner: home.bot }),
			]).pipe(
				Effect.map(([entries, list]) => {
					const seen = HashSet.fromIterable(
						pipe(
							entries,
							Arr.filter(BotMemory.visible(entries, viewer)),
							Arr.map((entry) => entry.id),
						),
					)
					return Arr.flatMap(list, (logged) => {
						const ids = Arr.filter(logged.entry.ids, (id) =>
							HashSet.has(seen, id),
						)
						// A reason can name entries that the viewer may not see.
						const { reason: _, ...entry } = logged.entry
						return ids.length === 0 ? [] : [{ ...entry, ids }]
					})
				}),
			),
		purge: (home, tag) =>
			locked(
				home,
				Effect.gen(function* () {
					const removed = yield* sql<{
						id: string
					}>`DELETE FROM openbot_bot_memories WHERE organization_id = ${home.organizationId} AND home_bot = ${home.bot} AND id IN (SELECT memory_id FROM openbot_bot_memory_tags WHERE organization_id = ${home.organizationId} AND home_bot = ${home.bot} AND tag = ${tag}) RETURNING id`.pipe(
						storageUnavailable(
							"The memory entries of a tag could not be removed.",
						),
					)
					if (removed.length > 0)
						yield* Effect.forEach(removed, (entry) =>
							sourcePolicies.remove(
								home.organizationId,
								policyId(home, entry.id),
							),
						)
					if (removed.length > 0)
						yield* bump(
							home,
							Arr.map(removed, (row) => row.id),
							"person",
							[],
						)
					return removed.length
				}),
			),
	})
})
export const layer = Layer.effect(BotMemories, make)
