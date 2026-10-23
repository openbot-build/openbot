import { randomUUID } from "node:crypto"
import { PgClient } from "@effect/sql-pg"
import type { Session } from "@openbot-build/core"
import { AgentMemory as Api, AgentsApi } from "@openbot-build/api"
import * as AgentMemory from "../plugins/memory/AgentMemory.ts"
import * as Audience from "../plugins/memory/Audience.ts"
import type * as Memory from "../plugins/memory/Memory.ts"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Option,
	Schema,
} from "effect"
import { AgentRecords } from "./AgentRecords.ts"

/**
 * Where the memory of an Agent lives. A linked Agent uses the memory of its source,
 * so everyone who uses a shared Agent adds to one pool.
 */
export const homeOf = (organizationId: string, agent: AgentsApi.Agent): Home =>
	agent.source ?? { organizationId, agent: agent.id }

/** One memory pool: the Agent and its organization. */
export interface Home {
	readonly organizationId: string
	readonly agent: AgentsApi.AgentId
}

/** What one change of the pool writes. */
export interface Change<A> {
	readonly entries: ReadonlyArray<AgentMemory.Entry>
	readonly by: AgentMemory.LogEntry["by"]
	readonly reasons?: ReadonlyArray<string>
	readonly result: A
}

/** Session memory kinds that last. They become topic tags when a Session Agent is promoted. */
const lasting = HashSet.make("procedure", "preference", "decision")

export const newId = () => "mem_" + randomUUID().replaceAll("-", "")

/** The pool of tagged memory entries of each Agent. It does not follow any Timeline. */
export class AgentMemories extends Context.Service<
	AgentMemories,
	{
		/** All entries of the pool, the most recently changed first. Only OpenBot reads it whole. */
		readonly pool: (
			home: Home,
		) => Effect.Effect<
			ReadonlyArray<AgentMemory.Entry>,
			AgentsApi.AgentStorageUnavailable
		>
		/** The entries that a viewer may see, with all of `tags`. */
		readonly view: (
			home: Home,
			viewer: Audience.Viewer,
			tags?: ReadonlyArray<string>,
		) => Effect.Effect<Api.View, AgentsApi.AgentStorageUnavailable>
		/**
		 * Reads the newest pool under a lock, and writes what `run` returns. Do slow work like
		 * model calls before it, so that the lock is short and no edit gets lost.
		 */
		readonly change: <A, E, R>(
			home: Home,
			run: (
				pool: ReadonlyArray<AgentMemory.Entry>,
			) => Effect.Effect<Change<A>, E, R>,
		) => Effect.Effect<A, E | AgentsApi.AgentStorageUnavailable, R>
		readonly edit: (
			home: Home,
			person: AgentMemory.Person,
			command: AgentMemory.Edit,
		) => Effect.Effect<
			Api.View,
			AgentsApi.AgentConflict | AgentsApi.AgentStorageUnavailable
		>
		/** The changes that touch entries the viewer may see, with only those ids. */
		readonly log: (
			home: Home,
			viewer: Audience.Viewer,
		) => Effect.Effect<
			ReadonlyArray<AgentMemory.LogEntry>,
			AgentsApi.AgentStorageUnavailable
		>
		/** Removes every entry with one tag of OpenBot, and gives how many went. */
		readonly purge: (
			home: Home,
			tag: string,
		) => Effect.Effect<number, AgentsApi.AgentStorageUnavailable>
		/**
		 * Adds the lasting entries of a Session memory, when a Session Agent is promoted.
		 * They become facts for the person who promotes it.
		 */
		readonly adopt: (
			home: Home,
			person: AgentMemory.Person,
			session: Session.Id,
			memory: Memory.State,
		) => Effect.Effect<void, AgentsApi.AgentStorageUnavailable>
	}
>()("@openbot-build/openbot/agents/AgentMemories") {}

const Sources = Schema.fromJsonString(Schema.Array(AgentMemory.Source))
const encodeSources = Schema.encodeSync(Sources)
const decodeSources = Schema.decodeUnknownEffect(Sources)
const decodeEntry = Schema.decodeUnknownEffect(AgentMemory.Entry)

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
	typeof AgentMemories.Service,
	never,
	AgentRecords | PgClient.PgClient
> = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const records = yield* AgentRecords
	const versions = records.collection(
		"memory_pool",
		Schema.Struct({ version: Schema.Natural }),
	)
	const logs = records.collection(
		"memory_log",
		Schema.Struct({ agent: AgentsApi.AgentId, entry: AgentMemory.LogEntry }),
	)
	const unavailable = () => AgentsApi.AgentStorageUnavailable.make({})
	const pool = (home: Home) =>
		Effect.gen(function* () {
			const rows =
				yield* sql<Row>`SELECT id, layer, content, sources, confidence, status, created_at, updated_at, invalidated_at FROM openbot_agent_memories WHERE organization_id = ${home.organizationId} AND home_agent = ${home.agent} ORDER BY updated_at DESC, id`
			const tags = yield* sql<{
				memory_id: string
				tag: string
			}>`SELECT memory_id, tag FROM openbot_agent_memory_tags WHERE organization_id = ${home.organizationId} AND home_agent = ${home.agent} ORDER BY tag`
			const byEntry = tags.reduce(
				(map, row) =>
					HashMap.set(map, row.memory_id, [
						...Option.getOrElse(HashMap.get(map, row.memory_id), () => []),
						row.tag,
					]),
				HashMap.empty<string, ReadonlyArray<string>>(),
			)
			return yield* Effect.forEach(rows, (row) =>
				Effect.flatMap(decodeSources(row.sources), (sources) =>
					decodeEntry({
						id: row.id,
						layer: row.layer,
						content: row.content,
						tags: Option.getOrElse(HashMap.get(byEntry, row.id), () => []),
						sources,
						...(row.confidence === null ? {} : { confidence: row.confidence }),
						status: row.status,
						createdAt: Number(row.created_at),
						updatedAt: Number(row.updated_at),
						...(row.invalidated_at === null
							? {}
							: { invalidatedAt: Number(row.invalidated_at) }),
					}),
				),
			)
		}).pipe(Effect.mapError(unavailable))
	const version = (home: Home) =>
		versions
			.find(home.organizationId, home.agent)
			.pipe(
				Effect.map(Option.match({ onNone: () => 0, onSome: (v) => v.version })),
			)
	const writeEntry = (home: Home, entry: AgentMemory.Entry) =>
		Effect.gen(function* () {
			yield* sql`INSERT INTO openbot_agent_memories (organization_id, home_agent, id, layer, content, sources, confidence, status, created_at, updated_at, invalidated_at) VALUES (${home.organizationId}, ${home.agent}, ${entry.id}, ${entry.layer}, ${entry.content}, ${encodeSources(entry.sources)}, ${entry.confidence ?? null}, ${entry.status}, ${entry.createdAt}, ${entry.updatedAt}, ${entry.invalidatedAt ?? null}) ON CONFLICT (organization_id, home_agent, id) DO UPDATE SET layer = EXCLUDED.layer, content = EXCLUDED.content, sources = EXCLUDED.sources, confidence = EXCLUDED.confidence, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, invalidated_at = EXCLUDED.invalidated_at`
			yield* sql`DELETE FROM openbot_agent_memory_tags WHERE organization_id = ${home.organizationId} AND home_agent = ${home.agent} AND memory_id = ${entry.id}`
			if (entry.tags.length > 0)
				yield* sql`INSERT INTO openbot_agent_memory_tags ${sql.insert(
					Arr.dedupe(entry.tags).map((tag) => ({
						organization_id: home.organizationId,
						home_agent: home.agent,
						memory_id: entry.id,
						tag,
					})),
				)}`
		}).pipe(Effect.mapError(unavailable))
	/** Gives the new version and writes its log entry. */
	const bump = (
		home: Home,
		ids: ReadonlyArray<string>,
		by: AgentMemory.LogEntry["by"],
		reasons: ReadonlyArray<string>,
	) =>
		Effect.gen(function* () {
			const next = (yield* version(home)) + 1
			const now = yield* Clock.currentTimeMillis
			yield* versions.put(
				{
					organizationId: home.organizationId,
					id: home.agent,
					owner: home.agent,
					scope: "",
					status: "",
				},
				{ version: next },
			)
			yield* logs.put(
				{
					organizationId: home.organizationId,
					id: home.agent + ":" + String(next).padStart(12, "0"),
					owner: home.agent,
					scope: "",
					status: "",
				},
				{
					agent: home.agent,
					entry: {
						version: next,
						at: now,
						by,
						ids,
						...(reasons.length === 0 ? {} : { reason: reasons.join("\n") }),
					},
				},
			)
			return next
		})
	const locked = <A, E, R>(home: Home, operation: Effect.Effect<A, E, R>) =>
		records.transaction(
			"memory:" + home.organizationId + ":" + home.agent,
			operation,
		)
	const change: (typeof AgentMemories.Service)["change"] = (home, run) =>
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
						changed.entries.map((entry) => entry.id),
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
				entries: entries.filter(
					(entry) =>
						Audience.visible(entry.tags, viewer) &&
						tags.every((tag) => entry.tags.includes(tag)),
				),
				version: current,
			})),
		)
	return AgentMemories.of({
		pool,
		view,
		change,
		edit: (home, person, command) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const found = yield* change(home, (current) =>
					Effect.succeed(
						Option.match(
							AgentMemory.edit({
								pool: current,
								person,
								change: command,
								now,
								id: newId,
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
					return yield* AgentsApi.AgentConflict.make({
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
				logs.list(home.organizationId, { owner: home.agent }),
			]).pipe(
				Effect.map(([entries, list]) => {
					const seen = HashSet.fromIterable(
						entries
							.filter((entry) => Audience.visible(entry.tags, viewer))
							.map((entry) => entry.id),
					)
					return list.flatMap((logged) => {
						const ids = logged.entry.ids.filter((id) => HashSet.has(seen, id))
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
					}>`DELETE FROM openbot_agent_memories WHERE organization_id = ${home.organizationId} AND home_agent = ${home.agent} AND id IN (SELECT memory_id FROM openbot_agent_memory_tags WHERE organization_id = ${home.organizationId} AND home_agent = ${home.agent} AND tag = ${tag}) RETURNING id`.pipe(
						Effect.mapError(unavailable),
					)
					if (removed.length > 0)
						yield* bump(
							home,
							removed.map((row) => row.id),
							"person",
							[],
						)
					return removed.length
				}),
			),
		adopt: (home, person, session, memory) =>
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const entries = Object.values(memory.entries)
					.filter(
						(entry) =>
							entry.status === "active" && HashSet.has(lasting, entry.kind),
					)
					.map((entry): AgentMemory.Entry => ({
						id: newId(),
						layer: "fact",
						content: entry.content,
						tags: [
							Audience.fromTag(person.userId),
							Audience.sessionTag(session),
							Audience.orgTag(person.organizationId),
							Audience.forTag(Audience.person(person.userId)),
							entry.kind,
						],
						sources: entry.sources.map((item) => ({ session, item })),
						status: "active",
						createdAt: now,
						updatedAt: now,
					}))
				if (entries.length === 0) return
				yield* change(home, () =>
					Effect.succeed({
						entries,
						by: "promotion" as const,
						result: undefined,
					}),
				)
			}),
	})
})
export const layer = Layer.effect(AgentMemories, make)
