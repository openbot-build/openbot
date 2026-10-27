import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import {
	Cause,
	Effect,
	Layer,
	Logger,
	Redacted,
	References,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Response } from "effect/ai"
import { Billing, BillingStorageError } from "../src/billing/Billing.ts"
import { CurrentCallIdentity, meter } from "../src/billing/MeteredModel.ts"
import { Unavailable } from "../src/billing/TokenThrottle.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Records from "../src/errors/Records.ts"
import * as Report from "../src/errors/Report.ts"
import * as Realtime from "../src/providers/openai/OpenAiRealtime.ts"
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
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const collect = () => {
	let lines: ReadonlyArray<unknown> = []
	return {
		lines: () => lines,
		layer: Logger.layer([
			Logger.make((log) => {
				lines = [
					...lines,
					{
						message: log.message,
						cause: Cause.pretty(log.cause),
						annotations: log.fiber.getRef(References.CurrentLogAnnotations),
					},
				]
			}),
		]),
	}
}
const opened = (errorId: Execution.ErrorId) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient
		const secrets = yield* Secrets.Secrets
		const [row] = yield* sql<{
			readonly cause: string
			readonly execution_id: string | null
		}>`select cause, execution_id from openbot_execution_failures where id = ${errorId}`
		assert.isDefined(row)
		assert.notMatch(row!.cause, /private-/)
		return {
			cause: yield* secrets.open(row!.cause, `failure:${errorId}`),
			executionId: row!.execution_id,
		}
	})
const counts = Response.Usage.make({
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	for (const step of [
		"reserve",
		"record",
		"unknown",
		"rate",
		"settle",
	] as const) {
		it.effect(
			`model ${step} errors keep all private data in sealed records`,
			() => {
				const logs = collect()
				return Effect.gen(function* () {
					const save = yield* Report.make
					let saved: ReadonlyArray<Execution.Failure> = []
					const report: Report.Report = (...input) =>
						save(...input).pipe(
							Effect.tap((failure) =>
								Effect.sync(() => {
									saved = [...saved, failure]
								}),
							),
						)
					const broken = Effect.failCause(
						Cause.combine(
							Cause.fail(
								BillingStorageError.make({ cause: `private-${step}-database` }),
							),
							Cause.die(new Error(`private-${step}-driver`)),
						),
					)
					const billing = yield* Billing.pipe(
						Effect.provide(
							Layer.mock(Billing, {
								reserve: () =>
									step === "reserve"
										? broken
										: Effect.succeed({
												id: Execution.CallId.make(`test-${step}`),
												startedAt: 1,
											}),
								record: () => (step === "record" ? broken : Effect.void),
								unknown: () => (step === "unknown" ? broken : Effect.void),
							}),
						),
					)
					const model = meter(
						yield* LanguageModel.make({
							generateText: () =>
								Effect.succeed([
									Response.makePart("finish", {
										reason: "stop",
										usage:
											step === "unknown"
												? Response.Usage.make({
														inputTokens: {
															total: undefined,
															uncached: undefined,
															cacheRead: undefined,
															cacheWrite: undefined,
														},
														outputTokens: {
															total: undefined,
															text: undefined,
															reasoning: undefined,
														},
													})
												: counts,
									}),
								]),
							streamText: () => Stream.empty,
						}),
						{
							organizationId: "org",
							modelId: "model",
							providerId: "provider",
							providerOwner: "platform",
						},
						{
							billing,
							report,
							throttle: {
								scopes: () =>
									step === "rate"
										? Effect.fail(
												Unavailable.make({ cause: "private-rate-database" }),
											)
										: Effect.succeed([]),
								take: () => Effect.void,
								charge: () =>
									step === "settle"
										? Effect.fail(
												Unavailable.make({ cause: "private-settle-database" }),
											)
										: Effect.succeed(0),
							},
						},
					)
					const executionId = Execution.Id.make(`test-${step}`)
					const result = yield* model.generateText({ prompt: "Answer." }).pipe(
						Effect.provideService(CurrentCallIdentity, {
							id: Execution.CallId.make(`test-${step}`),
							executionId,
							generation: 1,
						}),
						Effect.result,
					)
					assert.isAbove(saved.length, 0)
					const record = yield* opened(saved[0]!.errorId)
					assert.equal(record.executionId, executionId)
					assert.include(record.cause, `private-${step}-database`)
					if (step !== "rate" && step !== "settle")
						assert.include(record.cause, `private-${step}-driver`)
					if (step === "record") {
						assert.include(record.cause, "test-record")
						assert.include(record.cause, "inputUncached")
						assert.include(record.cause, "outputText")
					}
					const output = yield* encode([result, logs.lines()])
					assert.notMatch(output, /private-/)
					assert.include(output, saved[0]!.errorId)
				}).pipe(Effect.provide(logs.layer))
			},
		)
	}
	for (const event of [
		{
			type: "error",
			error: {
				message: "private-provider-error",
				code: "private-provider-code",
			},
		},
		{
			type: "response.done",
			response: { status: { detail: "private-protocol-error" } },
		},
	]) {
		it.effect(
			`Realtime ${event.type} errors keep their causes out of the public result`,
			() => {
				const logs = collect()
				return Effect.gen(function* () {
					const save = yield* Report.make
					let saved: ReadonlyArray<Execution.Failure> = []
					const report: Report.Report = (...input) =>
						save(...input).pipe(
							Effect.tap((failure) =>
								Effect.sync(() => {
									saved = [...saved, failure]
								}),
							),
						)
					const events = yield* Realtime.decodeEvent(
						yield* encode(event),
						report,
					)
					assert.equal(events.length, 1)
					assert.equal(events[0]!._tag, "Failure")
					assert.equal(saved.length, 1)
					assert.match(
						(yield* opened(saved[0]!.errorId)).cause,
						event.type === "error" ? /private-provider-error/ : /SchemaError/,
					)
					assert.notMatch(yield* encode([events, logs.lines()]), /private-/)
					assert.include(yield* encode(logs.lines()), saved[0]!.errorId)
				}).pipe(Effect.provide(logs.layer))
			},
		)
	}
})
