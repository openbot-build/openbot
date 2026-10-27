import * as ErrorRecords from "../src/errors/Records.ts"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Execution } from "@openbot-build/domain"
import {
	Config,
	Effect,
	Layer,
	Redacted,
	Schema,
	Stream,
	String as Str,
} from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Observation from "../src/execution/Observation.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"

const main = Effect.gen(function* () {
	const url = yield* Config.Redacted("OBSERVE_DATABASE_URL")
	const node = yield* Config.Int("OBSERVE_NODE")
	const namespace = yield* Config.String("OBSERVE_NAMESPACE")
	const id = Execution.Id.make(yield* Config.String("OBSERVE_EXECUTION_ID"))
	const after = yield* Config.Int("OBSERVE_AFTER")
	const services = Layer.merge(Store.layer, ErrorRecords.layer).pipe(
		Layer.provideMerge(
			Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
		),
		Layer.provideMerge(DatabasePostgres.layer({ databaseUrl: url })),
	)
	yield* Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		const store = yield* Store.Store
		const tracked = Store.Store.of({
			...store,
			events: (key, cursor) =>
				store.events(key, cursor).pipe(
					Effect.tap(() =>
						sql`insert into observation_process_reads (node, ready) values (${node}, true)
							on conflict (node) do nothing`.pipe(
							Effect.mapError((cause) =>
								Execution.StorageError.make({ cause }),
							),
						),
					),
				),
		})
		const events = yield* Effect.gen(function* () {
			const observation = yield* Observation.Observation
			return yield* Stream.runCollect(
				observation.observe({ namespace, id }, after),
			)
		}).pipe(
			Effect.provide(Observation.layer),
			Effect.provideService(Store.Store, tracked),
		)
		const encoded = yield* Schema.encodeEffect(
			Schema.fromJsonString(Schema.Array(Execution.Event)),
		)(events)
		yield* sql`update observation_process_reads set events = ${encoded}::jsonb where node = ${node}`
	}).pipe(Effect.provide(services))
}).pipe(Effect.provide(NodeServices.layer))

NodeRuntime.runMain(main)
