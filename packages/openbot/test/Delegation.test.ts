import assert from "node:assert/strict"
import { test } from "node:test"
import { Item } from "@openbot-build/core"
import {
	BotsApi,
	ChatView,
	DelegationsApi,
	MessageReceipt,
	RequestsApi,
} from "@openbot-build/api"
import { Effect, Redacted, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { names } from "../src/plugins/bots/BotPlugin.ts"
import * as BrowserHost from "./BrowserHost.ts"

const publicOrigin = "https://delegation.example.com"
const usage = {
	inputTokens: { total: 10, uncached: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}

/** IDs that the scripted model needs. The test fills them in. */
const known: { research?: string; other?: string } = {}

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
/** An answer that comes after some time, like a model that thinks for long. */
const later = (seconds: number, text: string) =>
	Stream.fromEffect(Effect.sleep(seconds * 1000)).pipe(
		Stream.flatMap(() => answer(text)),
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

/**
 * One scripted model for every Chat. It reads the last user message, and whether a
 * tool result came after it.
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
				const result = JSON.stringify(prompt.content.slice(last + 1).at(-1))
				// Work that the Bot gave to itself or to another Bot.
				if (input.includes("gives you this task:")) {
					if (input.includes("slow research")) return later(3, "Research done.")
					if (input.includes("deeper task")) return later(60, "Too late.")
					if (input.includes("deep task"))
						return answered
							? answer("I wait for the deeper task.")
							: call(names.delegate, { task: "deeper task" })
					if (input.includes("One more thing"))
						return answer("One more thing done.")
					return answer("Other work done.")
				}
				if (input.includes("Also look at the tests"))
					return answer("Tests look fine.")
				if (input.includes("Please also write it down"))
					return answer("Written down.")
				// Messages from OpenBot about work that ended.
				if (input.includes("[OpenBot] The work dlg_"))
					return answer("Noted: " + input)
				if (answered) return answer("Started: " + result)
				if (input.includes("research slowly"))
					return call(names.delegate, { task: "slow research" })
				if (input.includes("add to the research"))
					return call(names.delegate, {
						delegation: known.research,
						task: "Also look at the tests.",
					})
				if (input.includes("continue the research"))
					return call(names.delegate, {
						delegation: known.research,
						task: "One more thing.",
					})
				if (input.includes("go deep"))
					return call(names.delegate, { task: "deep task" })
				if (input.includes("ask the other Bot"))
					return call(names.delegate, {
						bot: known.other,
						reason: "The other Bot knows this.",
						task: "Other work.",
					})
				if (input.includes("are you there")) return answer("Yes, I am here.")
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
	const until = async <A>(
		label: string,
		check: () => Promise<A | undefined>,
	): Promise<A> => {
		for (let tries = 0; tries < 600; tries++) {
			const value = await check()
			if (value !== undefined) return value
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		throw new Error("Timed out: " + label)
	}
	return { send, json, until }
}

/** The direct Chat of a person with a Bot, with helpers to send and read. */
const direct = (
	host: Awaited<ReturnType<typeof BrowserHost.start>>,
	credential: Redacted.Redacted<string>,
	bot: string,
) => {
	const { send, json, until } = client(host)
	let chat = ""
	const view = (id = chat) =>
		json(ChatView, send(credential, "/v1/chats/" + id))
	const message = async (input: string, to?: string) => {
		const sent = await send(
			credential,
			to === undefined ? "/v1/bots/" + bot + "/messages" : to + "/messages",
			"POST",
			{ input },
		)
		assert.equal(sent.status, 202, await sent.clone().text())
		const receipt = Schema.decodeUnknownSync(MessageReceipt)(await sent.json())
		if (to === undefined) chat = receipt.chat
		return receipt
	}
	const rested = (id = chat) =>
		until("the Chat comes to rest", async () => {
			const current = await view(id)
			return current.status !== "Running" &&
				current.activity !== "active" &&
				current.inbox === 0
				? current
				: undefined
		})
	const history = async (id = chat) =>
		(
			await json(
				Schema.Struct({ items: Schema.Array(Item.Record) }),
				send(credential, "/v1/chats/" + id + "/items?limit=500"),
			)
		).items
			.toReversed()
			.map((item) => JSON.stringify(item.content))
			.join("\n")
	const delegations = () =>
		json(
			Schema.Array(DelegationsApi.Delegation),
			send(credential, "/v1/chats/" + chat + "/delegations"),
		)
	const delegation = (id: string) =>
		json(DelegationsApi.Delegation, send(credential, "/v1/delegations/" + id))
	const ended = (id: string, status: string) =>
		until(`the work ${id} is ${status}`, async () => {
			const current = await delegation(id)
			return current.status === status ? current : undefined
		})
	const says = (text: string, id = chat) =>
		until("the history says " + text, async () =>
			(await history(id)).includes(text) ? true : undefined,
		)
	return {
		chat: () => chat,
		view,
		message,
		rested,
		history,
		delegations,
		delegation,
		ended,
		says,
		turn: async (input: string) => {
			await message(input)
			return rested()
		},
	}
}

test(
	"a Bot gives slow work to itself without a request, answers the person at once while it runs, and takes more work into the same task",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("delegation-alice")
			const main = await host.defaultBot(alice.session)
			const chat = direct(host, alice.session, main)

			// Work for itself needs no request. The Bot answers at once.
			const started = await chat.turn("research slowly")
			assert.equal(started.status, "Completed")
			assert.equal(started.open.delegations, 1)
			const [research] = await chat.delegations()
			assert.ok(research !== undefined)
			assert.equal(research.bot, main)
			assert.ok(["queued", "running"].includes(research.status))
			known.research = research.id
			assert.deepEqual(
				await json(
					Schema.Array(RequestsApi.CapabilityRequest),
					send(alice.session, "/v1/requests"),
				),
				[],
			)

			// While the work runs, the person gets an answer at once.
			const asked = Date.now()
			const reply = await chat.message("are you there?")
			assert.equal(reply.delivery, "started")
			await chat.says("Yes, I am here.")
			assert.ok(Date.now() - asked < 2500, String(Date.now() - asked))
			assert.equal((await chat.delegation(research.id)).status, "running")

			// More work for running work goes into the same task. The work ends only
			// after the task Chat has read it, so the result is the last answer.
			await chat.turn("add to the research")
			const first = await chat.ended(research.id, "completed")
			assert.equal(first.result, "Tests look fine.")
			assert.ok(first.chat !== null)
			const task = first.chat
			assert.match(await chat.history(task), /Research done\./)
			assert.match(await chat.history(task), /Also look at the tests\./)
			await chat.says("Noted: [OpenBot] The work " + research.id)
			await chat.rested()

			// More work for ended work is new work in the same task Chat.
			await chat.turn("continue the research")
			const rounds = await chat.delegations()
			const next = rounds.find((entry) => entry.id !== research.id)
			assert.ok(next !== undefined)
			const second = await chat.ended(next.id, "completed")
			assert.equal(second.chat, task)
			assert.equal(second.result, "One more thing done.")
			await chat.says("Noted: [OpenBot] The work " + next.id)
			await chat.rested()

			// A person can also write in the task Chat. That is a new round of the work,
			// and its result goes to the parent Chat too.
			await chat.message("Please also write it down.", "/v1/chats/" + task)
			const round = await until("a new round of the work", async () =>
				(await chat.delegations()).find(
					(entry) =>
						entry.id !== research.id &&
						entry.id !== next.id &&
						entry.status === "completed",
				),
			)
			assert.equal(round.chat, task)
			assert.equal(round.result, "Written down.")
			await chat.says("Noted: [OpenBot] The work " + round.id)
			await chat.rested()
		} finally {
			await host.close()
		}
	},
)

test(
	"cancelling work also stops the work that it gave away, and a denied request comes back as a message",
	{ timeout: 120000 },
	async () => {
		const host = await BrowserHost.start({ publicOrigin, model })
		try {
			const { send, json, until } = client(host)
			const alice = await host.login("cancel-alice")
			const main = await host.defaultBot(alice.session)
			const chat = direct(host, alice.session, main)

			// The task gives work to itself again. Its work stays open while that runs.
			await chat.turn("go deep")
			const [deep] = await chat.delegations()
			assert.ok(deep !== undefined)
			const deeper = await until("the deeper work", async () => {
				const current = await chat.delegation(deep.id)
				if (current.chat === null) return undefined
				const list = await json(
					Schema.Array(DelegationsApi.Delegation),
					send(alice.session, "/v1/chats/" + current.chat + "/delegations"),
				)
				return list[0]?.status === "running" && list[0].chat !== null
					? list[0]
					: undefined
			})
			await chat.says(
				"I wait for the deeper task.",
				(await chat.delegation(deep.id)).chat!,
			)
			assert.equal((await chat.delegation(deep.id)).status, "running")

			// The person cancels the first work. The work below it stops too.
			const cancelled = await send(
				alice.session,
				"/v1/delegations/" + deep.id + "/cancel",
				"POST",
				{},
			)
			assert.equal(cancelled.status, 200, await cancelled.clone().text())
			await chat.ended(deep.id, "cancelled")
			await chat.ended(deeper.id, "cancelled")
			const stopped = await chat.rested(deeper.chat!)
			assert.notEqual(stopped.status, "Completed")
			assert.ok(!(await chat.history(deeper.chat!)).includes("Too late."))

			// Work for another Bot needs a decision. A denial comes back as a message.
			const other = await json(
				BotsApi.Bot,
				send(alice.session, "/v1/bots", "POST", {
					name: "Other",
					role: "Knows other things",
					instructions: "Help.",
				}),
			)
			known.other = other.id
			await chat.turn("ask the other Bot")
			const request = await until("a pending request", async () =>
				(
					await json(
						Schema.Array(RequestsApi.CapabilityRequest),
						send(alice.session, "/v1/requests?status=pending"),
					)
				).find((entry) => entry.capability.action === "bots.delegate"),
			)
			const denied = await send(
				alice.session,
				"/v1/requests/" + request.id,
				"POST",
				{
					expected: request.revision,
					decision: "deny",
					reason: "Not this week.",
				},
			)
			assert.equal(denied.status, 200, await denied.clone().text())
			const asked = (await chat.delegations()).find(
				(entry) => entry.bot === other.id,
			)
			assert.ok(asked !== undefined)
			const failed = await chat.ended(asked.id, "failed")
			assert.match(failed.result ?? "", /Not this week/)
			await chat.says("Noted: [OpenBot] The work " + asked.id)
			assert.match(await chat.history(), /Not this week/)
		} finally {
			await host.close()
		}
	},
)
