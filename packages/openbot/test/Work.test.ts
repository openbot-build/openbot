import { assert, it } from "@effect/vitest"
import { Item } from "@openbot-build/core"
import {
	BotsApi,
	ChatTodos,
	ChatView,
	MessageReceipt,
	RequestsApi,
	Settings,
} from "@openbot-build/api"
import { Effect, Redacted, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { names } from "../src/plugins/work/WorkPlugin.ts"

const planNames = names
import * as BrowserHost from "./BrowserHost.ts"

const publicOrigin = "https://work.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

const textOf = (message: Prompt.Message) =>
	typeof message.content === "string"
		? message.content
		: message.content
				.flatMap((part) => (part.type === "text" ? [part.text] : []))
				.join("")

const answer = (text: string) =>
	Stream.make(
		Response.makePart("text-start", { id: "answer" }),
		Response.makePart("text-delta", { id: "answer", delta: text }),
		Response.makePart("text-end", { id: "answer" }),
		Response.makePart("finish", { reason: "stop", usage }),
	)
let calls = 0
const call = (name: string, params: Record<string, unknown>) =>
	Stream.make(
		Response.makePart("tool-call", {
			id: "call-" + calls++,
			name,
			params,
			providerExecuted: false,
		}),
		Response.makePart("finish", { reason: "tool-calls", usage }),
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
const model = Effect.runSync(
	LanguageModel.make({
		generateText: () =>
			Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
		streamText: ({ prompt, tools }) =>
			Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
				const last = prompt.content.findLastIndex(
					(message) => message.role === "user",
				)
				const input = textOf(prompt.content[last]!)
				const answered = prompt.content
					.slice(last + 1)
					.some((message) => message.role === "tool")
				const reminded = input.includes("These todos are not done yet")
				const system = prompt.content
					.filter((message) => message.role === "system")
					.map(textOf)
					.join("\n")
				const lastResult = JSON.stringify(
					prompt.content.slice(last + 1).at(-1)?.content ?? "",
				)
				if (system.includes("You are in plan mode")) {
					if (input.includes("Your plan was not approved"))
						return answer("I keep planning.")
					const names = tools.map((tool) => tool.name)
					// Plan mode keeps only the tools that read.
					if (names.includes("openbot_create_bot"))
						return answer("A tool that changes things leaked.")
					if (!names.includes("openbot_list_bots"))
						return answer("A tool that reads is missing.")
					if (!answered)
						return call(planNames.submitPlan, {
							items: [todo("a", "pending"), todo("b", "pending")],
							summary: "Fix the bug in two steps.",
						})
					return answer(
						lastResult.includes("approved") ? "Plan sent." : "Still planning.",
					)
				}
				if (input.includes("Your plan is approved"))
					return answered
						? answer("Built.")
						: call(names.todos, {
								items: [todo("a", "done"), todo("b", "done")],
							})
				if (input.includes("do two steps")) {
					if (answered) return answer("I started.")
					return call(names.todos, {
						items: [todo("a", "in_progress"), todo("b", "pending")],
					})
				}
				if (input.includes("stop early"))
					return answered
						? answer("I stop here.")
						: call(names.todos, { items: [todo("a", "pending")] })
				if (reminded && input.includes("Step b")) {
					if (answered) return answer("All done.")
					return call(names.todos, {
						items: [todo("a", "done"), todo("b", "done")],
					})
				}
				if (reminded) return answer("I still stop.")
				if (input.includes("same id"))
					return answered
						? answer("Checked.")
						: call(names.todos, {
								items: [todo("a", "pending"), todo("a", "done")],
							})
				if (input.includes("Reminder: look at the build"))
					return answer("The build is green.")
				if (input.includes("remind me soon"))
					return answered
						? answer("I will look later.")
						: call(names.remind, { seconds: 2, note: "look at the build" })
				if (input.includes("remind me late"))
					return answered
						? answer("I will look much later.")
						: call(names.remind, { seconds: 3600, note: "look at the build" })
				if (input.includes("remind me wrongly"))
					return answered
						? answer("Wrong reminder.")
						: call(names.remind, {
								seconds: 1,
								until: "2026-10-23T09:00:00Z",
								note: "never",
							})
				return answer("Hello.")
			}),
	}),
)

const client = (host: Awaited<ReturnType<typeof BrowserHost.start>>) => {
	const send = (
		credential: Redacted.Redacted<string>,
		path: string,
		method = "GET",
		payload?: unknown,
	) =>
		fetch(host.address + path, {
			method,
			headers: {
				cookie:
					"__Host-openbot-session=" +
					encodeURIComponent(Redacted.value(credential)),
				origin: publicOrigin,
				...(payload === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		})
	const json = async <A, I>(
		schema: Schema.Codec<A, I>,
		response: Promise<globalThis.Response>,
	): Promise<A> => {
		const value = await response
		const body = await value.text()
		assert.ok(value.ok, value.status + " " + body)
		return Schema.decodeUnknownSync(schema)(JSON.parse(body))
	}
	const pause = () => new Promise((resolve) => setTimeout(resolve, 25))
	const until = async <A>(
		label: string,
		check: () => Promise<A | undefined>,
	): Promise<A> => {
		for (let tries = 0; tries < 400; tries++) {
			const value = await check()
			if (value !== undefined) return value
			await pause()
		}
		throw new Error("Timed out: " + label)
	}
	return { send, json, until }
}

/** The direct Chat with the default Bot, with helpers to send messages and read it. */
const chat = async (
	host: Awaited<ReturnType<typeof BrowserHost.start>>,
	credential: Redacted.Redacted<string>,
) => {
	const { send, json, until } = client(host)
	const bot = await host.defaultBot(credential)
	let path = ""
	const view = () => json(ChatView, send(credential, path))
	const todos = () => json(ChatTodos, send(credential, path + "/todos"))
	const rested = () =>
		until("the Chat comes to rest", async () => {
			const next = await view()
			return next.status !== "Running" &&
				next.activity !== "active" &&
				next.inbox === 0
				? next
				: undefined
		})
	/** Sends a message and waits until its Turn and the Turns after it end. */
	const turn = async (input: string) => {
		const sent = await send(
			credential,
			"/v1/bots/" + bot + "/messages",
			"POST",
			{
				input,
			},
		)
		assert.strictEqual(sent.status, 202, await sent.clone().text())
		const receipt = Schema.decodeUnknownSync(MessageReceipt)(await sent.json())
		path = "/v1/chats/" + receipt.chat
		return rested()
	}
	/** The text of the history, oldest first. */
	const history = async () => {
		const page = await json(
			Schema.Struct({ items: Schema.Array(Item.Record) }),
			send(credential, path + "/items?limit=500"),
		)
		return page.items.toReversed().map((item) => JSON.stringify(item.content))
	}
	const reminders = async () =>
		(await history()).filter((item) =>
			item.includes("These todos are not done yet"),
		).length
	return {
		bot,
		path: () => path,
		view,
		todos,
		turn,
		rested,
		history,
		reminders,
	}
}

it(
	"a Bot keeps working while its todos are open, and a person reads and replaces the list",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json } = client(host)
			const alice = await host.login("work-alice")
			const work = await chat(host, alice.session)

			// The Bot stops after the first step, so OpenBot reminds it once.
			// It then marks both steps done. A list where every item is done becomes empty.
			await work.turn("do two steps")
			assert.deepStrictEqual((await work.todos()).items, [])
			assert.strictEqual(await work.reminders(), 1)

			// A model that will not go on gets one reminder for each state of the list.
			await work.turn("stop early")
			assert.deepStrictEqual((await work.todos()).items, [todo("a", "pending")])
			assert.strictEqual(await work.reminders(), 2)

			// The tool refuses a list where two items have the same id.
			await work.turn("same id")
			assert.deepStrictEqual((await work.todos()).items, [todo("a", "pending")])

			// A person replaces the list. An old revision is a conflict.
			const current = await work.view()
			const replaced = await json(
				ChatView,
				send(alice.session, work.path() + "/todos", "PUT", {
					revision: current.chat.revision,
					items: [todo("c", "pending")],
				}),
			)
			assert.deepStrictEqual((await work.todos()).items, [todo("c", "pending")])
			const stale = await send(alice.session, work.path() + "/todos", "PUT", {
				revision: current.chat.revision,
				items: [],
			})
			assert.strictEqual(stale.status, 409)
			const twice = await send(alice.session, work.path() + "/todos", "PUT", {
				revision: replaced.chat.revision,
				items: [todo("d", "pending"), todo("d", "pending")],
			})
			assert.strictEqual(twice.status, 409)

			// Another member cannot read the list.
			const bob = await host.login("work-bob")
			const hidden = await send(bob.session, work.path() + "/todos")
			assert.ok([403, 404].includes(hidden.status), String(hidden.status))
		} finally {
			await host.close()
		}
	},
)

it(
	"a reminder comes back as a message, also over a restart, and only a stop of all work cancels it",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, until } = client(host)
			const alice = await host.login("remind-alice")
			const work = await chat(host, alice.session)
			const text = async () => (await work.history()).join("\n")

			// The Turn does not wait for the reminder. The reminder is saved, so a restart
			// does not lose it. At its time, its note starts a new Turn.
			const began = Date.now()
			const set = await work.turn("remind me soon")
			assert.strictEqual(set.status, "Completed")
			assert.strictEqual(set.open.reminders, 1)
			assert.match(await text(), /I will look later\./)
			await host.restart()
			await until("the reminder", async () =>
				(await text()).includes("The build is green.") ? true : undefined,
			)
			assert.ok(Date.now() - began >= 2000)
			assert.strictEqual((await work.rested()).open.reminders, 0)

			// A plain interrupt stops only the Turn. Stopping all work cancels the reminder.
			assert.strictEqual((await work.turn("remind me late")).open.reminders, 1)
			const interrupt = (payload: unknown) =>
				send(alice.session, work.path() + "/interrupt", "POST", payload)
			assert.strictEqual((await interrupt({})).status, 200)
			assert.strictEqual((await work.view()).open.reminders, 1)
			assert.strictEqual((await interrupt({ delegations: true })).status, 200)
			assert.strictEqual((await work.view()).open.reminders, 0)

			// A wrong input sets no reminder. The Bot gets an error.
			await work.turn("remind me wrongly")
			assert.match(await text(), /Give either seconds or until, not both/)
			assert.strictEqual((await work.view()).open.reminders, 0)
		} finally {
			await host.close()
		}
	},
)

it(
	"a plan asks for approval as the most specific setting says, and then runs in build mode",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("plan-alice")
			const organization = await json(
				Settings.OrganizationSettings,
				send(alice.session, "/v1/organization/settings"),
			)
			assert.deepStrictEqual(organization.planApproval, {
				approver: "chain",
				timeoutMs: 86400000,
				onTimeout: "stay",
			})
			// Alice says that her plans stay plans when nobody answers within one second.
			const mine = await json(
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
			const stale = await send(alice.session, "/v1/me/settings", "PATCH", {
				expectedVersion: 0,
				planApproval: null,
			})
			assert.strictEqual(stale.status, 409)
			const defaultBot = await host.defaultBot(alice.session)
			const work = await chat(host, alice.session)
			await work.turn("hello")
			/** Asks for a plan in plan mode, with the approval setting of the Chat. */
			const plan = async (planApproval: unknown) => {
				const current = await work.view()
				const changed = await send(alice.session, work.path(), "PATCH", {
					expected: current.chat.revision,
					mode: "plan",
					planApproval,
				})
				assert.strictEqual(changed.status, 200, await changed.clone().text())
				// The plan Turn does not wait for the decision.
				const asked = await work.turn("plan the fix")
				assert.strictEqual(asked.status, "Completed")
				return asked
			}
			const built = () =>
				until("the plan runs in build mode", async () => {
					const current = await work.view()
					return current.chat.settings.mode === "build" &&
						current.turn?.settings.mode === "build" &&
						current.status === "Completed" &&
						current.inbox === 0
						? current
						: undefined
				})
			const pending = () =>
				until("a plan request", async () => {
					const list = await json(
						Schema.Array(RequestsApi.CapabilityRequest),
						send(alice.session, "/v1/requests?status=pending"),
					)
					return list.find(
						(request) => request.capability.action === "plans.run",
					)
				})

			// 1. The Chat asks the person. Alice allows it, so the plan runs in a new Turn.
			await plan({ approver: "person", timeoutMs: 600000, onTimeout: "stay" })
			const request = await pending()
			assert.deepStrictEqual(request.approver, {
				_tag: "Person",
				userId: alice.identity.userId,
			})
			assert.strictEqual(request.onExpire, "deny")
			assert.strictEqual(request.chat, work.path().split("/").at(-1))
			const resolved = await send(
				alice.session,
				"/v1/requests/" + request.id,
				"POST",
				{ expected: request.revision, decision: "allow" },
			)
			assert.strictEqual(resolved.status, 200, await resolved.clone().text())
			await built()
			await until("the built answer", async () =>
				(await work.history()).some((item) => item.includes("Built."))
					? true
					: undefined,
			)
			// Every item is done, so the list is empty after the Turn.
			assert.deepStrictEqual((await work.todos()).items, [])

			// 2. The Chat says that silence means yes. It wins over the member setting.
			await plan({ approver: "person", timeoutMs: 1000, onTimeout: "run" })
			await built()

			// 3. Without a Chat setting, the member setting counts: the plan stays a plan,
			// and the Bot gets the reason.
			await plan(null)
			await until("the answer that the plan stays a plan", async () =>
				(await work.history()).some((item) => item.includes("I keep planning."))
					? true
					: undefined,
			)
			const stayed = await work.rested()
			assert.strictEqual(stayed.chat.settings.mode, "plan")

			// 4. A Bot setting comes before the member setting.
			const main = await json(
				BotsApi.Bot,
				send(alice.session, "/v1/bots/" + defaultBot),
			)
			const changed = await send(
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
			assert.strictEqual(changed.status, 200, await changed.clone().text())
			await plan(null)
			await built()
		} finally {
			await host.close()
		}
	},
)
