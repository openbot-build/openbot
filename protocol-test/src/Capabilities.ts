import {
	Clock,
	Context,
	Crypto,
	Effect,
	HashMap,
	Match,
	Option,
	Schema,
	Semaphore,
} from "effect"
import { Base64Url } from "effect/encoding"
import { McpSchema, McpServer } from "effect/ai"
import {
	Document,
	McpPublisher,
	PublisherProtection,
} from "@openbot-build/protocol"
import { type Scenario } from "./Scenarios.ts"
import * as Temporary from "./Temporary.ts"

const WorkspaceId = Schema.String.check(
	Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/),
)
const Text = Schema.String.check(Schema.isMaxLength(4000))
const Note = Schema.Struct({ id: Schema.String, text: Text })
const View = Schema.Struct({
	workspace: WorkspaceId,
	revision: Schema.Int,
	notes: Schema.Array(Note),
})
type View = typeof View.Type
interface Workspace {
	readonly view: View
	readonly receipts: HashMap.HashMap<
		string,
		{ readonly input: string; readonly view: View }
	>
}
interface Continuation {
	readonly subject: string
	readonly tool: string
	readonly input: string
	readonly request: McpSchema.McpInputRequest
}
const result = (data: Schema.JsonObject, message = JSON.stringify(data)) =>
	McpSchema.CallToolResult.make({
		content: [McpSchema.TextContent.make({ type: "text", text: message })],
		structuredContent: data,
	})
const businessError = (message: string) =>
	McpSchema.CallToolResult.make({
		isError: true,
		content: [McpSchema.TextContent.make({ type: "text", text: message })],
	})
const invalid = (message: string) => McpSchema.InvalidParams.make({ message })
const internal = () =>
	McpSchema.InternalError.make({
		message: "The test state is full. Try again after some entries expire.",
	})

export const register = (options: {
	readonly origin: string
	readonly scenario: Scenario
	readonly uiHtml: string
}) =>
	Effect.gen(function* () {
		const { scenario, origin } = options
		const server = yield* McpServer.McpServer
		const crypto = yield* Crypto.Crypto
		const lock = yield* Semaphore.make(1)
		const workspaces = Temporary.make<Workspace>(1_800_000)(1000)
		const continuations = Temporary.make<Continuation>(300_000)()
		const subject = Match.value(scenario.authentication).pipe(
			Match.when({ kind: "oauth" }, () =>
				PublisherProtection.currentIdentity.pipe(
					Effect.map((identity) => identity.subject),
					Effect.mapError(() =>
						invalid("There is no authenticated test account."),
					),
				),
			),
			Match.orElse(() => Effect.succeed("public")),
		)
		const keyFor = Effect.fn(function* (workspace: string) {
			return JSON.stringify([yield* subject, workspace])
		})
		const read = Effect.fn(function* (workspace: string) {
			const stored = Option.getOrUndefined(
				yield* workspaces.get(yield* keyFor(workspace)),
			)
			return (
				stored ?? {
					view: { workspace, revision: 0, notes: [] },
					receipts: HashMap.empty<
						string,
						{ readonly input: string; readonly view: View }
					>(),
				}
			)
		})
		const add = <A>(input: {
			readonly name: string
			readonly description: string
			readonly schema: Schema.ConstraintDecoder<A>
			readonly output?: Schema.Constraint
			readonly readOnly?: boolean
			readonly meta?: Schema.JsonObject
			readonly handle: (
				args: A,
			) => Effect.Effect<
				McpSchema.CallToolResult | McpSchema.InputRequired,
				McpSchema.InternalError | McpSchema.InvalidParams,
				McpSchema.McpRequestContext
			>
		}) =>
			Effect.gen(function* () {
				const json = Schema.toJsonSchemaDocument(input.schema)
				const output =
					input.output === undefined
						? undefined
						: Schema.toJsonSchemaDocument(input.output)
				const tool = yield* Schema.decodeUnknownEffect(McpSchema.Tool)({
					name: input.name,
					description: input.description,
					inputSchema: {
						type: "object",
						...json.schema,
						...(Object.keys(json.definitions).length === 0
							? {}
							: { $defs: json.definitions }),
					},
					...(output === undefined
						? {}
						: {
								outputSchema: {
									type: "object",
									...output.schema,
									...(Object.keys(output.definitions).length === 0
										? {}
										: { $defs: output.definitions }),
								},
							}),
					annotations: {
						readOnlyHint: input.readOnly ?? true,
						destructiveHint: input.readOnly === false,
						idempotentHint: true,
						openWorldHint: false,
					},
					...(input.meta === undefined ? {} : { _meta: input.meta }),
				})
				yield* server.addTool({
					tool,
					annotations: Context.empty(),
					handle: (args: unknown) =>
						Schema.decodeUnknownEffect(input.schema)(args).pipe(
							Effect.mapError((error) => invalid(error.message)),
							Effect.flatMap(input.handle),
						),
				})
			})
		const uiMeta = {
			ui: {
				resourceUri: "ui://protocol-test/workspace.html",
				visibility: ["model", "app"],
			},
		}
		const WorkspaceInput = Schema.Struct({ workspace: WorkspaceId })
		yield* add({
			name: "echo",
			description:
				"Return the given test text as a structured result that matches its schema.",
			schema: Schema.Struct({ text: Text }),
			output: Schema.Struct({ text: Text, scenario: Schema.String }),
			handle: ({ text }) =>
				Effect.succeed(result({ text, scenario: scenario.id })),
		})
		yield* add({
			name: "add",
			description: "Add two finite numbers.",
			schema: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }),
			output: Schema.Struct({ sum: Schema.Finite }),
			handle: ({ a, b }) =>
				Number.isFinite(a + b)
					? Effect.succeed(result({ sum: a + b }))
					: Effect.succeed(
							businessError("The sum is too large to be a finite number."),
						),
		})
		yield* add({
			name: "identity",
			description:
				"Show the current test account and the agreed client capabilities, without credentials.",
			schema: Schema.Struct({}),
			handle: () =>
				Effect.gen(function* () {
					const context = yield* McpSchema.McpRequestContext
					return result({
						subject: yield* subject,
						scenario: scenario.id,
						protocolVersion: context.protocolVersion,
						capabilities: yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
							context.clientCapabilities,
						).pipe(Effect.mapError(() => invalid("Invalid capabilities."))),
					})
				}),
		})
		yield* add({
			name: "content_samples",
			description:
				"Return sample content of each type: text, image, audio, embedded resource and resource link.",
			schema: Schema.Struct({}),
			handle: () =>
				Effect.succeed(
					McpSchema.CallToolResult.make({
						content: [
							McpSchema.TextContent.make({
								type: "text",
								text: "Test content samples of several types.",
							}),
							McpSchema.ImageContent.make({
								type: "image",
								mimeType: "image/png",
								data: Buffer.from(
									"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=",
									"base64",
								),
							}),
							McpSchema.AudioContent.make({
								type: "audio",
								mimeType: "audio/wav",
								data: Buffer.from(
									"UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==",
									"base64",
								),
							}),
							McpSchema.EmbeddedResource.make({
								type: "resource",
								resource: McpSchema.TextResourceContents.make({
									uri: "protocol-test://inline",
									mimeType: "text/plain",
									text: "A test embedded resource.",
								}),
							}),
							McpSchema.ResourceLink.make({
								type: "resource_link",
								uri: "protocol-test://about",
								name: "About Protocol Test",
								mimeType: "application/json",
							}),
						],
					}),
				),
		})
		yield* add({
			name: "read_workspace",
			description:
				"Read a temporary test workspace. An empty workspace is valid.",
			schema: WorkspaceInput,
			output: View,
			meta: uiMeta,
			handle: ({ workspace }) =>
				read(workspace).pipe(Effect.map(({ view }) => result(view))),
		})
		const WriteInput = Schema.Struct({
			workspace: WorkspaceId,
			text: Text,
			idempotencyKey: WorkspaceId,
		})
		yield* add({
			name: "write_note",
			description:
				"Write one temporary test note. The call fails if you reuse an idempotency key with different text.",
			schema: WriteInput,
			output: View,
			readOnly: false,
			meta: uiMeta,
			handle: (args) =>
				lock.withPermit(
					Effect.gen(function* () {
						const state = yield* read(args.workspace)
						const input = JSON.stringify([args.text])
						const prior = Option.getOrUndefined(
							HashMap.get(state.receipts, args.idempotencyKey),
						)
						if (prior !== undefined)
							return prior.input === input
								? result(prior.view)
								: businessError(
										"This idempotency key was already used with different input.",
									)
						if (
							state.view.notes.length >= 50 ||
							HashMap.size(state.receipts) >= 100
						)
							return businessError(
								"This workspace is full. Use a new temporary workspace.",
							)
						const view: View = {
							...state.view,
							revision: state.view.revision + 1,
							notes: [
								...state.view.notes,
								{ id: String(state.view.revision + 1), text: args.text },
							],
						}
						yield* workspaces
							.put(yield* keyFor(args.workspace), {
								view,
								receipts: HashMap.set(state.receipts, args.idempotencyKey, {
									input,
									view,
								}),
							})
							.pipe(Effect.mapError(internal))
						yield* server.notifications["notifications/resources/updated"]({
							uri: "protocol-test://workspace/" + args.workspace,
						})
						return result(view, "Created a test note. " + JSON.stringify(view))
					}),
				),
		})
		yield* add({
			name: "delete_note",
			description:
				"Delete a test note. Give the workspace revision that you expect.",
			schema: Schema.Struct({
				workspace: WorkspaceId,
				id: Schema.String,
				expectedRevision: Schema.Int,
			}),
			output: View,
			readOnly: false,
			handle: (args) =>
				lock.withPermit(
					Effect.gen(function* () {
						const state = yield* read(args.workspace)
						if (state.view.revision !== args.expectedRevision)
							return businessError(
								"The workspace revision changed. Read the workspace again before you delete.",
							)
						const notes = state.view.notes.filter((note) => note.id !== args.id)
						if (notes.length === state.view.notes.length)
							return result(state.view)
						const view = {
							...state.view,
							revision: state.view.revision + 1,
							notes,
						}
						yield* workspaces
							.put(yield* keyFor(args.workspace), { ...state, view })
							.pipe(Effect.mapError(internal))
						yield* server.notifications["notifications/resources/updated"]({
							uri: "protocol-test://workspace/" + args.workspace,
						})
						return result(view)
					}),
				),
		})
		yield* add({
			name: "ui_read_workspace",
			description:
				"Read a workspace. Only the App can call it. It tests host tool visibility.",
			schema: WorkspaceInput,
			output: View,
			meta: {
				ui: {
					resourceUri: "ui://protocol-test/workspace.html",
					visibility: ["app"],
				},
			},
			handle: ({ workspace }) =>
				read(workspace).pipe(Effect.map(({ view }) => result(view))),
		})
		yield* add({
			name: "test_error",
			description: "Return a tool error on purpose. It writes nothing.",
			schema: Schema.Struct({ message: Text }),
			handle: ({ message }) =>
				Effect.succeed(
					businessError(message || "An intended test business error."),
				),
		})
		yield* add({
			name: "wait",
			description:
				"Wait for up to ten seconds and send request progress and logs. Cancel the HTTP request to stop it.",
			schema: Schema.Struct({
				milliseconds: Schema.Int.check(
					Schema.isGreaterThanOrEqualTo(0),
					Schema.isLessThanOrEqualTo(10000),
				),
			}),
			handle: ({ milliseconds }) =>
				Effect.gen(function* () {
					const context = yield* McpSchema.McpRequestContext
					const progressToken = context.requestMetadata?.["progressToken"]
					yield* server.notifications["notifications/message"]({
						level: "info",
						logger: "protocol-test",
						data: "Starting the test wait.",
					})
					const tick = (index: number): Effect.Effect<void> =>
						Effect.gen(function* () {
							if (index > 4) return
							if (
								typeof progressToken === "string" ||
								typeof progressToken === "number"
							)
								yield* server.notifications["notifications/progress"]({
									progressToken,
									progress: index,
									total: 4,
									message: "Test wait progress.",
								})
							if (index < 4) {
								yield* Effect.sleep(milliseconds / 4)
								yield* tick(index + 1)
							}
						})
					yield* tick(0)
					return result({
						waited: milliseconds,
						completedAt: yield* Clock.currentTimeMillis,
					})
				}),
		})
		yield* add({
			name: "notify",
			description:
				"Send resource, tool list, resource list and prompt list notifications to test subscriptions.",
			schema: Schema.Struct({}),
			handle: () =>
				Effect.gen(function* () {
					yield* server.notifications["notifications/tools/list_changed"]({})
					yield* server.notifications["notifications/resources/list_changed"](
						{},
					)
					yield* server.notifications["notifications/prompts/list_changed"]({})
					return result({ notified: true })
				}),
		})
		const inputKinds = ["form", "url", "sampling", "roots"] as const
		yield* Effect.forEach(
			inputKinds,
			(kind) =>
				add({
					name: "request_" + kind,
					description:
						"Test the standard keyed input continuation for " +
						kind +
						". It does not write business data.",
					schema: Schema.Struct({ text: Text }),
					handle: ({ text }) =>
						Effect.gen(function* () {
							const context = yield* McpSchema.McpRequestContext
							const account = yield* subject
							if (context.requestState !== undefined) {
								const pending = Option.getOrUndefined(
									yield* continuations.get(context.requestState),
								)
								if (
									pending === undefined ||
									pending.subject !== account ||
									pending.tool !== kind ||
									pending.input !== text
								)
									return yield* invalid(
										"The continuation expired, or it does not match the original account, tool and input.",
									)
								const response = context.inputResponses?.["input"]
								if (
									response === undefined ||
									Object.keys(context.inputResponses ?? {}).length !== 1
								)
									return yield* invalid(
										"Return one response, for the requested input ID only.",
									)
								const responseSchema = Match.value(kind).pipe(
									Match.when("form", () => McpSchema.ElicitResult),
									Match.when("url", () => McpSchema.ElicitResult),
									Match.when("sampling", () => McpSchema.CreateMessageResult),
									Match.when("roots", () => McpSchema.ListRootsResult),
									Match.exhaustive,
								)
								yield* Schema.decodeUnknownEffect(responseSchema)(
									response,
								).pipe(Effect.mapError((error) => invalid(error.message)))
								yield* Match.value({ kind, action: response["action"] }).pipe(
									Match.when({ kind: "form", action: "accept" }, () =>
										Schema.decodeUnknownEffect(
											Schema.Struct({ label: Schema.NonEmptyString }),
										)(response["content"]).pipe(
											Effect.mapError((error) => invalid(error.message)),
											Effect.asVoid,
										),
									),
									Match.orElse(() => Effect.void),
								)
								if (
									Option.isNone(yield* continuations.take(context.requestState))
								)
									return yield* invalid(
										"The continuation was already completed.",
									)
								return result({ kind, response })
							}
							if (context.inputResponses !== undefined)
								return yield* invalid(
									"Input responses need the original request state.",
								)
							const id = yield* crypto
								.randomBytes(24)
								.pipe(Effect.map(Base64Url.encode), Effect.mapError(internal))
							const request = Match.value(kind).pipe(
								Match.when("form", (): McpSchema.McpInputRequest => ({
									method: "elicitation/create",
									params: {
										mode: "form",
										message: text || "Give a test label.",
										requestedSchema: {
											type: "object",
											properties: { label: { type: "string", minLength: 1 } },
											required: ["label"],
										},
									},
								})),
								Match.when("url", (): McpSchema.McpInputRequest => ({
									method: "elicitation/create",
									params: {
										mode: "url",
										message: text || "Open the test page.",
										url: origin + "/elicitation/" + id,
										elicitationId: id,
									},
								})),
								Match.when("sampling", (): McpSchema.McpInputRequest => ({
									method: "sampling/createMessage",
									params: {
										messages: [
											{
												role: "user",
												content: {
													type: "text",
													text: text || "Reply with a test greeting.",
												},
											},
										],
										maxTokens: 64,
									},
								})),
								Match.when("roots", (): McpSchema.McpInputRequest => ({
									method: "roots/list",
									params: {},
								})),
								Match.exhaustive,
							)
							yield* continuations
								.put(id, { subject: account, tool: kind, input: text, request })
								.pipe(Effect.mapError(internal))
							return new McpSchema.InputRequired({
								requestState: id,
								inputRequests: { input: request },
							})
						}),
				}),
			{ discard: true },
		)
		yield* McpServer.registerResource({
			uri: "protocol-test://about",
			name: "About Protocol Test",
			mimeType: "application/json",
			content: Effect.succeed(
				JSON.stringify({
					scenario: scenario.id,
					protocolVersion: Document.protocolVersion,
					synthetic: true,
					workspaceTtlSeconds: 1800,
				}),
			),
		})
		yield* McpServer.registerResource({
			uri: "protocol-test://binary",
			name: "Binary fixture",
			mimeType: "application/octet-stream",
			content: Effect.succeed(new Uint8Array([0, 1, 2, 127, 128, 255])),
		})
		yield* McpServer.registerResource`protocol-test://workspace/${WorkspaceId}`(
			{
				name: "Temporary workspace",
				mimeType: "application/json",
				completion: {
					param0: (prefix: string) =>
						Effect.succeed(
							["demo", "example", "test"].filter((value) =>
								value.startsWith(prefix),
							),
						),
				},
				content: (_uri, workspace) =>
					read(workspace).pipe(Effect.map(({ view }) => JSON.stringify(view))),
			},
		)
		// Register enough real resources to need more than one native MCP page.
		yield* Effect.forEach(
			Array.from({ length: 110 }, (_, index) => index),
			(index) =>
				McpServer.registerResource({
					uri: "protocol-test://fixture/" + index,
					name: "Synthetic fixture " + index,
					mimeType: "text/plain",
					content: Effect.succeed("Synthetic fixture " + index),
				}),
			{ discard: true },
		)
		yield* McpServer.registerPrompt({
			name: "summarize_workspace",
			description: "Prepare a prompt to summarize a test workspace.",
			parameters: {
				workspace: WorkspaceId,
				style: Schema.optional(Schema.String),
			},
			completion: {
				workspace: (prefix) =>
					Effect.succeed(
						["demo", "example", "test"].filter((value) =>
							value.startsWith(prefix),
						),
					),
				style: (prefix) =>
					Effect.succeed(
						["brief", "detailed"].filter((value) => value.startsWith(prefix)),
					),
			},
			content: ({ workspace, style }) =>
				Effect.succeed(
					"Read protocol-test://workspace/" +
						workspace +
						" and summarize its test notes in a " +
						(style ?? "brief") +
						" style.",
				),
		})
		yield* McpPublisher.registerUi({
			uri: "ui://protocol-test/workspace.html",
			name: "Protocol Test workspace",
			html: options.uiHtml,
			meta: {
				ui: {
					csp: { connectDomains: [], resourceDomains: [] },
					prefersBorder: true,
				},
			},
		})
	})
