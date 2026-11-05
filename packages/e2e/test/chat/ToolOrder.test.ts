import { BotsApi } from "@openbot-build/api"
import { BrowserHost, Caller, Messages } from "@openbot-build/server-testing"
import { assert, expect, layer } from "@effect/vitest"
import {
	Array as Arr,
	Deferred,
	Effect,
	Option,
	pipe,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"

const publicOrigin = "https://tool-order.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** What the model gets in the first step of one Turn. */
interface Seen {
	readonly tools: ReadonlyArray<string>
	readonly instructions: string
}

const textOf = (message: Prompt.Message) =>
	typeof message.content === "string"
		? message.content
		: pipe(
				message.content,
				Arr.flatMap((part) => (part.type === "text" ? [part.text] : [])),
				Arr.join(""),
			)

/** The text of every system message. */
const systemOf = (prompt: Prompt.Prompt) =>
	pipe(
		prompt.content,
		Arr.filter((message) => message.role === "system"),
		Arr.map(textOf),
		Arr.join("\n"),
	)

/**
 * Takes out the parts that change on each run: IDs, times and addresses.
 * The order and the words stay.
 */
const stable = (text: string) =>
	pipe(
		text,
		Str.replace(/member id [0-9A-Za-z]+/g, "member id <id>"),
		Str.replace(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
			"<uuid>",
		),
		Str.replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "<time>"),
		Str.replace(/http:\/\/(127\.0\.0\.1|localhost):\d+/g, "<address>"),
	)

/** Writes what the model got as plain text: one tool on each line, then the instructions. */
const render = (name: string, seen: Seen) =>
	Arr.join(
		[
			`# ${name} tools`,
			...seen.tools,
			"",
			`# ${name} instructions`,
			seen.instructions,
			"",
		],
		"\n",
	)

const answer = (text: string): Stream.Stream<Response.StreamPartEncoded> =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

const call = (
	name: string,
	params: Record<string, unknown>,
): Stream.Stream<Response.StreamPartEncoded> =>
	Stream.make(
		Response.makePart("tool-call", {
			id: "call-" + name,
			name,
			params,
			providerExecuted: false,
		}),
		Response.makePart("finish", { reason: "tool-calls", usage }),
	)

// The host is a real server with a real database and real time.
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a normal Turn and a review Turn give the model the same tools and instructions as before",
		() =>
			Effect.gen(function* () {
				const helper = yield* Ref.make("")
				const normal = yield* Deferred.make<Seen>()
				const review = yield* Deferred.make<Seen>()
				const model = yield* LanguageModel.make({
					generateText: () =>
						Effect.succeed([
							Response.makePart("text", { text: '{"changes":[]}' }),
						]),
					streamText: ({ prompt, tools }) =>
						Stream.unwrap(
							Effect.gen(function* () {
								const system = systemOf(prompt)
								const seen: Seen = {
									tools: Arr.map(tools, (tool) => tool.name),
									instructions: stable(system),
								}
								const answered = Arr.some(
									prompt.content,
									(message) => message.role === "tool",
								)
								const input = pipe(
									Arr.findLast(
										prompt.content,
										(message) => message.role === "user",
									),
									Option.map(textOf),
									Option.getOrElse(() => ""),
								)
								if (Str.includes("you decide one request")(system)) {
									yield* Deferred.succeed(review, seen)
									return answered
										? answer("Decided.")
										: call("openbot_approve", {
												scope: "lifetime",
												reason: "It fits the task I gave.",
											})
								}
								if (Str.includes("You are Helper.")(system))
									return answered
										? answer("Helper waits for a decision.")
										: call("ConfirmChange", { description: "helper change" })
								if (Str.includes("say hello")(input)) {
									yield* Deferred.succeed(normal, seen)
									return answer("Hello.")
								}
								if (Str.includes("confirm via helper")(input) && !answered)
									return call("openbot_delegate", {
										limits: { timeMs: 3600000 },
										bot: yield* Ref.get(helper),
										reason: "The Helper confirms changes.",
										task: "Confirm the change.",
									})
								return answer("Done.")
							}),
						),
				})
				const host = yield* BrowserHost.start({ publicOrigin, model })
				const member = yield* host.login("tool-order")
				const send: Messages.Send = (path, method, payload) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							member.session,
							path,
							method,
							payload,
						),
					)
				const main = yield* host
					.defaultBot(member.session)
					.pipe(Effect.flatMap(Schema.decodeEffect(BotsApi.BotId)))

				// A normal Turn in the direct Chat of the default Bot.
				const first = yield* Messages.message(send, main, "say hello")
				yield* Messages.settled(send, first.chat)
				const plain = yield* Deferred.await(normal)

				// A Bot that the default Bot owns needs a tool. The owner reviews the request in a review Chat.
				const owned = yield* Caller.read(
					BotsApi.Bot,
					send("/v1/bots", "POST", {
						name: "Helper",
						role: "Confirms changes",
						instructions: "Confirm the change.",
						bot: main,
					}),
				)
				yield* Ref.set(helper, owned.id)
				yield* Messages.message(send, main, "confirm via helper")
				const reviewed = yield* Deferred.await(review).pipe(
					Effect.timeout("60 seconds"),
				)
				assert.ok(Arr.isReadonlyArrayNonEmpty(plain.tools))
				assert.ok(Arr.isReadonlyArrayNonEmpty(reviewed.tools))
				yield* Effect.promise(() =>
					expect(
						Arr.join(
							[render("normal", plain), render("review", reviewed)],
							"\n",
						),
					).toMatchFileSnapshot("./snapshots/ToolOrder.txt"),
				)
			}),
		120000,
	)
})
