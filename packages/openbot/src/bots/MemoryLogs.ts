import { PgClient } from "@effect/sql-pg"
import { BotMemory, Bots } from "@openbot-build/domain"
import { Context, Effect, Layer, Schema } from "effect"
import { Secrets } from "../secrets/Secrets.ts"
import * as Failures from "../errors/Failures.ts"
import type { Keys } from "./BotRecords.ts"

const unavailable = Failures.replace(
	"The memory log could not be read or written.",
	() => Bots.BotStorageUnavailable.make({}),
)
const make = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const secrets = yield* Secrets
	const binding = Schema.encodeEffect(
		Schema.fromJsonString(Schema.Array(Schema.String)),
	)
	const collection = <A, I>(kind: string, schema: Schema.Codec<A, I>) => {
		const codec = Schema.fromJsonString(Schema.toCodecJson(schema))
		return {
			put: (keys: Keys, value: A) =>
				Effect.gen(function* () {
					const body = yield* secrets.seal(
						yield* Schema.encodeEffect(codec)(value),
						yield* binding(["bot-record", kind, keys.organizationId, keys.id]),
					)
					yield* sql`insert into openbot_bot_records (kind, organization_id, id, owner, scope, status, body) values (${kind}, ${keys.organizationId}, ${keys.id}, ${keys.owner}, ${keys.scope}, ${keys.status}, ${body}) on conflict (kind, organization_id, id) do update set body = excluded.body`
				}).pipe(unavailable),
			list: (
				organizationId: string,
				filter: { readonly owner: string },
			): Effect.Effect<ReadonlyArray<A>, Bots.BotStorageUnavailable> =>
				sql<{
					id: string
					body: string
				}>`select id, body from openbot_bot_records where kind = ${kind} and organization_id = ${organizationId} and owner = ${filter.owner} order by id`.pipe(
					Effect.flatMap((rows) =>
						Effect.forEach(rows, (row) =>
							Effect.gen(function* () {
								const value = yield* secrets.open(
									row.body,
									yield* binding(["bot-record", kind, organizationId, row.id]),
								)
								return yield* Schema.decodeEffect(codec)(value)
							}),
						),
					),
					unavailable,
				),
		}
	}
	return {
		confessions: collection("confession", BotMemory.Confession),
		enrichments: collection("memory_enrichment", BotMemory.Enrichment),
		changes: collection(
			"memory_log",
			Schema.Struct({ bot: Bots.BotId, entry: BotMemory.LogEntry }),
		),
	}
})
export class MemoryLogs extends Context.Service<
	MemoryLogs,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/bots/MemoryLogs") {}
export const layer = Layer.effect(MemoryLogs, make)
