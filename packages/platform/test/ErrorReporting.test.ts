// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Session } from "@openbot-build/core"
import {
	Cause,
	ConfigProvider,
	Effect,
	Exit,
	Layer,
	Logger,
	Redacted,
	References,
	Stream,
} from "effect"
import { LanguageModel } from "effect/ai"
import { HttpRouter, HttpServerResponse } from "effect/http"
import * as ErrorReporting from "../src/app/ErrorReporting.ts"
import * as EnvironmentConfiguration from "../src/configuration/EnvironmentConfiguration.ts"
import * as ManagedSessions from "../src/sessions/ManagedSessions.ts"
import * as Approvals from "../src/approvals/Approvals.ts"
import * as RepositoryPostgres from "../src/sessions/RepositoryPostgres.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

test("HTTP failures are reported once with route templates, and rejections keep their status", async () => {
	let logs: ReadonlyArray<Readonly<Record<string, unknown>>> = []
	const collector = Logger.layer([
		Logger.make((log) => {
			if (log.logLevel === "Error")
				logs = [...logs, log.fiber.getRef(References.CurrentLogAnnotations)]
		}),
	])
	const routes = Layer.mergeAll(
		HttpRouter.add("GET", "/fault/:id", Effect.die(new Error("private-token"))),
		HttpRouter.add(
			"GET",
			"/unavailable",
			HttpServerResponse.empty({ status: 503 }),
		),
		HttpRouter.add("GET", "/reject", HttpServerResponse.empty({ status: 400 })),
		HttpRouter.add("GET", "/cancel", Effect.interrupt),
		ErrorReporting.layerHttp,
	).pipe(Layer.provideMerge(collector))
	const { handler, dispose } = HttpRouter.toWebHandler(routes, {
		disableLogger: true,
	})
	try {
		assert.equal(
			(
				await handler(
					new Request(
						"https://example.com/fault/private-id?token=private-token",
					),
				)
			).status,
			500,
		)
		assert.equal(
			(await handler(new Request("https://example.com/unavailable"))).status,
			503,
		)
		assert.equal(
			(await handler(new Request("https://example.com/reject"))).status,
			400,
		)
		assert.equal(
			(await handler(new Request("https://example.com/missing"))).status,
			404,
		)
		assert.equal(
			(await handler(new Request("https://example.com/cancel"))).status,
			503,
		)
		assert.equal(logs.length, 2)
		assert.deepEqual(
			logs.map((log) => log["route"]),
			["/fault/:id", "/unavailable"],
		)
		assert.match(String(logs[0]!["requestId"]), /^[0-9a-f-]{36}$/)
		assert.doesNotMatch(JSON.stringify(logs), /private-id|private-token/)
	} finally {
		await dispose()
	}
})

test("startup reports configuration failure before a database is available and keeps its failure", async () => {
	let sent = 0
	const exit = await Effect.runPromiseExit(
		ErrorReporting.withStartup(EnvironmentConfiguration.load).pipe(
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromUnknown({}),
			),
			Effect.provide(
				Logger.layer([
					Logger.make((log) => {
						if (log.logLevel === "Error") sent++
					}),
				]),
			),
		),
	)
	assert.ok(Exit.isFailure(exit))
	assert.equal(sent, 1)
	if (Exit.isFailure(exit))
		assert.match(Cause.pretty(exit.cause), /OPENBOT_DATABASE_URL/)
	const cancelled = await Effect.runPromiseExit(
		ErrorReporting.withStartup(Effect.interrupt).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make(() => {
						sent++
					}),
				]),
			),
		),
	)
	assert.ok(Exit.isFailure(cancelled))
	assert.equal(sent, 1)
})

test(
	"saved Turn failures are reported once across later updates, and cancellation is not reported",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		let logs: ReadonlyArray<Readonly<Record<string, unknown>>> = []
		const layer = Layer.mergeAll(
			RepositoryPostgres.layer,
			Approvals.layer,
		).pipe(
			Layer.provideMerge(
				DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
			),
			Layer.provideMerge(
				Logger.layer([
					Logger.make((log) => {
						if (log.logLevel === "Error")
							logs = [
								...logs,
								log.fiber.getRef(References.CurrentLogAnnotations),
							]
					}),
				]),
			),
			Layer.provide(NodeServices.layer),
		)
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* DatabasePostgres.migrate
						const sessions = yield* ManagedSessions.make({
							memory: { defaults: { generate: false } },
						})
						const failing = yield* LanguageModel.make({
							generateText: () => Effect.die(new Error("Model unavailable")),
							streamText: () => Stream.die(new Error("Model unavailable")),
						})
						const slow = yield* LanguageModel.make({
							generateText: () => Effect.never,
							streamText: () => Stream.never,
						})
						const created = yield* sessions.create({})
						const receipt = yield* sessions
							.send(created.session.id, {
								input: "Private input",
								expected: created.session.revision,
							})
							.pipe(Effect.provideService(LanguageModel.LanguageModel, failing))
						const wait = (id: Session.Id): ReturnType<typeof sessions.get> =>
							Effect.gen(function* () {
								const view = yield* sessions.get(id)
								if (view.activity !== "active") return view
								yield* sessions.wait(
									id,
									view.session.revision,
									50,
									view.activity,
								)
								return yield* wait(id)
							})
						const failed = yield* wait(created.session.id)
						assert.equal(failed.response?.status, "failed")
						assert.equal(logs.length, 1)
						assert.equal(logs[0]!["sessionId"], created.session.id)
						assert.equal(logs[0]!["turnId"], receipt.id)
						yield* sessions.update(created.session.id, {
							expected: failed.session.revision,
							title: "Renamed",
						})
						assert.equal(logs.length, 1)
						const other = yield* sessions.create({})
						const pending = yield* sessions
							.send(other.session.id, {
								input: "Cancel",
								expected: other.session.revision,
							})
							.pipe(Effect.provideService(LanguageModel.LanguageModel, slow))
						yield* sessions.interrupt(
							other.session.id,
							Session.currentTurn(
								(yield* sessions.get(other.session.id)).session,
							)!.id,
						)
						const cancelled = yield* wait(other.session.id)
						assert.equal(cancelled.response?.id, pending.id)
						assert.equal(cancelled.response?.status, "cancelled")
						assert.equal(logs.length, 1)
					}),
				).pipe(Effect.provide(layer)),
			)
		} finally {
			await database.close()
		}
	},
)

test("database startup failure is reported without a working database", async () => {
	let sent = 0
	const program = DatabasePostgres.check.pipe(
		Effect.provide(
			DatabasePostgres.layer({
				databaseUrl: Redacted.make("postgres://127.0.0.1:1/unavailable"),
			}).pipe(Layer.provide(NodeServices.layer)),
		),
	)
	const exit = await Effect.runPromiseExit(
		ErrorReporting.withStartup(program).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((log) => {
						if (log.logLevel === "Error") sent++
					}),
				]),
			),
		),
	)
	assert.ok(Exit.isFailure(exit))
	assert.equal(sent, 1)
})
