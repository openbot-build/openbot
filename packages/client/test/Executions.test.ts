import { assert, it } from "@effect/vitest"
import {
	AccountAuth,
	BotAuth,
	SessionAuth,
	AppViewsApi,
} from "@openbot-build/api"
import { Execution } from "@openbot-build/domain"
import {
	Array as Arr,
	Crypto,
	Effect,
	Layer,
	Result,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { HttpApiMiddleware } from "effect/http-api"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Client from "../src/Client.ts"
import * as Executions from "../src/Executions.ts"
import * as AppViews from "../src/AppViews.ts"

const event = (
	id: string,
	sequence: number,
	body: Execution.EventBody,
): Execution.Event => ({
	executionId: Execution.Id.make(id),
	sequence,
	createdAt: 0,
	body,
})
const sse = (events: ReadonlyArray<Execution.Event>) =>
	Effect.map(
		Effect.forEach(events, (entry) =>
			Schema.encodeEffect(Schema.fromJsonString(Execution.Event))(entry).pipe(
				Effect.map(
					(data) =>
						`event: execution\nid: ${entry.sequence}\ndata: ${data}\n\n`,
				),
			),
		),
		Arr.join(""),
	)
const layer = (handle: (path: string) => Effect.Effect<Response>) =>
	Layer.effect(
		Client.Client,
		Client.make({ baseUrl: "https://test.invalid" }),
	).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(
					HttpClient.HttpClient,
					HttpClient.make((request, url) =>
						handle(url.pathname + url.search).pipe(
							Effect.map((response) =>
								HttpClientResponse.fromWeb(request, response),
							),
						),
					),
				),
				HttpApiMiddleware.layerClient(BotAuth, ({ request, next }) =>
					next(request),
				),
				HttpApiMiddleware.layerClient(AccountAuth, ({ request, next }) =>
					next(request),
				),
				HttpApiMiddleware.layerClient(SessionAuth, ({ request, next }) =>
					next(request),
				),
			),
		),
	)
const streamResponse = (events: ReadonlyArray<Execution.Event>) =>
	sse(events).pipe(
		Effect.map(
			(body) =>
				new Response(body, {
					headers: { "content-type": "text/event-stream" },
				}),
		),
		Effect.orDie,
	)

it.effect(
	"a child can finish after its parent stream ends, and each child has its own cursor",
	() =>
		Effect.gen(function* () {
			const seen = yield* Ref.make<ReadonlyArray<string>>([])
			const terminal = {
				_tag: "State",
				status: "completed",
				failure: null,
			} as const
			const client = layer((path) =>
				Ref.update(seen, Arr.append(path)).pipe(
					Effect.andThen(
						Str.startsWith("/v1/executions/parent/")(path)
							? streamResponse([
									event("parent", 1, {
										_tag: "ChildExecution",
										executionId: Execution.Id.make("child"),
										step: "one",
									}),
									event("parent", 2, terminal),
								])
							: streamResponse([
									event("child", 1, {
										_tag: "Text",
										step: "model",
										attempt: 2,
										text: "saved",
									}),
									event("child", 2, terminal),
								]),
					),
				),
			)
			const events = yield* Executions.observeTree(
				Execution.Id.make("parent"),
			).pipe(Stream.runCollect, Effect.provide(client))
			assert.strictEqual(events.length, 4)
			assert.deepStrictEqual(yield* Ref.get(seen), [
				"/v1/executions/parent/observe?afterSequence=0",
				"/v1/executions/child/observe?afterSequence=0",
			])
			yield* Executions.observe(Execution.Id.make("child"), 1).pipe(
				Stream.runDrain,
				Effect.provide(client),
			)
			assert.include(
				yield* Ref.get(seen),
				"/v1/executions/child/observe?afterSequence=1",
			)
		}),
)

for (const status of ["completed", "failed"] as const)
	it.effect(
		`the View bridge reads ${status} after an old unknown event without reading decision children`,
		() =>
			Effect.gen(function* () {
				const source = {
					connectionId: "connection",
					connectionName: "Documents",
					cardUrl: "https://app.test/card",
					appName: "Documents",
					remoteIndex: 0,
					revision: 1,
					kind: "tool",
					name: "read",
				}
				const opened = yield* Schema.decodeUnknownEffect(AppViewsApi.Opened)({
					id: "view",
					operationId: "original",
					readOnly: false,
					chat: "chat",
					turn: "turn",
					item: "item",
					source,
					interaction: { revision: 0, context: null },
					resource: {
						uri: "ui://test/view",
						mimeType: "text/html;profile=mcp-app",
						html: "<p>Test</p>",
					},
					tools: [],
					arguments: {},
				})
				const seen = yield* Ref.make<ReadonlyArray<string>>([])
				const reads = yield* Ref.make(0)
				const failure = { category: "external", errorId: "release-error" }
				const result = {
					content: [{ type: "text" as const, text: "Saved answer" }],
				}
				const client = layer((path) =>
					Ref.update(seen, Arr.append(path)).pipe(
						Effect.andThen(
							Effect.suspend(() => {
								if (path === "/v1/app-views/view/actions")
									return Effect.succeed(
										Response.json(
											{
												executionId: "turn",
												commandKey: "command",
												sequence: 1,
												chat: "chat",
												turn: "turn",
											},
											{ status: 202 },
										),
									)
								if (path === "/v1/executions/turn/observe?afterSequence=0")
									return streamResponse([
										event("turn", 1, {
											_tag: "ChildExecution",
											executionId: Execution.Id.make("app"),
											step: "tool",
										}),
										event("turn", 2, {
											_tag: "State",
											status: "completed",
											failure: null,
										}),
									])
								if (path === "/v1/executions/app/observe?afterSequence=0")
									return streamResponse([
										event("app", 1, {
											_tag: "ChildExecution",
											executionId: Execution.Id.make("private-request"),
											step: "approval",
										}),
										event("app", 2, {
											_tag: "State",
											status: "outcome_unknown",
											failure: null,
										}),
										event("app", 3, {
											_tag: "Result",
											resource: { kind: "AppCall", id: "call" },
										}),
										event("app", 4, {
											_tag: "State",
											status,
											failure: null,
										}),
									])
								if (path === "/v1/executions/turn")
									return Effect.succeed(
										Response.json({
											id: "turn",
											resource: { kind: "Turn", id: "turn" },
											status: "completed",
											sequence: 2,
											createdAt: 0,
											updatedAt: 1,
											failure: null,
										}),
									)
								if (path === "/v1/executions/app")
									return Effect.succeed(
										Response.json({
											id: "app",
											resource: { kind: "AppCall", id: "call" },
											status: "completed",
											sequence: 2,
											createdAt: 0,
											updatedAt: 1,
											failure: null,
										}),
									)
								if (path === "/v1/app-operations/call")
									return Ref.getAndUpdate(reads, (count) => count + 1).pipe(
										Effect.map((count) =>
											Response.json({
												id: "call",
												executionId: "app",
												chat: "chat",
												turn: "turn",
												callId: "same",
												toolName: "read",
												source,
												arguments: {},
												readOnly: true,
												round: 0,
												status: count === 0 ? "running" : status,
												result:
													count === 0 ? null : { _tag: "Completed", result },
												failure:
													count > 0 && status === "failed" ? failure : null,
												createdAt: 0,
												updatedAt: 1,
											}),
										),
									)
								return Effect.die(`Unexpected request: ${path}`)
							}),
						),
					),
				)
				const answer = yield* Effect.gen(function* () {
					const bridge = yield* AppViews.make(opened, "owner")
					return yield* bridge.callTool(
						{ name: "read", arguments: {} },
						{ source: "app" },
					)
				}).pipe(
					Effect.provide(client),
					Effect.result,
					Effect.provideService(
						Crypto.Crypto,
						Crypto.make({
							randomBytes: (size) => new Uint8Array(size),
							digest: () => Effect.die("This test makes no digest."),
						}),
					),
				)
				if (status === "completed") {
					assert.ok(Result.isSuccess(answer))
					assert.deepStrictEqual(answer.success, { _tag: "Completed", result })
				} else {
					assert.ok(Result.isFailure(answer))
					assert.strictEqual(answer.failure._tag, "ClientError")
					if (answer.failure._tag === "ClientError")
						assert.include(answer.failure.issue, "release-error")
				}
				assert.strictEqual(yield* Ref.get(reads), 2)
				assert.notInclude(
					yield* Ref.get(seen),
					"/v1/executions/private-request",
				)
				assert.strictEqual((yield* Ref.get(seen)).length, 9)
			}),
	)
