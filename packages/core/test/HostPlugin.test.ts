// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	MemoryPersistence,
	Plugin,
	SessionRuntime,
	SessionStoreRepository,
	Store,
} from "@openbot-build/core"
import { Context, Effect, Match, Schema, Stream } from "effect"
import { LanguageModel, Response, Tool, Toolkit } from "effect/ai"
import * as TimelineState from "../src/timeline/TimelineState.ts"

class CallerDependency extends Context.Service<CallerDependency, string>()(
	"@openbot-build/core/test/HostPlugin.test/CallerDependency",
) {}
test("a scoped host plugin owns its dynamic handlers, and caller tools keep the dependencies the caller gave them", async () => {
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
	const usage = {
		inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	}
	const model = await Effect.runPromise(
		LanguageModel.make({
			generateText: () => Effect.succeed([]),
			streamText: ({ prompt, tools }) =>
				Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
					assert.ok(tools.some((tool) => tool.name === "CallerTool"))
					assert.ok(tools.some((tool) => tool.name === "HostedTool"))
					const last = prompt.content.findLastIndex(
						(message) => message.role === "user",
					)
					const answered = prompt.content
						.slice(last + 1)
						.some((message) => message.role === "tool")
					return answered
						? Stream.make(
								Response.makePart("text-start", { id: "done" }),
								Response.makePart("text-delta", { id: "done", delta: "Done" }),
								Response.makePart("text-end", { id: "done" }),
								Response.makePart("finish", { reason: "stop", usage }),
							)
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
								Response.makePart("finish", { reason: "tool-calls", usage }),
							)
				}),
		}),
	)
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const definition = yield* Store.define({
					stores: {},
					schemaVersion: "hosted/1",
				})
				const store = yield* SessionStoreRepository.make({
					definition,
					persistence: yield* MemoryPersistence.make,
				})
				const runtime = yield* SessionRuntime.make({
					store,
					bot: { toolkit: callerToolkit, hostPlugin },
				})
				const view = yield* store.create({
					metadata: {},
					value: TimelineState.initial({}),
				})
				assert.equal(opened, 0)
				for (const input of ["First Turn", "Second Turn"]) {
					const current = yield* store.read(view.session.id)
					const completed = yield* runtime.execute({
						base: {
							session: current.session.id,
							revision: current.session.revision,
						},
						input,
					})
					assert.equal(
						Match.value(completed.session.turns.at(-1)?.status).pipe(
							Match.when({ _tag: "Completed" }, () => true),
							Match.orElse(() => false),
						),
						true,
					)
					assert.equal(opened, closed)
				}
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
		),
	)
	assert.equal(callerCalls, 2)
	assert.equal(hostedCalls, 2)
	assert.equal(opened, 2)
	assert.equal(closed, 2)
})
