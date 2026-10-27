import { Execution } from "@openbot-build/domain"
import * as Failures from "../src/errors/Failures.ts"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import {
	Cause,
	Effect,
	Deferred,
	Fiber,
	Exit,
	Layer,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { codec, snapshot } from "../src/errors/Snapshot.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Records from "../src/errors/Records.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const services = Records.layer.pipe(
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeServices.layer),
)
layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	for (const phase of ["seal", "write"] as const)
		it.effect(`an interrupted error ${phase} stays interrupted`, () =>
			Effect.gen(function* () {
				const secrets = yield* Secrets.Secrets
				const sql = yield* PgClient.PgClient
				const locked = yield* Deferred.make<void>()
				const release = yield* Deferred.make<void>()
				if (phase === "write") {
					yield* sql
						.withTransaction(
							Effect.gen(function* () {
								yield* sql`lock table openbot_execution_failures in access exclusive mode`
								yield* Deferred.succeed(locked, undefined)
								yield* Deferred.await(release)
							}),
						)
						.pipe(Effect.forkScoped)
					yield* Deferred.await(locked)
				}
				const entered = yield* Deferred.make<void>()
				const service = Layer.succeed(Secrets.Secrets, {
					...secrets,
					seal: (value, binding) =>
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(
								phase === "seal" ? Effect.never : secrets.seal(value, binding),
							),
						),
				})
				const running = yield* Effect.gen(function* () {
					const records = yield* Records.Records
					return yield* records.record(
						Cause.fail("private failure"),
						"unavailable",
					)
				}).pipe(
					Effect.provide(
						Layer.fresh(Records.layer.pipe(Layer.provide(service))),
					),
					Effect.forkScoped,
				)
				yield* Deferred.await(entered)
				if (phase === "write")
					yield* Effect.gen(function* () {
						while (true) {
							const waiting =
								yield* sql`select pid from pg_stat_activity where wait_event_type = 'Lock' and query like '%openbot_execution_failures%'`
							if (waiting.length > 0) return
							yield* Effect.sleep("10 millis")
						}
					}).pipe(Effect.timeout("2 seconds"))
				yield* Fiber.interrupt(running).pipe(Effect.timeout("2 seconds"))
				const exit = yield* Fiber.await(running)
				assert.isTrue(Exit.isFailure(exit))
				if (Exit.isFailure(exit))
					assert.isTrue(Cause.hasInterruptsOnly(exit.cause))
				yield* Deferred.succeed(release, undefined)
			}),
		)
	it.effect(
		"a replaced storage error keeps its redacted Cause in the sealed record",
		() =>
			Effect.gen(function* () {
				const records = yield* Records.Records
				const secrets = yield* Secrets.Secrets
				const sql = yield* PgClient.PgClient
				const original = Execution.StorageError.make({
					cause: Redacted.make(Cause.fail(new Error("private-driver-token"))),
				})
				const result = yield* Effect.fail(original).pipe(
					Failures.replace("The store failed.", () => ({
						_tag: "StoreUnavailable",
					})),
					Effect.exit,
				)
				assert.isTrue(Exit.isFailure(result))
				if (!Exit.isFailure(result)) return
				const { errorId } = yield* records.record(result.cause, "unavailable")
				const [row] = yield* sql<{
					readonly cause: string
				}>`select cause from openbot_execution_failures where id = ${errorId}`
				assert.isDefined(row)
				assert.notMatch(row!.cause, /private-driver-token/)
				const plain = yield* secrets.open(row!.cause, `failure:${errorId}`)
				assert.match(plain, /private-driver-token/)
			}),
	)
	it.effect("error snapshots keep the Effect call location", () =>
		Effect.gen(function* () {
			const fail = Effect.fn("snapshot-location-check")(function* () {
				return yield* Effect.fail("The call failed.")
			})
			const exit = yield* fail().pipe(Effect.exit)
			assert.isTrue(Exit.isFailure(exit))
			if (!Exit.isFailure(exit)) return
			const diagnostic = yield* exit.cause.pipe(
				snapshot,
				Schema.encodeEffect(codec),
			)
			assert.isTrue(Str.includes("snapshot-location-check")(diagnostic))
			assert.isTrue(Str.includes("ErrorRecords.test.ts:")(diagnostic))
		}),
	)
	it.effect(
		"a failed database write and failed backup seal keep all three causes",
		() =>
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				const secrets = yield* Secrets.Secrets
				const seals = yield* Ref.make(0)
				const rollback = { _tag: "TestRollback" } as const
				const broken = Layer.succeed(Secrets.Secrets, {
					...secrets,
					seal: (value, binding) =>
						Ref.updateAndGet(seals, (n) => n + 1).pipe(
							Effect.flatMap((n) =>
								n === 1
									? secrets.seal(value, binding)
									: Effect.fail(
											Secrets.SecretStorageError.make({
												message: "private backup error",
											}),
										),
							),
						),
				})
				yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* sql`set transaction read only`
							const result = yield* Effect.gen(function* () {
								return yield* (yield* Records.Records).record(
									Cause.fail("private original"),
									"unavailable",
								)
							}).pipe(
								Effect.provide(
									Layer.fresh(Records.layer.pipe(Layer.provide(broken))),
								),
								Effect.flip,
							)
							assert.isTrue(Redacted.isRedacted(result.cause))
							if (!Redacted.isRedacted(result.cause)) return
							const combined = Redacted.value(result.cause)
							assert.isTrue(Cause.isCause(combined))
							if (!Cause.isCause(combined)) return
							const diagnostic = yield* combined.pipe(
								snapshot,
								Schema.encodeEffect(codec),
							)
							for (const text of [
								"private original",
								"private backup error",
								"read-only transaction",
							])
								assert.isTrue(Str.includes(text)(diagnostic), text)
							return yield* Effect.fail(rollback)
						}),
					)
					.pipe(
						Effect.catchIf(
							(error) => error === rollback,
							() => Effect.void,
						),
					)
			}),
	)
	it.effect(
		"sealed error records keep stacks, driver fields and every reason",
		() =>
			Effect.gen(function* () {
				const records = yield* Records.Records
				const secrets = yield* Secrets.Secrets
				const sql = yield* PgClient.PgClient
				const inner = Object.assign(new Error("inner error"), {
					stack: "inner stack",
				})
				const outer = Object.assign(
					new Error("outer error", { cause: inner }),
					{
						stack: "outer stack",
						code: "PG_TEST",
						secret: Redacted.make("not in the record"),
					},
				)
				const cause = Cause.combine(
					Cause.fail(outer),
					Cause.combine(Cause.die("driver defect"), Cause.interrupt(12)),
				)
				const { errorId } = yield* records.record(cause, "unavailable")
				const [row] = yield* sql<{
					readonly cause: string
				}>`select cause from openbot_execution_failures where id = ${errorId}`
				assert.isDefined(row)
				const saved = row!.cause
				assert.isFalse(Str.includes("outer error")(saved))
				const plain = yield* secrets.open(saved, `failure:${errorId}`)
				for (const text of [
					"inner stack",
					"outer stack",
					"PG_TEST",
					"driver defect",
					"Interrupt",
					"Fail",
					"Die",
				])
					assert.isTrue(Str.includes(text)(plain), text)
				assert.isFalse(Str.includes("not in the record")(plain))
			}),
	)
	it.effect(
		"a failed error recorder keeps both causes without exposing them",
		() =>
			Effect.gen(function* () {
				const original = Cause.fail(new Error("private original"))
				const broken = Layer.mock(Secrets.Secrets, {
					seal: () =>
						Effect.fail(
							Secrets.SecretStorageError.make({
								message: "private seal error",
							}),
						),
				})
				const result = yield* Effect.gen(function* () {
					return yield* (yield* Records.Records).record(original, "unavailable")
				}).pipe(
					Effect.provide(
						Layer.fresh(Records.layer.pipe(Layer.provide(broken))),
					),
					Effect.flip,
				)
				assert.isTrue(Redacted.isRedacted(result.cause))
				if (!Redacted.isRedacted(result.cause)) return
				const combined = Redacted.value(result.cause)
				assert.isTrue(Cause.isCause(combined))
				if (!Cause.isCause(combined)) return
				const diagnostic = Cause.pretty(combined)
				assert.isTrue(Str.includes("private original")(diagnostic))
				assert.isTrue(Str.includes("private seal error")(diagnostic))
			}),
	)
})
