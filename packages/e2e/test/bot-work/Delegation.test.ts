import {
	BrowserHost,
	Caller,
	Messages,
	Wait,
} from "@openbot-build/openbot/testing"
import { Execution } from "@openbot-build/domain"
import { assert, layer } from "@effect/vitest"
import { Item } from "@openbot-build/core"
import {
	ChatView,
	BotsApi,
	DelegationsApi,
	RequestsApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Deferred,
	Duration,
	Effect,
	Option,
	pipe,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import type { HttpMethod } from "effect/http"

const { until } = Wait

const publicOrigin = "https://delegation.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** Values that the scripted model needs. The test fills them in. */
interface Known {
	readonly research?: string
	readonly other?: string
	readonly deepReplySeconds?: number
}

const isUser = (message: Prompt.Message): message is Prompt.UserMessage =>
	message.role === "user"

const textOf = (message: Prompt.Message) =>
	typeof message.content === "string"
		? message.content
		: pipe(
				message.content,
				Arr.flatMap((part) => (part.type === "text" ? [part.text] : [])),
				Arr.join(""),
			)

const answer = (text: string) =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)
/** An answer that comes after some time, like a model that thinks for long. */
const later = (seconds: number, text: string) =>
	Stream.fromEffect(Effect.sleep(Duration.seconds(seconds))).pipe(
		Stream.flatMap(() => answer(text)),
	)

/**
 * One scripted model for every Chat. It reads the last user message, and whether a
 * tool result came after it. The test puts the IDs that the model needs in `known`.
 */
const scripted = Effect.gen(function* () {
	const known = yield* Ref.make<Known>({})
	const calls = yield* Ref.make(0)
	const deepResult = yield* Deferred.make<void>()
	const call = (name: string, params: Record<string, unknown>) =>
		Stream.unwrap(
			Effect.map(
				Ref.getAndUpdate(calls, (count) => count + 1),
				(count) =>
					Stream.make(
						Response.makePart("tool-call", {
							id: "call-" + count,
							name,
							params,
							providerExecuted: false,
						}),
						Response.makePart("finish", { reason: "tool-calls", usage }),
					),
			),
		)
	const reply = (
		prompt: Prompt.Prompt,
		ids: Known,
	): Stream.Stream<Response.StreamPartEncoded> => {
		const last = Arr.findLastIndex(prompt.content, isUser)
		const input = pipe(
			last,
			Option.flatMap((index) => Arr.get(prompt.content, index)),
			Option.map(textOf),
			Option.getOrElse(() => ""),
		)
		const has = (text: string) => Str.includes(text)(input)
		const after = Arr.drop(prompt.content, Option.getOrElse(last, () => -1) + 1)
		const answered = Arr.some(after, (message) => message.role === "tool")
		const result = JSON.stringify(Option.getOrUndefined(Arr.last(after)))
		// Paused work that its decider lets go on.
		if (Str.startsWith("[OpenBot] Your work reached")(input))
			return answer("Finished after the pause. " + input)
		// Work that the Bot gave to itself or to another Bot.
		if (
			[
				"stepping task",
				"slow research",
				"deeper task",
				"deep task",
				"One more thing.",
				"Other work.",
			].includes(input)
		) {
			if (has("stepping task"))
				return answered
					? answer("This step must not run.")
					: call("openbot_list_bots", {})
			if (has("slow research")) return later(3, "Research done.")
			if (has("deeper task"))
				return Stream.fromEffect(Deferred.await(deepResult)).pipe(
					Stream.flatMap(() => answer("Deep work done.")),
				)
			if (has("deep task"))
				return answered
					? answer("I wait for the deeper task.")
					: call("openbot_delegate", {
							task: "deeper task",
							limits: { timeMs: 3600000 },
						})
			if (has("One more thing")) return answer("One more thing done.")
			return answer("Other work done.")
		}
		if (has("Also look at the tests")) return answer("Tests look fine.")
		if (has("Please also write it down")) return answer("Written down.")
		// Messages from OpenBot about work that ended.
		if (has('"delegation":"dlg_'))
			return has("Deep work done.") && ids.deepReplySeconds !== undefined
				? later(ids.deepReplySeconds, "Noted: " + input)
				: answer("Noted: " + input)
		if (answered) return answer("Started: " + result)
		if (has("research slowly"))
			return call("openbot_delegate", {
				task: "slow research",
				limits: { timeMs: 3600000 },
			})
		if (has("add to the research"))
			return call("openbot_delegate", {
				limits: { timeMs: 3600000 },
				delegation: ids.research,
				task: "Also look at the tests.",
			})
		if (has("continue the research"))
			return call("openbot_delegate", {
				limits: { timeMs: 3600000 },
				delegation: ids.research,
				task: "One more thing.",
			})
		if (has("step carefully"))
			return call("openbot_delegate", {
				task: "stepping task",
				limits: { timeMs: 3600000, steps: 1 },
			})
		if (has("research with a short time"))
			return call("openbot_delegate", {
				task: "slow research",
				limits: { timeMs: 1200 },
			})
		if (has("go deep with a short time"))
			return call("openbot_delegate", {
				task: "deep task",
				limits: { timeMs: 3000 },
			})
		if (has("go deep"))
			return call("openbot_delegate", {
				task: "deep task",
				limits: { timeMs: 3600000 },
			})
		if (has("ask the other Bot"))
			return call("openbot_delegate", {
				limits: { timeMs: 3600000 },
				bot: ids.other,
				reason: "The other Bot knows this.",
				task: "Other work.",
			})
		if (has("are you there")) return answer("Yes, I am here.")
		return answer("Hello.")
	}
	const model = yield* LanguageModel.make({
		generateText: () =>
			Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
		streamText: ({ prompt }) =>
			Stream.unwrap(Effect.map(Ref.get(known), (ids) => reply(prompt, ids))),
	})
	return { model, known, finishDeep: Deferred.succeed(deepResult, undefined) }
})

/** Calls the API of the host as one signed-in person. */
const client = Effect.fn("Delegation.client")(function* (
	host: BrowserHost.Host,
	credential: Redacted.Redacted<string>,
) {
	const call = Caller.withCookie({
		address: yield* host.address,
		publicOrigin,
	})
	const send = (
		path: string,
		method: HttpMethod.HttpMethod = "GET",
		payload?: unknown,
	) => call(credential, path, method, payload)
	/** Reads the JSON answer of a GET request with a schema. */
	const read = <S extends Schema.Constraint>(schema: S, path: string) =>
		Effect.flatMap(send(path), Caller.json(schema))
	return { send, read }
})

type Client = Effect.Success<ReturnType<typeof client>>

/** The direct Chat of a person with a Bot, with helpers to send and read. */
const direct = Effect.fn("Delegation.direct")(function* (
	api: Client,
	bot: string,
) {
	const { send, read } = api
	/** The ID of the direct Chat. The first message to the Bot sets it. */
	const current = yield* Ref.make("")
	const chatOf = (id: string | undefined) =>
		id === undefined ? Ref.get(current) : Effect.succeed(id)
	/** Sends a message to the Bot, or to another Chat when `chat` is given. */
	const message = Effect.fn("Delegation.message")(function* (
		input: string,
		chat?: string,
	) {
		if (chat !== undefined) return yield* Messages.send(send, chat, input)
		const receipt = yield* Messages.message(send, bot, input)
		yield* Ref.set(current, receipt.chat)
		return receipt
	})
	const rested = (id?: string) =>
		Effect.flatMap(chatOf(id), (chat) => Messages.settled(send, chat))
	const history = (id?: string) =>
		chatOf(id).pipe(
			Effect.flatMap((chat) =>
				read(
					Schema.Struct({ items: Schema.Array(Item.Record) }),
					"/v1/chats/" + chat + "/items?limit=500",
				),
			),
			Effect.map(({ items }) =>
				pipe(
					items,
					Arr.reverse,
					Arr.map((item) => JSON.stringify(item.content)),
					Arr.join("\n"),
				),
			),
		)
	const delegations = Effect.flatMap(Ref.get(current), (chat) =>
		read(
			Schema.Array(DelegationsApi.Delegation),
			"/v1/chats/" + chat + "/delegations",
		),
	)
	const delegation = (id: string) =>
		read(DelegationsApi.Delegation, "/v1/delegations/" + id)
	const ended = (id: string, status: DelegationsApi.DelegationStatus) =>
		until(
			`the work ${id} is ${status}`,
			Effect.map(
				delegation(id),
				Option.liftPredicate(
					(work: DelegationsApi.Delegation) => work.status === status,
				),
			),
		)
	const says = (text: string, id?: string) =>
		until(
			"the history says " + text,
			Effect.map(history(id), Option.liftPredicate(Str.includes(text))),
		)
	return {
		message,
		rested,
		history,
		delegations,
		delegation,
		ended,
		says,
		turn: (input: string) => Effect.andThen(message(input), rested()),
	}
})

// The host is a real server with real time.
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a Bot gives slow work to itself without a request, answers the person at once while it runs, and takes more work into the same task",
		() =>
			Effect.gen(function* () {
				const { model, known } = yield* scripted
				const host = yield* BrowserHost.start({ publicOrigin, model })
				const alice = yield* host.login("delegation-alice")
				const main = yield* host.defaultBot(alice.session)
				const api = yield* client(host, alice.session)
				const chat = yield* direct(api, main)

				// Work for itself needs no request. The Bot answers at once.
				const started = yield* chat.turn("research slowly")
				assert.strictEqual(started.status, "Completed")
				assert.strictEqual(started.open.delegations, 1)
				const research = yield* until(
					"the task starts",
					Effect.map(chat.delegations, (list) =>
						Arr.findFirst(
							list,
							(work) => work.status === "queued" || work.status === "running",
						),
					),
				)
				assert.ok(research !== undefined)
				assert.strictEqual(research.bot, main)
				assert.ok(["queued", "running"].includes(research.status))
				yield* Ref.update(known, (ids) => ({ ...ids, research: research.id }))
				assert.deepStrictEqual(
					yield* api.read(
						Schema.Array(RequestsApi.CapabilityRequest),
						"/v1/requests",
					),
					[],
				)

				// While the work runs, the person gets an answer at once.
				const [took] = yield* Effect.timed(
					Effect.gen(function* () {
						const reply = yield* chat.message("are you there?")
						assert.ok(reply.executionId.length > 0)
						yield* chat.says("Yes, I am here.")
					}),
				)
				assert.ok(
					Duration.isLessThan(took, Duration.millis(2500)),
					String(Duration.toMillis(took)),
				)
				assert.strictEqual(
					(yield* chat.delegation(research.id)).status,
					"running",
				)

				// More work for running work goes into the same task. The work ends only
				// after the task Chat has read it, so the result is the last answer.
				yield* chat.turn("add to the research")
				const first = yield* chat.ended(research.id, "completed")
				assert.strictEqual(first.result, "Tests look fine.")
				assert.ok(first.chat !== null)
				const task = first.chat
				assert.match(yield* chat.history(task), /Research done\./)
				assert.match(yield* chat.history(task), /Also look at the tests\./)
				yield* chat.says('Noted: {\\"delegation\\":\\"' + research.id)
				yield* chat.rested()

				// More work for ended work is new work in the same task Chat.
				yield* chat.turn("continue the research")
				const next = Arr.findFirst(
					yield* chat.delegations,
					(entry) => entry.id !== research.id,
				)
				assert.ok(Option.isSome(next))
				const second = yield* chat.ended(next.value.id, "completed")
				assert.strictEqual(second.chat, task)
				assert.strictEqual(second.result, "One more thing done.")
				yield* chat.says('Noted: {\\"delegation\\":\\"' + next.value.id)
				yield* chat.rested()

				// A person can also write in the task Chat. That is a new round of the work,
				// and its result goes to the parent Chat too.
				yield* chat.message("Please also write it down.", task)
				const round = yield* until(
					"a new round of the work",
					Effect.map(chat.delegations, (list) =>
						Arr.findFirst(
							list,
							(entry) =>
								entry.id !== research.id &&
								entry.id !== next.value.id &&
								entry.status === "completed",
						),
					),
				)
				assert.strictEqual(round.chat, task)
				assert.strictEqual(round.result, "Written down.")
				yield* chat.says('Noted: {\\"delegation\\":\\"' + round.id)
				yield* chat.rested()
			}),
		{ timeout: 120000 },
	)

	it.effect(
		"cancelling work also stops the work that it gave away, and a denied request comes back as a message",
		() =>
			Effect.gen(function* () {
				const { model, known } = yield* scripted
				const host = yield* BrowserHost.start({ publicOrigin, model })
				const alice = yield* host.login("cancel-alice")
				const main = yield* host.defaultBot(alice.session)
				const api = yield* client(host, alice.session)
				const chat = yield* direct(api, main)

				// The task gives work to itself again. Its work stays open while that runs.
				yield* chat.turn("go deep")
				const [deep] = yield* chat.delegations
				assert.ok(deep !== undefined)
				const deeper = yield* until(
					"the deeper work",
					Effect.gen(function* () {
						const current = yield* chat.delegation(deep.id)
						if (current.chat === null)
							return Option.none<DelegationsApi.Delegation>()
						const list = yield* api.read(
							Schema.Array(DelegationsApi.Delegation),
							"/v1/chats/" + current.chat + "/delegations",
						)
						return Option.filter(
							Arr.head(list),
							(entry) => entry.status === "running" && entry.chat !== null,
						)
					}),
				)
				assert.ok(deeper.chat !== null)
				const deepNow = yield* chat.delegation(deep.id)
				assert.ok(deepNow.chat !== null)
				yield* chat.says("I wait for the deeper task.", deepNow.chat)
				assert.strictEqual((yield* chat.delegation(deep.id)).status, "running")

				// The person cancels the first work. The work below it stops too.
				const cancelled = yield* api.send(
					"/v1/delegations/" + deep.id + "/cancel",
					"POST",
					{ commandKey: "cancel-deep-work" },
				)
				const cancelReceipt = yield* Caller.json(
					Execution.Receipt,
					202,
				)(cancelled)
				assert.strictEqual(cancelReceipt.executionId, deep.executionId)
				yield* chat.ended(deep.id, "cancelled")
				const retry = yield* api
					.send("/v1/delegations/" + deep.id + "/cancel", "POST", {
						commandKey: "cancel-deep-work",
					})
					.pipe(Effect.flatMap(Caller.json(Execution.Receipt, 202)))
				assert.deepStrictEqual(retry, cancelReceipt)
				yield* chat.ended(deeper.id, "cancelled")
				const stopped = yield* chat.rested(deeper.chat)
				assert.strictEqual(stopped.status, "Interrupted")
				assert.notInclude(yield* chat.history(deeper.chat), "Too late.")

				// Work for another Bot needs a decision. A denial comes back as a message.
				const other = yield* Effect.flatMap(
					api.send("/v1/bots", "POST", {
						name: "Other",
						role: "Knows other things",
						instructions: "Help.",
					}),
					Caller.json(BotsApi.Bot),
				)
				yield* Ref.update(known, (ids) => ({ ...ids, other: other.id }))
				yield* chat.turn("ask the other Bot")
				const request = yield* until(
					"a pending request",
					Effect.map(
						api.read(
							Schema.Array(RequestsApi.CapabilityRequest),
							"/v1/requests?status=pending",
						),
						(list) =>
							Arr.findFirst(
								list,
								(entry) => entry.capability.action === "bots.delegate",
							),
					),
				)
				const denied = yield* api.send("/v1/requests/" + request.id, "POST", {
					commandKey: `answer-14856:${request.id}`,
					expected: request.revision,
					decision: "deny",
					reason: "Not this week.",
				})
				assert.strictEqual(denied.status, 202, yield* denied.text)
				const asked = Arr.findFirst(
					yield* chat.delegations,
					(entry) => entry.bot === other.id,
				)
				assert.ok(Option.isSome(asked))
				const failed = yield* chat.ended(asked.value.id, "failed")
				assert.strictEqual(failed.failure?.category, "forbidden")
				assert.ok(failed.failure?.errorId)
				yield* chat.says('Noted: {\\"delegation\\":\\"' + asked.value.id)
				assert.include(yield* chat.history(), failed.failure!.errorId)
			}),
		{ timeout: 120000 },
	)

	it.effect(
		"work pauses at a limit and asks its decider, who lets it go on with words or stops it, and work below waits with it",
		() =>
			Effect.gen(function* () {
				const { model, known, finishDeep } = yield* scripted
				// The last model reply takes longer than one time window.
				yield* Ref.update(known, (ids) => ({ ...ids, deepReplySeconds: 4 }))
				const host = yield* BrowserHost.start({ publicOrigin, model })
				const alice = yield* host.login("limits-alice")
				const main = yield* host.defaultBot(alice.session)
				const api = yield* client(host, alice.session)
				const chat = yield* direct(api, main)
				const pendingRequests = api.read(
					Schema.Array(RequestsApi.CapabilityRequest),
					"/v1/requests?status=pending",
				)
				const pending = (limit: string) =>
					until(
						"a request to go on after the " + limit + " limit",
						Effect.map(pendingRequests, (list) =>
							Arr.findFirst(
								list,
								(entry) =>
									entry.capability.action === "delegations.continue" &&
									entry.capability.arguments?.["limit"] === limit,
							),
						),
					)
				const decide = Effect.fn("Delegation.decide")(function* (
					request: RequestsApi.CapabilityRequest,
					decision: "allow" | "deny",
					reason: string,
					scope: "once" | "chat" = "once",
				) {
					const decided = yield* api.send(
						"/v1/requests/" + request.id,
						"POST",
						{
							commandKey: `answer-16648:${request.id}`,
							expected: request.revision,
							decision,
							reason,
							...(decision === "allow" ? { scope } : {}),
						},
					)
					assert.strictEqual(decided.status, 202, yield* decided.text)
				})

				// The work may use one model step. Before its second step it pauses, and the
				// person above the Bot decides. The words of the decision go to the work.
				yield* chat.turn("step carefully")
				const [stepping] = yield* chat.delegations
				assert.ok(stepping !== undefined)
				assert.deepStrictEqual(stepping.limits, { timeMs: 3600000, steps: 1 })
				const steps = yield* pending("steps")
				assert.strictEqual(steps.capability.target, stepping.id)
				const waiting = yield* chat.ended(stepping.id, "paused")
				assert.strictEqual(waiting.pause?.limit, "steps")
				assert.strictEqual(waiting.pause?.request, steps.id)
				assert.strictEqual(waiting.usage?.steps, 1)
				assert.ok(waiting.chat !== null)
				assert.notInclude(yield* chat.history(waiting.chat), "must not run")
				yield* decide(steps, "allow", "Use the short way.")
				const finished = yield* chat.ended(stepping.id, "completed")
				assert.match(finished.result ?? "", /Finished after the pause/)
				assert.match(finished.result ?? "", /Use the short way\./)
				yield* chat.says('Noted: {\\"delegation\\":\\"' + stepping.id)
				yield* chat.rested()

				// The time is over while the model still thinks. The decider stops the work.
				yield* chat.turn("research with a short time")
				const slow = Arr.findFirst(
					yield* chat.delegations,
					(entry) => entry.id !== stepping.id,
				)
				assert.ok(Option.isSome(slow))
				const time = yield* pending("time")
				assert.strictEqual(time.capability.target, slow.value.id)
				assert.strictEqual(
					(yield* chat.delegation(slow.value.id)).status,
					"paused",
				)
				const pausedChat = (yield* chat.delegation(slow.value.id)).chat
				assert.ok(pausedChat !== null)
				// A late model result is saved, but cannot finish the paused Turn.
				yield* Effect.sleep("2 seconds")
				assert.notInclude(yield* chat.history(pausedChat), "Research done.")
				yield* decide(time, "deny", "Too slow.")
				const stopped = yield* chat.ended(slow.value.id, "cancelled")
				assert.strictEqual(stopped.executionStatus, "cancelled")
				assert.ok(stopped.chat !== null)
				// Cancellation keeps known results in history without reporting success.
				assert.strictEqual(stopped.result, null)
				assert.strictEqual(
					(yield* api.read(ChatView, "/v1/chats/" + stopped.chat)).status,
					"Interrupted",
				)
				yield* chat.says('Noted: {\\"delegation\\":\\"' + slow.value.id)
				yield* chat.rested()

				// Work that pauses pauses the work that it gave away. Only the work at the
				// limit asks. When it goes on, the work below goes on too.
				yield* chat.turn("go deep with a short time")
				const deep = Arr.findFirst(
					yield* chat.delegations,
					(entry) => entry.id !== stepping.id && entry.id !== slow.value.id,
				)
				assert.ok(Option.isSome(deep))
				const deeper = yield* until(
					"the deeper work",
					Effect.gen(function* () {
						const current = yield* chat.delegation(deep.value.id)
						if (current.chat === null)
							return Option.none<DelegationsApi.Delegation>()
						const list = yield* api.read(
							Schema.Array(DelegationsApi.Delegation),
							"/v1/chats/" + current.chat + "/delegations",
						)
						return Arr.findFirst(list, (entry) => entry.chat !== null)
					}),
				)
				const over = yield* pending("time")
				assert.strictEqual(over.capability.target, deep.value.id)
				const below = yield* chat.ended(deeper.id, "paused")
				assert.strictEqual(below.pause?.delegation, deep.value.id)
				assert.strictEqual(below.pause?.request, null)
				const asks = Arr.filter(
					yield* pendingRequests,
					(entry) => entry.capability.action === "delegations.continue",
				)
				assert.deepStrictEqual(
					Arr.map(asks, (entry) => entry.capability.target),
					[deep.value.id],
				)
				// This grant lets the same work use more time windows if it needs them.
				yield* decide(over, "allow", "Take more time.", "chat")
				yield* finishDeep
				yield* chat.ended(deeper.id, "completed")
				yield* chat.ended(deep.value.id, "completed")
			}),
		{ timeout: 120000 },
	)
})
