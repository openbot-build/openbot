import { PgClient } from "@effect/sql-pg"
import {
	Array as Arr,
	Effect,
	HashMap,
	HashSet,
	Option,
	Record as Rec,
	Schema,
} from "effect"
import type * as Audience from "../plugins/memory/Audience.ts"
import * as Memory from "../plugins/memory/BotMemory.ts"
import { Secrets } from "../secrets/Secrets.ts"
import type { Home } from "./BotMemories.ts"

const Sources = Schema.fromJsonString(Schema.Array(Memory.Source))
const Policy = Schema.fromJsonString(
	Schema.Struct({
		entry: Schema.String,
		policies: Schema.Array(Memory.SourcePolicy),
	}),
)
const binding = Schema.encodeEffect(
	Schema.fromJsonString(Schema.Array(Schema.String)),
)
const policyId = (home: Home, id: string) => JSON.stringify([home.bot, id])

interface Row {
	readonly id: string
	readonly layer: string
	readonly sources: string
	readonly confidence: number | null
	readonly status: string
	readonly created_at: string | number
	readonly updated_at: string | number
	readonly invalidated_at: string | number | null
}

/** Memory reads its access rules before it opens any content. */
export const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const secrets = yield* Secrets
	const lockKey = (home: Home) =>
		"bots:memory:" + home.organizationId + ":" + home.bot
	const locked =
		(shared: boolean) =>
		<A, E, R>(home: Home, work: Effect.Effect<A, E, R>) =>
			sql.withTransaction(
				Effect.gen(function* () {
					if (shared)
						yield* sql`select pg_advisory_xact_lock_shared(hashtextextended(${lockKey(home)}, 0))`
					else
						yield* sql`select pg_advisory_xact_lock(hashtextextended(${lockKey(home)}, 0))`
					return yield* work
				}),
			)
	const metadata = (
		home: Home,
		input: {
			readonly ids?: ReadonlyArray<string>
			readonly tags?: ReadonlyArray<string>
			readonly viewer?: Audience.Viewer
		} = {},
	) =>
		Effect.gen(function* () {
			if (input.ids?.length === 0) return []
			const tags = [
				...(input.tags ?? []),
				...(input.viewer === undefined
					? []
					: ["org:" + input.viewer.organizationId]),
			]
			const readRows = (ids?: ReadonlyArray<string>) =>
				sql<Row>`select m.id, m.layer, m.sources, m.confidence, m.status, m.created_at, m.updated_at, m.invalidated_at from openbot_bot_memories m where ${sql.and(
					[
						sql`m.organization_id = ${home.organizationId}`,
						sql`m.home_bot = ${home.bot}`,
						...(ids === undefined ? [] : [sql.in("m.id", ids)]),
						...Arr.map(
							tags,
							(tag) =>
								sql`exists (select 1 from openbot_bot_memory_tags t where t.organization_id = m.organization_id and t.home_bot = m.home_bot and t.memory_id = m.id and t.tag = ${tag})`,
						),
					],
				)} order by m.updated_at desc, m.id`
			const rows =
				input.ids === undefined
					? yield* readRows()
					: Arr.flatten(
							yield* Effect.forEach(Arr.chunksOf(input.ids, 500), readRows),
						)
			if (rows.length === 0) return []
			const ids = Arr.map(rows, (row) => row.id)
			const batches = Arr.chunksOf(ids, 500)
			const tagRows = Arr.flatten(
				yield* Effect.forEach(
					batches,
					(ids) =>
						sql<{
							readonly memory_id: string
							readonly tag: string
						}>`select memory_id, tag from openbot_bot_memory_tags where organization_id = ${home.organizationId} and home_bot = ${home.bot} and ${sql.in("memory_id", ids)} order by tag`,
				),
			)
			const byEntry = Rec.map(
				Arr.groupBy(tagRows, (row) => row.memory_id),
				Arr.map((row) => row.tag),
			)
			const policyRows = Arr.flatten(
				yield* Effect.forEach(
					batches,
					(ids) =>
						sql<{
							readonly body: string
						}>`select body from openbot_bot_records where kind = 'memory_source_policy' and organization_id = ${home.organizationId} and owner = ${home.bot} and ${sql.in(
							"id",
							Arr.map(ids, (id) => policyId(home, id)),
						)}`,
				),
			)
			const policies = HashMap.fromIterable(
				Arr.map(
					yield* Effect.forEach(policyRows, (row) =>
						Schema.decodeEffect(Policy)(row.body),
					),
					(value) => [value.entry, value.policies] as const,
				),
			)
			return yield* Effect.forEach(rows, (row) =>
				Effect.gen(function* () {
					const sources = yield* Schema.decodeEffect(Sources)(row.sources)
					return yield* Schema.decodeUnknownEffect(Memory.Metadata)({
						id: row.id,
						layer: row.layer,
						sources,
						tags: Option.getOrElse(Rec.get(byEntry, row.id), () => []),
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
		})
	const closure = (home: Home, roots: ReadonlyArray<Memory.Metadata>) =>
		Effect.gen(function* () {
			let known = HashMap.fromIterable(
				Arr.map(roots, (entry) => [entry.id, entry] as const),
			)
			let read = HashSet.fromIterable(Arr.map(roots, (entry) => entry.id))
			let pending = roots
			while (pending.length > 0) {
				const ids = Arr.dedupe(
					Arr.flatMap(pending, (entry) =>
						Arr.flatMap(entry.sources, (source) =>
							"entry" in source && !HashSet.has(read, source.entry)
								? [source.entry]
								: [],
						),
					),
				)
				if (ids.length === 0) break
				read = HashSet.union(read, HashSet.fromIterable(ids))
				pending = yield* metadata(home, { ids })
				for (const entry of pending) known = HashMap.set(known, entry.id, entry)
			}
			return Arr.fromIterable(HashMap.values(known))
		})
	const sealedContent = (home: Home, ids: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			const rows = Arr.flatten(
				yield* Effect.forEach(
					Arr.chunksOf(ids, 500),
					(batch) =>
						sql<{
							readonly id: string
							readonly content: string
						}>`select id, content from openbot_bot_memories where organization_id = ${home.organizationId} and home_bot = ${home.bot} and ${sql.in("id", batch)}`,
				),
			)
			return HashMap.fromIterable(
				Arr.map(rows, (row) => [row.id, row.content] as const),
			)
		})
	const openContent = (
		home: Home,
		entry: Memory.Metadata,
		sealed: HashMap.HashMap<string, string>,
	) =>
		Effect.gen(function* () {
			const value = yield* Schema.decodeUnknownEffect(Schema.String)(
				Option.getOrUndefined(HashMap.get(sealed, entry.id)),
			)
			const content = yield* secrets.open(
				value,
				yield* binding([
					"bot-memory",
					home.organizationId,
					home.bot,
					entry.id,
					"content",
				]),
			)
			return yield* Schema.decodeEffect(Memory.Entry)({ ...entry, content })
		})
	const contents = (home: Home, entries: ReadonlyArray<Memory.Metadata>) =>
		Effect.gen(function* () {
			const sealed = yield* sealedContent(
				home,
				Arr.map(entries, (entry) => entry.id),
			)
			return yield* Effect.forEach(entries, (entry) =>
				openContent(home, entry, sealed),
			)
		})
	const write = (home: Home, change: Memory.Change) =>
		Effect.gen(function* () {
			const entry = change.metadata
			const sources = yield* Schema.encodeEffect(Sources)(entry.sources)
			if (change.content !== undefined) {
				const sealed = yield* secrets.seal(
					change.content,
					yield* binding([
						"bot-memory",
						home.organizationId,
						home.bot,
						entry.id,
						"content",
					]),
				)
				yield* sql`insert into openbot_bot_memories (organization_id, home_bot, id, layer, content, sources, confidence, status, created_at, updated_at, invalidated_at) values (${home.organizationId}, ${home.bot}, ${entry.id}, ${entry.layer}, ${sealed}, ${sources}, ${entry.confidence ?? null}, ${entry.status}, ${entry.createdAt}, ${entry.updatedAt}, ${entry.invalidatedAt ?? null}) on conflict (organization_id, home_bot, id) do update set layer = excluded.layer, content = excluded.content, sources = excluded.sources, confidence = excluded.confidence, status = excluded.status, updated_at = excluded.updated_at, invalidated_at = excluded.invalidated_at`
			} else {
				yield* sql`update openbot_bot_memories set layer = ${entry.layer}, sources = ${sources}, confidence = ${entry.confidence ?? null}, status = ${entry.status}, updated_at = ${entry.updatedAt}, invalidated_at = ${entry.invalidatedAt ?? null} where organization_id = ${home.organizationId} and home_bot = ${home.bot} and id = ${entry.id}`
			}
			yield* sql`delete from openbot_bot_memory_tags where organization_id = ${home.organizationId} and home_bot = ${home.bot} and memory_id = ${entry.id}`
			if (entry.tags.length > 0)
				yield* sql`insert into openbot_bot_memory_tags ${sql.insert(Arr.map(Arr.dedupe(entry.tags), (tag) => ({ organization_id: home.organizationId, home_bot: home.bot, memory_id: entry.id, tag })))}`
			if (entry.sourcePolicies === undefined)
				yield* sql`delete from openbot_bot_records where kind = 'memory_source_policy' and organization_id = ${home.organizationId} and id = ${policyId(home, entry.id)}`
			else {
				const body = yield* Schema.encodeEffect(Policy)({
					entry: entry.id,
					policies: entry.sourcePolicies,
				})
				yield* sql`insert into openbot_bot_records (kind, organization_id, id, owner, scope, status, body) values ('memory_source_policy', ${home.organizationId}, ${policyId(home, entry.id)}, ${home.bot}, ${entry.id}, '', ${body}) on conflict (kind, organization_id, id) do update set body = excluded.body`
			}
		})
	const purge = (home: Home, tag: string) =>
		Effect.gen(function* () {
			const rows = yield* sql<{
				readonly id: string
			}>`delete from openbot_bot_memories where organization_id = ${home.organizationId} and home_bot = ${home.bot} and id in (select memory_id from openbot_bot_memory_tags where organization_id = ${home.organizationId} and home_bot = ${home.bot} and tag = ${tag}) returning id`
			const ids = Arr.map(rows, (row) => row.id)
			yield* Effect.forEach(
				Arr.chunksOf(ids, 500),
				(ids) =>
					sql`delete from openbot_bot_records where kind = 'memory_source_policy' and organization_id = ${home.organizationId} and ${sql.in(
						"id",
						Arr.map(ids, (id) => policyId(home, id)),
					)}`,
				{ discard: true },
			)
			return ids
		})
	return {
		read: locked(true),
		change: locked(false),
		metadata,
		closure,
		sealedContent,
		openContent,
		contents,
		write,
		purge,
	}
})
