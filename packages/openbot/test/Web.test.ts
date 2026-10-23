import { Effect, Match, Redacted, Schema, Stream } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	ChatResponse,
	ChatResponseEvent,
	ChatSummary,
	ChatView,
	RequestsApi,
} from "@openbot-build/api"
import { Item } from "@openbot-build/core"
import { AiError, LanguageModel, Response } from "effect/ai"
import * as BrowserHost from "./BrowserHost.ts"
import { bot, message, settled, view, type Send } from "./Messages.ts"

const pause = () => new Promise((resolve) => setTimeout(resolve, 25))

test(
	"public Chats, Turns, approvals and detached SSE share one execution",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin: "https://web.example.com",
		})
		try {
			const alice = await host.login("alice"),
				bob = await host.login("bob")
			const aliceBot = await host.defaultBot(alice.session)
			await host.defaultBot(bob.session)
			const request = (
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
						origin: "https://web.example.com",
						...(payload === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				})
			const asAlice: Send = (path, method, payload) =>
				request(alice.session, path, method, payload)
			// Bots learn memory only with the Bot memory model of the organization.
			const settings = await (
				await request(alice.session, "/v1/organization/settings")
			).json()
			const configured = await request(
				alice.session,
				"/v1/organization/settings",
				"PATCH",
				{
					expectedVersion: settings.version,
					botMemoryModel: {
						_tag: "Config.Selection",
						provider: "fixture",
						model: "fixture-model",
					},
				},
			)
			assert.equal(configured.status, 200, await configured.clone().text())
			const decode = Schema.decodeUnknownSync(ChatView)
			// The first message to a Bot makes the direct Chat of the member with it.
			const first = await message(asAlice, aliceBot, "Say hello")
			assert.equal(first.delivery, "started")
			const chat = first.chat,
				path = "/v1/chats/" + chat
			const initial = await settled(asAlice, chat)
			assert.equal(initial.chat.bot, aliceBot)
			assert.equal(initial.chat.kind, "direct")
			assert.equal(initial.chat.parent, null)
			assert.equal(initial.status, "Completed")
			assert.equal(initial.response?.id, first.turn)
			assert.deepEqual(
				Schema.decodeUnknownSync(Schema.Array(ChatSummary))(
					await (
						await request(alice.session, "/v1/chats?bot=" + aliceBot)
					).json(),
				).map((summary) => summary.chat.id),
				[chat],
			)
			assert.equal(
				(
					await request(alice.session, path, "PATCH", {
						expected: initial.chat.revision,
						mode: "invalid",
					})
				).status,
				400,
			)
			for (const suffix of ["", "/items", "/delegations", "/turns"])
				assert.equal((await request(bob.session, path + suffix)).status, 404)
			assert.equal(
				(
					await fetch(host.address + path, {
						headers: {
							cookie: "__Host-openbot-session=" + Redacted.value(alice.session),
						},
					})
				).status,
				200,
			)
			// The routes of versioned Sessions are gone.
			for (const [suffix, method] of [
				["/versions", "GET"],
				["/history", "GET"],
				["/memory", "GET"],
				["/fork", "POST"],
			] as const)
				assert.equal(
					(
						await request(
							alice.session,
							path + suffix,
							method,
							method === "POST" ? {} : undefined,
						)
					).status,
					404,
				)
			const requests = async (
				credential = alice.session,
			): Promise<ReadonlyArray<RequestsApi.CapabilityRequest>> =>
				Schema.decodeUnknownSync(Schema.Array(RequestsApi.CapabilityRequest))(
					await (
						await request(credential, "/v1/requests?status=pending")
					).json(),
				)
			const nextRequest = async () => {
				for (let tries = 0; tries < 200; tries++) {
					const list = await requests()
					if (list.length > 0) return list
					await pause()
				}
				return requests()
			}
			/** The notice in the Chat about a request, when it has come. */
			const noticeOf = async (ref: string) => {
				for (let tries = 0; tries < 200; tries++) {
					const page = Schema.decodeUnknownSync(
						Schema.Struct({ items: Schema.Array(Item.Record) }),
					)(
						await (
							await request(alice.session, path + "/items?limit=100")
						).json(),
					)
					const found = page.items.find(
						(item) =>
							item.origin?.notice?.kind === "request" &&
							item.origin.notice.ref === ref,
					)
					if (found !== undefined) return found
					await pause()
				}
				return undefined
			}
			// A call that needs approval gets a pending result at once, so the Turn does not wait.
			const asked = await message(asAlice, aliceBot, "request approval")
			assert.equal(asked.chat, chat)
			assert.equal(asked.delivery, "started")
			const pending = await nextRequest()
			const waiting = await settled(asAlice, chat)
			assert.equal(waiting.status, "Completed")
			assert.equal(waiting.response?.id, asked.turn)
			assert.equal(waiting.open.requests, 1)
			assert.equal(pending.length, 1)
			assert.equal(pending[0]!.capability.action, "tools.call")
			assert.equal(pending[0]!.chat, chat)
			assert.equal(host.toolCalls(), 0)
			assert.deepEqual(await requests(bob.session), [])
			const decide = "/v1/requests/" + pending[0]!.id
			assert.equal(
				(
					await request(alice.session, decide, "POST", {
						expected: pending[0]!.revision + 1,
						decision: "allow",
					})
				).status,
				409,
			)
			assert.equal(
				(
					await request(bob.session, decide, "POST", {
						expected: pending[0]!.revision,
						decision: "allow",
					})
				).status,
				404,
			)
			assert.equal(
				(
					await request(alice.session, decide, "POST", {
						expected: pending[0]!.revision,
						decision: "deny",
						reason: "Not now",
					})
				).status,
				200,
			)
			// The denial comes back to the Chat as a notice, and the call does not run.
			const denial = await noticeOf(pending[0]!.id)
			assert.ok(denial !== undefined)
			assert.match(JSON.stringify(denial.content), /Not now/)
			const denied = await settled(asAlice, chat)
			assert.equal(denied.open.requests, 0)
			assert.equal(host.toolCalls(), 0)
			assert.equal(
				(
					await request(alice.session, decide, "POST", {
						expected: pending[0]!.revision + 1,
						decision: "allow",
					})
				).status,
				409,
			)
			const again = await message(asAlice, aliceBot, "another approval")
			assert.equal(again.chat, chat)
			const second = await nextRequest()
			assert.equal(second.length, 1)
			assert.equal(
				(
					await request(
						alice.session,
						"/v1/requests/" + second[0]!.id,
						"POST",
						{
							expected: second[0]!.revision,
							decision: "allow",
						},
					)
				).status,
				200,
			)
			// The allowed call runs once, in a new step of the Chat.
			assert.ok((await noticeOf(second[0]!.id)) !== undefined)
			for (let tries = 0; tries < 200 && host.toolCalls() < 1; tries++)
				await pause()
			const completed = await settled(asAlice, chat)
			assert.equal(host.toolCalls(), 1)
			assert.equal(completed.open.requests, 0)
			assert.equal(completed.response?.status, "completed")
			// Interrupting a Chat that runs no Turn changes nothing.
			const interrupted = await request(
				alice.session,
				path + "/interrupt",
				"POST",
				{},
			)
			assert.equal(interrupted.status, 200)
			const unchanged = decode(await interrupted.json())
			assert.equal(unchanged.chat.revision, completed.chat.revision)
			assert.equal(unchanged.status, completed.status)
			const turns: {
				items: ReadonlyArray<{ id: string }>
				next: string | null
			} = await (await request(alice.session, path + "/turns?limit=1")).json()
			assert.equal(turns.items.length, 1)
			assert.ok(turns.next !== null)
			assert.equal(
				(await request(alice.session, path + "/turns/" + turns.items[0]!.id))
					.status,
				200,
			)
			assert.equal(
				(
					await request(
						alice.session,
						path + "/turns/" + turns.items[0]!.id + "/items?limit=1",
					)
				).status,
				200,
			)
			const planned = decode(
				await (
					await request(alice.session, path, "PATCH", {
						expected: completed.chat.revision,
						mode: "plan",
					})
				).json(),
			)
			assert.equal(planned.chat.settings.mode, "plan")
			assert.ok(planned.chat.revision > completed.chat.revision)
			assert.equal(
				(
					await request(alice.session, path, "PATCH", {
						expected: completed.chat.revision,
						mode: "build",
					})
				).status,
				409,
			)
			assert.equal((await view(asAlice, chat)).chat.settings.mode, "plan")
			// The Items of the Chat come newest first, one page at a time.
			const Page = Schema.Struct({
				items: Schema.Array(Item.Record),
				next: Schema.NullOr(Item.Seq),
			})
			const newest = Schema.decodeUnknownSync(Page)(
				await (await request(alice.session, path + "/items?limit=2")).json(),
			)
			assert.equal(newest.items.length, 2)
			assert.equal(newest.items[0]!.seq, newest.items[1]!.seq + 1)
			assert.equal(newest.next, newest.items[1]!.seq)
			const older = Schema.decodeUnknownSync(Page)(
				await (
					await request(
						alice.session,
						path + "/items?limit=2&before=" + newest.next,
					)
				).json(),
			)
			assert.equal(older.items[0]!.seq, newest.items[1]!.seq - 1)
			const beforeConsolidations = host.consolidations()
			const controller = new AbortController()
			const streaming = await fetch(host.address + path + "/messages", {
				method: "POST",
				signal: controller.signal,
				headers: {
					cookie:
						"__Host-openbot-session=" +
						encodeURIComponent(Redacted.value(alice.session)),
					origin: "https://web.example.com",
					"content-type": "application/json",
				},
				body: JSON.stringify({ input: "slow output", stream: true }),
			})
			assert.equal(streaming.status, 200)
			const reader = streaming.body!.getReader()
			let body = ""
			while (!body.includes("response.output_text.delta")) {
				const chunk = await reader.read()
				if (chunk.done) break
				body += new TextDecoder().decode(chunk.value)
			}
			assert.match(body, /response.output_text.delta/)
			// The Turn goes on after the client goes away.
			controller.abort()
			const final = await settled(asAlice, chat)
			assert.equal(final.response?.status, "completed")
			assert.equal(final.turn?.settings.mode, "plan")
			assert.equal(final.chat.settings.mode, "plan")
			assert.match(final.response.output[0]!.content[0]!.text, /Progress stays/)
			// No other model call ran. Bot memory learns only after the Bot confides,
			// and the empty pool gives the memory Bot nothing to add to the input.
			await new Promise((resolve) => setTimeout(resolve, 100))
			assert.equal(host.consolidations(), beforeConsolidations)
			const old = await (
				await request(alice.session, path + "/turns/" + completed.response!.id)
			).json()
			assert.deepEqual(
				Schema.decodeUnknownSync(ChatResponse)(old.response),
				completed.response,
			)
		} finally {
			await host.close()
		}
	},
)

test(
	"native SSE keeps Unicode, empty outputs, exact identities and one saved terminal result",
	{ timeout: 30000 },
	async () => {
		let calls = 0
		const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
		const model = await Effect.runPromise(
			LanguageModel.make({
				generateText: () =>
					Effect.succeed([
						Response.makePart("text", { text: '{"changes":[]}' }),
					]),
				streamText: ({ prompt }) => {
					calls++
					const user = prompt.content.findLast(
						(message) => message.role === "user",
					)
					const input = Match.value(user).pipe(
						Match.when({ role: "user" }, (message) =>
							message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join(""),
						),
						Match.orElse(() => ""),
					)
					const finish = (reason: Response.FinishReason) =>
						Response.makePart("finish", { reason, usage })
					const text = Stream.make(
						Response.makePart("text-start", { id: "text" }),
						Response.makePart("text-delta", {
							id: "text",
							delta: "héllo 🌍\n",
						}),
						Response.makePart("text-delta", { id: "text", delta: "é" }),
						Response.makePart("text-end", { id: "text" }),
					)
					return Match.value(input).pipe(
						Match.when("empty", () => Stream.make(finish("stop"))),
						Match.when("model-error", () =>
							text.pipe(
								Stream.concat(
									Stream.fail(
										AiError.make({
											module: "Fixture",
											method: "stream",
											reason: AiError.InvalidRequestError.make({
												description: "typed fixture failure",
											}),
										}),
									),
								),
							),
						),
						Match.when("defect", () =>
							text.pipe(Stream.concat(Stream.die(new Error("fixture defect")))),
						),
						Match.orElse(() =>
							text.pipe(
								Stream.concat(
									Stream.make(
										finish(
											input === "length"
												? "length"
												: input === "content-filter"
													? "content-filter"
													: "stop",
										),
									),
								),
							),
						),
					)
				},
			}),
		)
		const host = await BrowserHost.start({
			publicOrigin: "https://sse.example.com",
			model,
		})
		try {
			const account = await host.login("stream-observer")
			const request: Send = (path, method, payload) =>
				fetch(host.address + path, {
					method,
					headers: {
						cookie:
							"__Host-openbot-session=" +
							encodeURIComponent(Redacted.value(account.session)),
						origin: "https://sse.example.com",
						"content-type": "application/json",
					},
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				})
			for (const input of [
				"empty",
				"unicode",
				"length",
				"content-filter",
				"model-error",
				"defect",
			]) {
				// Each input goes to a new Bot, so it starts a new direct Chat.
				const observed = await bot(request, { name: "Observer " + input })
				const stream = await request(
					"/v1/bots/" + observed + "/messages",
					"POST",
					{ input, stream: true },
				)
				assert.equal(stream.status, 200)
				const events = (await stream.text())
					.split(/\r?\n\r?\n/)
					.flatMap((block) => {
						const data = block
							.split(/\r?\n/)
							.find((line) => line.startsWith("data:"))
						return data === undefined
							? []
							: [
									Schema.decodeSync(Schema.fromJsonString(ChatResponseEvent))(
										data.slice(5).trim(),
									),
								]
					})
				assert.deepEqual(
					events.map((event) => event.sequence_number),
					events.map((_, index) => index),
				)
				const terminal = events.filter((event) =>
					[
						"response.completed",
						"response.incomplete",
						"response.failed",
						"response.cancelled",
					].includes(event.type),
				)
				assert.equal(terminal.length, 1)
				const end = terminal[0]!
				assert.ok("response" in end)
				const [summary] = Schema.decodeUnknownSync(Schema.Array(ChatSummary))(
					await (await request("/v1/chats?bot=" + observed, "GET")).json(),
				)
				assert.ok(summary !== undefined)
				const current = await view(request, summary.chat.id)
				assert.deepEqual(end.response, current.response)
				assert.ok(
					events.every(
						(event) =>
							event.chat === current.chat.id &&
							event.turn === current.response!.id,
					),
				)
				const deltas = events.filter(
					(event) => event.type === "response.output_text.delta",
				)
				assert.ok(
					deltas.every(
						(event) =>
							event.step === 1 &&
							event.item_id === current.response!.output[0]!.id,
					),
				)
				if (input === "empty") {
					assert.equal(end.response.output[0]!.content[0]!.text, "")
					assert.ok(
						events.some((event) => event.type === "response.output_item.done"),
					)
				} else {
					assert.equal(end.response.output[0]!.content[0]!.text, "héllo 🌍\né")
				}
				if (input === "model-error" || input === "defect") {
					assert.equal(end.response.status, "failed")
					assert.equal(
						end.response.error?.code,
						input === "defect" ? "internal_error" : "model_error",
					)
				} else {
					assert.equal(
						end.response.status,
						["length", "content-filter"].includes(input)
							? "incomplete"
							: "completed",
					)
				}
			}
			assert.equal(calls, 6)
		} finally {
			await host.close()
		}
	},
)
