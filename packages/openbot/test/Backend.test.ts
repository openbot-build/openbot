import { assert, layer } from "@effect/vitest"
import { Operations, Plugin, PluginComposition } from "@openbot-build/core"
import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Exit,
	Layer,
	Option,
	Record as Rec,
	Ref,
	References,
	Result,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, type Prompt, Response, Tool, Toolkit } from "effect/ai"
import * as BackendLayers from "../src/app/BackendLayers.ts"
import { Backend } from "../src/app/Backend.ts"
import * as ChatFeatures from "../src/chats/ChatFeatures.ts"
import * as ChatHost from "../src/chats/ChatHost.ts"
import * as HostTools from "../src/chats/HostTools.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as ModelRegistry from "../src/models/ModelRegistry.ts"
import * as BotFixture from "./BotFixture.ts"
import * as ChatsFixture from "./ChatsFixture.ts"
import * as Wait from "./Wait.ts"

/** How long an unused runtime stays open in these tests. */
const idleTimeToLive = "300 millis"
/** Longer than `idleTimeToLive`, so an unused runtime has closed after it. */
const pastIdle = "800 millis"

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

/** A text answer of the model, in one stream. */
const answer = (text: string) =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

const Slow = Tool.make("Slow", {
	description: "Takes as long as the test wants.",
	parameters: Schema.Struct({}),
	success: Schema.String,
})
const slowToolkit = Toolkit.make(Slow)

/** True when the prompt has the result of a tool call. */
const hasToolResult = (prompt: Prompt.Prompt) =>
	Arr.some(
		prompt.content,
		(message) =>
			message.role === "tool" &&
			Arr.some(message.content, (part) => part.type === "tool-result"),
	)

/**
 * The model of these tests. It answers when `gate` opens. When the Turn has
 * the Slow tool, it calls it first, and answers after the result.
 */
const model = (gate: Deferred.Deferred<void>) =>
	LanguageModel.make({
		generateText: () => Effect.succeed([]),
		streamText: ({ prompt, tools }) => {
			const parts: Stream.Stream<Response.StreamPartEncoded> =
				hasToolResult(prompt) ||
				!Arr.some(tools, (tool) => tool.name === "Slow")
					? answer("done")
					: Stream.make(
							Response.makePart("tool-call", {
								id: "slow-call",
								name: "Slow",
								params: {},
								providerExecuted: false,
							}),
							Response.makePart("finish", { reason: "tool-calls", usage }),
						)
			return Stream.unwrap(Effect.as(Deferred.await(gate), parts))
		},
	})

/** The model registry of the tests: the test model for each organization. */
const registry = (answers: LanguageModel.LanguageModel) => {
	const models = ChatsFixture.models(answers)
	return Layer.mock(ModelRegistry.ModelRegistry, {
		catalog: () => models.modelCatalog,
		liveCatalog: () => Effect.succeed({ providers: [], models: [] }),
		resolve: (_organizationId, selection) => models.resolveModel(selection),
	})
}

interface Counters {
	/** How many runtimes were built. */
	readonly builds: Ref.Ref<number>
	/** How many runtimes are open now. */
	readonly open: Ref.Ref<number>
}

const counters = Effect.gen(function* () {
	const counters: Counters = {
		builds: yield* Ref.make(0),
		open: yield* Ref.make(0),
	}
	return counters
})

/**
 * Tools of the host that count the runtimes: each runtime builds the plugin
 * once, and holds one resource until it closes. `ready` runs in each build
 * before it ends. The Turns also get the Slow tool, which ends when
 * `slow` opens.
 */
const countingTools = (
	count: Counters,
	options: {
		readonly ready?: Effect.Effect<void>
		readonly slow?: Deferred.Deferred<void>
	} = {},
) =>
	Layer.effect(
		HostTools.HostTools,
		Effect.map(HostTools.HostTools, (tools) => {
			const resident = Plugin.make({ id: Plugin.Id.make("test-counting") })(
				() =>
					Effect.gen(function* () {
						yield* Ref.update(count.builds, (n) => n + 1)
						yield* Effect.acquireRelease(
							Ref.update(count.open, (n) => n + 1),
							() => Ref.update(count.open, (n) => n - 1),
						)
						yield* options.ready ?? Effect.void
						return (next, input) => next(input)
					}),
			)
			return HostTools.HostTools.of({
				plugin: PluginComposition.merge(resident, tools.plugin),
			})
		}),
	).pipe(
		Layer.provide(
			options.slow === undefined
				? HostTools.none
				: HostTools.layer({
						toolkit: slowToolkit,
						handlers: () =>
							slowToolkit.toLayer({
								Slow: () =>
									Deferred.await(options.slow!).pipe(Effect.as("slow done")),
							}),
					}),
		),
	)

/** The `deliver` that the plugins of a runtime got, once a runtime is built. */
type KeptDeliver = Ref.Ref<Option.Option<ChatFeatures.PluginInput["deliver"]>>

/**
 * Plugins that keep the `deliver` they get, as a command session of the
 * Computer plugin keeps it for the notice at its end.
 */
const keepDeliver = (kept: KeptDeliver) => (input: ChatFeatures.PluginInput) =>
	Plugin.make({ id: ChatFeatures.pluginId })<ChatFeatures.Tools>(() =>
		Effect.gen(function* () {
			yield* Ref.set(kept, Option.some(input.deliver))
			return (next, options) => next(options)
		}),
	)

/**
 * A Backend whose runtimes close after `idleTimeToLive`. A background tool
 * call starts after 50 milliseconds. With `kept`, the plugins keep their
 * `deliver` in it.
 */
const backend = (input: {
	readonly gate: Deferred.Deferred<void>
	readonly tools: Layer.Layer<HostTools.HostTools>
	readonly kept?: KeptDeliver
}) =>
	Layer.unwrap(
		Effect.map(model(input.gate), (answers) =>
			BackendLayers.layer({
				defaultModel: ChatsFixture.selection,
				idleTimeToLive,
			}).pipe(Layer.provide(registry(answers))),
		),
	).pipe(
		Layer.provide(input.tools),
		Layer.provide(
			Layer.effect(
				ChatFeatures.ChatFeatures,
				Effect.map(ChatFeatures.ChatFeatures, (none) =>
					ChatFeatures.ChatFeatures.of({
						...none,
						...(input.kept === undefined
							? {}
							: { plugins: keepDeliver(input.kept) }),
						operationSettings: () =>
							Effect.succeed({
								...Operations.defaultSettings,
								budget: "50 millis",
							}),
					}),
				),
			).pipe(Layer.provide(ChatFeatures.none)),
		),
	)

/**
 * A member of the test organization. Each test has its own member, so its
 * runtime and its direct Chat are its own.
 */
const memberNamed = (userId: string) => ({
	kind: "member" as const,
	organizationId: "test-organization",
	userId,
})

// The runtimes close after a real time, so the tests use the real clock.
layer(ChatsFixture.layerDatabase, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect(
		"an unused runtime closes after its time to live, and the next call builds it again",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const count = yield* counters
				const member = memberNamed("idle-member")
				const gate = yield* Deferred.make<void>()
				yield* Deferred.succeed(gate, undefined)
				yield* Effect.gen(function* () {
					const chats = yield* (yield* Backend).forCaller(member)
					const created = yield* chats.create(BotFixture.direct())
					assert.strictEqual(yield* Ref.get(count.builds), 1)
					assert.strictEqual(yield* Ref.get(count.open), 1)
					yield* Effect.sleep(pastIdle)
					assert.strictEqual(yield* Ref.get(count.open), 0)
					// The same Chats still work. The call builds the runtime again.
					const found = yield* chats.get(created.chat.id)
					assert.strictEqual(found.chat.id, created.chat.id)
					assert.strictEqual(yield* Ref.get(count.builds), 2)
					assert.strictEqual(yield* Ref.get(count.open), 1)
				}).pipe(Effect.provide(backend({ gate, tools: countingTools(count) })))
				// The Backend closes its runtimes when it closes.
				assert.strictEqual(yield* Ref.get(count.open), 0)
			}),
	)

	it.effect("a running Turn keeps its runtime open", () =>
		Effect.gen(function* () {
			yield* DatabasePostgres.migrate
			const count = yield* counters
			const member = memberNamed("running-member")
			const gate = yield* Deferred.make<void>()
			yield* Effect.gen(function* () {
				const chats = yield* (yield* Backend).forCaller(member)
				const created = yield* chats.create(BotFixture.direct())
				const receipt = yield* chats.deliver(created.chat.id, {
					input: "Wait for the gate",
					author: ChatHost.authorOf(member.userId),
				})
				assert.strictEqual(receipt.delivery, "started")
				yield* Effect.sleep(pastIdle)
				assert.strictEqual(yield* Ref.get(count.builds), 1)
				assert.strictEqual(yield* Ref.get(count.open), 1)
				yield* Deferred.succeed(gate, undefined)
				const done = yield* ChatsFixture.settled(chats, created.chat.id)
				assert.strictEqual(done.status, "Completed")
				yield* Effect.sleep(pastIdle)
				assert.strictEqual(yield* Ref.get(count.open), 0)
				assert.strictEqual(yield* Ref.get(count.builds), 1)
			}).pipe(Effect.provide(backend({ gate, tools: countingTools(count) })))
		}),
	)

	it.effect(
		"a background tool call keeps its runtime open until its notice reaches the Chat",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const count = yield* counters
				const member = memberNamed("background-member")
				const gate = yield* Deferred.make<void>()
				yield* Deferred.succeed(gate, undefined)
				const slow = yield* Deferred.make<void>()
				yield* Effect.gen(function* () {
					const chats = yield* (yield* Backend).forCaller(member)
					const created = yield* chats.create(BotFixture.direct())
					const id = created.chat.id
					yield* chats.deliver(id, {
						input: "Call the slow tool",
						author: ChatHost.authorOf(member.userId),
					})
					// The call goes on in the background, and the Turn ends.
					const first = yield* ChatsFixture.settled(chats, id)
					assert.strictEqual(first.status, "Completed")
					const [running] = yield* chats.operations.list(id)
					assert.strictEqual(running?.status._tag, "Running")
					yield* Effect.sleep(pastIdle)
					assert.strictEqual(yield* Ref.get(count.builds), 1)
					assert.strictEqual(yield* Ref.get(count.open), 1)
					// The end of the call starts a Turn with its notice.
					yield* Deferred.succeed(slow, undefined)
					yield* Wait.untilTrue(
						"the notice Turn of the background tool call",
						chats.turns(id, {}),
						(page) => page.items.length === 2,
						{ spacing: "50 millis", times: 200 },
					)
					const last = yield* ChatsFixture.settled(chats, id)
					assert.strictEqual(last.status, "Completed")
					yield* Effect.sleep(pastIdle)
					assert.strictEqual(yield* Ref.get(count.open), 0)
					assert.strictEqual(yield* Ref.get(count.builds), 1)
				}).pipe(
					Effect.provide(
						backend({ gate, tools: countingTools(count, { slow }) }),
					),
				)
			}),
	)

	it.effect(
		"the end of a command session reaches its Chat after the runtime closed",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const count = yield* counters
				const member = memberNamed("session-member")
				const gate = yield* Deferred.make<void>()
				yield* Deferred.succeed(gate, undefined)
				const kept = yield* Ref.make<
					Option.Option<ChatFeatures.PluginInput["deliver"]>
				>(Option.none())
				yield* Effect.gen(function* () {
					const chats = yield* (yield* Backend).forCaller(member)
					const created = yield* chats.create(BotFixture.direct())
					const id = created.chat.id
					// A command session keeps this `deliver` while its command runs.
					const deliver = yield* Ref.get(kept)
					assert.ok(Option.isSome(deliver))
					yield* Effect.sleep(pastIdle)
					assert.strictEqual(yield* Ref.get(count.open), 0)
					// The command ends after the runtime closed.
					const receipt = yield* deliver.value(id, {
						input: "The command ended.",
						author: ChatHost.authorOf(member.userId),
						notice: { kind: "computer_session", ref: "session-1" },
					})
					assert.strictEqual(receipt.delivery, "started")
					const done = yield* ChatsFixture.settled(chats, id).pipe(
						Effect.timeout("10 seconds"),
					)
					assert.strictEqual(done.status, "Completed")
					const page = yield* chats.turns(id, {})
					assert.deepStrictEqual(
						Arr.map(page.items, (turn) => turn.status._tag),
						["Completed"],
					)
					assert.strictEqual(yield* Ref.get(count.builds), 2)
				}).pipe(
					Effect.provide(backend({ gate, tools: countingTools(count), kept })),
				)
			}),
	)

	it.effect(
		"the build of one runtime does not wait for the build of another",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const count = yield* counters
				const member = memberNamed("parallel-member")
				const gate = yield* Deferred.make<void>()
				const both = yield* Deferred.make<void>()
				// Each build waits until two builds run at the same time.
				const ready = Ref.get(count.builds).pipe(
					Effect.flatMap((builds) =>
						builds >= 2 ? Deferred.succeed(both, undefined) : Effect.void,
					),
					Effect.andThen(Deferred.await(both)),
				)
				yield* Effect.gen(function* () {
					const service = yield* Backend
					return yield* Effect.all(
						[
							service.forCaller(member),
							service.forCaller({ ...member, userId: "other-user" }),
						],
						{ concurrency: "unbounded" },
					)
				}).pipe(
					Effect.timeout("10 seconds"),
					Effect.provide(
						backend({ gate, tools: countingTools(count, { ready }) }),
					),
				)
				assert.strictEqual(yield* Ref.get(count.builds), 2)
			}),
	)

	it.effect(
		"a failed build keeps its cause, and the next call builds again",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const count = yield* counters
				const member = memberNamed("failing-member")
				const gate = yield* Deferred.make<void>()
				yield* Effect.gen(function* () {
					const service = yield* Backend
					yield* Effect.forEach([1, 2], (builds) =>
						Effect.gen(function* () {
							const exit = yield* service.forCaller(member).pipe(Effect.exit)
							assert.ok(Exit.isFailure(exit))
							assert.deepStrictEqual(
								Result.getSuccess(Cause.findDefect(exit.cause)),
								Option.some("build failed"),
							)
							assert.strictEqual(yield* Ref.get(count.builds), builds)
							assert.strictEqual(yield* Ref.get(count.open), 0)
						}),
					)
				}).pipe(
					Effect.provide(
						backend({
							gate,
							tools: countingTools(count, {
								ready: Effect.die("build failed"),
							}),
						}),
					),
				)
			}),
	)

	it.effect(
		"a runtime does not keep the log annotations of the call that opens it",
		() =>
			Effect.gen(function* () {
				yield* DatabasePostgres.migrate
				const count = yield* counters
				const member = memberNamed("annotated-member")
				const gate = yield* Deferred.make<void>()
				const seen = yield* Ref.make<
					Option.Option<Readonly<Record<string, unknown>>>
				>(Option.none())
				const ready = Effect.gen(function* () {
					yield* Ref.set(
						seen,
						Option.some(yield* References.CurrentLogAnnotations),
					)
				})
				yield* Effect.gen(function* () {
					yield* (yield* Backend)
						.forCaller(member)
						.pipe(Effect.annotateLogs({ requestId: "first" }))
				}).pipe(
					Effect.provide(
						backend({ gate, tools: countingTools(count, { ready }) }),
					),
				)
				const annotations = yield* Ref.get(seen)
				assert.ok(Option.isSome(annotations))
				assert.isFalse(Rec.has(annotations.value, "requestId"))
			}),
	)
})
