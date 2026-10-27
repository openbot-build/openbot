import * as Read from "./Read.ts"
import {
	BrowserHost,
	Caller,
	Messages,
	Wait,
	Chats,
	Failures,
} from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import { Operation } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Deferred,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Ref,
	References,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import { HostTools } from "@openbot-build/openbot"

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
const slowToolkit = Toolkit.make(Slow.annotate(Operation.Budget, "50 millis"))

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

interface Counters {
	/** How many Turn resource sets were built. */
	readonly builds: Ref.Ref<number>
	/** How many Turn resource sets are open now. */
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
 * Tools of the host that count Turn resources. Each Turn opens its tools
 * and holds its resource until the Turn and its tools end. `ready` runs in each build
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
		Effect.map(HostTools.HostTools, (tools) =>
			HostTools.HostTools.of({
				register: Effect.gen(function* () {
					yield* Ref.update(count.builds, (n) => n + 1)
					yield* Effect.acquireRelease(
						Ref.update(count.open, (n) => n + 1),
						() => Ref.update(count.open, (n) => n - 1),
					)
					yield* options.ready ?? Effect.void
					return yield* tools.register
				}),
			}),
		),
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

const start = (
	name: string,
	gate: Deferred.Deferred<void>,
	tools: Layer.Layer<HostTools.HostTools>,
) =>
	Effect.gen(function* () {
		const publicOrigin = `https://${name}.example.com`
		const host = yield* BrowserHost.start({
			publicOrigin,
			model: yield* model(gate),
			hostTools: tools,
		})
		const member = yield* host.login(name)
		const bot = yield* host.defaultBot(member.session)
		const send: Messages.Send = (path, method, body) =>
			Effect.flatMap(host.address, (address) =>
				Caller.withCookie({ address, publicOrigin })(
					member.session,
					path,
					method,
					body,
				),
			)
		const chat = yield* host.run(Chats.direct(member.identity, bot))
		return { host, member, bot, send, chat }
	})

layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect("Chat reads do not open tool resources", () =>
		Effect.gen(function* () {
			const count = yield* counters
			const gate = yield* Deferred.make<void>()
			const test = yield* start("read-resources", gate, countingTools(count))
			yield* Messages.view(test.send, test.chat)
			yield* test.host.restart
			yield* Messages.view(test.send, test.chat)
			assert.strictEqual(yield* Ref.get(count.builds), 0)
			assert.strictEqual(yield* Ref.get(count.open), 0)
		}),
	)
	it.effect("a running Turn holds its tools until the model closes", () =>
		Effect.gen(function* () {
			const count = yield* counters
			const gate = yield* Deferred.make<void>()
			const test = yield* start("running-resources", gate, countingTools(count))
			yield* Messages.send(test.send, test.chat, "Wait for the gate")
			yield* Wait.untilTrue(
				"the open model scope",
				Ref.get(count.open),
				(value) => value === 1,
			)
			assert.strictEqual(yield* Ref.get(count.builds), 1)
			yield* Deferred.succeed(gate, undefined)
			assert.strictEqual(
				(yield* Messages.settled(test.send, test.chat)).status,
				"Completed",
			)
			assert.strictEqual(yield* Ref.get(count.open), 0)
		}),
	)
	it.effect("a background tool owns resources after its parent Turn ends", () =>
		Effect.gen(function* () {
			const count = yield* counters
			const gate = yield* Deferred.make<void>()
			yield* Deferred.succeed(gate, undefined)
			const slow = yield* Deferred.make<void>()
			const test = yield* start(
				"background-resources",
				gate,
				countingTools(count, { slow }),
			)
			yield* Messages.send(test.send, test.chat, "Call the slow tool")
			const first = yield* Messages.settled(test.send, test.chat)
			assert.strictEqual(first.status, "Completed")
			yield* Wait.untilTrue(
				"the background tool scope",
				Ref.get(count.open),
				(value) => value === 1,
			)
			assert.strictEqual(yield* Ref.get(count.open), 1)
			yield* Deferred.succeed(slow, undefined)
			yield* Wait.untilTrue(
				"the saved tool notice",
				Read.turns(test.send, test.chat),
				(page) => page.items.length === 2,
			)
			assert.strictEqual(
				(yield* Messages.settled(test.send, test.chat)).status,
				"Completed",
			)
			assert.strictEqual(yield* Ref.get(count.open), 0)
		}),
	)
	it.effect(
		"a command notice starts a new execution after the server restarts",
		() =>
			Effect.gen(function* () {
				const count = yield* counters
				const gate = yield* Deferred.make<void>()
				yield* Deferred.succeed(gate, undefined)
				const test = yield* start("late-notice", gate, countingTools(count))
				yield* Messages.talk(test.send, test.bot, "Start the command")
				assert.strictEqual(yield* Ref.get(count.open), 0)
				yield* test.host.restart
				const submit = test.host.run(
					Chats.submitComputerNotice(test.member.identity, test.bot, test.chat),
				)
				const receipt = yield* submit
				assert.deepEqual(yield* submit, receipt)
				assert.strictEqual(
					(yield* Messages.settled(test.send, test.chat)).status,
					"Completed",
				)
				const page = yield* Read.turns(test.send, test.chat)
				assert.strictEqual(page.items.length, 2)
				assert.strictEqual(yield* Ref.get(count.builds), 2)
				assert.strictEqual(yield* Ref.get(count.open), 0)
			}),
	)
	it.effect("one Chat's tool build does not block another Chat", () =>
		Effect.gen(function* () {
			const count = yield* counters
			const gate = yield* Deferred.make<void>()
			const both = yield* Deferred.make<void>()
			const ready = Ref.get(count.builds).pipe(
				Effect.flatMap((builds) =>
					builds >= 2 ? Deferred.succeed(both, undefined) : Effect.void,
				),
				Effect.andThen(Deferred.await(both)),
			)
			const test = yield* start(
				"parallel-resources",
				gate,
				countingTools(count, { ready }),
			)
			const second = yield* Messages.bot(test.send)
			const receipts = yield* Effect.all(
				[
					Messages.message(test.send, test.bot, "go"),
					Messages.message(test.send, second, "go"),
				],
				{ concurrency: 2 },
			)
			yield* Deferred.await(both).pipe(Effect.timeout("10 seconds"))
			yield* Deferred.succeed(gate, undefined)
			yield* Effect.forEach(receipts, (receipt) =>
				Messages.settled(test.send, receipt.chat),
			)
			assert.strictEqual(yield* Ref.get(count.builds), 2)
			assert.strictEqual(yield* Ref.get(count.open), 0)
		}),
	)
	it.effect(
		"a failed tool build releases its scope and the next Turn builds again",
		() =>
			Effect.gen(function* () {
				const count = yield* counters
				const gate = yield* Deferred.make<void>()
				yield* Deferred.succeed(gate, undefined)
				const ready = Ref.get(count.builds).pipe(
					Effect.flatMap((builds) =>
						builds === 1
							? Effect.die("Private tool build failure")
							: Effect.void,
					),
				)
				const test = yield* start(
					"resource-build-failure",
					gate,
					countingTools(count, { ready }),
				)
				const { receipt, view } = yield* Messages.talk(
					test.send,
					test.bot,
					"go",
				)
				assert.strictEqual(view.response?.status, "failed")
				assert.strictEqual(yield* Ref.get(count.builds), 1)
				assert.strictEqual(yield* Ref.get(count.open), 0)
				const execution = yield* Caller.read(
					Execution.Record,
					test.send(`/v1/executions/${receipt.executionId}`, "GET"),
				)
				assert.strictEqual(execution.status, "failed")
				const failures = yield* test.host.run(Failures.read)
				assert.strictEqual(failures.length, 1)
				assert.strictEqual(execution.failure?.errorId, failures[0]?.id)
				assert.strictEqual(failures[0]?.executionId, receipt.executionId)
				const next = yield* Messages.talk(test.send, test.bot, "try again")
				assert.strictEqual(next.view.response?.status, "completed")
				assert.notStrictEqual(next.receipt.executionId, receipt.executionId)
				assert.strictEqual(yield* Ref.get(count.builds), 2)
				assert.strictEqual(yield* Ref.get(count.open), 0)
				assert.deepStrictEqual(yield* test.host.run(Failures.read), failures)
			}),
	)
	it.effect("tool builds do not keep a command's request log annotations", () =>
		Effect.gen(function* () {
			const count = yield* counters
			const gate = yield* Deferred.make<void>()
			yield* Deferred.succeed(gate, undefined)
			const seen = yield* Ref.make(
				Option.none<Readonly<Record<string, unknown>>>(),
			)
			const ready = Effect.flatMap(References.CurrentLogAnnotations, (value) =>
				Ref.set(seen, Option.some(value)),
			)
			const test = yield* start(
				"resource-annotations",
				gate,
				countingTools(count, { ready }),
			)
			yield* Messages.talk(test.send, test.bot, "go").pipe(
				Effect.annotateLogs({ requestId: "first" }),
			)
			assert.isFalse(
				Rec.has(Option.getOrThrow(yield* Ref.get(seen)), "requestId"),
			)
		}),
	)
})
