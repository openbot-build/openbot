import { assert, layer } from "@effect/vitest"
import { AppExecution, ArtifactsApi, ConnectionsApi } from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Response as AiResponse } from "effect/ai"
import * as Network from "@openbot-build/protocol/NodeHttpServer"
import { AppNetwork } from "../src/apps/AppHost.ts"
import { filesOf } from "../src/settings/Documents.ts"
import { bindings } from "../src/settings/Platform.ts"
import { Secrets } from "../src/secrets/Secrets.ts"
import * as Fixture from "./AppFixture.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import * as Messages from "./Messages.ts"
import * as Wait from "./Wait.ts"

const publicOrigin = "https://artifact-apps.example.com"
const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

/** The model asks the real App for one document in each Turn. */
const documentModel = LanguageModel.make({
	generateText: () =>
		Effect.succeed([AiResponse.makePart("text", { text: '{"changes":[]}' })]),
	streamText: ({ prompt, tools }) => {
		const last = Option.getOrElse(
			Arr.findLastIndex(prompt.content, (entry) => entry.role === "user"),
			() => -1,
		)
		const answered = Arr.some(
			Arr.drop(prompt.content, last + 1),
			(entry) =>
				entry.role === "tool" &&
				Arr.some(entry.content, (part) => part.type === "tool-result"),
		)
		const tool = Arr.findFirst(
			tools,
			(entry) =>
				entry.description !== undefined &&
				Str.includes(" / read_document.")(entry.description),
		)
		return answered || Option.isNone(tool)
			? Stream.make(AiResponse.makePart("finish", { reason: "stop", usage }))
			: Stream.make(
					AiResponse.makePart("tool-call", {
						id: "read-document",
						name: tool.value.name,
						params: { id: "alpha  note" },
						providerExecuted: false,
					}),
					AiResponse.makePart("finish", { reason: "tool-calls", usage }),
				)
	},
})

const terminal = (send: Messages.Send, receipt: Execution.Receipt) =>
	Wait.untilTrue(
		"the source command",
		Caller.read(
			Execution.Record,
			send(`/v1/executions/${receipt.executionId}`, "GET"),
		),
		(record) => Execution.isTerminal(record.status),
	)

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"App sources keep saved results and reject failed, other Chat, and other caller results",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start({ capabilities: true })
				const objects = yield* Ref.make(
					HashMap.empty<string, Uint8Array<ArrayBuffer>>(),
				)
				const cardUrl = publisher.origin + "/card"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* documentModel,
					appReadRules: [{ cardUrl, tool: "read_document" }],
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
					platformFetch: (request) =>
						Effect.gen(function* () {
							const key = new URL(request.url).pathname
							if (request.method === "PUT") {
								const bytes = new Uint8Array(
									yield* Effect.promise(() => request.arrayBuffer()),
								)
								yield* Ref.update(objects, HashMap.set(key, bytes))
								return new Response(null, { status: 200 })
							}
							if (request.method === "GET" || request.method === "HEAD") {
								const found = HashMap.get(yield* Ref.get(objects), key)
								return Option.isNone(found)
									? new Response(null, { status: 404 })
									: new Response(
											request.method === "HEAD"
												? null
												: new Blob([found.value]),
											{
												headers: {
													"content-length": String(found.value.length),
												},
											},
										)
							}
							return new Response(null, { status: 204 })
						}),
				})
				const storageSecret = yield* host.run(
					Effect.flatMap(Secrets, (secrets) =>
						secrets.seal("secret", bindings.fileStorageSecret),
					),
				)
				yield* host.updatePlatform((document) => ({
					...document,
					files: {
						...filesOf(document),
						storage: {
							endpoint: "http://artifact-apps.test",
							publicEndpoint: null,
							region: "us-east-1",
							bucket: "files",
							accessKeyId: "access",
							secretAccessKey: storageSecret,
							secretAccessKeyHint: null,
							forcePathStyle: true,
						},
					},
				}))
				const alice = yield* host.login("artifact-app-alice")
				const bob = yield* host.login("artifact-app-bob")
				const send: Messages.Send = (path, method, payload) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							alice.session,
							path,
							method,
							payload,
						),
					)
				const other: Messages.Send = (path, method, payload) =>
					Effect.flatMap(host.address, (address) =>
						Caller.withCookie({ address, publicOrigin })(
							bob.session,
							path,
							method,
							payload,
						),
					)
				const draft = yield* Caller.read(
					ConnectionsApi.ConnectionDraft,
					send("/v1/connection-drafts", "POST", { input: cardUrl }),
					201,
				)
				yield* Caller.read(
					ConnectionsApi.Connection,
					send("/v1/connections", "POST", {
						draftId: draft.id,
						revision: draft.revision,
						cardUrl,
						remoteIndex: 0,
						values: {
							"header:X-Account": "source",
							"header:X-Secret": "private-app-value",
						},
						name: "Source documents",
						confirmed: true,
					}),
					201,
				)
				const bot = yield* Messages.bot(send, { name: "Source documents" })
				const receipt = yield* Messages.message(send, bot, "Read the document")
				yield* Messages.settled(send, receipt.chat)
				const operations = yield* Caller.read(
					Schema.Array(AppExecution.ExecutionView),
					send(`/v1/chats/${receipt.chat}/app-operations`, "GET"),
				)
				const operation = yield* Effect.fromOption(Arr.head(operations))
				assert.strictEqual(operation.status, "completed")
				assert.ok(operation.result?._tag === "Completed")
				if (operation.result?._tag !== "Completed") return
				const count = yield* publisher.businessCalls
				const capture = yield* Caller.read(
					Execution.Receipt,
					send(`/v1/chats/${receipt.chat}/sources`, "POST", {
						commandKey: "saved-app-source",
						from: { _tag: "AppResult", operationId: operation.id },
						reportedUrl: "https://reported.example.com/document",
					}),
					202,
				)
				assert.strictEqual((yield* terminal(send, capture)).status, "completed")
				const sources = yield* Caller.read(
					ArtifactsApi.SourcePage,
					send(`/v1/chats/${receipt.chat}/sources`, "GET"),
				)
				const source = yield* Effect.fromOption(Arr.head(sources.items))
				assert.deepStrictEqual(source.origin, {
					_tag: "AppResult",
					operationId: operation.id,
				})
				assert.strictEqual(
					source.reportedUrl,
					"https://reported.example.com/document",
				)
				const body = yield* send(
					`/v1/chats/${receipt.chat}/sources/${source.id}/content`,
					"GET",
				)
				assert.strictEqual(body.status, 200)
				const saved = yield* Schema.decodeEffect(
					Schema.fromJsonString(Schema.Json),
				)(yield* body.text)
				assert.deepStrictEqual(saved, operation.result.result)
				assert.strictEqual(yield* publisher.businessCalls, count)
				yield* publisher.setInvalidOutput(true)
				const failedBot = yield* Messages.bot(send, {
					name: "Bad source documents",
				})
				const failedChat = yield* Messages.message(
					send,
					failedBot,
					"Read a bad document",
				)
				yield* Messages.settled(send, failedChat.chat)
				const failed = yield* Effect.fromOption(
					Arr.head(
						yield* Caller.read(
							Schema.Array(AppExecution.ExecutionView),
							send(`/v1/chats/${failedChat.chat}/app-operations`, "GET"),
						),
					),
				)
				assert.strictEqual(failed.result?._tag, "Failed")
				const bobBot = yield* Messages.bot(other, { name: "Other documents" })
				const bobChat = yield* Messages.message(other, bobBot, "Open a Chat")
				yield* Messages.settled(other, bobChat.chat)
				for (const [name, call, chat, id] of [
					["failed", send, failedChat.chat, failed.id],
					["other-chat", send, failedChat.chat, operation.id],
					["other-caller", other, bobChat.chat, operation.id],
				] as const) {
					const rejected = yield* Caller.read(
						Execution.Receipt,
						call(`/v1/chats/${chat}/sources`, "POST", {
							commandKey: name,
							from: { _tag: "AppResult", operationId: id },
						}),
						202,
					)
					assert.strictEqual(
						(yield* terminal(call, rejected)).status,
						"failed",
						name,
					)
					assert.deepStrictEqual(
						(yield* Caller.read(
							ArtifactsApi.SourcePage,
							call(`/v1/chats/${chat}/sources`, "GET"),
						)).items,
						[],
					)
				}
				const kept = yield* send(
					`/v1/chats/${receipt.chat}/sources/${source.id}/content`,
					"GET",
				)
				assert.strictEqual(kept.status, 200)
				assert.deepStrictEqual(
					yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
						yield* kept.text,
					),
					saved,
				)
			}),
		120_000,
	)
})
