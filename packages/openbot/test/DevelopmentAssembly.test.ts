import { assert, expectTypeOf, it, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Chat, Config, Item, Model, Turn } from "@openbot-build/core"
import * as Client from "@openbot-build/client"
import { Discovery } from "@openbot-build/protocol"
import {
	ChatSummary,
	ChatView,
	AppDiscoveryFailed,
	AppDiscoveryResult,
	AuthApi,
	RequestsApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Context,
	Effect,
	Exit,
	HashMap,
	Layer,
	Option,
	Record as Rec,
	Redacted,
	Ref,
	Result,
	Schedule,
	Schema,
	Scope,
	Stream,
} from "effect"
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	HttpServer,
} from "effect/http"
import type * as Chats from "../src/chats/Chats.ts"
import { authorOf } from "../src/chats/ChatHost.ts"
import * as Backend from "../dist/app/Backend.js"
import * as Development from "../dist/Development.js"
import * as Server from "../dist/app/Server.js"
import { HostTools, OpenBot } from "@openbot-build/openbot"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as DatabasePostgres from "../dist/database/DatabasePostgres.js"
import * as Caller from "./Caller.ts"
import * as PostgresTest from "./PostgresTest.ts"
import * as DefaultBot from "./DefaultBot.ts"
import { browser, signIn } from "./DevelopmentLogin.ts"
import { bot, message, model, settled } from "./Messages.ts"

const settings = (databaseUrl: string) => ({
	host: "127.0.0.1",
	port: 0,
	databaseUrl: Redacted.make(databaseUrl),
	secretKeys: Redacted.make(
		"test:" +
			"1111111111111111111111111111111111111111111111111111111111111111",
	),
	auth: {
		mode: "development" as const,
		publicOrigin: "https://localhost:8443",
		secret: Redacted.make("DevelopmentAssemblySecretMustRemainStable123456"),
	},
})
/** Files, programs and an HTTP client for the tests. */
const platform = Layer.merge(NodeServices.layer, FetchHttpClient.layer)
/** A page of the Items of a Chat, as the API gives it. */
const ItemPage = Schema.Struct({
	items: Schema.Array(Item.Record),
	next: Schema.NullOr(Item.Seq),
})
/** Gives a value as JSON text. */
const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
/** Runs the migrations with a database pool of their own, which closes at the end. */
const migrate = (options: ReturnType<typeof settings>) =>
	DatabasePostgres.migrate.pipe(Effect.provide(DatabasePostgres.layer(options)))
/** Starts a server in the current scope, and gives its services and its address. */
const launch = <ROut, E, R>(
	server: Layer.Layer<ROut | HttpServer.HttpServer, E, R>,
) =>
	Effect.map(Layer.build(server), (services) => ({
		services,
		address: HttpServer.formatAddress(
			Context.get(services, HttpServer.HttpServer).address,
		),
	}))
/**
 * Runs a read again, 25 milliseconds apart, until `done` holds for its value.
 * It tries again at most 200 times, and then gives the last value.
 */
const poll = <A, E, R>(
	read: Effect.Effect<A, E, R>,
	done: (value: A) => boolean,
) =>
	Effect.repeat(read, {
		until: done,
		times: 200,
		schedule: Schedule.spaced("25 millis"),
	})
/** Waits until no Turn runs in a Chat and no input waits in its inbox. */
const wait = (chats: typeof Chats.Chats.Service, id: Chat.Id) => {
	const next = (
		view: ChatView,
		remaining: number,
	): Effect.Effect<ChatView, Chats.ServiceError> =>
		Effect.gen(function* () {
			if (
				view.activity !== "active" &&
				view.status !== "Running" &&
				view.inbox === 0
			)
				return view
			assert.ok(remaining > 0, "The Chat came to rest")
			const updated = yield* chats.wait(
				id,
				view.chat.revision,
				1000,
				view.activity,
			)
			return yield* next(updated, remaining - 1)
		})
	return chats.get(id).pipe(Effect.flatMap((view) => next(view, 20)))
}
/** A fetch that sends each request with a Cookie, from an origin. */
const fetchWith = (cookie: string, origin: string) =>
	Layer.effect(
		FetchHttpClient.Fetch,
		Effect.gen(function* () {
			const fetch = yield* FetchHttpClient.Fetch
			return (input, init) =>
				fetch(input, {
					...init,
					headers: {
						...Rec.fromEntries(new Headers(init?.headers)),
						cookie,
						origin,
					},
				})
		}),
	)

it.effect(
	"discovery injection keeps construction failures and required services",
	() =>
		Effect.sync(() => {
			class DiscoveryConfiguration extends Context.Service<
				DiscoveryConfiguration,
				{ readonly enabled: boolean }
			>()(
				"@openbot-build/openbot/test/DevelopmentAssembly.test/DiscoveryConfiguration",
			) {}
			class DiscoveryStartupFailed extends Schema.TaggedError<
				DiscoveryStartupFailed,
				{ readonly brand: unique symbol }
			>()("DiscoveryStartupFailed", {}) {}
			const injected = Layer.effect(
				Discovery.Discovery,
				Effect.gen(function* () {
					yield* DiscoveryConfiguration
					return yield* DiscoveryStartupFailed.make({})
				}),
			)
			const server = Server.layerFixed(settings("postgresql://unused")).pipe(
				Layer.provide(injected),
			)
			expectTypeOf<DiscoveryConfiguration>().toExtend<
				Layer.Services<typeof server>
			>()
			expectTypeOf<DiscoveryStartupFailed>().toExtend<
				Layer.Error<typeof server>
			>()
		}),
)

// The tests use a real PostgreSQL server and a real HTTP server, so they run in real time.
layer(platform, { excludeTestServices: true })((it) => {
	it.effect(
		"development assembly streams through the API and keeps the Chat after a restart",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const options = settings(database.url)
				const publicOrigin = options.auth.publicOrigin
				yield* migrate(options)
				// The first server has a scope of its own, so the test can stop it before the restart.
				const firstScope = yield* Scope.fork(yield* Effect.scope)
				const first = yield* Scope.provide(
					launch(Development.layer(options)),
					firstScope,
				)
				const { credential, send } = yield* signIn(first.address, publicOrigin)
				const defaultBot = yield* DefaultBot.ensure(send)
				const response = yield* send(
					`/v1/bots/${defaultBot}/messages`,
					"POST",
					{
						input: "Persist this development conversation",
						stream: true,
					},
				)
				assert.strictEqual(response.status, 200)
				const events = yield* response.text
				assert.match(events, /response.output_text.delta/)
				assert.match(
					events,
					/Development response: Persist this development conversation/,
				)
				assert.match(events, /response.completed/)
				const [summary] = yield* Effect.flatMap(
					send(`/v1/chats?bot=${defaultBot}`, "GET"),
					Caller.json(Schema.Array(ChatSummary)),
				)
				assert.ok(summary !== undefined)
				const id = summary.chat.id
				const path = `/v1/chats/${id}`
				// The development platform gives each new Chat a simulated model.
				assert.deepStrictEqual(
					summary.chat.settings.model,
					DevelopmentModel.selection,
				)
				const account = yield* Effect.flatMap(
					send("/auth/session", "GET"),
					Caller.json(AuthApi.SessionInfo),
				)
				const author = authorOf(account.userId)
				const member = {
					kind: "member" as const,
					...(yield* Caller.memberOf(account)),
				}
				const chats = yield* Context.get(
					first.services,
					Backend.Backend,
				).forCaller(member)
				const saved = yield* wait(chats, id)
				assert.strictEqual(saved.status, "Completed")
				const savedItems = yield* Effect.flatMap(
					send(path + "/items", "GET"),
					Caller.json(ItemPage),
				)
				assert.ok(savedItems.items.length >= 2)
				yield* Scope.close(firstScope, Exit.void)
				const restarted = yield* launch(Development.layer(options))
				const restartedSend = browser(
					restarted.address,
					publicOrigin,
					credential,
				)
				const restored = yield* Effect.flatMap(
					restartedSend(path, "GET"),
					Caller.json(ChatView),
				)
				assert.deepStrictEqual(restored, saved)
				assert.deepStrictEqual(
					yield* Effect.flatMap(
						restartedSend(path + "/items", "GET"),
						Caller.json(ItemPage),
					),
					savedItems,
				)
				const continuation = yield* restartedSend(path + "/messages", "POST", {
					input: "Continue once",
					stream: true,
				})
				assert.match(
					yield* continuation.text,
					/Development response: Continue once/,
				)
				const restartedChats = yield* Context.get(
					restarted.services,
					Backend.Backend,
				).forCaller(member)
				const continued = yield* wait(restartedChats, id)
				assert.strictEqual(
					(yield* restartedChats.items(id, {})).items.length,
					savedItems.items.length + 2,
				)
				const select = (current: ChatView, name: string) =>
					restartedChats.update(id, {
						expected: current.chat.revision,
						model: Config.Selection.make({
							provider: DevelopmentModel.provider,
							model: Model.Id.make(name),
						}),
					})
				/** Sends a message and reads the live events of the Turn that it starts. */
				const live = <A>(
					input: string,
					read: (
						events: Stream.Stream<{ readonly event: string }>,
					) => Effect.Effect<A>,
				) =>
					Effect.scoped(
						Effect.gen(function* () {
							const result = yield* restartedChats.deliverStream(id, {
								input,
								author,
							})
							assert.strictEqual(result.receipt.delivery, "started")
							assert.ok(Option.isSome(result.events))
							return yield* read(result.events.value)
						}),
					)
				yield* select(continued, "mock-slow")
				const partial = yield* live("Interrupt this slow response", (stream) =>
					stream.pipe(
						Stream.filter(
							(event) => event.event === "response.output_text.delta",
						),
						Stream.take(1),
						Stream.runCollect,
					),
				)
				assert.strictEqual(partial.length, 1)
				yield* restartedChats.interrupt(id)
				const interrupted = yield* wait(restartedChats, id)
				assert.strictEqual(interrupted.status, "Interrupted")
				assert.strictEqual(interrupted.response?.status, "cancelled")
				yield* select(interrupted, "mock-failure")
				const failedEvents = yield* live(
					"Save this failed input",
					Stream.runCollect,
				)
				assert.ok(
					Arr.some(
						failedEvents,
						(event) => event.event === "response.output_text.delta",
					),
				)
				assert.ok(
					Arr.some(failedEvents, (event) => event.event === "response.failed"),
				)
				const failed = yield* wait(restartedChats, id)
				assert.strictEqual(failed.status, "Failed")
				assert.strictEqual(failed.response?.status, "failed")
				assert.match(
					yield* toJson((yield* restartedChats.items(id, {})).items),
					/Save this failed input/,
				)
				yield* restartedChats.update(id, {
					expected: failed.chat.revision,
					model: DevelopmentModel.selection,
				})
				yield* live("Recover after failure", Stream.runDrain)
				assert.strictEqual(
					(yield* wait(restartedChats, id)).response?.status,
					"completed",
				)
			}),
		{ timeout: 30000 },
	)

	it.effect(
		"server assembly keeps extra per-Chat handlers and approvals",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const options = settings(database.url)
				const calls = yield* Ref.make(HashMap.empty<Chat.Id, number>())
				const assembly = Layer.unwrap(
					Effect.gen(function* () {
						const { builtinModels } = yield* DevelopmentModel.make
						return Server.layerFixed({
							...options,
							builtinModels,
							defaultModel: DevelopmentModel.selection,
						}).pipe(
							Layer.provide(
								Layer.merge(
									OpenBot.layerOutside,
									// Each Chat gets its own handlers of the tool of the host.
									HostTools.layer({
										toolkit: DevelopmentModel.toolkit,
										handlers: (chat) =>
											DevelopmentModel.toolkit.toLayer({
												DevelopmentConfirmation: ({ description }) =>
													Ref.update(calls, (current) =>
														HashMap.set(
															current,
															chat,
															Option.getOrElse(
																HashMap.get(current, chat),
																() => 0,
															) + 1,
														),
													).pipe(
														Effect.as({ confirmed: `${chat}: ${description}` }),
													),
											}),
									}),
								),
							),
							Layer.provideMerge(OpenBot.layerShared(options)),
						)
					}),
				)
				yield* migrate(options)
				const { address } = yield* launch(assembly)
				const { send } = yield* signIn(address, options.auth.publicOrigin)
				// Two Bots with the tool model, so each one has its own Chat.
				const talk = (name: string) =>
					Effect.flatMap(bot(send, { name, model: model("mock-tool") }), (id) =>
						message(send, id, "Confirm independently"),
					)
				const [first, second] = yield* Effect.all(
					[talk("First"), talk("Second")],
					{ concurrency: "unbounded" },
				)
				assert.ok(first !== undefined && second !== undefined)
				assert.notStrictEqual(first.chat, second.chat)
				const pendingOf = (chat: string) =>
					poll(
						Effect.map(
							Effect.flatMap(
								send("/v1/requests?status=pending", "GET"),
								Caller.json(Schema.Array(RequestsApi.CapabilityRequest)),
							),
							(pending) => Arr.filter(pending, (entry) => entry.chat === chat),
						),
						Arr.isReadonlyArrayNonEmpty,
					)
				const [firstRequests, secondRequests] = yield* Effect.all(
					[pendingOf(first.chat), pendingOf(second.chat)],
					{ concurrency: "unbounded" },
				)
				assert.strictEqual(firstRequests.length, 1)
				assert.strictEqual(secondRequests.length, 1)
				for (const entry of [...firstRequests, ...secondRequests])
					assert.deepStrictEqual(
						[entry.capability.action, entry.capability.target],
						["tools.call", "DevelopmentConfirmation"],
					)
				const [firstRequest] = firstRequests
				const [secondRequest] = secondRequests
				assert.ok(firstRequest !== undefined && secondRequest !== undefined)
				// The Turns do not wait for the decisions, and no call runs before one.
				const turnStatus = (receipt: typeof first) =>
					Effect.map(
						Effect.flatMap(
							send(`/v1/chats/${receipt.chat}/turns/${receipt.turn}`, "GET"),
							Caller.json(Schema.Struct({ turn: Turn.Record })),
						),
						(view) => view.turn.status._tag,
					)
				yield* Effect.all(
					[settled(send, first.chat), settled(send, second.chat)],
					{ concurrency: "unbounded" },
				)
				const firstTurns = yield* Effect.all([
					turnStatus(first),
					turnStatus(second),
				])
				assert.strictEqual(HashMap.size(yield* Ref.get(calls)), 0)
				const decide = Effect.fn("DevelopmentAssembly.decide")(function* (
					entry: RequestsApi.CapabilityRequest,
					decision: "allow" | "deny",
				) {
					const response = yield* send("/v1/requests/" + entry.id, "POST", {
						expected: entry.revision,
						decision,
						...(decision === "deny" ? { reason: "rejected" } : {}),
					})
					assert.strictEqual(response.status, 200)
				})
				yield* decide(firstRequest, "allow")
				yield* decide(secondRequest, "deny")
				const itemsOf = (chat: string) =>
					Effect.map(
						Effect.flatMap(
							send(`/v1/chats/${chat}/items?limit=100`, "GET"),
							Caller.json(ItemPage),
						),
						(page) => page.items,
					)
				const noticeOf = (chat: string, ref: string) =>
					poll(
						Effect.map(itemsOf(chat), (items) =>
							Arr.findFirst(
								items,
								(item) =>
									item.origin?.notice?.kind === "request" &&
									item.origin.notice.ref === ref,
							),
						),
						Option.isSome,
					)
				// The allowed call runs once, with the handlers of its own Chat.
				assert.ok(Option.isSome(yield* noticeOf(first.chat, firstRequest.id)))
				yield* poll(Ref.get(calls), HashMap.has(Chat.Id.make(first.chat)))
				const approved = yield* settled(send, first.chat)
				assert.strictEqual(
					Option.getOrElse(
						HashMap.get(yield* Ref.get(calls), Chat.Id.make(first.chat)),
						() => 0,
					),
					1,
				)
				assert.match(
					yield* toJson(yield* itemsOf(first.chat)),
					new RegExp(first.chat + ": Confirm independently"),
				)
				// The denial comes back as a notice, and the call never runs.
				const denial = yield* noticeOf(second.chat, secondRequest.id)
				assert.ok(Option.isSome(denial))
				assert.match(yield* toJson(denial.value.content), /rejected/)
				yield* settled(send, second.chat)
				const finalCalls = yield* Ref.get(calls)
				assert.strictEqual(
					HashMap.has(finalCalls, Chat.Id.make(second.chat)),
					false,
				)
				assert.strictEqual(HashMap.size(finalCalls), 1)
				// A pending result lets the first Turns end well. After the allowed call,
				// the model answers with its result and asks for nothing more.
				assert.deepStrictEqual(firstTurns, ["Completed", "Completed"])
				assert.match(
					yield* toJson(approved.response),
					new RegExp(
						"Development confirmation result: " +
							first.chat +
							": Confirm independently",
					),
				)
				assert.strictEqual(approved.open.requests, 0)
			}),
		{ timeout: 60000 },
	)

	it.effect(
		"development HTTP discovery uses fixed local data with standard authentication",
		() =>
			Effect.gen(function* () {
				const database = yield* PostgresTest.start
				const options = settings(database.url)
				const publicOrigin = options.auth.publicOrigin
				yield* migrate(options)
				const { address } = yield* launch(Development.layer(options))
				const { cookie } = yield* signIn(address, publicOrigin)
				const { api } = Context.get(
					yield* Layer.build(
						Client.layer({ baseUrl: address }).pipe(
							Layer.provide(fetchWith(cookie, publicOrigin)),
						),
					),
					Client.Client,
				)
				const discover = (input: string) =>
					api.apps.discoverApp({ payload: { input } })
				for (const input of [
					"app.development.test",
					"https://app.development.test/card.json",
				]) {
					const result = yield* discover(input)
					assert.ok(result._tag === "Single")
					assert.strictEqual(
						result.candidate.cardUrl,
						"https://app.development.test/card.json",
					)
					assert.strictEqual(
						result.candidate.card.name,
						"app.development.test/simulated-app",
					)
					assert.strictEqual(result.candidate.sources[0]?.originalInput, input)
					assert.strictEqual(
						result.candidate.endpoints[0]?.remote.url,
						"https://app.development.test/mcp",
					)
				}
				const failures: ReadonlyArray<readonly [string, string]> = [
					["unknown.development.test", "NoDeclaration"],
					["https://publisher.example/card.json", "NoDeclaration"],
					["http://app.development.test/card.json", "InvalidInput"],
					[
						"https://name:secret@app.development.test/card.json",
						"InvalidInput",
					],
					["not a link", "InvalidInput"],
				]
				for (const [input, reason] of failures) {
					const result = yield* Effect.result(discover(input))
					assert.ok(Result.isFailure(result))
					assert.ok(Schema.is(AppDiscoveryFailed)(result.failure))
					assert.strictEqual(result.failure.reason, reason)
				}
				const valid = yield* toJson({ input: "app.development.test" })
				const request = (headers: Record<string, string>, body = valid) =>
					HttpClient.execute(
						HttpClientRequest.post(address + "/v1/apps/discover", {
							headers,
						}).pipe(HttpClientRequest.bodyText(body, "application/json")),
					)
				for (const [headers, status] of [
					[{}, 401],
					[{ cookie }, 403],
					[{ cookie, origin: "https://foreign.development.test" }, 403],
					[
						{
							cookie: "__Host-openbot-session=invalid",
							origin: publicOrigin,
						},
						401,
					],
				] satisfies ReadonlyArray<readonly [Record<string, string>, number]>) {
					const response = yield* request(headers)
					assert.strictEqual(response.status, status)
					yield* response.text
				}
				const session = yield* request({ cookie, origin: publicOrigin })
				assert.strictEqual(session.status, 200)
				assert.strictEqual(
					(yield* Caller.json(Schema.toCodecJson(AppDiscoveryResult))(session))
						._tag,
					"Single",
				)
				const malformed = yield* request({ cookie, origin: publicOrigin }, "{")
				assert.strictEqual(malformed.status, 400)
				yield* malformed.text
			}),
		{ timeout: 30000 },
	)
})
