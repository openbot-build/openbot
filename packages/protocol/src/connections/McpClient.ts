import {
	HashSet,
	Array as Arr,
	Cause,
	Clock,
	Effect,
	Equal,
	Exit,
	Layer,
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
import * as AppConnections from "./AppConnections.ts"
import * as Sdk from "../network/Sdk.ts"
import * as Mcp from "@modelcontextprotocol/client"

import * as Document from "../Document.ts"
import * as Network from "../network/Network.ts"
import * as App from "./App.ts"
import * as Store from "./Store.ts"
import {
	PermissionDenied,
	ClientError,
	AuthorizationRequired,
	OutcomeUnknown,
	ToolFailure,
	InvocationPolicy,
	type Invocation,
	type Error,
	type CallOptions,
	type InputHandler,
	type Continuation,
	type OperationResult,
	type Client,
} from "./Client.ts"

/**
 * Close an SDK object as best-effort cleanup.
 * A failed close only logs a warning, so the next cleanup steps still run.
 */
const closeQuietly = (name: string, close: () => Promise<void>) =>
	Effect.tryPromise(close).pipe(
		Effect.catch((error) =>
			Effect.logWarning(`Could not close the MCP ${name}`, error),
		),
	)

/**
 * Fails with a `ClientError` in place of the failure of `self`.
 * `ClientError` has no field for the cause, so this logs the failure first.
 */
const replace =
	(message: string, error: LazyArg<ClientError>) =>
	<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, ClientError, R> =>
		self.pipe(
			Effect.tapError((failure) =>
				Effect.logWarning(message, Cause.fail(failure)),
			),
			Effect.mapError(error),
		)

export const layerPolicy = (
	check: (invocation: Invocation) => Effect.Effect<void, PermissionDenied>,
) => Layer.succeed(InvocationPolicy, { check })

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
 * `ClientError` has no field for the cause, so this logs the thrown error or the schema issues first.
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
		Effect.catch((cause) =>
			Effect.logWarning(
				"An MCP value does not match its schema",
				Cause.fail(cause),
			).pipe(Effect.andThen(Effect.fail(error(cause)))),
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

export const open = Effect.fn("Client.open")(function* (options: {
	readonly key: Store.ConnectionKey
	readonly clientInfo: Mcp.Implementation
	readonly capabilities?: Mcp.ClientCapabilities
	readonly inputs?: InputHandler
	readonly eagerLists?: boolean
}) {
	const store = yield* Store.AppStore
	const credentials = yield* Store.CredentialStore
	const policy = yield* InvocationPolicy
	const active = yield* App.ConnectionScopes
	const network = yield* Network.Network
	const initial = yield* AppConnections.usable(options.key)
	if (
		network.identity.scope === "user" &&
		network.identity.owner !== initial.owner
	)
		return yield* PermissionDenied.make({
			action: "connect",
			target: initial.endpoint,
		})
	const scope = yield* Scope.fork(yield* Effect.scope)
	return yield* Effect.gen(function* () {
		yield* active.register({ key: options.key, scope })
		const closed = yield* Ref.make(false)
		const guard = Effect.fn("Client.currentConnection")(function* () {
			if (yield* Ref.get(closed))
				return yield* ClientError.make({
					reason: "Closed",
					issue: "Connection Scope is closed",
				})
			const connection = yield* store.get(options.key)
			if (connection.state !== "Enabled")
				return yield* App.AppError.make({
					reason: "Unavailable",
				})
			if (
				connection.endpoint !== initial.endpoint ||
				connection.cardUrl !== initial.cardUrl
			)
				return yield* ClientError.make({
					reason: "ConnectionChanged",
					issue: "Open a client after explicit revalidation",
				})
			return yield* Match.value(connection.authorization).pipe(
				Match.tag("Unprotected", () =>
					Effect.succeed({
						connection,
						token: Option.none<Redacted.Redacted<string>>(),
					}),
				),
				Match.tag("Authorized", (auth) =>
					Effect.gen(function* () {
						if (
							auth.binding.owner !== connection.owner ||
							auth.binding.connectionId !== connection.connectionId ||
							auth.binding.resource !== connection.endpoint
						)
							return yield* ClientError.make({
								reason: "ConnectionChanged",
								issue: "Credential binding no longer matches this connection",
							})
						const credential = yield* credentials.get({
							binding: auth.binding,
							reference: auth.credentialRef,
						})
						const now = yield* Clock.currentTimeMillis
						if (
							credential.expiresAt !== undefined &&
							credential.expiresAt <= now
						)
							return yield* AuthorizationRequired.make({
								reason: "Expired",
								scopes: credential.scopes,
							})
						return {
							connection,
							token: Option.some(credential.accessToken),
						}
					}),
				),
				Match.tag("ScopeRequired", (auth) =>
					Effect.fail(
						AuthorizationRequired.make({
							reason: "InsufficientScope",
							scopes: auth.scopes,
						}),
					),
				),
				Match.tag("PendingAuthorization", (auth) =>
					Effect.fail(
						AuthorizationRequired.make({
							reason: "Pending",
							scopes: auth.scopes,
						}),
					),
				),
				Match.tag("AuthorizationFailed", () =>
					Effect.fail(
						AuthorizationRequired.make({
							reason: "Pending",
							scopes: [],
						}),
					),
				),
				Match.exhaustive,
			)
		})
		yield* guard()
		const checked = Effect.fn("Client.check")(function* (
			invocation: Omit<Invocation, "connection">,
		) {
			const { connection } = yield* guard()
			yield* policy.check({ ...invocation, connection })
			return connection
		})
		// The SDK auth provider and notification handlers are Promise callbacks.
		// When the guard fails, the Promise rejects with the typed error, the SDK
		// stops the request, and `mapError` below gets the same typed error back.
		const run = Effect.runPromiseWith(yield* Effect.context<never>())
		const token = () =>
			run(
				guard().pipe(
					Effect.map((current) =>
						Option.getOrUndefined(Option.map(current.token, Redacted.value)),
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
			initial.owner,
			initial.connectionId,
			initial.endpoint,
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
		const transport = new Sdk.HttpTransport(new URL(initial.endpoint), {
			fetch,
			authProvider: { token },
			requestInit: {
				headers: Redacted.value(initial.headers),
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
				yield* closeQuietly("client", () => sdk.close())
				yield* closeQuietly("transport", () => transport.close())
				yield* PubSub.shutdown(notices)
			}),
		)
		// `ClientError` has no field for the cause, so this logs the failure first.
		const logged = (error: unknown, replacement: ClientError) =>
			Effect.logWarning("The MCP request failed", Cause.fail(error)).pipe(
				Effect.andThen(Effect.fail(replacement)),
			)
		const mapError = (error: unknown): Effect.Effect<never, Error> => {
			if (
				Schema.is(ClientError)(error) ||
				Schema.is(AuthorizationRequired)(error) ||
				Schema.is(Store.StoreError)(error) ||
				Schema.is(App.AppError)(error)
			)
				return Effect.fail(error)
			if (error instanceof Mcp.UnauthorizedError)
				return Effect.fail(
					AuthorizationRequired.make({
						reason:
							challenge?.error === "invalid_token" ? "Expired" : "Pending",
						scopes: scopeList(challenge?.scope),
						resourceMetadataUrl: challenge?.resourceMetadataUrl?.href,
					}),
				)
			if (error instanceof Mcp.InsufficientScopeError)
				return Effect.fail(
					AuthorizationRequired.make({
						reason: "InsufficientScope",
						scopes: scopeList(error.requiredScope),
						resourceMetadataUrl: error.resourceMetadataUrl?.href,
					}),
				)
			if (error instanceof Mcp.ProtocolError)
				return Effect.fail(
					ClientError.make({
						reason: "Protocol",
						issue: error.message,
					}),
				)
			// The messages of a NetworkError are fixed texts of this package.
			if (Schema.is(Network.NetworkError)(error))
				return Effect.fail(
					ClientError.make({
						reason: "Network",
						issue: error.message,
					}),
				)
			// The message of an SdkError can hold the raw body of the server,
			// so `issue` keeps only the code, and the log keeps the full error.
			if (
				error instanceof Mcp.SdkError &&
				error.code !== Mcp.SdkErrorCode.RequestTimeout
			)
				return logged(
					error,
					ClientError.make({
						reason:
							error.code === Mcp.SdkErrorCode.InvalidResult
								? "Schema"
								: "Protocol",
						issue: error.code,
					}),
				)
			return logged(
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
			params: Mcp.CallToolRequest["params"],
			call: CallOptions,
			next?: Next,
		) => Effect.Effect<OperationResult<Mcp.CallToolResult>, Error> = Effect.fn(
			"Client.callTool",
		)(function* (
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
			const visible = pipe(
				Arr.findFirst(yield* allTools(), (tool) => tool.name === params.name),
				Option.filter((tool) => visibility(tool, call.source)),
			)
			if (Option.isNone(visible))
				return yield* PermissionDenied.make({
					action: "tools/call",
					target: params.name,
				})
			const tool = visible.value
			yield* validateDynamic(tool.inputSchema, params.arguments ?? {})
			// Manual MRTR must reach the host before the final structured output is checked.
			// The SDK still handles parameter headers with the real input schema.
			const { outputSchema, ...requestTool } = tool
			// `OutcomeUnknown` keeps only a fixed cause name, so this logs the full error first.
			const unknownOutcome = (
				error: ClientError,
				cause: OutcomeUnknown["cause"],
			) =>
				Effect.logWarning(
					"The MCP tool call has an unknown outcome",
					Cause.fail(error),
				).pipe(
					Effect.annotateLogs({ tool: params.name }),
					Effect.andThen(
						Effect.fail(
							OutcomeUnknown.make({
								key: options.key,
								target: params.name,
								cause,
							}),
						),
					),
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
				return inputRequired(decoded, (next) => callTool(params, call, next))
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
		const client: Client = {
			resume: Effect.fn("Client.resume")(
				function* (continuation, responses, call) {
					const { parsed, decoded } = yield* decodeInputs(
						continuation,
						responses,
					)
					const resume = (
						next: Next,
					): Effect.Effect<OperationResult<unknown>, Error> =>
						Match.value(continuation.method).pipe(
							Match.when("tools/call", () =>
								Schema.decodeUnknownEffect(
									Schema.Struct({
										name: Schema.String,
										arguments: Schema.optionalKey(Schema.JsonObject),
									}),
								)(continuation.params).pipe(
									replace("The saved tool call is not valid", inputMismatch),
									Effect.flatMap((params) => callTool(params, call, next)),
								),
							),
							Match.when("resources/read", () =>
								Schema.decodeUnknownEffect(
									Schema.Union([
										Schema.Struct({ uri: Schema.String }),
										Schema.Struct({
											uriTemplate: Schema.String,
											values: Schema.Record(Schema.String, Schema.String),
										}),
									]),
								)(continuation.params).pipe(
									replace(
										"The saved resource read is not valid",
										inputMismatch,
									),
									Effect.flatMap((params) =>
										"uri" in params
											? Effect.succeed(params.uri)
											: Effect.try(() =>
													new Mcp.UriTemplate(params.uriTemplate).expand(
														params.values,
													),
												).pipe(
													replace(
														"Could not expand the saved resource template",
														inputMismatch,
													),
												),
									),
									Effect.flatMap((uri) => readResource({ uri }, call, next)),
								),
							),
							Match.when("prompts/get", () =>
								Schema.decodeUnknownEffect(
									Schema.Struct({
										name: Schema.String,
										arguments: Schema.optionalKey(
											Schema.Record(Schema.String, Schema.String),
										),
									}),
								)(continuation.params).pipe(
									replace(
										"The saved prompt request is not valid",
										inputMismatch,
									),
									Effect.flatMap((params) => getPrompt(params, call, next)),
								),
							),
							Match.exhaustive,
						)
					return yield* inputRequired(parsed, resume).respond(decoded)
				},
			),
			key: options.key,
			discovery,
			notifications: Stream.fromPubSub(notices),
			listTools: lists.tools,
			modelTools: allTools("model"),
			listResources: lists.resources,
			listResourceTemplates: lists.templates,
			listPrompts: lists.prompts,
			callTool,
			readResource,
			getPrompt,
			readTemplate: Effect.fn("Client.readTemplate")(function* (input) {
				const template = Arr.findFirst(
					yield* allPages((cursor) =>
						lists.templates(cursor, "host", { singlePage: true }).pipe(
							Effect.map((page) => ({
								items: page.resourceTemplates,
								nextCursor: page.nextCursor,
							})),
						),
					),
					(template) => template.uriTemplate === input.template,
				)
				if (Option.isNone(template))
					return yield* ClientError.make({
						reason: "Schema",
						issue: "Unknown resource template",
					})
				const uri = yield* Effect.try(() =>
					new Mcp.UriTemplate(template.value.uriTemplate).expand(input.values),
				).pipe(
					replace("Could not expand the resource template", () =>
						ClientError.make({
							reason: "Schema",
							issue: "Invalid resource template arguments",
						}),
					),
				)
				return yield* readResource({ uri }, { source: input.source })
			}),
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
					(subscription) =>
						closeQuietly("subscription", () => subscription.close()),
				)
				return {
					honoredFilter: subscription.honoredFilter,
					closed: Effect.tryPromise(() => subscription.closed).pipe(
						replace("The MCP subscription failed", () =>
							ClientError.make({
								reason: "Protocol",
								issue: "Subscription failed",
							}),
						),
					),
					close: invoke(() => subscription.close()),
				}
			}),
			close: Scope.close(scope, Exit.void),
		}
		// Read only the lists advertised by the live discovery response.
		if (options.eagerLists !== false) {
			if (sdk.getServerCapabilities()?.tools !== undefined) yield* lists.tools()
			if (sdk.getServerCapabilities()?.resources !== undefined) {
				yield* lists.resources()
				yield* lists.templates()
			}
			if (sdk.getServerCapabilities()?.prompts !== undefined)
				yield* lists.prompts()
		}
		return client
	}).pipe(Effect.onError(() => Scope.close(scope, Exit.void)))
})
