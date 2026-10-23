import { memberOf } from "./Caller.ts"
// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Chat, Config, Item, Model } from "@openbot-build/core"
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
	Context,
	Data,
	Effect,
	HashMap,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Result,
	Schema,
	Stream,
} from "effect"
import { FetchHttpClient, HttpServer } from "effect/http"
import type * as Chats from "../src/chats/Chats.ts"
import { authorOf } from "../src/chats/ChatHost.ts"
import * as Backend from "../dist/app/Backend.js"
import * as Development from "../dist/Development.js"
import * as Server from "../dist/app/Server.js"
import * as DevelopmentModel from "../src/app/DevelopmentModel.ts"
import * as DatabasePostgres from "../dist/database/DatabasePostgres.js"
import * as PostgresTest from "./PostgresTest.ts"
import * as DefaultBot from "./DefaultBot.ts"
import * as Organizations from "./Organizations.ts"
import { bot, message, model, settled, type Send } from "./Messages.ts"

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
/** Signs in to a development server and gives the headers of the browser. */
const signIn = async (address: string, publicOrigin: string) => {
	const login = await fetch(address + "/auth/development/sign-in", {
		method: "POST",
		headers: { origin: publicOrigin, "content-type": "application/json" },
		body: "{}",
	})
	assert.equal(login.status, 200)
	const cookie = login.headers
		.getSetCookie()
		.find((value) => value.startsWith(AuthApi.SessionCookie + "="))!
		.split(";")[0]!
	const headers = {
		cookie,
		origin: publicOrigin,
		"content-type": "application/json",
	}
	const send: Send = (path, method, payload) =>
		fetch(address + path, {
			method,
			headers,
			...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
		})
	await Organizations.ensure(send)
	return { cookie, headers, send }
}

test(
	"development assembly streams through the API and keeps the Chat after a restart",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		const options = settings(database.url)
		const server = () => ManagedRuntime.make(Development.layer(options))
		let runtime: ReturnType<typeof server> | undefined
		try {
			await using migration = ManagedRuntime.make(
				DatabasePostgres.layer(options).pipe(Layer.provide(NodeServices.layer)),
			)
			await migration.runPromise(DatabasePostgres.migrate)
			runtime = server()
			let address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			const { cookie, headers } = await signIn(
				address,
				options.auth.publicOrigin,
			)
			const send: Send = (path, method, payload) =>
				fetch(address + path, {
					method,
					headers,
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				})
			const defaultBot = await DefaultBot.ensure(send)
			const response = await send(`/v1/bots/${defaultBot}/messages`, "POST", {
				input: "Persist this development conversation",
				stream: true,
			})
			assert.equal(response.status, 200)
			const events = await response.text()
			assert.match(events, /response.output_text.delta/)
			assert.match(
				events,
				/Development response: Persist this development conversation/,
			)
			assert.match(events, /response.completed/)
			const [summary] = Schema.decodeUnknownSync(Schema.Array(ChatSummary))(
				await (await send(`/v1/chats?bot=${defaultBot}`, "GET")).json(),
			)
			assert.ok(summary !== undefined)
			const id = summary.chat.id
			const path = `/v1/chats/${id}`
			// The development platform gives each new Chat a simulated model.
			assert.deepEqual(summary.chat.settings.model, DevelopmentModel.selection)
			const backend = await runtime.runPromise(Backend.Backend)
			const session = Schema.decodeUnknownSync(AuthApi.SessionInfo)(
				await (
					await fetch(address + "/auth/session", { headers: { cookie } })
				).json(),
			)
			const author = authorOf(session.userId)
			const chats = await runtime.runPromise(
				backend.forCaller({ kind: "member", ...memberOf(session) }),
			)
			const saved = await runtime.runPromise(wait(chats, id))
			assert.equal(saved.status, "Completed")
			const savedItems = await (await send(path + "/items", "GET")).json()
			assert.ok(savedItems.items.length >= 2)
			await runtime.dispose()
			runtime = server()
			address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			const restored = Schema.decodeUnknownSync(ChatView)(
				await (await send(path, "GET")).json(),
			)
			assert.deepEqual(restored, saved)
			assert.deepEqual(
				await (await send(path + "/items", "GET")).json(),
				savedItems,
			)
			const continuation = await send(path + "/messages", "POST", {
				input: "Continue once",
				stream: true,
			})
			assert.match(
				await continuation.text(),
				/Development response: Continue once/,
			)
			const restartedChats = await runtime.runPromise(
				Effect.flatMap(Backend.Backend, (backend) =>
					backend.forCaller({ kind: "member", ...memberOf(session) }),
				),
			)
			const continued = await runtime.runPromise(wait(restartedChats, id))
			assert.equal(
				(await runtime.runPromise(restartedChats.items(id, {}))).items.length,
				savedItems.items.length + 2,
			)
			const select = (current: ChatView, name: string) =>
				runtime!.runPromise(
					restartedChats.update(id, {
						expected: current.chat.revision,
						model: Config.Selection.make({
							provider: DevelopmentModel.provider,
							model: Model.Id.make(name),
						}),
					}),
				)
			/** Sends a message and reads the live events of the Turn that it starts. */
			const live = <A>(
				input: string,
				read: (
					events: Stream.Stream<{ readonly event: string }>,
				) => Effect.Effect<A>,
			) =>
				runtime!.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							const result = yield* restartedChats.deliverStream(id, {
								input,
								author,
							})
							assert.equal(result.receipt.delivery, "started")
							assert.ok(Option.isSome(result.events))
							return yield* read(result.events.value)
						}),
					),
				)
			await select(continued, "mock-slow")
			const partial = await live("Interrupt this slow response", (stream) =>
				stream.pipe(
					Stream.filter(
						(event) => event.event === "response.output_text.delta",
					),
					Stream.take(1),
					Stream.runCollect,
				),
			)
			assert.equal(partial.length, 1)
			await runtime.runPromise(restartedChats.interrupt(id))
			const interrupted = await runtime.runPromise(wait(restartedChats, id))
			assert.equal(interrupted.status, "Interrupted")
			assert.equal(interrupted.response?.status, "cancelled")
			await select(interrupted, "mock-failure")
			const failedEvents = await live(
				"Save this failed input",
				Stream.runCollect,
			)
			assert.ok(
				failedEvents.some(
					(event) => event.event === "response.output_text.delta",
				),
			)
			assert.ok(failedEvents.some((event) => event.event === "response.failed"))
			const failed = await runtime.runPromise(wait(restartedChats, id))
			assert.equal(failed.status, "Failed")
			assert.equal(failed.response?.status, "failed")
			assert.match(
				JSON.stringify(
					(await runtime.runPromise(restartedChats.items(id, {}))).items,
				),
				/Save this failed input/,
			)
			await runtime.runPromise(
				restartedChats.update(id, {
					expected: failed.chat.revision,
					model: DevelopmentModel.selection,
				}),
			)
			await live("Recover after failure", Stream.runDrain)
			assert.equal(
				(await runtime.runPromise(wait(restartedChats, id))).response?.status,
				"completed",
			)
		} finally {
			await runtime?.dispose()
			await database.close()
		}
	},
)

test(
	"server assembly keeps extra per-Chat handlers and approvals",
	{ timeout: 60000 },
	async () => {
		const database = await PostgresTest.start()
		const options = settings(database.url)
		let calls = HashMap.empty<Chat.Id, number>()
		const layer = Layer.unwrap(
			Effect.gen(function* () {
				const { builtinModels, chats } = yield* DevelopmentModel.make
				return Server.layerFixed({
					...options,
					builtinModels,
					chats: {
						...chats,
						layerExecution: (ref: Chat.Ref) =>
							DevelopmentModel.toolkit.toLayer({
								DevelopmentConfirmation: ({ description }) =>
									Effect.sync(() => {
										calls = HashMap.set(
											calls,
											ref.id,
											HashMap.get(calls, ref.id).pipe(
												Option.getOrElse(() => 0),
											) + 1,
										)
										return { confirmed: `${ref.id}: ${description}` }
									}),
							}),
					},
				}).pipe(Layer.provide(DevelopmentModel.layerTools))
			}),
		)
		const runtime = ManagedRuntime.make(layer)
		try {
			await using migration = ManagedRuntime.make(
				DatabasePostgres.layer(options).pipe(Layer.provide(NodeServices.layer)),
			)
			await migration.runPromise(DatabasePostgres.migrate)
			const address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			const { send } = await signIn(address, options.auth.publicOrigin)
			// Two Bots with the tool model, so each one has its own Chat.
			const talk = async (name: string) => {
				const id = await bot(send, { name, model: model("mock-tool") })
				return message(send, id, "Confirm independently")
			}
			const [first, second] = await Promise.all([talk("First"), talk("Second")])
			assert.ok(first !== undefined && second !== undefined)
			assert.notEqual(first.chat, second.chat)
			const pendingOf = async (chat: string) => {
				for (let tries = 0; tries < 200; tries++) {
					const list = Schema.decodeUnknownSync(
						Schema.Array(RequestsApi.CapabilityRequest),
					)(
						await (await send("/v1/requests?status=pending", "GET")).json(),
					).filter((entry) => entry.chat === chat)
					if (list.length > 0) return list
					await new Promise((resolve) => setTimeout(resolve, 25))
				}
				return []
			}
			const [firstRequests, secondRequests] = await Promise.all([
				pendingOf(first.chat),
				pendingOf(second.chat),
			])
			assert.equal(firstRequests?.length, 1)
			assert.equal(secondRequests?.length, 1)
			for (const entry of [...firstRequests!, ...secondRequests!])
				assert.deepEqual(
					[entry.capability.action, entry.capability.target],
					["tools.call", "DevelopmentConfirmation"],
				)
			// The Turns do not wait for the decisions, and no call runs before one.
			const turnStatus = async (receipt: typeof first) =>
				(
					await (
						await send(`/v1/chats/${receipt.chat}/turns/${receipt.turn}`, "GET")
					).json()
				).turn.status._tag as string
			await Promise.all([settled(send, first.chat), settled(send, second.chat)])
			const firstTurns = [await turnStatus(first), await turnStatus(second)]
			assert.equal(HashMap.size(calls), 0)
			const decide = async (
				entry: RequestsApi.CapabilityRequest,
				decision: "allow" | "deny",
			) =>
				assert.equal(
					(
						await send("/v1/requests/" + entry.id, "POST", {
							expected: entry.revision,
							decision,
							...(decision === "deny" ? { reason: "rejected" } : {}),
						})
					).status,
					200,
				)
			await decide(firstRequests![0]!, "allow")
			await decide(secondRequests![0]!, "deny")
			const itemsOf = async (chat: string) =>
				Schema.decodeUnknownSync(
					Schema.Struct({ items: Schema.Array(Item.Record) }),
				)(await (await send(`/v1/chats/${chat}/items?limit=100`, "GET")).json())
					.items
			const noticeOf = async (chat: string, ref: string) => {
				for (let tries = 0; tries < 200; tries++) {
					const found = (await itemsOf(chat)).find(
						(item) =>
							item.origin?.notice?.kind === "request" &&
							item.origin.notice.ref === ref,
					)
					if (found !== undefined) return found
					await new Promise((resolve) => setTimeout(resolve, 25))
				}
				return undefined
			}
			// The allowed call runs once, with the handlers of its own Chat.
			assert.ok(
				(await noticeOf(first.chat, firstRequests![0]!.id)) !== undefined,
			)
			for (
				let tries = 0;
				tries < 200 && !HashMap.has(calls, Chat.Id.make(first.chat));
				tries++
			)
				await new Promise((resolve) => setTimeout(resolve, 25))
			const approved = await settled(send, first.chat)
			assert.equal(
				HashMap.get(calls, Chat.Id.make(first.chat)).pipe(
					Option.getOrElse(() => 0),
				),
				1,
			)
			assert.match(
				JSON.stringify(await itemsOf(first.chat)),
				new RegExp(first.chat + ": Confirm independently"),
			)
			// The denial comes back as a notice, and the call never runs.
			const denial = await noticeOf(second.chat, secondRequests![0]!.id)
			assert.ok(denial !== undefined)
			assert.match(JSON.stringify(denial.content), /rejected/)
			await settled(send, second.chat)
			assert.equal(HashMap.has(calls, Chat.Id.make(second.chat)), false)
			assert.equal(HashMap.size(calls), 1)
			// A pending result lets the first Turns end well. After the allowed call,
			// the model answers with its result and asks for nothing more.
			assert.deepEqual(firstTurns, ["Completed", "Completed"])
			assert.match(
				JSON.stringify(approved.response),
				new RegExp(
					"Development confirmation result: " +
						first.chat +
						": Confirm independently",
				),
			)
			assert.equal(approved.open.requests, 0)
		} finally {
			await runtime.dispose()
			await database.close()
		}
	},
)

test("discovery injection keeps construction failures and required services", () => {
	class DiscoveryConfiguration extends Context.Service<
		DiscoveryConfiguration,
		{ readonly enabled: boolean }
	>()(
		"@openbot-build/openbot/test/DevelopmentAssembly.test/DiscoveryConfiguration",
	) {}
	class DiscoveryStartupFailed extends Data.TaggedError(
		"DiscoveryStartupFailed",
	)<{}> {}
	const injected = Layer.effect(
		Discovery.Discovery,
		Effect.gen(function* () {
			yield* DiscoveryConfiguration
			return yield* new DiscoveryStartupFailed()
		}),
	)
	const server = Server.layerFixed({
		...settings("postgresql://unused"),
		discovery: injected,
	})
	const serverDependency: DiscoveryConfiguration extends Layer.Services<
		typeof server
	>
		? true
		: false = true
	const serverFailure: DiscoveryStartupFailed extends Layer.Error<typeof server>
		? true
		: false = true
	assert.deepEqual([serverDependency, serverFailure], [true, true])
})

test(
	"development HTTP discovery uses fixed local data with standard authentication",
	{ timeout: 30000 },
	async () => {
		const database = await PostgresTest.start()
		const options = settings(database.url)
		const runtime = ManagedRuntime.make(Development.layer(options))
		try {
			await using migration = ManagedRuntime.make(
				DatabasePostgres.layer(options).pipe(Layer.provide(NodeServices.layer)),
			)
			await migration.runPromise(DatabasePostgres.migrate)
			const address = await runtime.runPromise(
				Effect.map(HttpServer.HttpServer, (server) =>
					HttpServer.formatAddress(server.address),
				),
			)
			const login = await fetch(address + "/auth/development/sign-in", {
				method: "POST",
				headers: {
					origin: options.auth.publicOrigin,
					"content-type": "application/json",
				},
				body: "{}",
			})
			assert.equal(login.status, 200)
			const cookie = login.headers
				.getSetCookie()
				.find((value) => value.startsWith(AuthApi.SessionCookie + "="))!
				.split(";")[0]!
			await Organizations.ensure((path, method, payload) =>
				fetch(address + path, {
					method,
					headers: {
						cookie,
						origin: options.auth.publicOrigin,
						"content-type": "application/json",
					},
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				}),
			)
			await using client = ManagedRuntime.make(
				Client.layer({ baseUrl: address }).pipe(
					Layer.provide(
						Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
							fetch(input, {
								...init,
								headers: {
									...Object.fromEntries(new Headers(init?.headers)),
									cookie,
									origin: options.auth.publicOrigin,
								},
							}),
						),
					),
				),
			)
			const discover = (input: string) =>
				Client.Client.use((client) =>
					client.api.apps.discoverApp({ payload: { input } }),
				)
			for (const input of [
				"app.development.test",
				"https://app.development.test/card.json",
			]) {
				const result = await client.runPromise(discover(input))
				assert.ok(result._tag === "Single")
				assert.equal(
					result.candidate.cardUrl,
					"https://app.development.test/card.json",
				)
				assert.equal(
					result.candidate.card.name,
					"app.development.test/simulated-app",
				)
				assert.equal(result.candidate.sources[0]?.originalInput, input)
				assert.equal(
					result.candidate.endpoints[0]?.remote.url,
					"https://app.development.test/mcp",
				)
			}
			const failures: ReadonlyArray<readonly [string, string]> = [
				["unknown.development.test", "NoDeclaration"],
				["https://publisher.example/card.json", "NoDeclaration"],
				["http://app.development.test/card.json", "InvalidInput"],
				["https://name:secret@app.development.test/card.json", "InvalidInput"],
				["not a link", "InvalidInput"],
			]
			for (const [input, reason] of failures) {
				const result = await client.runPromise(
					discover(input).pipe(Effect.result),
				)
				assert.ok(Result.isFailure(result))
				assert.ok(Schema.is(AppDiscoveryFailed)(result.failure))
				assert.equal(result.failure.reason, reason)
			}
			const request = (
				headers: Record<string, string>,
				body = JSON.stringify({ input: "app.development.test" }),
			) =>
				fetch(address + "/v1/apps/discover", {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body,
				})
			for (const [headers, status] of [
				[{}, 401],
				[{ cookie }, 403],
				[{ cookie, origin: "https://foreign.development.test" }, 403],
				[
					{
						cookie: "__Host-openbot-session=invalid",
						origin: options.auth.publicOrigin,
					},
					401,
				],
			] satisfies ReadonlyArray<readonly [Record<string, string>, number]>) {
				const response = await request(headers)
				assert.equal(response.status, status)
				await response.text()
			}
			const session = await request({
				cookie,
				origin: options.auth.publicOrigin,
			})
			assert.equal(session.status, 200)
			assert.equal(
				Schema.decodeUnknownSync(Schema.toCodecJson(AppDiscoveryResult))(
					await session.json(),
				)._tag,
				"Single",
			)
			const malformed = await request(
				{ cookie, origin: options.auth.publicOrigin },
				"{",
			)
			assert.equal(malformed.status, 400)
			await malformed.text()
		} finally {
			await runtime.dispose()
			await database.close()
		}
	},
)
