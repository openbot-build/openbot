import assert from "node:assert/strict"
import { test } from "node:test"
import { Session } from "@openbot-build/core"
import { SessionTodos, SessionView } from "@openbot-build/api"
import { Effect, Redacted, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { names } from "../src/plugins/work/WorkPlugin.ts"
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

const todo = (id: string, status: string) => ({
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
		streamText: ({ prompt }) =>
			Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
				const last = prompt.content.findLastIndex(
					(message) => message.role === "user",
				)
				const input = textOf(prompt.content[last]!)
				const answered = prompt.content
					.slice(last + 1)
					.some((message) => message.role === "tool")
				const reminded = input.startsWith("OpenBot reminder")
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

/** A new Session of the Main Agent, with helpers to start Turns and read it. */
const session = async (
	host: Awaited<ReturnType<typeof BrowserHost.start>>,
	credential: Redacted.Redacted<string>,
) => {
	const { send, json, until } = client(host)
	const created = await json(
		SessionView,
		send(credential, "/v1/sessions", "POST", {}),
	)
	const path = "/v1/sessions/" + created.session.id
	const view = () => json(SessionView, send(credential, path))
	const todos = () => json(SessionTodos, send(credential, path + "/todos"))
	const turn = async (input: string) => {
		const current = await view()
		const started = await send(credential, path + "/turns", "POST", {
			expected: current.session.revision,
			input,
		})
		assert.equal(started.status, 202, await started.clone().text())
		return until("the Turn completes", async () => {
			const next = await view()
			return next.session.turns.length > current.session.turns.length &&
				Session.status(next.session)._tag === "Completed"
				? next
				: undefined
		})
	}
	/** The reminders in the history. The context window holds copies, so it is not counted. */
	const reminders = async () => {
		const state = (await (
			await send(credential, path + "/history")
		).json()) as {
			value: { conversation: { history: ReadonlyArray<unknown> } }
		}
		return state.value.conversation.history.filter((item) =>
			JSON.stringify(item).includes("OpenBot reminder"),
		).length
	}
	return { path, view, todos, turn, reminders, send, json }
}

test(
	"an Agent keeps working while its todos are open, and a person reads and replaces the list",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const alice = await host.login("work-alice")
			const work = await session(host, alice.session)
			assert.deepEqual(await work.todos(), { items: [] })

			// The Agent stops after the first step, so OpenBot reminds it once.
			// It then marks both steps done, and the Turn ends.
			await work.turn("do two steps")
			assert.deepEqual((await work.todos()).items, [
				todo("a", "done"),
				todo("b", "done"),
			])
			assert.equal(await work.reminders(), 1)

			// A model that will not go on gets one reminder for each state of the list.
			await work.turn("stop early")
			assert.deepEqual((await work.todos()).items, [todo("a", "pending")])
			assert.equal(await work.reminders(), 2)

			// The tool refuses a list where two items have the same id.
			await work.turn("same id")
			assert.deepEqual((await work.todos()).items, [todo("a", "pending")])

			// A person replaces the list. An old revision is a conflict.
			const current = await work.view()
			const replaced = await work.json(
				SessionView,
				work.send(alice.session, work.path + "/todos", "PUT", {
					expected: current.session.head,
					revision: current.session.revision,
					items: [todo("c", "pending")],
				}),
			)
			assert.deepEqual((await work.todos()).items, [todo("c", "pending")])
			const stale = await work.send(
				alice.session,
				work.path + "/todos",
				"PUT",
				{
					expected: current.session.head,
					revision: current.session.revision,
					items: [],
				},
			)
			assert.equal(stale.status, 409)
			const twice = await work.send(
				alice.session,
				work.path + "/todos",
				"PUT",
				{
					expected: replaced.session.head,
					revision: replaced.session.revision,
					items: [todo("d", "pending"), todo("d", "pending")],
				},
			)
			assert.equal(twice.status, 409)

			// The list is part of the Timeline, so a fork of an older version has the older list.
			const fork = await work.json(
				SessionView,
				work.send(alice.session, work.path + "/fork", "POST", {
					version: current.session.head,
				}),
			)
			const forked = await work.json(
				SessionTodos,
				work.send(alice.session, "/v1/sessions/" + fork.session.id + "/todos"),
			)
			assert.deepEqual(forked.items, [todo("a", "pending")])

			// Another member cannot read the list.
			const bob = await host.login("work-bob")
			const hidden = await work.send(bob.session, work.path + "/todos")
			assert.ok([403, 404].includes(hidden.status), String(hidden.status))
		} finally {
			await host.close()
		}
	},
)
