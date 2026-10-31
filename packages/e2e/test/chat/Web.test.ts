import { BrowserHost, Caller, Messages } from "@openbot-build/openbot/testing"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	Match,
	Option,
	pipe,
	Redacted,
	Ref,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { assert, it } from "@effect/vitest"
import {
	ChatResponse,
	ChatCommandReceipt,
	ChatSummary,
	ChatView,
	RequestsApi,
	Settings,
} from "@openbot-build/api"
import { Item, Turn } from "@openbot-build/core"
import { AiError, LanguageModel, type Prompt, Response } from "effect/ai"
import { HttpClient } from "effect/http"
const { bot, message, settled, view } = Messages
type Send = Messages.Send

/** Gives a value as JSON text. */
const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

/** Reads the JSON text of one live event. */
const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(Execution.Event))

const isUser = (message: Prompt.Message): message is Prompt.UserMessage =>
	message.role === "user"

/** The text parts of a message of the person, as one text. */
const textOf = (message: Prompt.UserMessage) =>
	pipe(
		message.content,
		Arr.filter((part) => part.type === "text"),
		Arr.map((part) => part.text),
		Arr.join(""),
	)

// The host runs real servers, so these tests need real time.
it.layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"public Chats, Turns, approvals and detached SSE share one execution",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin: "https://web.example.com",
				})
				const alice = yield* host.login("alice"),
					bob = yield* host.login("bob")
				const aliceBot = yield* host.defaultBot(alice.session)
				yield* host.defaultBot(bob.session)
				const address = yield* host.address
				const request = Caller.withCookie({
					address,
					publicOrigin: "https://web.example.com",
				})
				const asAlice: Send = (path, method, payload) =>
					request(alice.session, path, method, payload)
				// Bots learn memory only with the Bot memory model of the organization.
				const settings = yield* Effect.flatMap(
					request(alice.session, "/v1/organization/settings"),
					Caller.json(Settings.OrganizationSettings),
				)
				const configured = yield* request(
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
				assert.strictEqual(configured.status, 200, yield* configured.text)
				// The first message to a Bot makes the direct Chat of the member with it.
				const first = yield* message(asAlice, aliceBot, "Say hello")
				assert.ok(first.executionId.length > 0)
				const chat = first.chat,
					path = "/v1/chats/" + chat
				const initial = yield* settled(asAlice, chat)
				assert.strictEqual(initial.chat.bot, aliceBot)
				assert.strictEqual(initial.chat.kind, "direct")
				assert.strictEqual(initial.chat.parent, null)
				assert.strictEqual(initial.status, "Completed")
				assert.strictEqual(initial.response?.id, first.turn)
				assert.deepStrictEqual(
					Arr.map(
						yield* Effect.flatMap(
							request(alice.session, "/v1/chats?bot=" + aliceBot),
							Caller.json(Schema.Array(ChatSummary)),
						),
						(summary) => summary.chat.id,
					),
					[chat],
				)
				assert.strictEqual(
					(yield* request(alice.session, path, "PATCH", {
						expected: initial.chat.revision,
						mode: "invalid",
					})).status,
					400,
				)
				for (const suffix of ["", "/items", "/delegations", "/turns"])
					assert.strictEqual(
						(yield* request(bob.session, path + suffix)).status,
						404,
					)
				assert.strictEqual(
					(yield* HttpClient.get(address + path, {
						headers: {
							cookie: "__Host-openbot-session=" + Redacted.value(alice.session),
						},
					})).status,
					200,
				)
				// The routes of versioned Sessions are gone.
				for (const [suffix, method] of [
					["/versions", "GET"],
					["/history", "GET"],
					["/memory", "GET"],
					["/fork", "POST"],
				] as const)
					assert.strictEqual(
						(yield* request(
							alice.session,
							path + suffix,
							method,
							method === "POST" ? {} : undefined,
						)).status,
						404,
					)
				const requests = (credential = alice.session) =>
					Effect.flatMap(
						request(credential, "/v1/requests?status=pending"),
						Caller.json(Schema.Array(RequestsApi.CapabilityRequest)),
					)
				const nextRequest = requests().pipe(
					Effect.repeat({
						until: Arr.isReadonlyArrayNonEmpty,
						schedule: Schedule.spaced("25 millis"),
						times: 200,
					}),
				)
				/** The notice in the Chat about a request, when it has come. */
				const noticeOf = (ref: string) =>
					Effect.flatMap(
						request(alice.session, path + "/items?limit=100"),
						Caller.json(Schema.Struct({ items: Schema.Array(Item.Record) })),
					).pipe(
						Effect.map((page) =>
							Arr.findFirst(
								page.items,
								(item) =>
									item.origin?.notice?.kind === "request" &&
									item.origin.notice.ref === ref,
							),
						),
						Effect.repeat({
							until: Option.isSome,
							schedule: Schedule.spaced("25 millis"),
							times: 199,
						}),
					)
				// A call that needs approval gets a pending result at once, so the Turn does not wait.
				const asked = yield* message(asAlice, aliceBot, "request approval")
				assert.strictEqual(asked.chat, chat)
				assert.ok(asked.executionId.length > 0)
				const pending = yield* nextRequest
				const waiting = yield* settled(asAlice, chat)
				assert.strictEqual(waiting.status, "Completed")
				assert.strictEqual(waiting.response?.id, asked.turn)
				assert.strictEqual(waiting.open.requests, 1)
				assert.strictEqual(pending.length, 1)
				assert.strictEqual(pending[0]!.capability.action, "tools.call")
				assert.strictEqual(pending[0]!.chat, chat)
				assert.strictEqual(yield* host.toolCalls, 0)
				assert.deepStrictEqual(yield* requests(bob.session), [])
				const decide = "/v1/requests/" + pending[0]!.id
				assert.strictEqual(
					(yield* request(alice.session, decide, "POST", {
						commandKey: "decision-6275",
						expected: pending[0]!.revision + 1,
						decision: "allow",
					})).status,
					409,
				)
				assert.strictEqual(
					(yield* request(bob.session, decide, "POST", {
						commandKey: "decision-6451",
						expected: pending[0]!.revision,
						decision: "allow",
					})).status,
					404,
				)
				assert.strictEqual(
					(yield* request(alice.session, decide, "POST", {
						commandKey: "decision-6625",
						expected: pending[0]!.revision,
						decision: "deny",
						reason: "Not now",
					})).status,
					202,
				)
				// The denial comes back to the Chat as a notice, and the call does not run.
				const denial = yield* noticeOf(pending[0]!.id)
				assert.ok(Option.isSome(denial))
				assert.match(yield* jsonText(denial.value.content), /Not now/)
				const denied = yield* settled(asAlice, chat)
				assert.strictEqual(denied.open.requests, 0)

				const retried = yield* request(alice.session, decide, "POST", {
					commandKey: "decision-6625",
					expected: pending[0]!.revision,
					decision: "deny",
					reason: "Not now",
				}).pipe(Effect.flatMap(Caller.json(Execution.Receipt, 202)))
				assert.strictEqual(retried.executionId, pending[0]!.executionId)
				assert.strictEqual(
					(yield* request(alice.session, decide, "POST", {
						commandKey: "decision-6625",
						expected: pending[0]!.revision,
						decision: "deny",
						reason: "Changed answer",
					})).status,
					409,
				)
				assert.strictEqual(yield* host.toolCalls, 0)
				assert.strictEqual(
					(yield* request(alice.session, decide, "POST", {
						commandKey: "decision-7205",
						expected: pending[0]!.revision + 1,
						decision: "allow",
					})).status,
					409,
				)
				const again = yield* message(asAlice, aliceBot, "another approval")
				assert.strictEqual(again.chat, chat)
				const second = yield* nextRequest
				assert.strictEqual(second.length, 1)
				assert.strictEqual(
					(yield* request(
						alice.session,
						"/v1/requests/" + second[0]!.id,
						"POST",
						{
							commandKey: "decision-7626",
							expected: second[0]!.revision,
							decision: "allow",
						},
					)).status,
					202,
				)
				// The allowed call runs once, in a new step of the Chat.
				assert.ok(Option.isSome(yield* noticeOf(second[0]!.id)))
				yield* host.toolCalls.pipe(
					Effect.repeat({
						until: (count) => count >= 1,
						schedule: Schedule.spaced("25 millis"),
						times: 199,
					}),
				)
				const completed = yield* settled(asAlice, chat)
				assert.strictEqual(yield* host.toolCalls, 1)
				assert.strictEqual(completed.open.requests, 0)
				assert.strictEqual(completed.response?.status, "completed")
				// Interrupting a Chat that runs no Turn changes nothing.
				const interrupted = yield* request(
					alice.session,
					path + "/interrupt",
					"POST",
					{ commandKey: "stop-idle" },
				)
				assert.strictEqual(interrupted.status, 202)
				const unchanged = yield* Caller.read(
					ChatView,
					request(alice.session, path),
				)
				assert.strictEqual(unchanged.chat.revision, completed.chat.revision)
				assert.strictEqual(unchanged.status, completed.status)
				const turns = yield* Effect.flatMap(
					request(alice.session, path + "/turns?limit=1"),
					Caller.json(
						Schema.Struct({
							items: Schema.Array(Turn.Record),
							next: Schema.NullOr(Turn.Id),
						}),
					),
				)
				assert.strictEqual(turns.items.length, 1)
				assert.ok(turns.next !== null)
				assert.strictEqual(
					(yield* request(alice.session, path + "/turns/" + turns.items[0]!.id))
						.status,
					200,
				)
				assert.strictEqual(
					(yield* request(
						alice.session,
						path + "/turns/" + turns.items[0]!.id + "/items?limit=1",
					)).status,
					200,
				)
				const planned = yield* Effect.flatMap(
					request(alice.session, path, "PATCH", {
						expected: completed.chat.revision,
						mode: "plan",
					}),
					Caller.json(ChatView),
				)
				assert.strictEqual(planned.chat.settings.mode, "plan")
				assert.ok(planned.chat.revision > completed.chat.revision)
				assert.strictEqual(
					(yield* request(alice.session, path, "PATCH", {
						expected: completed.chat.revision,
						mode: "build",
					})).status,
					409,
				)
				assert.strictEqual(
					(yield* view(asAlice, chat)).chat.settings.mode,
					"plan",
				)
				// The Items of the Chat come newest first, one page at a time.
				const Page = Schema.Struct({
					items: Schema.Array(Item.Record),
					next: Schema.NullOr(Item.Seq),
				})
				const newest = yield* Effect.flatMap(
					request(alice.session, path + "/items?limit=2"),
					Caller.json(Page),
				)
				assert.strictEqual(newest.items.length, 2)
				assert.strictEqual(newest.items[0]!.seq, newest.items[1]!.seq + 1)
				assert.strictEqual(newest.next, newest.items[1]!.seq)
				const older = yield* Effect.flatMap(
					request(alice.session, path + "/items?limit=2&before=" + newest.next),
					Caller.json(Page),
				)
				assert.strictEqual(older.items[0]!.seq, newest.items[1]!.seq - 1)
				const beforeConsolidations = yield* host.consolidations
				const accepted = yield* request(
					alice.session,
					path + "/messages",
					"POST",
					{ input: "slow output", commandKey: "slow-output" },
				).pipe(Effect.flatMap(Caller.json(ChatCommandReceipt, 202)))
				const streaming = yield* request(
					alice.session,
					`/v1/executions/${accepted.executionId}/observe?afterSequence=0`,
				)
				assert.strictEqual(streaming.status, 200)
				// The client reads until the first text delta. Then it closes the connection.
				const body = yield* streaming.stream.pipe(
					Stream.decodeText(),
					Stream.scan(
						() => "",
						(body, chunk: string) => body + chunk,
					),
					Stream.takeUntil(Str.includes('"_tag":"Text"')),
					Stream.runLast,
					Effect.map(Option.getOrElse(() => "")),
				)
				assert.match(body, /"_tag":"Text"/)
				// The Turn goes on after the client goes away.
				const final = yield* settled(asAlice, chat)
				assert.strictEqual(final.response?.status, "completed")
				assert.strictEqual(final.turn?.settings.mode, "plan")
				assert.strictEqual(final.chat.settings.mode, "plan")
				const firstPart = final.response!.output[0]!.content[0]!
				assert.strictEqual(firstPart.type, "output_text")
				assert.match(
					firstPart.type === "output_text" ? firstPart.text : "",
					/Progress stays/,
				)
				// No other model call ran. Bot memory learns only after the Bot confides,
				// and the empty pool gives the memory Bot nothing to add to the input.
				yield* Effect.sleep("100 millis")
				assert.strictEqual(yield* host.consolidations, beforeConsolidations)
				const old = yield* Effect.flatMap(
					request(alice.session, path + "/turns/" + completed.response!.id),
					Caller.json(Schema.Struct({ response: ChatResponse })),
				)
				assert.deepStrictEqual(old.response, completed.response)
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"native SSE keeps Unicode, empty outputs, exact identities and one saved terminal result",
		() =>
			Effect.gen(function* () {
				const calls = yield* Ref.make(0)
				const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }
				const model = yield* LanguageModel.make({
					generateText: () =>
						Effect.succeed([
							Response.makePart("text", { text: '{"changes":[]}' }),
						]),
					streamText: ({ prompt }) => {
						const input = pipe(
							Arr.findLast(prompt.content, isUser),
							Option.map(textOf),
							Option.getOrElse(() => ""),
						)
						const finish = (reason: Response.FinishReason) =>
							Response.makePart("finish", { reason, usage })
						const text = Stream.make(
							Response.makePart("text-start", { id: "text" }),
							Response.makePart("text-delta", {
								id: "text",
								delta: "héllo 🌍\n",
							}),
							Response.makePart("text-delta", { id: "text", delta: "é" }),
							Response.makePart("text-end", { id: "text" }),
						)
						const answer = Match.value(input).pipe(
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
								text.pipe(
									Stream.concat(Stream.die(new Error("fixture defect"))),
								),
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
						return Stream.unwrap(
							Effect.as(
								Ref.update(calls, (count) => count + 1),
								answer,
							),
						)
					},
				})
				const host = yield* BrowserHost.start({
					publicOrigin: "https://sse.example.com",
					model,
				})
				const account = yield* host.login("stream-observer")
				const call = Caller.withCookie({
					address: yield* host.address,
					publicOrigin: "https://sse.example.com",
				})
				const request: Send = (path, method, payload) =>
					call(account.session, path, method, payload)
				for (const input of [
					"empty",
					"unicode",
					"length",
					"content-filter",
					"model-error",
					"defect",
				]) {
					// Each input goes to a new Bot, so it starts a new direct Chat.
					const observed = yield* bot(request, { name: "Observer " + input })
					const accepted = yield* message(request, observed, input)
					const stream = yield* request(
						`/v1/executions/${accepted.executionId}/observe?afterSequence=0`,
						"GET",
					)
					assert.strictEqual(stream.status, 200)
					const events = yield* Effect.forEach(
						pipe(
							Str.split(yield* stream.text, /\r?\n\r?\n/),
							Arr.flatMap((block) =>
								Option.toArray(
									Arr.findFirst(
										Str.split(block, /\r?\n/),
										Str.startsWith("data:"),
									),
								),
							),
						),
						(data) => decodeEvent(Str.trim(Str.slice(5)(data))),
					)
					assert.deepStrictEqual(
						Arr.map(events, (event) => event.sequence),
						Arr.map(events, (_, index) => index + 1),
					)
					assert.ok(
						Arr.every(
							events,
							(event) => event.executionId === accepted.executionId,
						),
					)
					const terminal = Arr.filter(
						events,
						(event) =>
							event.body._tag === "State" &&
							Execution.isTerminal(event.body.status),
					)
					assert.strictEqual(terminal.length, 1)
					const end = terminal[0]!.body
					assert.ok(end._tag === "State")
					const current = yield* view(request, accepted.chat)
					const text = Arr.flatMap(events, (event) =>
						event.body._tag === "Text" ? [event.body] : [],
					)
					assert.ok(Arr.every(text, (event) => event.attempt === 0))
					assert.strictEqual(
						Arr.join(
							Arr.map(text, (event) => event.text),
							"",
						),
						input === "empty" ? "" : "héllo 🌍\né",
					)
					if (input === "model-error" || input === "defect") {
						assert.strictEqual(end.status, "failed")
						assert.ok(end.failure !== null)
						assert.strictEqual(current.response?.status, "failed")
						assert.ok(!Str.includes("fixture defect")(yield* jsonText(current)))
						assert.ok(
							!Str.includes("typed fixture failure")(yield* jsonText(current)),
						)
					} else {
						assert.strictEqual(end.status, "completed")
						assert.strictEqual(
							current.response?.status,
							Arr.contains(["length", "content-filter"], input)
								? "incomplete"
								: "completed",
						)
						const part = current.response!.output[0]!.content[0]!
						assert.strictEqual(part.type, "output_text")
						assert.strictEqual(
							part.type === "output_text" ? part.text : "",
							input === "empty" ? "" : "héllo 🌍\né",
						)
					}
				}
				assert.strictEqual(yield* Ref.get(calls), 6)
			}),
		{ timeout: 30000 },
	)
})
