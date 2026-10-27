import * as ErrorRecordsFixture from "./ErrorRecordsFixture.ts"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Exit,
	Fiber,
	Layer,
	Redacted,
	Schedule,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Response } from "effect/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { meter } from "../src/billing/MeteredModel.ts"
import { Billing } from "../src/billing/Billing.ts"
import * as TokenThrottle from "../src/billing/TokenThrottle.ts"
import * as Fixture from "./TokenThrottleFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

class Database extends Context.Service<Database, PostgresTest.Database>()(
	"@openbot-build/openbot/test/TokenThrottle.test/Database",
) {}

const tables = Layer.effectDiscard(
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		// These tests isolate the token bucket schema from the rest of the product.
		yield* sql`create table openbot_token_buckets (
		organization_id text not null, kind text not null, subject_id text not null,
		level float8 not null, updated_at float8 not null, tokens_per_second float8 not null,
		burst_tokens float8 not null, primary key (organization_id, kind, subject_id))`
		yield* sql`create table token_test_nodes (runner integer primary key, go boolean not null default false)`
		yield* sql`create table token_test_results (runner integer not null, slot integer not null, done float8 not null,
		primary key (runner, slot))`
	}),
).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Database, (database) =>
				PgClient.layer({ url: Redacted.make(database.url) }),
			),
		),
	),
)

const services = tables.pipe(
	Layer.provideMerge(Layer.effect(Database, PostgresTest.start)),
	Layer.provideMerge(NodeServices.layer),
)

const call = {
	organizationId: "org",
	providerId: "provider",
	providerOwner: "platform" as const,
	modelId: "model",
}
const elapsed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.map(Effect.timed(effect), ([duration, value]) => ({
		value,
		ms: Duration.toMillis(duration),
	}))

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect("each scope uses the lower rate and a distinct identity", () =>
		Effect.gen(function* () {
			const throttle = yield* TokenThrottle.make.pipe(
				Effect.provide([
					ErrorRecordsFixture.layer,
					Fixture.settings(
						{
							...Fixture.none,
							organization: { tokensPerSecond: 100, burstTokens: 50 },
							member: { tokensPerSecond: 10, burstTokens: 10 },
						},
						{
							...Fixture.none,
							organization: { tokensPerSecond: 200, burstTokens: 10 },
							bot: { tokensPerSecond: 30, burstTokens: 30 },
							token: { tokensPerSecond: 5, burstTokens: 5 },
						},
					),
				]),
			)
			assert.deepEqual(
				yield* throttle.scopes(call, {
					source: "turn",
					userId: "user",
					botId: "bot",
				}),
				[
					Fixture.scope("org", 100, 10),
					{
						identity: {
							organizationId: "org",
							kind: "member",
							subjectId: "user",
						},
						rate: { tokensPerSecond: 10, burstTokens: 10 },
					},
					{
						identity: { organizationId: "org", kind: "bot", subjectId: "bot" },
						rate: { tokensPerSecond: 30, burstTokens: 30 },
					},
				],
			)
		}),
	)

	it.effect("two service instances keep one burst and one pace", () =>
		Effect.gen(function* () {
			const first = yield* Fixture.make
			const second = yield* Fixture.make
			const scope = Fixture.scope("two-services", 100, 20)
			const result = yield* elapsed(
				Effect.forEach(
					[first, second, first, second],
					(throttle) => throttle.take([scope], 20),
					{ concurrency: "unbounded" },
				),
			)
			assert.isAtLeast(result.ms, 590)
			assert.isBelow(result.ms, 3000)
		}),
	)

	it.effect(
		"concurrent debits take from all shared scopes in one transaction",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const first = yield* Fixture.make
				const second = yield* Fixture.make
				const scopes = [
					Fixture.scope("atomic-a", 1, 1),
					Fixture.scope("atomic-b", 1, 1),
				]
				yield* Effect.forEach(
					Arr.range(0, 31),
					(index) =>
						(index % 2 === 1 ? first : second).charge(
							index % 2 === 1 ? scopes : Arr.reverse(scopes),
							10,
						),
					{ concurrency: "unbounded" },
				)
				const rows = yield* sql<{
					readonly level: number
				}>`select level from openbot_token_buckets where subject_id in ('atomic-a', 'atomic-b') order by subject_id`
				assert.equal(rows.length, 2)
				for (const row of rows) assert.closeTo(row.level, -319, 3)
				assert.closeTo(rows[0]?.level ?? 0, rows[1]?.level ?? 1, 0.001)
			}),
	)

	it.effect("identity fields cannot collide through punctuation", () =>
		Effect.gen(function* () {
			const sql = yield* PgClient.PgClient
			const throttle = yield* Fixture.make
			const first: TokenThrottle.Scope = {
				...Fixture.scope("c", 1, 10),
				identity: { organizationId: "a:b", kind: "member", subjectId: "c" },
			}
			const second: TokenThrottle.Scope = {
				...first,
				identity: { organizationId: "a", kind: "member", subjectId: "b:c" },
			}
			yield* throttle.charge([first], 100)
			yield* throttle.take([second], 10)
			assert.equal(
				(yield* sql`select subject_id from openbot_token_buckets where kind = 'member'`)
					.length,
				2,
			)
		}),
	)

	it.effect("a stop interrupts waiting without losing shared debt", () =>
		Effect.gen(function* () {
			const throttle = yield* Fixture.make
			const scope = Fixture.scope("cancel", 1, 1)
			const fiber = yield* Effect.forkChild(throttle.take([scope], 100))
			const sql = yield* PgClient.PgClient
			yield* sql`select level from openbot_token_buckets where subject_id = 'cancel'`.pipe(
				Effect.repeat({
					schedule: Schedule.spaced("10 millis"),
					until: (rows) => rows.length === 1,
				}),
				Effect.timeout("5 seconds"),
			)
			yield* Fiber.interrupt(fiber)
			assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(fiber)))
			const [row] = yield* sql<{
				readonly level: number
			}>`select level from openbot_token_buckets where subject_id = 'cancel'`
			assert.isBelow(row?.level ?? 0, -98)
		}),
	)

	it.effect(
		"confirmed counts give unused estimates back without growing the burst",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const throttle = yield* Fixture.make
				const scope = Fixture.scope("refund", 1, 10)
				yield* throttle.charge([scope], 100)
				yield* throttle.charge([scope], -200)
				assert.deepEqual(
					yield* sql`select level from openbot_token_buckets where subject_id = 'refund'`,
					[{ level: 10 }],
				)
			}),
	)

	it.effect(
		"a shared paced stream stays complete and settles its confirmed count",
		() =>
			Effect.gen(function* () {
				const pieces = Arr.makeBy(40, (index) =>
					Str.padStart(40, "x")(String(index)),
				)
				const throttle = yield* TokenThrottle.make.pipe(
					Effect.provide([
						ErrorRecordsFixture.layer,
						Fixture.settings(
							{
								...Fixture.none,
								organization: { tokensPerSecond: 2000, burstTokens: 100 },
							},
							Fixture.none,
						),
					]),
				)
				const model = yield* LanguageModel.make({
					generateText: () => Effect.succeed([]),
					streamText: () =>
						Stream.fromIterable<Response.StreamPartEncoded>([
							Response.makePart("text-start", { id: "text" }),
							...Arr.map(pieces, (delta) =>
								Response.makePart("text-delta", {
									id: "text",
									delta,
								}),
							),
							Response.makePart("text-end", { id: "text" }),
							Response.makePart("finish", {
								reason: "stop",
								usage: {
									inputTokens: { total: 2, uncached: 2, cacheRead: 0 },
									outputTokens: { total: 400, text: 400, reasoning: 0 },
								},
							}),
						]),
				})
				const billing = yield* Effect.provide(
					Billing,
					Layer.mock(Billing, {
						reserve: () =>
							Effect.succeed({
								id: Execution.CallId.make("stream"),
								startedAt: 0,
							}),
						unknown: () => Effect.void,
						record: () => Effect.void,
					}),
				)
				const result = yield* elapsed(
					meter(
						model,
						{ ...call, organizationId: "stream" },
						{
							throttle,
							billing,
							report: () => Effect.die("No rate error is expected."),
						},
					)
						.streamText({ prompt: "Write" })
						.pipe(Stream.runCollect),
				)
				assert.equal(
					Arr.filter(result.value, (part) => part.type === "text-delta").length,
					40,
				)
				assert.equal(
					Arr.join(
						Arr.flatMap(result.value, (part) =>
							part.type === "text-delta" ? [part.delta] : [],
						),
						"",
					),
					Arr.join(pieces, ""),
				)
				assert.isAtLeast(result.ms, 140)
			}),
	)

	it.effect("two Node processes keep the same token rate", () =>
		Effect.gen(function* () {
			const database = yield* Database
			const sql = yield* PgClient.PgClient
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const processes = yield* Effect.forEach([1, 2], (runner) =>
				spawner.spawn(
					ChildProcess.make(
						"node",
						[
							"--disable-warning=ExperimentalWarning",
							new URL("./TokenThrottleNode.ts", import.meta.url).pathname,
						],
						{
							extendEnv: true,
							env: {
								TEST_DATABASE_URL: database.url,
								TEST_RUNNER_ID: String(runner),
							},
							stdout: "inherit",
							stderr: "inherit",
							killSignal: "SIGKILL",
						},
					),
				),
			)
			assert.notEqual(processes[0]?.pid, processes[1]?.pid)
			yield* sql`select runner from token_test_nodes`.pipe(
				Effect.repeat({
					schedule: Schedule.spaced("20 millis"),
					until: (rows) => rows.length === 2,
				}),
				Effect.timeout("20 seconds"),
			)
			const [time] = yield* sql<{
				readonly at: number
			}>`select extract(epoch from clock_timestamp())::float8 * 1000 as at`
			yield* sql`update token_test_nodes set go = true`
			for (const process of processes) assert.equal(yield* process.exitCode, 0)
			const rows = yield* sql<{
				readonly done: number
			}>`select done from token_test_results order by done`
			assert.equal(rows.length, 24)
			for (const [index, row] of rows.entries()) {
				const available = 10 + (row.done - (time?.at ?? row.done)) / 10
				assert.isAtMost((index + 1) * 10, available + 1)
			}
			assert.isAtLeast((rows[23]?.done ?? 0) - (time?.at ?? 0), 2290)
		}),
	)
})
