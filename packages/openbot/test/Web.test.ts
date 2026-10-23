import { Effect, Match, Redacted, Schema, Stream } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import {
	SessionMemory,
	SessionView,
	SessionResponseEvent,
	RequestsApi,
} from "@openbot-build/api"
import { AiError, LanguageModel, Response } from "effect/ai"
import { Timeline, Session } from "@openbot-build/core"
import * as BrowserHost from "./BrowserHost.ts"

test(
	"public Sessions, Turns, approvals, historical Fork and detached SSE share one execution",
	{ timeout: 60000 },
	async () => {
		const host = await BrowserHost.start({
			publicOrigin: "https://web.example.com",
		})
		try {
			const alice = await host.login("alice"),
				bob = await host.login("bob")
			const aliceAgent = await host.defaultAgent(alice.session)
			await host.defaultAgent(bob.session)
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
			// Agents learn memory only with the Agent memory model of the organization.
			const settings = await (
				await request(alice.session, "/v1/organization/settings")
			).json()
			const configured = await request(
				alice.session,
				"/v1/organization/settings",
				"PATCH",
				{
					expectedVersion: settings.version,
					agentMemoryModel: {
						_tag: "Config.Selection",
						provider: "fixture",
						model: "fixture-model",
					},
				},
			)
			assert.equal(configured.status, 200, await configured.clone().text())
			const decode = Schema.decodeUnknownSync(SessionView)
			const get = async (path: string) =>
				decode(await (await request(alice.session, path)).json())
			const created = await request(alice.session, "/v1/sessions", "POST", {
				title: "A workflow",
			})
			assert.equal(created.status, 201)
			const initial = decode(await created.json()),
				path = "/v1/sessions/" + initial.session.id
			assert.equal(
				(
					await request(alice.session, "/v1/sessions", "POST", {
						settings: { mode: "invalid" },
					})
				).status,
				400,
			)
			const versions = Schema.decodeUnknownSync(Schema.Array(Timeline.Version))(
				await (await request(alice.session, path + "/versions")).json(),
			)
			assert.deepEqual(versions, [initial.state.version])
			for (const suffix of ["", "/versions", "/delegations", "/turns"])
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
			const wait = async (target = path): Promise<SessionView> => {
				let view = await get(target)
				for (let tries = 0; tries < 200 && view.activity === "active"; tries++)
					view = decode(
						await (
							await request(
								alice.session,
								target +
									"/wait?after=" +
									view.session.revision +
									"&afterActivity=" +
									view.activity +
									"&timeoutMs=100",
							)
						).json(),
					)
				assert.notEqual(view.activity, "active")
				return view
			}
			assert.equal(
				(
					await request(alice.session, path + "/turns", "POST", {
						expected: initial.session.revision,
						input: "request approval",
					})
				).status,
				202,
			)
			const waiting = await wait()
			assert.equal(Session.status(waiting.session)._tag, "Waiting")
			const requests = async (
				credential = alice.session,
			): Promise<ReadonlyArray<RequestsApi.CapabilityRequest>> =>
				Schema.decodeUnknownSync(Schema.Array(RequestsApi.CapabilityRequest))(
					await (
						await request(credential, "/v1/requests?status=pending")
					).json(),
				)
			// The request appears when OpenBot has seen that the Turn waits.
			const nextRequest = async () => {
				for (let tries = 0; tries < 200; tries++) {
					const list = await requests()
					if (list.length > 0) return list
					await new Promise((resolve) => setTimeout(resolve, 25))
				}
				return requests()
			}
			/** Waits until the Turn no longer waits for a decision. */
			const settled = async () => {
				for (let tries = 0; tries < 200; tries++) {
					const view = await wait()
					if (Session.status(view.session)._tag !== "Waiting") return view
					await new Promise((resolve) => setTimeout(resolve, 25))
				}
				return wait()
			}
			const pending = await nextRequest()
			assert.equal(pending.length, 1)
			assert.equal(pending[0]!.capability.action, "tools.call")
			assert.equal(pending[0]!.session, initial.session.id)
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
					await request(alice.session, path + "/fork", "POST", {
						version: waiting.session.head,
					})
				).status,
				400,
			)
			const fork = decode(
				await (await request(alice.session, path + "/fork", "POST", {})).json(),
			)
			assert.equal(fork.session.head, initial.session.head)
			assert.deepEqual(fork.session.turns, [])
			assert.equal(fork.agent, initial.agent)
			assert.equal(fork.kind, "direct")
			assert.equal(fork.parent, null)
			assert.deepEqual(fork.session.pending, [])
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
			const denied = await settled()
			assert.notEqual(Session.status(denied.session)._tag, "Waiting")
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
			assert.equal(
				(
					await request(alice.session, path + "/turns", "POST", {
						expected: denied.session.revision,
						input: "another approval",
					})
				).status,
				202,
			)
			await wait()
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
			const completed = await settled()
			assert.equal(host.toolCalls(), 1)
			const control =
				path + "/turns/" + Session.currentTurn(completed.session)!.id
			assert.equal(
				(await request(alice.session, control + "/interrupt", "POST", {}))
					.status,
				409,
			)
			assert.equal(
				(
					await request(alice.session, control + "/steer", "POST", {
						input: "late",
					})
				).status,
				409,
			)
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
					await request(alice.session, path + "/mode", "PUT", {
						expected: completed.session.revision,
						mode: "plan",
					})
				).json(),
			)
			assert.equal(planned.session.head, completed.session.head)
			assert.equal(planned.session.settings.mode, "plan")
			assert.equal(
				(
					await request(alice.session, path + "/mode", "PUT", {
						expected: completed.session.revision,
						mode: "build",
					})
				).status,
				409,
			)
			const historical = Schema.decodeUnknownSync(Timeline.State({}))(
				await (
					await request(
						alice.session,
						path + "/history?version=" + initial.session.head,
					)
				).json(),
			)
			assert.equal(historical.value.conversation.history.length, 0)
			assert.equal((await get(path)).session.head, planned.session.head)
			const memoryOf = async () =>
				Schema.decodeUnknownSync(SessionMemory)(
					await (await request(alice.session, path + "/memory")).json(),
				)
			const configure = async (
				view: typeof planned,
				command: { use?: boolean | null; generate?: boolean | null },
			) =>
				decode(
					await (
						await request(alice.session, path + "/memory", "POST", {
							expected: view.session.head,
							revision: view.session.revision,
							command: { _tag: "Configure", ...command },
						})
					).json(),
				)
			assert.deepEqual((await memoryOf()).settings, {
				use: true,
				generate: true,
			})
			const generationOff = await configure(planned, { generate: false })
			assert.equal(generationOff.session.head, planned.session.head)
			assert.ok(generationOff.session.revision > planned.session.revision)
			assert.deepEqual((await memoryOf()).overrides, { generate: false })
			assert.deepEqual((await memoryOf()).settings, {
				use: true,
				generate: false,
			})
			const beforeConsolidations = host.consolidations()
			const controller = new AbortController()
			const streaming = await fetch(host.address + path + "/turns", {
				method: "POST",
				signal: controller.signal,
				headers: {
					cookie:
						"__Host-openbot-session=" +
						encodeURIComponent(Redacted.value(alice.session)),
					origin: "https://web.example.com",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					expected: generationOff.session.revision,
					input: "slow output",
					overrides: { mode: "build" },
					stream: true,
				}),
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
			controller.abort()
			const final = await wait()
			assert.equal(final.response?.status, "completed")
			assert.equal(final.session.turns.at(-1)!.settings.mode, "build")
			assert.equal(final.session.settings.mode, "plan")
			assert.equal(host.consolidations(), beforeConsolidations)
			assert.match(final.response.output[0]!.content[0]!.text, /Progress stays/)
			const configuredFork = decode(
				await (await request(alice.session, path + "/fork", "POST", {})).json(),
			)
			assert.deepEqual(
				Schema.decodeUnknownSync(SessionMemory)(
					await (
						await request(
							alice.session,
							"/v1/sessions/" + configuredFork.session.id + "/memory",
						)
					).json(),
				).overrides,
				{ generate: false },
			)
			const generationDefault = await configure(final, { generate: null })
			assert.deepEqual((await memoryOf()).overrides, {})
			assert.equal(
				(
					await request(alice.session, path + "/turns", "POST", {
						expected: generationDefault.session.revision,
						input: "one explicit extraction",
					})
				).status,
				202,
			)
			await wait()
			// One model call learns Session memory. Agent memory learns only after the Agent
			// confides, and the empty pool gives the memory Agent nothing to add to the input.
			for (
				let tries = 0;
				tries < 200 && host.consolidations() < beforeConsolidations + 1;
				tries++
			)
				await new Promise((resolve) => setTimeout(resolve, 25))
			await new Promise((resolve) => setTimeout(resolve, 100))
			assert.equal(host.consolidations(), beforeConsolidations + 1)
			const old = await (
				await request(alice.session, path + "/turns/" + completed.response!.id)
			).json()
			assert.equal(old.response.id, completed.response!.id)
			assert.equal(old.response.version, completed.response!.version)
			// Sessions without an Agent belong to the default Agent of the member.
			assert.equal(initial.agent, aliceAgent)
			assert.equal(
				(await request(alice.session, path + "/merge", "POST", {})).status,
				404,
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
			await host.defaultAgent(account.session)
			const request = (path: string, payload?: unknown) =>
				fetch(host.address + path, {
					method: payload === undefined ? "GET" : "POST",
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
				const created = Schema.decodeUnknownSync(SessionView)(
					await (await request("/v1/sessions", {})).json(),
				)
				const path = "/v1/sessions/" + created.session.id
				const stream = await request(path + "/turns", {
					input,
					expected: created.session.revision,
					stream: true,
				})
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
									Schema.decodeSync(
										Schema.fromJsonString(SessionResponseEvent),
									)(data.slice(5).trim()),
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
				const view = Schema.decodeUnknownSync(SessionView)(
					await (await request(path)).json(),
				)
				assert.deepEqual(end.response, view.response)
				assert.ok(
					events.every(
						(event) =>
							event.session === view.session.id &&
							event.turn === view.response!.id,
					),
				)
				const deltas = events.filter(
					(event) => event.type === "response.output_text.delta",
				)
				assert.ok(
					deltas.every(
						(event) =>
							event.step === 1 &&
							event.item_id === view.response!.output[0]!.id,
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
