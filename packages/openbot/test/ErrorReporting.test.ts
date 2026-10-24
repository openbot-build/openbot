// @effect-diagnostics strictEffectProvide:off
import * as BotFixture from "./BotFixture.ts"
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Chat } from "@openbot-build/core"
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
import { LanguageModel, type Prompt } from "effect/ai"
import { HttpRouter, HttpServerResponse } from "effect/http"
import * as ErrorReporting from "../src/app/ErrorReporting.ts"
import * as EnvironmentConfiguration from "../src/configuration/EnvironmentConfiguration.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as ManagedChats from "../src/chats/ManagedChats.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

it("HTTP failures are reported once with route templates, and rejections keep their status", async () => {
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
		assert.strictEqual(
			(
				await handler(
					new Request(
						"https://example.com/fault/private-id?token=private-token",
					),
				)
			).status,
			500,
		)
		assert.strictEqual(
			(await handler(new Request("https://example.com/unavailable"))).status,
			503,
		)
		assert.strictEqual(
			(await handler(new Request("https://example.com/reject"))).status,
			400,
		)
		assert.strictEqual(
			(await handler(new Request("https://example.com/missing"))).status,
			404,
		)
		assert.strictEqual(
			(await handler(new Request("https://example.com/cancel"))).status,
			503,
		)
		assert.strictEqual(logs.length, 2)
		assert.deepStrictEqual(
			logs.map((log) => log["route"]),
			["/fault/:id", "/unavailable"],
		)
		assert.match(String(logs[0]!["requestId"]), /^[0-9a-f-]{36}$/)
		assert.notMatch(JSON.stringify(logs), /private-id|private-token/)
	} finally {
		await dispose()
	}
})

it.effect(
	"startup reports configuration failure before a database is available and keeps its failure",
	() =>
		Effect.gen(function* () {
			let sent = 0
			const exit = yield* ErrorReporting.withStartup(
				EnvironmentConfiguration.load,
			).pipe(
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
				Effect.exit,
			)
			assert.ok(Exit.isFailure(exit))
			assert.strictEqual(sent, 1)
			if (Exit.isFailure(exit))
				assert.match(Cause.pretty(exit.cause), /OPENBOT_DATABASE_URL/)
			const cancelled = yield* ErrorReporting.withStartup(
				Effect.interrupt,
			).pipe(
				Effect.provide(
					Logger.layer([
						Logger.make(() => {
							sent++
						}),
					]),
				),
				Effect.exit,
			)
			assert.ok(Exit.isFailure(cancelled))
			assert.strictEqual(sent, 1)
		}),
)

// This test runs a real PostgreSQL and waits for real Turns, so it needs the real clock.
it.live(
	"saved Turn failures are reported once across later updates, and cancellation is not reported",
	() =>
		Effect.gen(function* () {
			const database = yield* Effect.acquireRelease(
				Effect.promise(() => PostgresTest.start()),
				(database) => Effect.promise(() => database.close()),
			)
			let logs: ReadonlyArray<Readonly<Record<string, unknown>>> = []
			const layer = DatabasePostgres.layer({
				databaseUrl: Redacted.make(database.url),
			}).pipe(
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
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* DatabasePostgres.migrate
					// The model fails for one Chat and never answers in the other.
					const failsOrWaits = (prompt: Prompt.Prompt) =>
						JSON.stringify(prompt.content).includes("Cancel")
					const model = yield* LanguageModel.make({
						generateText: ({ prompt }) =>
							failsOrWaits(prompt)
								? Effect.never
								: Effect.die(new Error("Model unavailable")),
						streamText: ({ prompt }) =>
							failsOrWaits(prompt)
								? Stream.never
								: Stream.die(new Error("Model unavailable")),
					})
					const chats = yield* ManagedChats.make().pipe(
						Effect.provideService(LanguageModel.LanguageModel, model),
					)
					const author = ChatHost.authorOf("test-user")
					const created = yield* chats.create(BotFixture.direct())
					const receipt = yield* chats.deliver(created.chat.id, {
						input: "Private input",
						author,
					})
					const wait = (id: Chat.Id): ReturnType<typeof chats.get> =>
						Effect.gen(function* () {
							const view = yield* chats.get(id)
							if (view.activity !== "active") return view
							yield* chats.wait(id, view.chat.revision, 50, view.activity)
							return yield* wait(id)
						})
					const failed = yield* wait(created.chat.id)
					assert.strictEqual(failed.response?.status, "failed")
					assert.strictEqual(logs.length, 1)
					assert.strictEqual(logs[0]!["chatId"], created.chat.id)
					assert.strictEqual(logs[0]!["turnId"], receipt.turn)
					yield* chats.update(created.chat.id, {
						expected: failed.chat.revision,
						mode: "plan",
					})
					assert.strictEqual(logs.length, 1)
					const other = yield* chats.create({
						...BotFixture.direct(),
						kind: "task",
					})
					const pending = yield* chats.deliver(other.chat.id, {
						input: "Cancel",
						author,
					})
					yield* chats.interrupt(other.chat.id)
					const cancelled = yield* wait(other.chat.id)
					assert.strictEqual(cancelled.response?.id, pending.turn)
					assert.strictEqual(cancelled.response?.status, "cancelled")
					assert.strictEqual(logs.length, 1)
				}),
			).pipe(Effect.provide(layer))
		}),
)

// The database client tries a real network connection, so this test needs the real clock.
it.live("database startup failure is reported without a working database", () =>
	Effect.gen(function* () {
		let sent = 0
		const program = DatabasePostgres.check.pipe(
			Effect.provide(
				DatabasePostgres.layer({
					databaseUrl: Redacted.make("postgres://127.0.0.1:1/unavailable"),
				}).pipe(Layer.provide(NodeServices.layer)),
			),
		)
		const exit = yield* ErrorReporting.withStartup(program).pipe(
			Effect.provide(
				Logger.layer([
					Logger.make((log) => {
						if (log.logLevel === "Error") sent++
					}),
				]),
			),
			Effect.exit,
		)
		assert.ok(Exit.isFailure(exit))
		assert.strictEqual(sent, 1)
	}),
)
