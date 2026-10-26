import { assert, layer } from "@effect/vitest"
import {
	AppViewsApi as Api,
	AppExecution,
	AppExperienceApi,
	type ChatView,
	ConnectionsApi,
	RequestsApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Effect,
	Layer,
	Option,
	Schedule,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Response } from "effect/ai"
import type { HttpMethod } from "effect/http"
import * as Network from "@openbot-build/protocol/NodeHttpServer"
import { AppNetwork } from "../src/apps/AppHost.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import { message, settled, type Send } from "./Messages.ts"
const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

/** No new Turn ran in a Chat in time. */
class NoNewTurn extends Schema.TaggedError<
	NoNewTurn,
	{ readonly brand: unique symbol }
>()("NoNewTurn", { chat: Schema.String }) {
	override get message() {
		return "No new Turn ran in the Chat " + this.chat
	}
}

/** One page of the Items of a Chat, with only the fields that the test reads. */
const ItemsPage = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			content: Schema.Struct({
				content: Schema.Array(
					Schema.Struct({ role: Schema.String, content: Schema.Unknown }),
				),
			}),
		}),
	),
	next: Schema.NullOr(Schema.Finite),
})

/**
 * Reads the JSON body of an answer with a schema, and fails unless the status
 * is 2xx. The server writes the JSON form of each schema, where a missing
 * optional value is null.
 */
const json = <S extends Schema.Constraint>(schema: S) =>
	Caller.json(Schema.toCodecJson(schema))

const isToolResult = Schema.is(
	Schema.Struct({ type: Schema.Literal("tool-result"), id: Schema.String }),
)

/** The query of one page of Items, before the given Item position. */
const itemsQuery = (before?: number) =>
	new URLSearchParams({
		limit: "100",
		...(before === undefined ? {} : { before: String(before) }),
	}).toString()

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"App views bind to the real history and account, accept each exact host action once, keep confirmed state and survive view closure",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start({ capabilities: true })
				const model = yield* LanguageModel.make({
					generateText: () =>
						Effect.succeed([
							Response.makePart("text", { text: '{"changes":[]}' }),
						]),
					streamText: ({ prompt, tools }) => {
						const last = Arr.findLastIndex(
							prompt.content,
							(m) => m.role === "user",
						)
						const input = Option.flatMap(last, (index) =>
							Arr.get(prompt.content, index),
						)
						// A message from OpenBot, such as a decision, asks for no new App call.
						const notice = Option.exists(
							input,
							(m) =>
								m.role === "user" &&
								Arr.some(
									m.content,
									(p) =>
										p.type === "text" && Str.startsWith("[OpenBot]")(p.text),
								),
						)
						const finished =
							notice ||
							Arr.some(
								Arr.drop(prompt.content, Option.getOrElse(last, () => -1) + 1),
								(m) =>
									m.role === "tool" &&
									Arr.some(m.content, (p) => p.type === "tool-result"),
							)
						const tool = Arr.findFirst(
							tools,
							(tool) =>
								tool.description !== undefined &&
								Str.includes(" / read_document.")(tool.description),
						)
						return finished || Option.isNone(tool)
							? Stream.make(
									Response.makePart("finish", { reason: "stop", usage }),
								)
							: Stream.make(
									Response.makePart("tool-call", {
										id: "document-call",
										name: tool.value.name,
										params: { id: "alpha" },
										providerExecuted: false,
									}),
									Response.makePart("finish", { reason: "tool-calls", usage }),
								)
					},
				})
				const publicOrigin = "https://openbot.fixture.test"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model,
					discovery: publisher.discovery,
					appProbe: publisher.probe,
					appNetwork: Layer.succeed(AppNetwork, {
						layer: (owner, origins) =>
							Network.layerUserNetwork({
								owner,
								allowedOrigins: origins,
								ca: publisher.ca,
								allowAddress: (ip) => ip === "127.0.0.1",
							}),
					}),
				})
				const alice = yield* host.login("views-alice")
				const bob = yield* host.login("views-bob")
				const bot = yield* host.defaultBot(alice.session)
				yield* host.defaultBot(bob.session)
				/** Calls the server as a signed-in browser. A restart changes the address. */
				const request = (
					path: string,
					method: HttpMethod.HttpMethod = "GET",
					body?: unknown,
					cookie = alice.session,
				) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							cookie,
							path,
							method,
							body,
						),
					)
				const post = (path: string, body: unknown) =>
					request(path, "POST", body)
				const draft = yield* Effect.flatMap(
					post("/v1/connection-drafts", {
						input: publisher.origin + "/card",
					}),
					json(ConnectionsApi.ConnectionDraft),
				)
				const added = yield* post("/v1/connections", {
					draftId: draft.id,
					revision: draft.revision,
					cardUrl: publisher.origin + "/card",
					remoteIndex: 0,
					values: {
						"header:X-Account": "Work",
						"header:X-Secret": "secret-work",
					},
					name: "Work documents",
					confirmed: true,
				})
				assert.strictEqual(added.status, 201, yield* added.text)
				const asAlice: Send = (path, method, payload) =>
					request(path, method, payload)
				const receipt = yield* message(asAlice, bot, "Read the document")
				const id = receipt.chat
				const wait = settled(asAlice, id)
				/** Waits until a Turn after `turn` has run, and the Chat is at rest. */
				const after = (turn: string | undefined) => {
					const isNew = (view: ChatView) =>
						view.turn !== null && view.turn.id !== turn
					return wait.pipe(
						Effect.repeat({
							until: isNew,
							schedule: Schedule.spaced("25 millis"),
							times: 199,
						}),
						Effect.filterOrFail(isNew, () => NoNewTurn.make({ chat: id })),
					)
				}
				/** All Items of the Chat. */
				const items = Stream.runCollect(
					Stream.paginate(itemsQuery(), (query) =>
						Effect.map(
							Effect.flatMap(
								request("/v1/chats/" + id + "/items?" + query),
								json(ItemsPage),
							),
							(page) =>
								[
									page.items,
									Option.map(Option.fromNullishOr(page.next), itemsQuery),
								] as const,
						),
					),
				)
				/**
				 * Answers the one pending request of the Chat. The decision comes back to the
				 * Chat as a message, so this waits until the next Turn has run.
				 */
				const approve = (accepted = true) =>
					Effect.gen(function* () {
						const pending = yield* Effect.flatMap(
							request("/v1/requests?status=pending"),
							json(Schema.Array(RequestsApi.CapabilityRequest)),
						).pipe(
							Effect.map(Arr.filter((entry) => entry.chat === id)),
							Effect.repeat({
								until: Arr.isReadonlyArrayNonEmpty,
								schedule: Schedule.spaced("25 millis"),
								times: 199,
							}),
						)
						assert.strictEqual(pending.length, 1)
						const entry = yield* Effect.fromOption(Arr.head(pending))
						const before = (yield* wait).turn?.id
						const response = yield* post("/v1/requests/" + entry.id, {
							expected: entry.revision,
							decision: accepted ? "allow" : "deny",
						})
						assert.strictEqual(response.status, 200, yield* response.text)
						return yield* after(before)
					})
				const operations = Effect.flatMap(
					request("/v1/chats/" + id + "/app-operations"),
					json(Schema.Array(AppExecution.Invocation)),
				)
				yield* wait
				yield* approve()
				const original = yield* Effect.fromOption(Arr.head(yield* operations))
				const item = yield* Effect.fromOption(
					Arr.findFirst(yield* items, (item) =>
						Arr.some(
							item.content.content,
							(m) =>
								m.role === "tool" &&
								Arr.isArray(m.content) &&
								Arr.some(
									m.content,
									(p) => isToolResult(p) && p.id === original.callId,
								),
						),
					),
				)
				const opening = { chatId: id, itemId: item.id }
				const openResponse = yield* post(
					"/v1/app-operations/" + original.id + "/view",
					opening,
				)
				const openBody = yield* openResponse.text
				assert.strictEqual(openResponse.status, 200, openBody)
				const view = yield* json(Api.Opened)(openResponse)
				assert.strictEqual(view.resource.mimeType, "text/html;profile=mcp-app")
				assert.strictEqual(Str.includes("secret-work")(openBody), false)
				assert.strictEqual(
					(yield* request(
						"/v1/app-views/" + view.id,
						"GET",
						undefined,
						bob.session,
					)).status,
					404,
				)
				assert.strictEqual(
					(yield* post("/v1/app-operations/" + original.id + "/view", {
						...opening,
						itemId: "arbitrary",
					})).status,
					404,
				)
				const context = {
					content: [{ type: "text", text: "Confirmed selection alpha" }],
				}
				const saved = yield* request(
					"/v1/app-views/" + view.id + "/context",
					"PUT",
					{ revision: 0, context },
				)
				assert.strictEqual(saved.status, 200, yield* saved.text)
				assert.strictEqual(
					(yield* request("/v1/app-views/" + view.id + "/context", "PUT", {
						revision: 0,
						context,
					})).status,
					409,
				)

				const action = {
					kind: "tool",
					requestId: "write-one",
					name: "write_board",
					arguments: { id: "alpha", text: "Reviewed document" },
				}
				const accepted = yield* post(
					"/v1/app-views/" + view.id + "/actions",
					action,
				)
				assert.strictEqual(accepted.status, 202, yield* accepted.text)
				const ticket = yield* accepted.json
				const duplicate = yield* post(
					"/v1/app-views/" + view.id + "/actions",
					action,
				)
				assert.strictEqual(duplicate.status, 202, yield* duplicate.text)
				assert.deepStrictEqual(yield* duplicate.json, ticket)
				assert.strictEqual(
					(yield* post("/v1/app-views/" + view.id + "/actions", {
						...action,
						arguments: { id: "different", text: "No" },
					})).status,
					409,
				)
				yield* wait
				assert.strictEqual((yield* publisher.writes).length, 0)
				assert.strictEqual(
					(yield* request("/v1/app-views/" + view.id, "DELETE")).status,
					200,
				)
				yield* approve()
				assert.deepStrictEqual(yield* publisher.writes, [
					{ account: "Work", text: "Reviewed document" },
				])
				assert.strictEqual(
					(yield* post("/v1/app-views/" + view.id + "/actions", {
						...action,
						requestId: "closed",
					})).status,
					404,
				)
				const restored = yield* Effect.flatMap(
					post("/v1/app-operations/" + original.id + "/view", opening),
					json(Api.Opened),
				)
				assert.deepStrictEqual(restored.interaction, { revision: 1, context })
				assert.strictEqual((yield* publisher.writes).length, 1)
				const appOnly = yield* post(
					"/v1/app-views/" + restored.id + "/actions",
					{
						kind: "tool",
						requestId: "app-only",
						name: "hidden_action",
						arguments: { id: "alpha" },
					},
				)
				assert.strictEqual(appOnly.status, 202, yield* appOnly.text)
				yield* wait
				yield* approve(false)
				assert.strictEqual(yield* publisher.businessCalls, 2)
				assert.strictEqual(
					Arr.some(
						yield* operations,
						(r) => r.source.name === "hidden_action" && r.status === "Rejected",
					),
					true,
				)
				yield* host.restart
				// A view keeps no state in the process, so it stays open after a restart.
				const reopened = yield* request("/v1/app-views/" + restored.id)
				assert.strictEqual(reopened.status, 200, yield* reopened.text)
				const durable = yield* Effect.flatMap(
					post("/v1/app-operations/" + original.id + "/view", opening),
					json(Api.Opened),
				)
				assert.deepStrictEqual(durable.interaction, { revision: 1, context })
				assert.strictEqual((yield* publisher.writes).length, 1)
				const exportedResponse = yield* request("/v1/app-experience/export")
				assert.strictEqual(
					exportedResponse.status,
					200,
					yield* exportedResponse.text,
				)
				const exported = yield* exportedResponse.json
				assert.deepStrictEqual(exported, {
					format: "openbot-apps-v1",
					apps: [
						{
							name: "Work documents",
							cardUrl: publisher.origin + "/card",
							remoteIndex: 0,
						},
					],
				})
				const importedResponse = yield* request(
					"/v1/app-experience/import",
					"POST",
					exported,
					bob.session,
				)
				assert.strictEqual(
					importedResponse.status,
					200,
					yield* importedResponse.text,
				)
				const imported = yield* json(AppExperienceApi.Imported)(
					importedResponse,
				)
				const bobDraft = yield* Effect.fromOption(
					Option.flatMapNullishOr(
						Arr.head(imported.entries),
						(entry) => entry.draft,
					),
				)
				assert.strictEqual(bobDraft.discovery._tag, "Single")
				assert.deepStrictEqual(
					yield* Effect.flatMap(
						request("/v1/connections", "GET", undefined, bob.session),
						(response) => response.json,
					),
					[],
				)
				const bobConnection = yield* request(
					"/v1/connections",
					"POST",
					{
						draftId: bobDraft.id,
						revision: bobDraft.revision,
						cardUrl: publisher.origin + "/card",
						remoteIndex: 0,
						values: {
							"header:X-Account": "Bob",
							"header:X-Secret": "secret-bob",
						},
						name: "Bob documents",
						confirmed: true,
					},
					bob.session,
				)
				assert.strictEqual(bobConnection.status, 201, yield* bobConnection.text)
				const resetResponse = yield* post("/v1/app-experience/reset", {})
				assert.strictEqual(resetResponse.status, 200, yield* resetResponse.text)
				const reset = yield* json(AppExperienceApi.Reset)(resetResponse)
				assert.strictEqual(reset.removed.length, 1)
				assert.deepStrictEqual(reset.pending, [])
				assert.deepStrictEqual(
					yield* Effect.flatMap(
						request("/v1/connections"),
						(response) => response.json,
					),
					[],
				)
				assert.strictEqual(
					(yield* Effect.flatMap(
						request("/v1/connections", "GET", undefined, bob.session),
						json(Schema.Array(ConnectionsApi.Connection)),
					)).length,
					1,
				)
				assert.strictEqual((yield* items).length > 0, true)
				assert.strictEqual((yield* operations).length > 0, true)
				assert.strictEqual((yield* publisher.writes).length, 1)
			}),
	)
})
