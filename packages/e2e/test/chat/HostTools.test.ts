import { BrowserHost, Caller, Messages } from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Option,
	Predicate,
	Ref,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, type Prompt, Response, Tool, Toolkit } from "effect/ai"
import { HostTools } from "@openbot-build/openbot"

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const Echo = Tool.make("Echo", {
	description: "Gives back the text, with the Chat that asked for it.",
	parameters: Schema.Struct({ text: Schema.String }),
	success: Schema.String,
})
const toolkit = Toolkit.make(Echo)

/** A text answer of the model, in one stream. */
const answer = (text: string) =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

/** The results of the tool calls after the last input of a person. */
const resultsOfTurn = (prompt: Prompt.Prompt) => {
	const last = Option.getOrElse(
		Arr.findLastIndex(prompt.content, (message) => message.role === "user"),
		() => -1,
	)
	return Arr.flatMap(Arr.drop(prompt.content, last + 1), (message) =>
		message.role === "tool"
			? Arr.flatMap(message.content, (part) =>
					part.type === "tool-result" && Predicate.isString(part.result)
						? [part.result]
						: [],
				)
			: [],
	)
}

/**
 * A model that calls Echo once in each Turn when the Turn has it, and then
 * gives the result of the call as its answer.
 */
const model = LanguageModel.make({
	generateText: () => Effect.succeed([]),
	streamText: ({ prompt, tools }) => {
		const results = resultsOfTurn(prompt)
		if (Arr.isReadonlyArrayNonEmpty(results))
			return answer("Echo said " + Arr.join(results, ", "))
		if (!Arr.some(tools, (tool) => tool.name === "Echo"))
			return answer("This Turn has no Echo tool.")
		return Stream.make(
			Response.makePart("tool-call", {
				id: "echo-call",
				name: "Echo",
				params: { text: "hello" },
				providerExecuted: false,
			}),
			Response.makePart("finish", { reason: "tool-calls", usage }),
		)
	},
})

// The database is a real server, so the test runs on the real clock.
layer(BrowserHost.layerPlatform, {
	excludeTestServices: true,
	timeout: "60 seconds",
})((it) => {
	it.effect(
		"each execution gets the tools of the host and closes their handlers for its own Chat",
		() =>
			Effect.gen(function* () {
				const answers = yield* model
				const built = yield* Ref.make(0)
				const open = yield* Ref.make(0)
				const tools = HostTools.layer({
					toolkit,
					handlers: (chat) =>
						toolkit.toLayer(
							Effect.gen(function* () {
								yield* Effect.acquireRelease(
									Ref.update(open, (count) => count + 1),
									() => Ref.update(open, (count) => count - 1),
								)
								yield* Ref.update(built, (count) => count + 1)
								return {
									Echo: ({ text }) => Effect.succeed(`${chat}: ${text}`),
								}
							}),
						),
				})
				const publicOrigin = "https://host-tools.example.com"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: answers,
					hostTools: tools,
				})
				const member = yield* host.login("host-tools")
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
				yield* Effect.forEach(["first", "second"], (input, index) =>
					Effect.gen(function* () {
						const { receipt, view } = yield* Messages.talk(send, bot, input)
						const id = receipt.chat
						assert.strictEqual(view.status, "Completed")
						assert.match(
							yield* encodeJson(view.response?.output),
							new RegExp(`Echo said ${id}: hello`),
						)
						// Each execution closes its handlers before it reaches its final state.
						assert.ok((yield* Ref.get(built)) >= index + 1)
						assert.strictEqual(yield* Ref.get(open), 0)
					}),
				)

				// Without tools of the host, a Turn has only the tools of OpenBot.
				const before = yield* Ref.get(built)
				const plainOrigin = "https://no-host-tools.example.com"
				const plain = yield* BrowserHost.start({
					publicOrigin: plainOrigin,
					model: answers,
					hostTools: HostTools.none,
				})
				const other = yield* plain.login("plain")
				const otherBot = yield* plain.defaultBot(other.session)
				const otherSend: Messages.Send = (path, method, body) =>
					Effect.flatMap(plain.address, (address) =>
						Caller.withCookie({ address, publicOrigin: plainOrigin })(
							other.session,
							path,
							method,
							body,
						),
					)
				const { view } = yield* Messages.talk(otherSend, otherBot, "third")
				assert.match(
					yield* encodeJson(view.response?.output),
					/This Turn has no Echo tool\./,
				)
				assert.strictEqual(yield* Ref.get(built), before)
			}),
		60000,
	)
})
