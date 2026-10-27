import {
	AppFixture as Fixture,
	BrowserHost,
	Caller,
	Messages,
	Wait,
} from "@openbot-build/openbot/testing"
import { assert, layer } from "@effect/vitest"
import {
	AppExecution,
	AppViewsApi,
	ConnectionsApi,
	DeveloperApi,
	UserTokensApi,
} from "@openbot-build/api"
import {
	Crypto,
	Deferred,
	Ref,
	Array as Arr,
	Effect,
	Layer,
	Option,
	Schema,
	Schedule,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel, Response } from "effect/ai"
import { Sse } from "effect/encoding"
import {
	HttpServerRequest,
	HttpServerResponse,
	type HttpMethod,
} from "effect/http"
import * as Network from "@openbot-build/protocol/NodeHttpServer"
import { CatalogDiscovery, Document } from "@openbot-build/protocol"
import { Execution } from "@openbot-build/domain"
import { Fixture as ProtocolFixture } from "@openbot-build/protocol/testing"
import { AppHost } from "@openbot-build/openbot"

const publicOrigin = "https://app-api.example.com"
type Send = (
	path: string,
	method?: HttpMethod.HttpMethod,
	payload?: unknown,
) => Caller.Call

const status = (call: Caller.Call, expected: number) =>
	Effect.gen(function* () {
		const response = yield* call
		assert.strictEqual(response.status, expected, yield* response.text)
	})

/** The event log gives the end of work, even after its business record is gone. */
const completed = Effect.fn("AppApiE2E.completed")(function* (
	send: Send,
	executionId: Execution.Id,
) {
	const response = yield* send(
		`/v1/executions/${executionId}/observe?afterSequence=0`,
	)
	assert.strictEqual(response.status, 200)
	const end = yield* Effect.fromOption(
		yield* response.stream.pipe(
			Stream.decodeText(),
			Stream.pipeThroughChannel(Sse.decodeDataSchema(Execution.Event)),
			Stream.runLast,
		),
	)
	assert.strictEqual(end.data.executionId, executionId)
	assert.deepStrictEqual(end.data.body, {
		_tag: "State",
		status: "completed",
		failure: null,
	})
})

/** Both callers use the same account through its public credentials. */
const callers = Effect.fn("AppApiE2E.callers")(function* (
	host: BrowserHost.Host,
	name: string,
) {
	const account = yield* host.login(name)
	const cookie: Send = (path, method, payload) =>
		Effect.flatMap(host.address, (address) =>
			Caller.withCookie({ address, publicOrigin })(
				account.session,
				path,
				method,
				payload,
			),
		)
	const key = yield* Caller.read(
		UserTokensApi.CreatedToken,
		cookie("/v1/user/tokens", "POST", { name: "App API test" }),
		201,
	)
	const token: Send = (path, method, payload) =>
		Effect.flatMap(host.address, (address) =>
			Caller.withToken(address)(key.secret, path, method, payload),
		)
	return { cookie, token }
})

const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

/** The outside model makes one real App call for the first user message. */
const documentModel = LanguageModel.make({
	generateText: () =>
		Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
	streamText: ({ prompt, tools }) => {
		const last = Arr.findLastIndex(
			prompt.content,
			(entry) => entry.role === "user",
		)
		const request = Option.flatMap(last, (index) =>
			Arr.get(prompt.content, index),
		)
		const read = Option.exists(
			request,
			(entry) =>
				entry.role === "user" &&
				Arr.some(
					entry.content,
					(part) => part.type === "text" && part.text === "Read the document",
				),
		)
		const answered = Arr.some(
			Arr.drop(prompt.content, Option.getOrElse(last, () => -1) + 1),
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
		return !read || answered || Option.isNone(tool)
			? Stream.make(Response.makePart("finish", { reason: "stop", usage }))
			: Stream.make(
					Response.makePart("tool-call", {
						id: "read-document",
						name: tool.value.name,
						params: { id: "alpha" },
						providerExecuted: false,
					}),
					Response.makePart("finish", { reason: "tool-calls", usage }),
				)
	},
})

const Items = Schema.Struct({
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
})
const isToolResult = Schema.is(
	Schema.Struct({ type: Schema.Literal("tool-result"), id: Schema.String }),
)

/** The publisher puts each ownership proof in a real HTTPS Card. */
const proofPublisher = Effect.fn("AppApiE2E.proofPublisher")(function* (
	app: Fixture.Publisher,
) {
	const origin = yield* Deferred.make<string>()
	const tokens = yield* Ref.make<ReadonlyArray<string>>([])
	const fixture = yield* ProtocolFixture.serveHttps(
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest
			const base = yield* Deferred.await(origin)
			if (request.url === "/robots.txt")
				return HttpServerResponse.text("User-agent: *\nAllow: /\n")
			if (request.url === "/.well-known/ai-catalog.json")
				return yield* HttpServerResponse.json({
					specVersion: "1.0",
					entries: [
						{
							identifier: "documents",
							type: Document.cardMediaType,
							url: base + "/card",
						},
					],
				})
			if (request.url !== "/card")
				return HttpServerResponse.empty({ status: 404 })
			return yield* HttpServerResponse.json({
				$schema: Document.cardSchemaUrl,
				name: "fixture.example/documents",
				version: "1.0.0",
				description: "Read documents from the test account",
				remotes: [
					{
						type: "streamable-http",
						url: app.origin + "/mcp",
						supportedProtocolVersions: [Document.protocolVersion],
						headers: [
							{ name: "X-Account", isRequired: true, isSecret: false },
							{ name: "X-Secret", isRequired: true, isSecret: true },
						],
					},
				],
				_meta: {
					"openbot/developer-verification": {
						version: 1,
						tokens: yield* Ref.get(tokens),
					},
				},
			})
		}),
	)
	yield* Deferred.succeed(origin, fixture.ipOrigin)
	const network = (owner: string, origins: ReadonlyArray<string>) =>
		Network.layerUserNetwork({
			owner,
			allowedOrigins: origins,
			ca: [app.ca, fixture.ca],
			allowAddress: (ip) => ip === "127.0.0.1",
		})
	return {
		cardUrl: fixture.ipOrigin + "/card",
		publish: (token: string) => Ref.set(tokens, [token]),
		publicNetwork: app.publicNetwork({
			origins: [fixture.ipOrigin],
			cas: [fixture.ca],
		}),
		discovery: CatalogDiscovery.layer().pipe(
			Layer.provide(CatalogDiscovery.layerRules),
			Layer.provide(
				network("public-publisher", [fixture.ipOrigin, app.origin]),
			),
		),
		appNetwork: Layer.succeed(AppHost.AppNetwork, { layer: network }),
	}
})

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"tokens and cookies read App results and views, keep context, send each message once and check the owner",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start({ capabilities: true })
				const cardUrl = publisher.origin + "/card"
				const host = yield* BrowserHost.start({
					publicOrigin,
					model: yield* documentModel,
					appReadRules: [{ cardUrl, tool: "read_document" }],
					discovery: publisher.discovery,
					appProbe: publisher.probe,
					appNetwork: Layer.succeed(AppHost.AppNetwork, {
						layer: (owner, origins) =>
							Network.layerUserNetwork({
								owner,
								allowedOrigins: origins,
								ca: publisher.ca,
								allowAddress: (ip) => ip === "127.0.0.1",
							}),
					}),
				})
				const alice = yield* callers(host, "app-api-alice")
				const bob = yield* callers(host, "app-api-bob")
				for (const [name, send, other] of [
					["cookie", alice.cookie, alice.token],
					["token", alice.token, alice.cookie],
				] as const) {
					const draft = yield* Caller.read(
						ConnectionsApi.ConnectionDraft,
						send("/v1/connection-drafts", "POST", { input: cardUrl }),
						201,
					)
					const connection = yield* Caller.read(
						ConnectionsApi.Connection,
						send("/v1/connections", "POST", {
							draftId: draft.id,
							revision: draft.revision,
							cardUrl,
							remoteIndex: 0,
							values: {
								"header:X-Account": name,
								"header:X-Secret": "private-app-value",
							},
							name: "Documents " + name,
							confirmed: true,
						}),
						201,
					)
					const bot = yield* Messages.bot(send, { name: "Documents " + name })
					const receipt = yield* Messages.message(
						send,
						bot,
						"Read the document",
					)
					yield* Messages.settled(send, receipt.chat)
					const operations = yield* Caller.read(
						Schema.Array(AppExecution.ExecutionView),
						send(`/v1/chats/${receipt.chat}/app-operations`),
					)
					assert.strictEqual(operations.length, 1)
					const operation = yield* Effect.fromOption(Arr.head(operations))
					assert.strictEqual(operation.status, "completed")
					assert.ok(operation.result?._tag === "Completed")
					assert.deepInclude(operation.result.result, {
						structuredContent: {
							id: "alpha",
							account: name,
							text: "Document content alpha",
						},
					})
					const operationPath = `/v1/app-operations/${operation.id}`
					assert.deepStrictEqual(
						yield* Caller.read(
							AppExecution.ExecutionView,
							other(operationPath),
						),
						operation,
					)
					const items = yield* Caller.read(
						Items,
						send(`/v1/chats/${receipt.chat}/items?limit=100`),
					)
					const item = yield* Effect.fromOption(
						Arr.findFirst(items.items, (entry) =>
							Arr.some(
								entry.content.content,
								(message) =>
									message.role === "tool" &&
									Arr.isArray(message.content) &&
									Arr.some(
										message.content,
										(part) =>
											isToolResult(part) && part.id === operation.callId,
									),
							),
						),
					)
					const opening = { chatId: receipt.chat, itemId: item.id }
					const opened = yield* Caller.read(
						AppViewsApi.Opened,
						send(operationPath + "/view", "POST", opening),
					)
					const viewPath = `/v1/app-views/${opened.id}`
					assert.strictEqual(
						opened.resource.mimeType,
						"text/html;profile=mcp-app",
					)
					assert.deepStrictEqual(
						(yield* Caller.read(AppViewsApi.Binding, other(viewPath)))
							.interaction,
						{ revision: 0, context: null },
					)
					for (const denied of [bob.cookie, bob.token]) {
						yield* status(denied(operationPath), 404)
						yield* status(denied(viewPath), 404)
						yield* status(
							denied(viewPath + "/context", "PUT", {
								revision: 0,
								context: {},
							}),
							404,
						)
						yield* status(
							denied(viewPath + "/messages", "POST", {
								commandKey: "wrong-owner",
								content: { content: [{ type: "text", text: "No" }] },
							}),
							404,
						)
					}
					const read = (method: string, params = {}) =>
						Caller.read(
							Schema.JsonObject,
							send(viewPath + "/read", "POST", { method, params }),
						)
					const first = yield* read("tools/list")
					const listed = yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							tools: Schema.Array(Schema.Struct({ name: Schema.String })),
						}),
					)(first)
					assert.deepStrictEqual(
						Arr.map(listed.tools, (tool) => tool.name),
						["read_document", "read_later", "write_board", "hidden_action"],
					)
					assert.deepInclude(yield* read("resources/list"), {
						resources: [
							{
								uri: "notes://documents/index",
								name: "Document index",
								mimeType: "text/plain",
							},
						],
					})
					assert.deepInclude(
						yield* read("resources/templates/list", { cursor: "later" }),
						{
							resourceTemplates: [
								{
									uriTemplate: "notes://documents/{id}",
									name: "Document",
									mimeType: "text/plain",
								},
							],
						},
					)
					const context = {
						content: [{ type: "text", text: "Selected alpha" }],
					}
					assert.deepStrictEqual(
						yield* Caller.read(
							AppViewsApi.Interaction,
							send(viewPath + "/context", "PUT", { revision: 0, context }),
						),
						{ revision: 1, context },
					)
					yield* status(
						other(viewPath + "/context", "PUT", { revision: 0, context: {} }),
						409,
					)
					assert.deepStrictEqual(
						yield* Caller.read(
							AppViewsApi.Interaction,
							other(operationPath + `/interaction?chatId=${receipt.chat}`),
						),
						{ revision: 1, context },
					)
					const message = {
						commandKey: "view-message-" + name,
						content: {
							content: [{ type: "text", text: "Keep the selected document" }],
						},
					}
					const ticket = yield* Caller.read(
						AppViewsApi.ActionTicket,
						send(viewPath + "/messages", "POST", message),
						202,
					)
					yield* Messages.settled(send, receipt.chat)
					assert.deepStrictEqual(
						yield* Caller.read(
							AppViewsApi.ActionTicket,
							send(viewPath + "/messages", "POST", message),
							202,
						),
						ticket,
					)
					yield* status(other(viewPath + "/messages", "POST", message), 409)
					yield* status(
						send(viewPath + "/messages", "POST", {
							...message,
							content: { content: [{ type: "text", text: "Another message" }] },
						}),
						409,
					)
					yield* Messages.settled(send, receipt.chat)
					const afterMessage = yield* Caller.read(
						Items,
						other(`/v1/chats/${receipt.chat}/items?limit=100`),
					)
					const messages = Arr.flatMap(
						afterMessage.items,
						(item) => item.content.content,
					)
					assert.strictEqual(
						Arr.filter(
							messages,
							(entry) =>
								entry.role === "user" &&
								entry.content ===
									`Confirmed message from App ${connection.id}:\nKeep the selected document`,
						).length,
						1,
					)

					yield* host.restart
					assert.deepStrictEqual(
						(yield* Caller.read(AppViewsApi.Binding, send(viewPath)))
							.interaction,
						{ revision: 1, context },
					)
					yield* status(send(viewPath, "DELETE"), 200)
					yield* status(other(viewPath), 404)
					const reopened = yield* Caller.read(
						AppViewsApi.Opened,
						other(operationPath + "/view", "POST", opening),
					)
					assert.deepStrictEqual(reopened.interaction, { revision: 1, context })
					yield* status(other(`/v1/app-views/${reopened.id}`, "DELETE"), 200)
					const removal = yield* Caller.read(
						Execution.Receipt,
						send(`/v1/connections/${connection.id}`, "DELETE", {
							commandKey: `remove:${connection.id}`,
						}),
					)
					const removed = yield* Caller.read(
						Execution.Record,
						send(`/v1/executions/${removal.executionId}`),
					).pipe(
						Effect.repeat({
							until: (state) => Execution.isTerminal(state.status),
							schedule: Schedule.spaced("20 millis"),
						}),
						Effect.timeout("30 seconds"),
					)
					assert.equal(removed.status, "completed")
				}
				assert.strictEqual(yield* publisher.businessCalls, 2)
				assert.deepStrictEqual(yield* publisher.writes, [])
			}),
		{ timeout: 60000 },
	)
	it.effect(
		"tokens and cookies prove App control, share reports, run connection tests and clear their saved state",
		() =>
			Effect.gen(function* () {
				const crypto = yield* Crypto.Crypto
				const app = yield* Fixture.start({ capabilities: true })
				const publisher = yield* proofPublisher(app)
				const host = yield* BrowserHost.start({
					publicOrigin,
					discovery: publisher.discovery,
					indexPublicNetwork: publisher.publicNetwork,
					appNetwork: publisher.appNetwork,
				})
				const alice = yield* callers(host, "developer-api-alice")
				const bob = yield* callers(host, "developer-api-bob")
				for (const [name, send, other] of [
					["cookie", alice.cookie, alice.token],
					["token", alice.token, alice.cookie],
				] as const) {
					const claim = yield* Caller.read(
						DeveloperApi.Challenge,
						send("/v1/developer/claims", "POST", {
							_tag: "AppCard",
							cardUrl: publisher.cardUrl,
						}),
					)
					yield* publisher.publish(claim.token)
					const proofPath = `/v1/developer/proofs/${claim.id}`
					const verifyPath = `/v1/developer/claims/${claim.id}/verify`
					const command = { commandKey: "prove-" + name }
					const accepted = yield* Caller.read(
						Execution.Receipt,
						send(verifyPath, "POST", command),
						202,
					)
					assert.deepStrictEqual(
						yield* Caller.read(
							Execution.Receipt,
							send(verifyPath, "POST", command),
							202,
						),
						accepted,
					)
					const verified = yield* Wait.untilTrue(
						"App proof",
						Caller.read(
							Execution.Record,
							other(`/v1/executions/${accepted.executionId}`),
						),
						(record) => Execution.isTerminal(record.status),
					)
					assert.strictEqual(verified.status, "completed")
					assert.strictEqual(
						(yield* Caller.read(DeveloperApi.Proof, other(proofPath))).status,
						"Confirmed",
					)
					const report = yield* Caller.read(
						DeveloperApi.SavedReport,
						send("/v1/developer/reports", "POST", {
							cardUrl: publisher.cardUrl,
						}),
					)
					const reportPath = `/v1/developer/reports/${report.id}`
					assert.deepStrictEqual(
						yield* Caller.read(DeveloperApi.SavedReport, other(reportPath)),
						report,
					)
					assert.strictEqual(
						(yield* Caller.read(
							Schema.Array(DeveloperApi.SavedReport),
							other(
								"/v1/developer/reports?" +
									new URLSearchParams({ cardUrl: publisher.cardUrl }),
							),
						)).length,
						1,
					)
					for (const denied of [bob.cookie, bob.token]) {
						yield* status(denied(reportPath), 404)
						yield* status(denied(proofPath), 404)
					}
					const invitation = yield* Caller.read(
						DeveloperApi.Invitation,
						send(proofPath + "/invitations", "POST", { role: "viewer" }),
					)
					const grant = yield* Caller.read(
						DeveloperApi.Grant,
						bob.token(
							`/v1/developer/invitations/${invitation.id}/accept`,
							"POST",
						),
					)
					assert.strictEqual(grant.role, "viewer")
					assert.deepStrictEqual(
						yield* Caller.read(
							DeveloperApi.SavedReport,
							bob.cookie(reportPath),
						),
						report,
					)
					yield* status(
						bob.token("/v1/developer/reports", "POST", {
							cardUrl: publisher.cardUrl,
						}),
						403,
					)
					const members = yield* Caller.read(
						Schema.Struct({ members: Schema.Array(DeveloperApi.Member) }),
						other(proofPath + "/members"),
					)
					assert.strictEqual(members.members.length, 1)
					const member = yield* Effect.fromOption(Arr.head(members.members))
					assert.strictEqual(
						(yield* Caller.read(
							DeveloperApi.Member,
							send(`/v1/developer/members/${member.id}`, "PUT", {
								role: "maintainer",
							}),
						)).role,
						"maintainer",
					)
					const input = {
						id: yield* crypto.randomUUIDv4(),
						cardUrl: publisher.cardUrl,
						remoteIndex: 0,
					}
					const test = yield* Caller.read(
						DeveloperApi.ConnectionTest,
						send("/v1/developer/tests", "POST", input),
					)
					assert.strictEqual(test.status, "AwaitingConfiguration")
					assert.deepStrictEqual(
						yield* Caller.read(
							DeveloperApi.ConnectionTest,
							other("/v1/developer/tests", "POST", input),
						),
						test,
					)
					const testPath = `/v1/developer/tests/${test.id}`
					yield* status(bob.token(testPath), 404)
					const configured = yield* Caller.read(
						DeveloperApi.ConnectionTest,
						send(testPath + "/configuration", "PUT", {
							"header:X-Account": name,
							"header:X-Secret": "private-developer-value",
						}),
					)
					assert.strictEqual(configured.status, "Queued")
					const runCommand = { commandKey: "run-" + test.id }
					const started = yield* send(testPath + "/run", "POST", runCommand)
					const execution = yield* Caller.json(Execution.Receipt, 202)(started)
					assert.notInclude(yield* started.text, "private-developer-value")
					assert.deepStrictEqual(
						yield* Caller.read(
							Execution.Receipt,
							send(testPath + "/run", "POST", runCommand),
							202,
						),
						execution,
					)
					yield* completed(other, execution.executionId)
					const done = yield* Caller.read(
						DeveloperApi.ConnectionTest,
						other(testPath),
					)
					assert.strictEqual(done.executionId, execution.executionId)
					assert.strictEqual(done.status, "Succeeded")
					assert.deepStrictEqual(
						Arr.map(done.stages, (stage) => [stage.name, stage.status]),
						[
							["configuration", "Passed"],
							["negotiation", "Passed"],
							["tools", "Passed"],
							["resources", "Passed"],
							["resourceTemplates", "Passed"],
							["prompts", "Passed"],
						],
					)
					assert.strictEqual(
						(yield* Effect.fromOption(
							Arr.findFirst(done.stages, (stage) => stage.name === "tools"),
						)).items.length,
						4,
					)
					assert.deepStrictEqual(
						yield* Caller.read(
							Schema.Array(ConnectionsApi.Connection),
							other("/v1/connections"),
						),
						[],
					)
					yield* host.restart
					assert.strictEqual(
						(yield* Caller.read(DeveloperApi.ConnectionTest, send(testPath)))
							.status,
						"Succeeded",
					)
					const cleanupCommand = { commandKey: "cleanup-" + test.id }
					const cleanupCall = send(
						testPath + "/cleanup",
						"POST",
						cleanupCommand,
					)
					const cleanup = yield* Caller.read(
						Execution.Receipt,
						cleanupCall,
						202,
					)
					assert.deepStrictEqual(
						yield* Caller.read(Execution.Receipt, cleanupCall, 202),
						cleanup,
					)
					yield* completed(other, cleanup.executionId)
					const cleaned = yield* Caller.read(
						DeveloperApi.ConnectionTest,
						other(testPath),
					)
					assert.strictEqual(cleaned.cleanupExecutionId, cleanup.executionId)
					assert.strictEqual(cleaned.cleanupLocal, "Complete")
					assert.strictEqual(cleaned.cleanup, "Complete")
					const deleteCall = other(
						testPath +
							"?" +
							new URLSearchParams({ commandKey: "delete-" + test.id }),
						"DELETE",
					)
					const removed = yield* Caller.read(Execution.Receipt, deleteCall, 202)
					yield* completed(send, removed.executionId)
					yield* status(send(testPath), 404)
					assert.deepStrictEqual(
						yield* Caller.read(Execution.Receipt, deleteCall, 202),
						removed,
					)
					yield* status(send(reportPath, "DELETE"), 200)
					yield* status(other(reportPath), 404)
					yield* status(
						other(`/v1/developer/members/${member.id}`, "DELETE"),
						200,
					)
					assert.deepStrictEqual(
						(yield* Caller.read(
							Schema.Struct({ members: Schema.Array(DeveloperApi.Member) }),
							send(proofPath + "/members"),
						)).members,
						[],
					)
					const unused = yield* Caller.read(
						DeveloperApi.Invitation,
						other(proofPath + "/invitations", "POST", { role: "viewer" }),
					)
					assert.strictEqual(
						(yield* Caller.read(
							DeveloperApi.Invitation,
							send(`/v1/developer/invitations/${unused.id}/revoke`, "POST"),
						)).status,
						"Revoked",
					)
					assert.strictEqual(
						(yield* Caller.read(
							DeveloperApi.Proof,
							send(proofPath + "/relinquish", "POST"),
						)).status,
						"Relinquished",
					)
				}
				assert.strictEqual(yield* app.businessCalls, 0)
			}),
		{ timeout: 60000 },
	)
})
