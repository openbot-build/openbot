import { assert, it } from "@effect/vitest"
import {
	Chat,
	ChatRuntime,
	ChatStoreRepository,
	MemoryPersistence,
	Plugin,
	Store,
} from "@openbot-build/core"
import { Array as Arr, Context, Effect, Option, Schema, Stream } from "effect"
import { LanguageModel, Response, Tool, Toolkit } from "effect/ai"
import { finish, textParts } from "./LanguageModelTest.ts"

class CallerDependency extends Context.Service<CallerDependency, string>()(
	"@openbot-build/core/test/HostPlugin.test/CallerDependency",
) {}
it.effect(
	"a scoped host plugin owns its dynamic handlers, and caller tools keep the dependencies the caller gave them",
	() => {
		let opened = 0
		let closed = 0
		let callerCalls = 0
		let hostedCalls = 0
		const caller = Tool.make("CallerTool", {
			success: Schema.String,
		}).addDependency(CallerDependency)
		const callerToolkit = Toolkit.make(caller)
		const hosted = Tool.dynamic("HostedTool", {
			parameters: { type: "object", properties: {} },
			success: Schema.String,
		})
		const hostPlugin = Plugin.make({ id: Plugin.Id.make("hosted-test") })<{
			HostedTool: typeof hosted
		}>(() =>
			Effect.succeed((next, input) =>
				Stream.scoped(
					Stream.unwrap(
						Effect.gen(function* () {
							yield* Effect.acquireRelease(
								Effect.sync(() => {
									opened++
								}),
								() =>
									Effect.sync(() => {
										closed++
									}),
							)
							const incoming = yield* input.toolkit
							const toolkit = Toolkit.make(hosted)
							const handlers = yield* toolkit.toHandlers({
								HostedTool: () =>
									Effect.sync(() => {
										hostedCalls++
										return "owned by this Turn"
									}),
							})
							return next({
								...input,
								toolkit: Effect.succeed(Toolkit.merge(incoming, toolkit)),
							}).pipe(Stream.provideContext(handlers))
						}),
					),
				),
			),
		)
		return Effect.gen(function* () {
			const model = yield* LanguageModel.make({
				generateText: () => Effect.succeed([]),
				streamText: ({ prompt, tools }) =>
					Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
						assert.ok(Arr.some(tools, (tool) => tool.name === "CallerTool"))
						assert.ok(Arr.some(tools, (tool) => tool.name === "HostedTool"))
						const user = Arr.findLastIndex(
							prompt.content,
							(message) => message.role === "user",
						)
						assert.ok(Option.isSome(user))
						const last = user.value
						const answered = Arr.some(
							Arr.drop(prompt.content, last + 1),
							(message) => message.role === "tool",
						)
						return answered
							? Stream.fromArray(textParts("Done"))
							: Stream.make(
									Response.makePart("tool-call", {
										id: "caller-" + last,
										name: "CallerTool",
										params: {},
										providerExecuted: false,
									}),
									Response.makePart("tool-call", {
										id: "hosted-" + last,
										name: "HostedTool",
										params: {},
										providerExecuted: false,
									}),
									finish("tool-calls"),
								)
					}),
			})
			yield* Effect.scoped(
				Effect.gen(function* () {
					const definition = yield* Store.define({
						stores: {},
						schemaVersion: "hosted/1",
					})
					const store = yield* ChatStoreRepository.make({
						definition,
						persistence: yield* MemoryPersistence.make,
					})
					const runtime = yield* ChatRuntime.make({
						store,
						bot: { toolkit: callerToolkit, hostPlugin },
					})
					const view = yield* store.create({})
					assert.strictEqual(opened, 0)
					for (const input of ["First Turn", "Second Turn"]) {
						const completed = yield* runtime.execute({
							chat: view.chat.id,
							input,
						})
						assert.strictEqual(Chat.status(completed.chat)._tag, "Completed")
						assert.strictEqual(opened, closed)
					}
					assert.strictEqual((yield* store.turns(view.chat.id)).length, 2)
				}),
			).pipe(
				Effect.provideService(LanguageModel.LanguageModel, model),
				Effect.provide(
					callerToolkit.toLayer({
						CallerTool: () =>
							Effect.map(CallerDependency, (value) => {
								callerCalls++
								return value
							}),
					}),
				),
				Effect.provideService(CallerDependency, "caller-owned dependency"),
			)
			assert.strictEqual(callerCalls, 2)
			assert.strictEqual(hostedCalls, 2)
			assert.strictEqual(opened, 2)
			assert.strictEqual(closed, 2)
		})
	},
)
