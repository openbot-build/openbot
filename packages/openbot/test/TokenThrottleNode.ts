import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Array as Arr, Config, Effect, Layer, Schedule } from "effect"
import * as Fixture from "./TokenThrottleFixture.ts"

const main = Effect.gen(function* () {
	const runner = yield* Config.Int("TEST_RUNNER_ID")
	const sql = yield* PgClient.PgClient
	const throttle = yield* Fixture.make
	yield* sql`insert into token_test_nodes (runner) values (${runner})`
	yield* sql<{
		readonly go: boolean
	}>`select go from token_test_nodes where runner = ${runner}`.pipe(
		Effect.repeat({
			schedule: Schedule.spaced("10 millis"),
			until: (rows) => rows[0]?.go === true,
		}),
	)
	yield* Effect.forEach(
		Arr.range(0, 11),
		(slot) =>
			throttle.take([Fixture.scope("two-processes")], 10).pipe(
				Effect.andThen(sql`insert into token_test_results (runner, slot, done) values
			(${runner}, ${slot}, extract(epoch from clock_timestamp())::float8 * 1000)`),
			),
		{ concurrency: "unbounded", discard: true },
	)
})

const services = Layer.unwrap(
	Effect.map(Config.Redacted("TEST_DATABASE_URL"), (url) =>
		PgClient.layer({ url }),
	),
).pipe(Layer.provideMerge(NodeServices.layer))

main.pipe(Effect.provide(services), Effect.scoped, NodeRuntime.runMain)
