import { assert, layer } from "@effect/vitest"
import { Item } from "@openbot-build/core"
import {
	BotsApi,
	ChatTodos,
	ChatView,
	RequestsApi,
	Settings,
} from "@openbot-build/api"
import {
	Array as Arr,
	Clock,
	Effect,
	Option,
	pipe,
	Redacted,
	Ref,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import type { HttpMethod } from "effect/http"
import { names } from "../src/plugins/work/WorkPlugin.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Messages from "./Messages.ts"

const publicOrigin = "https://work.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** Something that the test waits for did not happen in time. */
class TimedOut extends Schema.TaggedError<
	TimedOut,
	{ readonly brand: unique symbol }
>()("TimedOut", { label: Schema.String }) {
	override get message() {
		return "Timed out: " + this.label
	}
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const textOf = (message: Prompt.Message) =>
	typeof message.content === "string"
		? message.content
		: pipe(
				message.content,
				Arr.flatMap((part) => (part.type === "text" ? [part.text] : [])),
				Arr.join(""),
			)

const answer = (text: string): Stream.Stream<Response.StreamPartEncoded> =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)

const todo = (id: string, status: "pending" | "in_progress" | "done") => ({
	id,
	content: "Step " + id,
	status,
})

/**
 * A scripted model. It reads the last user message, and whether a tool result came
 * after it.
 */
const scripted = Effect.gen(function* () {
	const calls = yield* Ref.make(0)
	const call = (name: string, params: Record<string, unknown>) =>
		Effect.map(
			Ref.getAndUpdate(calls, (count) => count + 1),
			(count): Stream.Stream<Response.StreamPartEncoded> =>
				Stream.make(
					Response.makePart("tool-call", {
						id: "call-" + count,
						name,
						params,
						providerExecuted: false,
					}),
					Response.makePart("finish", { reason: "tool-calls", usage }),
				),
		)
	return yield* LanguageModel.make({
		generateText: () =>
			Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
		streamText: ({ prompt, tools }) =>
			Stream.unwrap(
				Effect.gen(function* () {
					const last = Arr.findLastIndex(
						prompt.content,
						(message) => message.role === "user",
					)
					const input = pipe(
						last,
						Option.flatMap((index) => Arr.get(prompt.content, index)),
						Option.map(textOf),
						Option.getOrElse(() => ""),
					)
					const after = Arr.drop(
						prompt.content,
						Option.getOrElse(last, () => -1) + 1,
					)
					const answered = Arr.some(after, (message) => message.role === "tool")
					const says = (text: string) => Str.includes(text)(input)
					const reminded = says("These todos are not done yet")
					const system = pipe(
						prompt.content,
						Arr.filter((message) => message.role === "system"),
						Arr.map(textOf),
						Arr.join("\n"),
					)
					if (Str.includes("You are in plan mode")(system)) {
						if (says("Your plan was not approved"))
							return answer("I keep planning.")
						const toolNames = Arr.map(tools, (tool) => tool.name)
						// Plan mode keeps only the tools that read.
						if (Arr.contains(toolNames, "openbot_create_bot"))
							return answer("A tool that changes things leaked.")
						if (!Arr.contains(toolNames, "openbot_list_bots"))
							return answer("A tool that reads is missing.")
						if (!answered)
							return yield* call(names.submitPlan, {
								items: [todo("a", "pending"), todo("b", "pending")],
								summary: "Fix the bug in two steps.",
							})
						const lastResult = yield* encodeJson(
							pipe(
								Arr.last(after),
								Option.map((message) => message.content),
								Option.getOrElse(() => ""),
							),
						)
						return answer(
							Str.includes("approved")(lastResult)
								? "Plan sent."
								: "Still planning.",
						)
					}
					if (says("Your plan is approved"))
						return answered
							? answer("Built.")
							: yield* call(names.todos, {
									items: [todo("a", "done"), todo("b", "done")],
								})
					if (says("do two steps")) {
						if (answered) return answer("I started.")
						return yield* call(names.todos, {
							items: [todo("a", "in_progress"), todo("b", "pending")],
						})
					}
					if (says("stop early"))
						return answered
							? answer("I stop here.")
							: yield* call(names.todos, { items: [todo("a", "pending")] })
					if (reminded && says("Step b")) {
						if (answered) return answer("All done.")
						return yield* call(names.todos, {
							items: [todo("a", "done"), todo("b", "done")],
						})
					}
					if (reminded) return answer("I still stop.")
					if (says("same id"))
						return answered
							? answer("Checked.")
							: yield* call(names.todos, {
									items: [todo("a", "pending"), todo("a", "done")],
								})
					if (says("Reminder: look at the build"))
						return answer("The build is green.")
					if (says("remind me soon"))
						return answered
							? answer("I will look later.")
							: yield* call(names.remind, {
									seconds: 2,
									note: "look at the build",
								})
					if (says("remind me late"))
						return answered
							? answer("I will look much later.")
							: yield* call(names.remind, {
									seconds: 3600,
									note: "look at the build",
								})
					if (says("remind me wrongly"))
						return answered
							? answer("Wrong reminder.")
							: yield* call(names.remind, {
									seconds: 1,
									until: "2026-10-23T09:00:00Z",
									note: "never",
								})
					return answer("Hello.")
				}).pipe(
					// A script that cannot write its input as JSON is a broken test.
					Effect.orDie,
				),
			),
	})
})

/**
 * Runs a check again and again, 25 milliseconds apart, until it gives a value.
 * It fails with `TimedOut` after 400 tries.
 */
const until = <A, E, R>(
	label: string,
	check: Effect.Effect<Option.Option<A>, E, R>,
) =>
	check.pipe(
		Effect.repeat({
			until: Option.isSome,
			times: 399,
			schedule: Schedule.spaced("25 millis"),
		}),
		Effect.flatMap(Effect.fromOption(() => TimedOut.make({ label }))),
	)

/** Calls the API of the host as signed-in people. */
const client = (host: BrowserHost.Host) => {
	/** A restart changes the address, so each call reads it again. */
	const send = (
		credential: Redacted.Redacted<string>,
		path: string,
		method: HttpMethod.HttpMethod = "GET",
		payload?: unknown,
	): Caller.Call =>
		Effect.flatMap(host.address, (address) =>
			Caller.withCookie({ address, publicOrigin })(
				credential,
				path,
				method,
				payload,
			),
		)
	/** Reads a 2xx JSON answer with a schema. */
	const json = <S extends Schema.Constraint>(schema: S, call: Caller.Call) =>
		Effect.flatMap(call, Caller.json(schema))
	return { send, json }
}

/** The direct Chat with the default Bot, with helpers to send messages and read it. */
const chat = Effect.fn("Work.chat")(function* (
	host: BrowserHost.Host,
	credential: Redacted.Redacted<string>,
) {
	const { send, json } = client(host)
	const bot = yield* host.defaultBot(credential)
	/** The ID of the direct Chat. Each message to the Bot sets it. */
	const current = yield* Ref.make("")
	const id = Ref.get(current)
	const path = Effect.map(id, (value) => "/v1/chats/" + value)
	const request: Messages.Send = (...call) => send(credential, ...call)
	const view = Effect.flatMap(id, (value) => Messages.view(request, value))
	const todos = Effect.flatMap(path, (base) =>
		json(ChatTodos, send(credential, base + "/todos")),
	)
	const rested = Effect.flatMap(id, (value) => Messages.settled(request, value))
	/** The text of the history, oldest first. */
	const history = Effect.gen(function* () {
		const page = yield* json(
			Schema.Struct({ items: Schema.Array(Item.Record) }),
			send(credential, (yield* path) + "/items?limit=500"),
		)
		return yield* Effect.forEach(Arr.reverse(page.items), (item) =>
			encodeJson(item.content),
		)
	})
	return {
		id,
		path,
		view,
		todos,
		rested,
		history,
		/** Sends a message and waits until its Turn and the Turns after it end. */
		turn: (input: string) =>
			Messages.message(request, bot, input).pipe(
				Effect.tap((receipt) => Ref.set(current, receipt.chat)),
				Effect.andThen(rested),
			),
		/** How many reminders about open todos the history holds. */
		reminders: Effect.map(
			history,
			(items) =>
				Arr.filter(items, Str.includes("These todos are not done yet")).length,
		),
	}
})

// The host is a real server with real time.
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"a Bot keeps working while its todos are open, and a person reads and replaces the list",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted,
				})
				const { send, json } = client(host)
				const alice = yield* host.login("work-alice")
				const work = yield* chat(host, alice.session)

				// The Bot stops after the first step, so OpenBot reminds it once.
				// It then marks both steps done. A list where every item is done becomes empty.
				yield* work.turn("do two steps")
				assert.deepStrictEqual((yield* work.todos).items, [])
				assert.strictEqual(yield* work.reminders, 1)

				// A model that will not go on gets one reminder for each state of the list.
				yield* work.turn("stop early")
				assert.deepStrictEqual((yield* work.todos).items, [
					todo("a", "pending"),
				])
				assert.strictEqual(yield* work.reminders, 2)

				// The tool refuses a list where two items have the same id.
				yield* work.turn("same id")
				assert.deepStrictEqual((yield* work.todos).items, [
					todo("a", "pending"),
				])

				// A person replaces the list. An old revision is a conflict.
				const path = yield* work.path
				const current = yield* work.view
				const replaced = yield* json(
					ChatView,
					send(alice.session, path + "/todos", "PUT", {
						revision: current.chat.revision,
						items: [todo("c", "pending")],
					}),
				)
				assert.deepStrictEqual((yield* work.todos).items, [
					todo("c", "pending"),
				])
				const stale = yield* send(alice.session, path + "/todos", "PUT", {
					revision: current.chat.revision,
					items: [],
				})
				assert.strictEqual(stale.status, 409)
				const twice = yield* send(alice.session, path + "/todos", "PUT", {
					revision: replaced.chat.revision,
					items: [todo("d", "pending"), todo("d", "pending")],
				})
				assert.strictEqual(twice.status, 409)

				// Another member cannot read the list.
				const bob = yield* host.login("work-bob")
				const hidden = yield* send(bob.session, path + "/todos")
				assert.strictEqual(hidden.status, 404)
				const notFound = yield* Caller.json(
					Schema.Struct({ _tag: Schema.String }),
					404,
				)(hidden)
				assert.strictEqual(notFound._tag, "ChatNotFound")
			}),
		{ timeout: 120000 },
	)

	it.effect(
		"a reminder comes back as a message, also over a restart, and only a stop of all work cancels it",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted,
				})
				const { send } = client(host)
				const alice = yield* host.login("remind-alice")
				const work = yield* chat(host, alice.session)
				const text = Effect.map(work.history, Arr.join("\n"))

				// The Turn does not wait for the reminder. The reminder is saved, so a restart
				// does not lose it. At its time, its note starts a new Turn.
				const began = yield* Clock.currentTimeMillis
				const set = yield* work.turn("remind me soon")
				assert.strictEqual(set.status, "Completed")
				assert.strictEqual(set.open.reminders, 1)
				assert.match(yield* text, /I will look later\./)
				yield* host.restart
				yield* until(
					"the reminder",
					Effect.map(
						text,
						Option.liftPredicate(Str.includes("The build is green.")),
					),
				)
				assert.ok((yield* Clock.currentTimeMillis) - began >= 2000)
				assert.strictEqual((yield* work.rested).open.reminders, 0)

				// A plain interrupt stops only the Turn. Stopping all work cancels the reminder.
				assert.strictEqual(
					(yield* work.turn("remind me late")).open.reminders,
					1,
				)
				const path = yield* work.path
				const interrupt = (payload: unknown) =>
					send(alice.session, path + "/interrupt", "POST", payload)
				assert.strictEqual((yield* interrupt({})).status, 200)
				assert.strictEqual((yield* work.view).open.reminders, 1)
				assert.strictEqual(
					(yield* interrupt({ delegations: true })).status,
					200,
				)
				assert.strictEqual((yield* work.view).open.reminders, 0)

				// A wrong input sets no reminder. The Bot gets an error.
				yield* work.turn("remind me wrongly")
				assert.match(yield* text, /Give either seconds or until, not both/)
				assert.strictEqual((yield* work.view).open.reminders, 0)
			}),
		{ timeout: 120000 },
	)

	it.effect(
		"a plan asks for approval as the most specific setting says, and then runs in build mode",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* scripted,
				})
				const { send, json } = client(host)
				const alice = yield* host.login("plan-alice")
				const organization = yield* json(
					Settings.OrganizationSettings,
					send(alice.session, "/v1/organization/settings"),
				)
				assert.deepStrictEqual(organization.planApproval, {
					approver: "chain",
					timeoutMs: 86400000,
					onTimeout: "stay",
				})
				// Alice says that her plans stay plans when nobody answers within one second.
				const mine = yield* json(
					Settings.MemberSettings,
					send(alice.session, "/v1/me/settings", "PATCH", {
						expectedVersion: 0,
						planApproval: {
							approver: "person",
							timeoutMs: 1000,
							onTimeout: "stay",
						},
					}),
				)
				assert.strictEqual(mine.version, 1)
				const stale = yield* send(alice.session, "/v1/me/settings", "PATCH", {
					expectedVersion: 0,
					planApproval: null,
				})
				assert.strictEqual(stale.status, 409)
				const defaultBot = yield* host.defaultBot(alice.session)
				const work = yield* chat(host, alice.session)
				yield* work.turn("hello")
				const path = yield* work.path
				/** Asks for a plan in plan mode, with the approval setting of the Chat. */
				const plan = Effect.fn("Work.plan")(function* (planApproval: unknown) {
					const current = yield* work.view
					const changed = yield* send(alice.session, path, "PATCH", {
						expected: current.chat.revision,
						mode: "plan",
						planApproval,
					})
					assert.strictEqual(changed.status, 200, yield* changed.text)
					// The plan Turn does not wait for the decision.
					const asked = yield* work.turn("plan the fix")
					assert.strictEqual(asked.status, "Completed")
					return asked
				})
				const built = until(
					"the plan runs in build mode",
					Effect.map(
						work.view,
						Option.liftPredicate(
							(current) =>
								current.chat.settings.mode === "build" &&
								current.turn?.settings.mode === "build" &&
								current.status === "Completed" &&
								current.inbox === 0,
						),
					),
				)
				const pending = until(
					"a plan request",
					Effect.map(
						json(
							Schema.Array(RequestsApi.CapabilityRequest),
							send(alice.session, "/v1/requests?status=pending"),
						),
						Arr.findFirst(
							(request) => request.capability.action === "plans.run",
						),
					),
				)

				// 1. The Chat asks the person. Alice allows it, so the plan runs in a new Turn.
				yield* plan({
					approver: "person",
					timeoutMs: 600000,
					onTimeout: "stay",
				})
				const request = yield* pending
				assert.deepStrictEqual(request.approver, {
					_tag: "Person",
					userId: alice.identity.userId,
				})
				assert.strictEqual(request.onExpire, "deny")
				assert.strictEqual(request.chat, yield* work.id)
				const resolved = yield* send(
					alice.session,
					"/v1/requests/" + request.id,
					"POST",
					{ expected: request.revision, decision: "allow" },
				)
				assert.strictEqual(resolved.status, 200, yield* resolved.text)
				yield* built
				yield* until(
					"the built answer",
					Effect.map(
						work.history,
						Option.liftPredicate(Arr.some(Str.includes("Built."))),
					),
				)
				// Every item is done, so the list is empty after the Turn.
				assert.deepStrictEqual((yield* work.todos).items, [])

				// 2. The Chat says that silence means yes. It wins over the member setting.
				yield* plan({ approver: "person", timeoutMs: 1000, onTimeout: "run" })
				yield* built

				// 3. Without a Chat setting, the member setting counts: the plan stays a plan,
				// and the Bot gets the reason.
				yield* plan(null)
				yield* until(
					"the answer that the plan stays a plan",
					Effect.map(
						work.history,
						Option.liftPredicate(Arr.some(Str.includes("I keep planning."))),
					),
				)
				const stayed = yield* work.rested
				assert.strictEqual(stayed.chat.settings.mode, "plan")

				// 4. A Bot setting comes before the member setting.
				const main = yield* json(
					BotsApi.Bot,
					send(alice.session, "/v1/bots/" + defaultBot),
				)
				const changed = yield* send(
					alice.session,
					"/v1/bots/" + main.id,
					"PATCH",
					{
						expected: main.revision,
						planApproval: {
							approver: "person",
							timeoutMs: 1000,
							onTimeout: "run",
						},
					},
				)
				assert.strictEqual(changed.status, 200, yield* changed.text)
				yield* plan(null)
				yield* built
			}),
		{ timeout: 120000 },
	)
})
