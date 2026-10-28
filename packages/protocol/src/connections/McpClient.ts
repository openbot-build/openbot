import {
	HashSet,
	Array as Arr,
	Cause,
	Effect,
	Equal,
	Exit,
	FiberSet,
	PubSub,
	Redacted,
	Ref,
	Scope,
	Stream,
	Match,
	Option,
	Predicate,
	Record as Rec,
	Schema,
	String as Str,
	pipe,
} from "effect"
import { dual, type LazyArg } from "effect/Function"
import * as Sdk from "../network/Sdk.ts"
import * as Mcp from "@modelcontextprotocol/client"

import * as Document from "../Document.ts"
import * as Network from "../network/Network.ts"
import * as App from "./App.ts"
import * as Store from "./Store.ts"
import {
	PermissionDenied,
	withCause,
	ClientError,
	AuthorizationRequired,
	OutcomeUnknown,
	ToolFailure,
	type Request,
	type ResolvedAction,
	type ResolvedTool,
	type ResolvedResource,
	type ResolvedTemplate,
	type ResolvedPrompt,
	type ActionTarget,
	type InvokeOptions,
	type Error,
	type CallOptions,
	type InputHandler,
	type Continuation,
	type OperationResult,
	type Client,
} from "./Client.ts"

/** Close failures keep their cause. Other owned objects still close in their finalizers. */
const closeResource = (close: () => Promise<void>) =>
	Effect.tryPromise(close).pipe(Effect.orDie)

/** Keep the full cause for the host when making a safe typed failure. */
const replace =
	(error: LazyArg<ClientError>) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, ClientError, R> =>
		self.pipe(
			Effect.catchCause((cause) =>
				Effect.failCause(Cause.map(cause, () => withCause(error(), cause))),
			),
		)

const visibility = (tool: Mcp.Tool, source: CallOptions["source"]) => {
	const ui = tool._meta?.["ui"]
	if (
		!Schema.is(Schema.Struct({ visibility: Schema.Array(Schema.Unknown) }))(ui)
	)
		return true
	return source === "host" || ui.visibility.includes(source)
}

const reservedMeta = HashSet.fromIterable([
	Mcp.PROTOCOL_VERSION_META_KEY,
	Mcp.CLIENT_INFO_META_KEY,
	Mcp.CLIENT_CAPABILITIES_META_KEY,
	Mcp.SERVER_INFO_META_KEY,
])

/** The SDK keeps the cache of each connection apart by this JSON text. */
const CachePartition = Schema.fromJsonString(
	Schema.Tuple([Schema.String, Schema.String, Schema.String]),
)

/** An OAuth scope value is a list of names with spaces between them. */
const scopeList = (scope: string | undefined): ReadonlyArray<string> =>
	scope === undefined
		? []
		: pipe(scope, Str.split(/\s+/), Arr.filter(Str.isNonEmpty))

/**
 * The most list pages that the client reads in one walk.
 * The SDK 2.3.1 list helpers stop at 64 pages, but `singlePage` goes around them, so the client keeps the same limit.
 */
const maxPages = 64

/** The next request of an MRTR operation: the saved server state and the host answers. */
interface Next {
	readonly requestState?: string | undefined
	readonly inputResponses: Mcp.InputResponses
}

/**
 * Check a value with a Standard Schema from the SDK.
 * The schema is built inside `Effect.tryPromise`, because the SDK can throw while it builds a JSON Schema validator.
 * `validate` gives back a result or a Promise, so `Promise.resolve` makes both a Promise.
 * The host gets a private cause with the thrown error or the schema issues.
 */
export const decodeStandard = <A>(
	schema: () => Mcp.StandardSchemaV1<unknown, A>,
	value: unknown,
	error: (cause: unknown) => ClientError,
) =>
	Effect.tryPromise(() =>
		Promise.resolve(schema()["~standard"].validate(value)),
	).pipe(
		Effect.flatMap((result) =>
			result.issues === undefined
				? Effect.succeed(result.value)
				: Effect.fail(result.issues),
		),
		Effect.catchCause((cause) =>
			Effect.failCause(
				Cause.map(cause, (failure) => withCause(error(failure), cause)),
			),
		),
	)

/** Saved MRTR input that does not fit its operation. */
const inputMismatch = () =>
	ClientError.make({
		reason: "Schema",
		issue: "The input response does not match this operation.",
	})

const decodeInputs = (
	continuation: Continuation,
	responses: Schema.JsonObject,
) =>
	Effect.gen(function* () {
		const parsed = yield* decodeStandard(
			() => Mcp.withInputRequired(Mcp.specTypeSchemas.CallToolResult),
			continuation.request,
			inputMismatch,
		).pipe(Effect.filterOrFail(Mcp.isInputRequiredResult, inputMismatch))
		const requests = parsed.inputRequests ?? {}
		if (Rec.some(responses, (_, id) => requests[id] === undefined))
			return yield* inputMismatch()
		const decoded: Mcp.InputResponses = yield* Effect.all(
			Rec.map(requests, (request, id) =>
				Match.value(request).pipe(
					Match.when({ method: "elicitation/create" }, (request) =>
						decodeStandard(
							() => Mcp.specTypeSchemas.ElicitResult,
							responses[id],
							inputMismatch,
						).pipe(
							Effect.tap((result) => {
								const params = request.params
								return result.action === "accept" &&
									params !== undefined &&
									"requestedSchema" in params
									? decodeStandard(
											() =>
												Mcp.fromJsonSchema(
													params.requestedSchema as Mcp.JsonSchemaType,
												),
											result.content,
											inputMismatch,
										)
									: Effect.void
							}),
						),
					),
					Match.when({ method: "sampling/createMessage" }, () =>
						decodeStandard(
							() => Mcp.specTypeSchemas.CreateMessageResult,
							responses[id],
							inputMismatch,
						),
					),
					Match.when({ method: "roots/list" }, () =>
						decodeStandard(
							() => Mcp.specTypeSchemas.ListRootsResult,
							responses[id],
							inputMismatch,
						),
					),
					Match.exhaustive,
				),
			),
		)
		return { parsed, decoded }
	})
/** Check saved MRTR responses without sending a remote request. */
export const validateInputs: {
	(
		responses: Schema.JsonObject,
	): (continuation: Continuation) => Effect.Effect<void, ClientError>
	(
		continuation: Continuation,
		responses: Schema.JsonObject,
	): Effect.Effect<void, ClientError>
} = dual(2, (continuation: Continuation, responses: Schema.JsonObject) =>
	decodeInputs(continuation, responses).pipe(Effect.asVoid),
)

/** Open a scoped MCP connection. The host owns access and current credentials. */
export interface OpenOptions {
	readonly key: Store.ConnectionKey
	readonly endpoint: string
	readonly headers: Redacted.Redacted<Readonly<Record<string, string>>>
	readonly clientInfo: Mcp.Implementation
	readonly capabilities?: Mcp.ClientCapabilities
	readonly inputs?: InputHandler
	readonly readToken: Effect.Effect<
		Option.Option<Redacted.Redacted<string>>,
		Error
	>
	readonly check: (request: Request) => Effect.Effect<void, Error>
	readonly registerScope?: (
		scope: Scope.Closeable,
	) => Effect.Effect<{ readonly close: Effect.Effect<void> }>
}
export const open = Effect.fn("Client.open")(function* (options: OpenOptions) {
	const network = yield* Network.Network
	if (
		network.identity.scope === "user" &&
		network.identity.owner !== options.key.owner
	)
		return yield* PermissionDenied.make({
			action: "connect",
			target: options.endpoint,
		})
	const closed = yield* Ref.make(false)
	const { scope, close } = yield* Effect.acquireRelease(
		Effect.gen(function* () {
			const scope = yield* Scope.make()
			yield* Scope.addFinalizer(scope, Ref.set(closed, true))
			const registered = yield* (
				options.registerScope === undefined
					? Effect.succeed({ close: Scope.close(scope, Exit.void) })
					: options.registerScope(scope)
			).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
			return { scope, close: registered.close }
		}),
		({ close }) => close,
	)
	return yield* Effect.gen(function* () {
		const guard = Effect.gen(function* () {
			if (yield* Ref.get(closed))
				return yield* ClientError.make({
					reason: "Closed",
					issue: "Connection Scope is closed",
				})
		})
		const checked = (request: Request) =>
			guard.pipe(Effect.andThen(options.check(request)))
		yield* checked({
			action: "connect",
			target: options.endpoint,
			arguments: {},
			source: "host",
		})
		yield* options.readToken

		// The SDK auth provider and notification handlers are Promise callbacks.
		// When the guard fails, the Promise rejects with the typed error, the SDK
		// stops the request, and `mapError` below gets the same typed error back.
		const callbacks = yield* FiberSet.make().pipe(Scope.provide(scope))
		const start = yield* FiberSet.runtimePromise(callbacks)<never>()
		// Effect 4.0.6 adds runtime fibers after they start. Yield first so a
		// callback cannot close the owner before its fiber belongs to the set.
		const run = <A, E>(effect: Effect.Effect<A, E>) =>
			start(Effect.andThen(Effect.yieldNow, effect))
		const token = () =>
			run(
				guard.pipe(
					Effect.andThen(options.readToken),
					Effect.map((token) =>
						Option.getOrUndefined(Option.map(token, Redacted.value)),
					),
				),
			)
		const transportFetch = yield* Sdk.fetch().pipe(
			Effect.provideService(Scope.Scope, scope),
		)
		let challenge:
			| {
					readonly resourceMetadataUrl?: URL
					readonly scope?: string
					readonly error?: string
			  }
			| undefined
		// @effect-diagnostics-next-line asyncFunction:off -- The SDK transport needs a fetch function that returns a Promise.
		const fetch: Mcp.FetchLike = async (input, init) => {
			const response = await transportFetch(input, init)
			if (response.status === 401 || response.status === 403)
				challenge = Mcp.extractWWWAuthenticateParams(response)
			return response
		}
		// A host may never read the notifications, so the PubSub keeps only the newest 256.
		// Each reader of `notifications` gets every notification that comes after it joins.
		const notices = yield* PubSub.sliding<Mcp.Notification>(256)
		const capabilities = {
			...options.capabilities,
			...options.inputs?.capabilities,
		}
		const cachePartition = yield* Schema.encodeEffect(CachePartition)([
			options.key.owner,
			options.key.connectionId,
			options.endpoint,
		]).pipe(Effect.orDie)
		const sdk = new Mcp.Client(options.clientInfo, {
			versionNegotiation: {
				mode: { pin: Document.protocolVersion },
				probe: { maxRetries: 0 },
			},
			inputRequired: { autoFulfill: false },
			enforceStrictCapabilities: true,
			capabilities,
			cachePartition,
		})
		// In SDK 2.3.1 the client clears its list cache on each list_changed notification
		// before it calls this handler, so the handler only passes the notification on.
		sdk.fallbackNotificationHandler = (notification) =>
			run(PubSub.publish(notices, notification).pipe(Effect.asVoid))
		const transport = new Sdk.HttpTransport(new URL(options.endpoint), {
			fetch,
			authProvider: { token },
			requestInit: {
				headers: Redacted.value(options.headers),
				redirect: "manual",
			},
			redirectPolicy: "same-origin",
			onInsufficientScope: "throw",
			maxStepUpRetries: 0,
			reconnectionOptions: {
				maxRetries: 0,
				maxReconnectionDelay: 0,
				initialReconnectionDelay: 0,
				reconnectionDelayGrowFactor: 1,
			},
		})
		yield* Scope.addFinalizer(
			scope,
			Effect.gen(function* () {
				yield* Ref.set(closed, true)
				yield* closeResource(() => sdk.close()).pipe(
					Effect.ensuring(closeResource(() => transport.close())),
					Effect.ensuring(PubSub.shutdown(notices)),
				)
			}),
		)
		const failed = <E extends Error>(error: unknown, replacement: E) =>
			Effect.fail(withCause(replacement, Cause.fail(error)))
		const mapError = (error: unknown): Effect.Effect<never, Error> => {
			if (
				Schema.is(ClientError)(error) ||
				Schema.is(PermissionDenied)(error) ||
				Schema.is(OutcomeUnknown)(error) ||
				Schema.is(ToolFailure)(error) ||
				Schema.is(AuthorizationRequired)(error) ||
				Schema.is(Store.StoreError)(error) ||
				Schema.is(App.AppError)(error)
			)
				return Effect.fail(error)
			if (error instanceof Mcp.UnauthorizedError)
				return failed(
					error,
					AuthorizationRequired.make({
						reason:
							challenge?.error === "invalid_token" ? "Expired" : "Pending",
						scopes: scopeList(challenge?.scope),
						resourceMetadataUrl: challenge?.resourceMetadataUrl?.href,
					}),
				)
			if (error instanceof Mcp.InsufficientScopeError)
				return failed(
					error,
					AuthorizationRequired.make({
						reason: "InsufficientScope",
						scopes: scopeList(error.requiredScope),
						resourceMetadataUrl: error.resourceMetadataUrl?.href,
					}),
				)
			if (error instanceof Mcp.ProtocolError)
				return failed(
					error,
					ClientError.make({
						reason: "Protocol",
						issue: "The MCP server rejected the request.",
					}),
				)
			// Drivers may put private text in a network error message.
			if (Schema.is(Network.NetworkError)(error))
				return failed(
					error,
					ClientError.make({
						reason: "Network",
						issue: "The MCP network request failed.",
					}),
				)
			// The message of an SdkError can hold the raw body of the server,
			// so `issue` keeps only the code. Its private cause keeps the full error.
			if (
				error instanceof Mcp.SdkError &&
				error.code !== Mcp.SdkErrorCode.RequestTimeout
			)
				return failed(
					error,
					ClientError.make({
						reason:
							error.code === Mcp.SdkErrorCode.InvalidResult
								? "Schema"
								: "Protocol",
						issue: error.code,
					}),
				)
			return failed(
				error,
				ClientError.make({
					reason: "Network",
					issue: "MCP request did not return a valid response",
				}),
			)
		}
		const invoke = <A>(request: (signal: AbortSignal) => Promise<A>) =>
			Effect.tryPromise(request).pipe(
				Effect.catch((error) => mapError(error.cause)),
			)
		yield* guard
		yield* invoke((signal) => sdk.connect(transport, { signal }))
		const discovery = sdk.getDiscoverResult()
		if (discovery === undefined)
			return yield* ClientError.make({
				reason: "Protocol",
				issue: "Missing real-time server discovery",
			})
		// In SDK 2.3.1, `sdk.close()` calls `_resetConnectionState`, and that clears the server
		// capabilities. So the check for a closed client must come first.
		const requireCapability = Effect.fn("Client.requireCapability")(function* (
			name: "tools" | "resources" | "prompts",
		) {
			if (yield* Ref.get(closed))
				return yield* ClientError.make({
					reason: "Closed",
					issue: "Connection Scope is closed",
				})
			if (sdk.getServerCapabilities()?.[name] === undefined)
				return yield* ClientError.make({
					reason: "UnsupportedCapability",
					issue: `Server does not advertise ${name}`,
				})
		})
		const validateMeta = (meta: Mcp.RequestMetaObject | undefined) =>
			meta !== undefined &&
			Arr.some(Rec.keys(meta), (key) => HashSet.has(reservedMeta, key))
				? Effect.fail(
						ClientError.make({
							reason: "Schema",
							issue: "Reserved MCP identity metadata cannot be overridden",
						}),
					)
				: Effect.void
		const validateDynamic = (
			schema: Mcp.Tool["inputSchema"] | NonNullable<Mcp.Tool["outputSchema"]>,
			value: unknown,
		) =>
			decodeStandard(
				() => Mcp.fromJsonSchema(schema as Mcp.JsonSchemaType),
				value,
				() =>
					ClientError.make({
						reason: "Schema",
						issue: "Value does not match the service JSON Schema",
					}),
			)
		const invalidResult = () =>
			ClientError.make({
				reason: "Schema",
				issue: "Invalid standard result",
			})
		const requestOptions = (call: CallOptions, signal: AbortSignal) => ({
			signal,
			...Rec.filter({ timeout: call.timeoutMs }, Predicate.isNotUndefined),
			...Rec.filter({ onprogress: call.onprogress }, Predicate.isNotUndefined),
			allowInputRequired: true,
		})
		// The SDK 2.3.1 list helpers join all pages and drop the cursors.
		// With `singlePage` we send the raw request, so callers keep each cursor and can find repeated ones.
		const lists = {
			tools: Effect.fn("Client.listTools")(function* (
				input: {
					readonly cursor?: string
					readonly source?: CallOptions["source"]
					readonly refresh?: boolean
					readonly singlePage?: boolean
				} = {},
			) {
				yield* requireCapability("tools")
				yield* checked({
					action: "tools/list",
					target: "",
					arguments: input,
					source: input.source ?? "host",
				})
				const result = yield* invoke((signal) =>
					input.singlePage === true
						? sdk.request(
								{
									method: "tools/list",
									params:
										input.cursor === undefined ? {} : { cursor: input.cursor },
								},
								{ signal },
							)
						: sdk.listTools(
								input.cursor === undefined
									? undefined
									: {
											cursor: input.cursor,
										},
								{
									signal,
									cacheMode: input.refresh === true ? "refresh" : "use",
								},
							),
				)
				const source = input.source
				return source === undefined
					? result
					: {
							...result,
							tools: Arr.filter(result.tools, (tool) =>
								visibility(tool, source),
							),
						}
			}),
			resources: Effect.fn("Client.listResources")(function* (
				cursor?: string,
				source: CallOptions["source"] = "host",
				options: { readonly singlePage?: boolean } = {},
			) {
				yield* requireCapability("resources")
				yield* checked({
					action: "resources/list",
					target: "",
					arguments: { cursor },
					source,
				})
				const result = yield* invoke((signal) =>
					options.singlePage === true
						? sdk.request(
								{
									method: "resources/list",
									params: cursor === undefined ? {} : { cursor },
								},
								{ signal },
							)
						: sdk.listResources(cursor === undefined ? undefined : { cursor }, {
								signal,
							}),
				)
				return result
			}),
			templates: Effect.fn("Client.listResourceTemplates")(function* (
				cursor?: string,
				source: CallOptions["source"] = "host",
				options: { readonly singlePage?: boolean } = {},
			) {
				yield* requireCapability("resources")
				yield* checked({
					action: "resources/templates/list",
					target: "",
					arguments: { cursor },
					source,
				})
				const result = yield* invoke((signal) =>
					options.singlePage === true
						? sdk.request(
								{
									method: "resources/templates/list",
									params: cursor === undefined ? {} : { cursor },
								},
								{ signal },
							)
						: sdk.listResourceTemplates(
								cursor === undefined ? undefined : { cursor },
								{ signal },
							),
				)
				return result
			}),
			prompts: Effect.fn("Client.listPrompts")(function* (
				cursor?: string,
				source: CallOptions["source"] = "host",
				options: { readonly singlePage?: boolean } = {},
			) {
				yield* requireCapability("prompts")
				yield* checked({
					action: "prompts/list",
					target: "",
					arguments: { cursor },
					source,
				})
				const result = yield* invoke((signal) =>
					options.singlePage === true
						? sdk.request(
								{
									method: "prompts/list",
									params: cursor === undefined ? {} : { cursor },
								},
								{ signal },
							)
						: sdk.listPrompts(cursor === undefined ? undefined : { cursor }, {
								signal,
							}),
				)
				return result
			}),
		}
		const allPages = <A>(
			read: (cursor?: string) => Effect.Effect<
				{
					readonly items: ReadonlyArray<A>
					readonly nextCursor?: string | undefined
				},
				Error
			>,
		) => {
			const next = (
				cursor: string | undefined,
				seen: HashSet.HashSet<string>,
				pages: number,
				items: ReadonlyArray<A>,
			): Effect.Effect<ReadonlyArray<A>, Error> =>
				read(cursor).pipe(
					Effect.flatMap((page) => {
						const all = Arr.appendAll(items, page.items)
						if (page.nextCursor === undefined) return Effect.succeed(all)
						if (HashSet.has(seen, page.nextCursor))
							return Effect.fail(
								ClientError.make({
									reason: "Protocol",
									issue: "The service repeated a capability cursor",
								}),
							)
						if (pages >= maxPages)
							return Effect.fail(
								ClientError.make({
									reason: "Protocol",
									issue: "The service sent too many pages",
								}),
							)
						return next(
							page.nextCursor,
							HashSet.add(seen, page.nextCursor),
							pages + 1,
							all,
						)
					}),
				)
			return next(undefined, HashSet.empty(), 1, [])
		}
		const allTools = (source: CallOptions["source"] = "host") =>
			allPages((cursor) =>
				lists
					.tools({
						...(cursor === undefined ? {} : { cursor }),
						source,
						singlePage: true,
					})
					.pipe(
						Effect.map((page) => ({
							items: page.tools,
							nextCursor: page.nextCursor,
						})),
					),
			)
		const inputRequired = <A>(
			result: Mcp.InputRequiredResult,
			resume: (next: Next) => Effect.Effect<OperationResult<A>, Error>,
		): Extract<OperationResult<A>, { readonly _tag: "InputRequired" }> => {
			const requests = result.inputRequests ?? {}
			const respond = Effect.fn("Client.respond")(function* (
				responses: Mcp.InputResponses,
			) {
				// Effect 4.0.6 `Record.keys` cannot infer the key type of a record
				// with an index signature, so the type arguments are given here.
				if (
					!Equal.equals(
						HashSet.fromIterable(Rec.keys<string, unknown>(responses)),
						HashSet.fromIterable(Rec.keys<string, unknown>(requests)),
					)
				)
					return yield* ClientError.make({
						reason: "Schema",
						issue:
							"Input responses must match the request IDs of this operation",
					})
				if (
					Arr.some(
						Rec.values(requests),
						(request) =>
							(request.method === "sampling/createMessage" &&
								capabilities.sampling === undefined) ||
							(request.method === "elicitation/create" &&
								capabilities.elicitation === undefined) ||
							(request.method === "roots/list" &&
								capabilities.roots === undefined),
					)
				)
					return yield* ClientError.make({
						reason: "InputUnavailable",
						issue: "Host did not declare this input capability",
					})
				return yield* resume({
					requestState: result.requestState,
					inputResponses: responses,
				})
			})
			const inputs = options.inputs
			const handle =
				inputs === undefined
					? Effect.fail(
							ClientError.make({
								reason: "InputUnavailable",
								issue: "Host input handler is not installed",
							}),
						)
					: Effect.all(
							Rec.map(requests, (request) => inputs.handle(request)),
						).pipe(Effect.flatMap(respond))
			return {
				_tag: "InputRequired",
				result,
				respond,
				handle,
			}
		}
		const finish = <A>(
			result: A | Mcp.InputRequiredResult,
			resume: (next: Next) => Effect.Effect<OperationResult<A>, Error>,
		): OperationResult<A> =>
			Mcp.isInputRequiredResult(result)
				? inputRequired(result, resume)
				: { _tag: "Completed", result }
		const callTool: (
			tool: Mcp.Tool,
			params: Mcp.CallToolRequest["params"],
			call: CallOptions,
			next?: Next,
		) => Effect.Effect<OperationResult<Mcp.CallToolResult>, Error> = Effect.fn(
			"Client.callTool",
		)(function* (
			tool: Mcp.Tool,
			params: Mcp.CallToolRequest["params"],
			call: CallOptions,
			next?: Next,
		) {
			yield* requireCapability("tools")
			yield* validateMeta(params._meta)
			yield* checked({
				action: "tools/call",
				target: params.name,
				arguments: params.arguments,
				source: call.source,
			})
			yield* validateDynamic(tool.inputSchema, params.arguments ?? {})
			// Manual MRTR must reach the host before the final structured output is checked.
			// The SDK still handles parameter headers with the real input schema.
			const { outputSchema, ...requestTool } = tool
			// Keep the first private error when the remote write has no known result.
			const unknownOutcome = (
				error: ClientError,
				cause: OutcomeUnknown["cause"],
			) =>
				failed(
					error,
					OutcomeUnknown.make({
						key: options.key,
						target: params.name,
						cause,
					}),
				)
			const raw = yield* invoke((signal) =>
				sdk.callTool(
					{ ...params, ...next },
					{ ...requestOptions(call, signal), toolDefinition: requestTool },
				),
			).pipe(
				Effect.catchIf(
					(error): error is ClientError =>
						Schema.is(ClientError)(error) &&
						["Network", "Protocol", "Closed"].includes(error.reason) &&
						call.readOnly !== true,
					(error) =>
						unknownOutcome(
							error,
							error.reason === "Network"
								? "Network"
								: error.reason === "Closed"
									? "Closed"
									: "Protocol",
						),
				),
			)
			// A bad result of a call that may write leaves the remote outcome unknown.
			const writeOutcome = (
				error: ClientError,
			): Effect.Effect<never, ClientError | OutcomeUnknown> =>
				call.readOnly === true
					? Effect.fail(error)
					: unknownOutcome(error, "Schema")
			const decoded = yield* decodeStandard(
				() => Mcp.withInputRequired(Mcp.specTypeSchemas.CallToolResult),
				raw,
				() =>
					ClientError.make({
						reason: "Schema",
						issue: "Invalid standard tool result",
					}),
			).pipe(Effect.catch(writeOutcome))
			if (Mcp.isInputRequiredResult(decoded))
				return inputRequired(decoded, (next) =>
					callTool(tool, params, call, next),
				)
			if (decoded.isError === true)
				return yield* ToolFailure.make({
					result: decoded,
				})
			if (outputSchema !== undefined)
				yield* validateDynamic(outputSchema, decoded.structuredContent).pipe(
					Effect.catch(writeOutcome),
				)
			return { _tag: "Completed", result: decoded } as const
		})
		const readResource: (
			params: Mcp.ReadResourceRequest["params"],
			call: CallOptions,
			next?: Next,
		) => Effect.Effect<OperationResult<Mcp.ReadResourceResult>, Error> =
			Effect.fn("Client.readResource")(function* (
				params: Mcp.ReadResourceRequest["params"],
				call: CallOptions,
				next?: Next,
			) {
				yield* requireCapability("resources")
				yield* validateMeta(params._meta)
				yield* checked({
					action: "resources/read",
					target: params.uri,
					arguments: params,
					source: call.source,
				})
				const raw = yield* invoke((signal) =>
					sdk.readResource(
						{ ...params, ...next },
						requestOptions(call, signal),
					),
				)
				const result = yield* decodeStandard(
					() => Mcp.withInputRequired(Mcp.specTypeSchemas.ReadResourceResult),
					raw,
					invalidResult,
				)
				return finish(result, (next) => readResource(params, call, next))
			})
		const getPrompt: (
			params: Mcp.GetPromptRequest["params"],
			call: CallOptions,
			next?: Next,
		) => Effect.Effect<OperationResult<Mcp.GetPromptResult>, Error> = Effect.fn(
			"Client.getPrompt",
		)(function* (
			params: Mcp.GetPromptRequest["params"],
			call: CallOptions,
			next?: Next,
		) {
			yield* requireCapability("prompts")
			yield* validateMeta(params._meta)
			yield* checked({
				action: "prompts/get",
				target: params.name,
				arguments: params,
				source: call.source,
			})
			const result = yield* invoke((signal) =>
				sdk.request(
					{
						method: "prompts/get",
						params: {
							...params,
							...next,
						},
					},
					Mcp.withInputRequired(Mcp.specTypeSchemas.GetPromptResult),
					requestOptions(call, signal),
				),
			)
			return finish(result, (next) => getPrompt(params, call, next))
		})
		const findDefinition = <A>(
			read: (cursor?: string) => Effect.Effect<
				{
					readonly items: ReadonlyArray<A>
					readonly nextCursor?: string | undefined
				},
				Error
			>,
			matches: (value: A) => boolean,
		) => {
			const page = (
				cursor: string | undefined,
				seen: HashSet.HashSet<string>,
				count: number,
			): Effect.Effect<Option.Option<A>, Error> =>
				Effect.gen(function* () {
					const value = yield* read(cursor)
					const found = Arr.findFirst(value.items, matches)
					if (Option.isSome(found) || value.nextCursor === undefined)
						return found
					if (HashSet.has(seen, value.nextCursor))
						return yield* ClientError.make({
							reason: "Protocol",
							issue: "The service repeated a capability cursor",
						})
					if (count >= maxPages)
						return yield* ClientError.make({
							reason: "Protocol",
							issue: "The service sent too many pages",
						})
					return yield* page(
						value.nextCursor,
						HashSet.add(seen, value.nextCursor),
						count + 1,
					)
				})
			return page(undefined, HashSet.empty(), 1)
		}
		const bind = <Params>(
			method: Continuation["method"],
			target: Readonly<Record<string, string>>,
			source: CallOptions["source"],
			decode: (value: Schema.JsonObject) => Effect.Effect<Params, ClientError>,
			send: (
				params: Params,
				call: CallOptions,
				next?: Next,
			) => Effect.Effect<OperationResult<unknown>, Error>,
		) => ({
			invoke: (params: Params, call: InvokeOptions) =>
				send(params, { ...call, source }),
			resume: Effect.fn("Client.resume")(function* (
				continuation: Continuation,
				responses: Schema.JsonObject,
				call: InvokeOptions,
			) {
				if (
					continuation.method !== method ||
					Rec.some(target, (value, key) => continuation.params[key] !== value)
				)
					return yield* inputMismatch()
				const params = yield* decode(continuation.params)
				const { parsed, decoded } = yield* decodeInputs(continuation, responses)
				return yield* inputRequired(parsed, (next) =>
					send(params, { ...call, source }, next),
				).respond(decoded)
			}),
		})
		const toolAction = (
			definition: Mcp.Tool,
			source: CallOptions["source"],
		): ResolvedTool => ({
			kind: "tool",
			definition,
			...bind(
				"tools/call",
				{ name: definition.name },
				source,
				(value) =>
					decodeStandard(
						() => Mcp.specTypeSchemas.CallToolRequest,
						{ method: "tools/call", params: value },
						inputMismatch,
					).pipe(Effect.map((value) => value.params)),
				(params: Omit<Mcp.CallToolRequest["params"], "name">, call, next) =>
					callTool(
						definition,
						{ ...params, name: definition.name },
						call,
						next,
					),
			),
		})
		const resourceAction = (
			definition: Mcp.Resource,
			source: CallOptions["source"],
		): ResolvedResource => ({
			kind: "resource",
			definition,
			...bind(
				"resources/read",
				{ uri: definition.uri },
				source,
				(value) =>
					decodeStandard(
						() => Mcp.specTypeSchemas.ReadResourceRequest,
						{ method: "resources/read", params: value },
						inputMismatch,
					).pipe(Effect.map((value) => value.params)),
				(params: Omit<Mcp.ReadResourceRequest["params"], "uri">, call, next) =>
					readResource({ ...params, uri: definition.uri }, call, next),
			),
		})
		const promptAction = (
			definition: Mcp.Prompt,
			source: CallOptions["source"],
		): ResolvedPrompt => ({
			kind: "prompt",
			definition,
			...bind(
				"prompts/get",
				{ name: definition.name },
				source,
				(value) =>
					decodeStandard(
						() => Mcp.specTypeSchemas.GetPromptRequest,
						{ method: "prompts/get", params: value },
						inputMismatch,
					).pipe(Effect.map((value) => value.params)),
				(params: Omit<Mcp.GetPromptRequest["params"], "name">, call, next) =>
					getPrompt({ ...params, name: definition.name }, call, next),
			),
		})
		const templateAction = (
			definition: Mcp.ResourceTemplateType,
			source: CallOptions["source"],
		): ResolvedTemplate => ({
			kind: "template",
			definition,
			...bind(
				"resources/read",
				{ uriTemplate: definition.uriTemplate },
				source,
				(value) =>
					Schema.decodeUnknownEffect(
						Schema.Struct({
							values: Schema.Record(
								Schema.String,
								Schema.Union([
									Schema.String,
									Schema.mutable(Schema.Array(Schema.String)),
								]),
							),
							_meta: Schema.optionalKey(Schema.JsonObject),
						}),
					)(value).pipe(replace(inputMismatch)),
				(params: Parameters<ResolvedTemplate["invoke"]>[0], call, next) =>
					Effect.gen(function* () {
						const uri = yield* Effect.try(() =>
							new Mcp.UriTemplate(definition.uriTemplate).expand(params.values),
						).pipe(
							replace(() =>
								ClientError.make({
									reason: "Schema",
									issue: "Invalid resource template arguments",
								}),
							),
						)
						return yield* readResource(
							{
								uri,
								...(params._meta === undefined ? {} : { _meta: params._meta }),
							},
							call,
							next,
						)
					}),
			),
		})
		const resolve = Effect.fn("Client.resolve")(function* (
			target: ActionTarget,
			source: CallOptions["source"],
		): Effect.fn.Return<Option.Option<ResolvedAction>, Error> {
			yield* guard
			switch (target.kind) {
				case "tool":
					if (discovery.capabilities.tools === undefined) return Option.none()
					return Option.map(
						yield* findDefinition(
							(cursor) =>
								lists
									.tools({
										...(cursor === undefined ? {} : { cursor }),
										source,
										singlePage: true,
									})
									.pipe(
										Effect.map((page) => ({
											items: page.tools,
											nextCursor: page.nextCursor,
										})),
									),
							(value) => value.name === target.name,
						),
						(definition) => toolAction(definition, source),
					)
				case "resource":
					if (discovery.capabilities.resources === undefined)
						return Option.none()
					return Option.map(
						yield* findDefinition(
							(cursor) =>
								lists.resources(cursor, source, { singlePage: true }).pipe(
									Effect.map((page) => ({
										items: page.resources,
										nextCursor: page.nextCursor,
									})),
								),
							(value) => value.uri === target.name,
						),
						(definition) => resourceAction(definition, source),
					)
				case "template":
					if (discovery.capabilities.resources === undefined)
						return Option.none()
					return Option.map(
						yield* findDefinition(
							(cursor) =>
								lists.templates(cursor, source, { singlePage: true }).pipe(
									Effect.map((page) => ({
										items: page.resourceTemplates,
										nextCursor: page.nextCursor,
									})),
								),
							(value) => value.uriTemplate === target.name,
						),
						(definition) => templateAction(definition, source),
					)
				case "prompt":
					if (discovery.capabilities.prompts === undefined) return Option.none()
					return Option.map(
						yield* findDefinition(
							(cursor) =>
								lists.prompts(cursor, source, { singlePage: true }).pipe(
									Effect.map((page) => ({
										items: page.prompts,
										nextCursor: page.nextCursor,
									})),
								),
							(value) => value.name === target.name,
						),
						(definition) => promptAction(definition, source),
					)
			}
		})
		const client: Client = {
			resolve,
			key: options.key,
			discovery,
			notifications: Stream.fromPubSub(notices),
			listTools: lists.tools,
			modelTools: allTools("model"),
			listResources: lists.resources,
			listResourceTemplates: lists.templates,
			listPrompts: lists.prompts,
			readResource,

			listen: Effect.fn("Client.listen")(function* (filter) {
				yield* checked({
					action: "subscriptions/listen",
					target: "",
					arguments: filter,
					source: "host",
				})
				const subscription = yield* Effect.acquireRelease(
					invoke((signal) =>
						sdk.listen(filter, {
							signal,
						}),
					),
					(subscription) => closeResource(() => subscription.close()),
				)
				return {
					honoredFilter: subscription.honoredFilter,
					closed: Effect.tryPromise(() => subscription.closed).pipe(
						replace(() =>
							ClientError.make({
								reason: "Protocol",
								issue: "Subscription failed",
							}),
						),
					),
					close: invoke(() => subscription.close()),
				}
			}),
			close,
		}
		return client
	}).pipe(Effect.onError(() => close))
})
