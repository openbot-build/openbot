import {
	HashSet,
	Array as Arr,
	Clock,
	Effect,
	Equal,
	Exit,
	Layer,
	Queue,
	Redacted,
	Ref,
	Scope,
	Stream,
	Match,
	Predicate,
	Record,
	Schema,
} from "effect"
import { dual } from "effect/Function"
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

/** The next request of an MRTR operation: the saved server state and the host answers. */
interface Next {
	readonly requestState?: string | undefined
	readonly inputResponses: Mcp.InputResponses
}

/**
 * Check a value with a Standard Schema from the SDK.
 * The schema is built inside the Promise, because the SDK can throw while it builds a JSON Schema validator.
 */
export const decodeStandard = <A>(
	schema: () => Mcp.StandardSchemaV1<unknown, A>,
	value: unknown,
	error: () => ClientError,
) =>
	Effect.tryPromise({
		try: async () => schema()["~standard"].validate(value),
		catch: error,
	}).pipe(
		Effect.flatMap((result) =>
			result.issues === undefined
				? Effect.succeed(result.value)
				: Effect.fail(error()),
		),
	)

const decodeInputs = (
	continuation: Continuation,
	responses: Schema.JsonObject,
) =>
	Effect.gen(function* () {
		const parsed = yield* decodeStandard(
			() => Mcp.withInputRequired(Mcp.specTypeSchemas.CallToolResult),
			continuation.request,
			() =>
				new ClientError({
					reason: "Schema",
					issue: "The input response does not match this operation.",
				}),
		).pipe(
			Effect.filterOrFail(
				Mcp.isInputRequiredResult,
				() =>
					new ClientError({
						reason: "Schema",
						issue: "The input response does not match this operation.",
					}),
			),
		)
		const requests = parsed.inputRequests ?? {}
		if (Object.keys(responses).some((id) => requests[id] === undefined))
			return yield* new ClientError({
				reason: "Schema",
				issue: "The input response does not match this operation.",
			})
		const decoded: Mcp.InputResponses = yield* Effect.all(
			Record.map(requests, (request, id) =>
				Match.value(request).pipe(
					Match.when({ method: "elicitation/create" }, (request) =>
						decodeStandard(
							() => Mcp.specTypeSchemas.ElicitResult,
							responses[id],
							() =>
								new ClientError({
									reason: "Schema",
									issue: "The input response does not match this operation.",
								}),
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
											() =>
												new ClientError({
													reason: "Schema",
													issue:
														"The input response does not match this operation.",
												}),
										)
									: Effect.void
							}),
						),
					),
					Match.when({ method: "sampling/createMessage" }, () =>
						decodeStandard(
							() => Mcp.specTypeSchemas.CreateMessageResult,
							responses[id],
							() =>
								new ClientError({
									reason: "Schema",
									issue: "The input response does not match this operation.",
								}),
						),
					),
					Match.when({ method: "roots/list" }, () =>
						decodeStandard(
							() => Mcp.specTypeSchemas.ListRootsResult,
							responses[id],
							() =>
								new ClientError({
									reason: "Schema",
									issue: "The input response does not match this operation.",
								}),
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
		return yield* new PermissionDenied({
			action: "connect",
			target: initial.endpoint,
		})
	const scope = yield* Scope.fork(yield* Effect.scope)
	return yield* Effect.gen(function* () {
		yield* active.register({ key: options.key, scope })
		const closed = yield* Ref.make(false)
		const guard = Effect.fn("Client.currentConnection")(function* () {
			if (yield* Ref.get(closed))
				return yield* new ClientError({
					reason: "Closed",
					issue: "Connection Scope is closed",
				})
			const connection = yield* store.get(options.key)
			if (connection.state !== "Enabled")
				return yield* new App.AppError({
					reason: "Unavailable",
				})
			if (
				connection.endpoint !== initial.endpoint ||
				connection.cardUrl !== initial.cardUrl
			)
				return yield* new ClientError({
					reason: "ConnectionChanged",
					issue: "Open a client after explicit revalidation",
				})
			return yield* Match.value(connection.authorization).pipe(
				Match.tag("Unprotected", () =>
					Effect.succeed({ connection, token: undefined }),
				),
				Match.tag("Authorized", (auth) =>
					Effect.gen(function* () {
						if (
							auth.binding.owner !== connection.owner ||
							auth.binding.connectionId !== connection.connectionId ||
							auth.binding.resource !== connection.endpoint
						)
							return yield* new ClientError({
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
							return yield* new AuthorizationRequired({
								reason: "Expired",
								scopes: credential.scopes,
							})
						return {
							connection,
							token: Redacted.value(credential.accessToken),
						}
					}),
				),
				Match.tag("ScopeRequired", (auth) =>
					Effect.fail(
						new AuthorizationRequired({
							reason: "InsufficientScope",
							scopes: auth.scopes,
						}),
					),
				),
				Match.orElse((auth) =>
					Effect.fail(
						new AuthorizationRequired({
							reason: "Pending",
							scopes: Predicate.hasProperty(auth, "scopes") ? auth.scopes : [],
						}),
					),
				),
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
		// The SDK auth provider is a Promise callback. When the guard fails, the
		// Promise rejects with the typed error, the SDK stops the request, and
		// `mapError` below gets the same typed error back.
		const run = Effect.runPromiseWith(yield* Effect.context<never>())
		const token = () =>
			run(guard().pipe(Effect.map((current) => current.token)))
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
		const fetch: Mcp.FetchLike = async (input, init) => {
			const response = await transportFetch(input, init)
			if (response.status === 401 || response.status === 403)
				challenge = Mcp.extractWWWAuthenticateParams(response)
			return response
		}
		const queue = yield* Queue.make<Mcp.Notification>()
		let dirty = HashSet.empty<string>()
		const capabilities = {
			...options.capabilities,
			...options.inputs?.capabilities,
		}
		const sdk = new Mcp.Client(options.clientInfo, {
			versionNegotiation: {
				mode: { pin: Document.protocolVersion },
				probe: { maxRetries: 0 },
			},
			inputRequired: { autoFulfill: false },
			enforceStrictCapabilities: true,
			capabilities,
			cachePartition: JSON.stringify([
				initial.owner,
				initial.connectionId,
				initial.endpoint,
			]),
		})
		const notify = async (notification: Mcp.Notification) => {
			Queue.offerUnsafe(queue, notification)
		}
		sdk.fallbackNotificationHandler = notify
		sdk.setNotificationHandler(
			"notifications/tools/list_changed",
			async (notification) => {
				dirty = HashSet.add(dirty, "tools")
				await notify(notification)
			},
		)
		sdk.setNotificationHandler(
			"notifications/resources/list_changed",
			async (notification) => {
				dirty = HashSet.add(dirty, "resources")
				dirty = HashSet.add(dirty, "templates")
				await notify(notification)
			},
		)
		sdk.setNotificationHandler(
			"notifications/prompts/list_changed",
			async (notification) => {
				dirty = HashSet.add(dirty, "prompts")
				await notify(notification)
			},
		)
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
				yield* Queue.shutdown(queue)
			}),
		)
		const mapError = (error: unknown): Error => {
			if (
				error instanceof ClientError ||
				error instanceof AuthorizationRequired ||
				error instanceof Store.StoreError ||
				error instanceof App.AppError
			)
				return error
			if (error instanceof Mcp.UnauthorizedError)
				return new AuthorizationRequired({
					reason: challenge?.error === "invalid_token" ? "Expired" : "Pending",
					scopes: challenge?.scope?.split(/\s+/).filter(Boolean) ?? [],
					resourceMetadataUrl: challenge?.resourceMetadataUrl?.href,
				})
			if (error instanceof Mcp.InsufficientScopeError)
				return new AuthorizationRequired({
					reason: "InsufficientScope",
					scopes: error.requiredScope?.split(/\s+/).filter(Boolean) ?? [],
					resourceMetadataUrl: error.resourceMetadataUrl?.href,
				})
			if (error instanceof Mcp.ProtocolError)
				return new ClientError({
					reason: "Protocol",
					issue: error.message,
				})
			if (
				error instanceof Mcp.SdkError &&
				error.code !== Mcp.SdkErrorCode.RequestTimeout
			)
				return new ClientError({
					reason:
						error.code === Mcp.SdkErrorCode.InvalidResult
							? "Schema"
							: "Protocol",
					issue: error.code,
				})
			return new ClientError({
				reason: "Network",
				issue: "MCP request did not return a valid response",
			})
		}
		const invoke = <A>(request: (signal: AbortSignal) => Promise<A>) =>
			Effect.tryPromise({ try: request, catch: mapError })
		yield* invoke((signal) => sdk.connect(transport, { signal }))
		const discovery = sdk.getDiscoverResult()
		if (discovery === undefined)
			return yield* new ClientError({
				reason: "Protocol",
				issue: "Missing real-time server discovery",
			})
		const requireCapability = (name: "tools" | "resources" | "prompts") =>
			sdk.getServerCapabilities()?.[name] === undefined
				? Effect.fail(
						new ClientError({
							reason: "UnsupportedCapability",
							issue: `Server does not advertise ${name}`,
						}),
					)
				: Effect.void
		const validateMeta = (meta: Mcp.RequestMetaObject | undefined) =>
			meta !== undefined &&
			Object.keys(meta).some((key) => HashSet.has(reservedMeta, key))
				? Effect.fail(
						new ClientError({
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
					new ClientError({
						reason: "Schema",
						issue: "Value does not match the service JSON Schema",
					}),
			)
		const invalidResult = () =>
			new ClientError({
				reason: "Schema",
				issue: "Invalid standard result",
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
									cacheMode:
										input.refresh === true || HashSet.has(dirty, "tools")
											? "refresh"
											: "use",
								},
							),
				)
				dirty = HashSet.remove(dirty, "tools")
				const source = input.source
				return source === undefined
					? result
					: {
							...result,
							tools: result.tools.filter((tool) => visibility(tool, source)),
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
								cacheMode: HashSet.has(dirty, "resources") ? "refresh" : "use",
							}),
				)
				dirty = HashSet.remove(dirty, "resources")
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
								{
									signal,
									cacheMode: HashSet.has(dirty, "templates")
										? "refresh"
										: "use",
								},
							),
				)
				dirty = HashSet.remove(dirty, "templates")
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
								cacheMode: HashSet.has(dirty, "prompts") ? "refresh" : "use",
							}),
				)
				dirty = HashSet.remove(dirty, "prompts")
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
				items: ReadonlyArray<A>,
			): Effect.Effect<ReadonlyArray<A>, Error> =>
				read(cursor).pipe(
					Effect.flatMap((page) => {
						const all = Arr.appendAll(items, page.items)
						if (page.nextCursor === undefined) return Effect.succeed(all)
						if (HashSet.has(seen, page.nextCursor))
							return Effect.fail(
								new ClientError({
									reason: "Protocol",
									issue: "The service repeated a capability cursor",
								}),
							)
						return next(
							page.nextCursor,
							HashSet.add(seen, page.nextCursor),
							all,
						)
					}),
				)
			return next(undefined, HashSet.empty(), [])
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
				if (
					!Equal.equals(
						HashSet.fromIterable(Object.keys(responses)),
						HashSet.fromIterable(Object.keys(requests)),
					)
				)
					return yield* new ClientError({
						reason: "Schema",
						issue:
							"Input responses must match the request IDs of this operation",
					})
				if (
					Object.values(requests).some(
						(request) =>
							(request.method === "sampling/createMessage" &&
								capabilities.sampling === undefined) ||
							(request.method === "elicitation/create" &&
								capabilities.elicitation === undefined) ||
							(request.method === "roots/list" &&
								capabilities.roots === undefined),
					)
				)
					return yield* new ClientError({
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
							new ClientError({
								reason: "InputUnavailable",
								issue: "Host input handler is not installed",
							}),
						)
					: Effect.all(
							Record.map(requests, (request) => inputs.handle(request)),
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
			const tool = (yield* allTools()).find((tool) => tool.name === params.name)
			if (tool === undefined || !visibility(tool, call.source))
				return yield* new PermissionDenied({
					action: "tools/call",
					target: params.name,
				})
			yield* validateDynamic(tool.inputSchema, params.arguments ?? {})
			// Manual MRTR must reach the host before the final structured output is checked.
			// The SDK still handles parameter headers with the real input schema.
			const { outputSchema, ...requestTool } = tool
			const raw = yield* invoke((signal) =>
				sdk.callTool(
					{ ...params, ...next },
					{
						signal,
						...Record.filter(
							{ timeout: call.timeoutMs },
							Predicate.isNotUndefined,
						),
						...Record.filter(
							{ onprogress: call.onprogress },
							Predicate.isNotUndefined,
						),
						allowInputRequired: true,
						toolDefinition: requestTool,
					},
				),
			).pipe(
				Effect.catchIf(
					(error): error is ClientError =>
						error instanceof ClientError &&
						["Network", "Protocol", "Closed"].includes(error.reason) &&
						call.readOnly !== true,
					(error) =>
						Effect.fail(
							new OutcomeUnknown({
								key: options.key,
								target: params.name,
								cause:
									error.reason === "Network"
										? "Network"
										: error.reason === "Closed"
											? "Closed"
											: "Protocol",
							}),
						),
				),
			)
			// A bad result of a call that may write leaves the remote outcome unknown.
			const writeOutcome = (error: ClientError) =>
				call.readOnly === true
					? error
					: new OutcomeUnknown({
							key: options.key,
							target: params.name,
							cause: "Schema",
						})
			const decoded = yield* decodeStandard(
				() => Mcp.withInputRequired(Mcp.specTypeSchemas.CallToolResult),
				raw,
				() =>
					new ClientError({
						reason: "Schema",
						issue: "Invalid standard tool result",
					}),
			).pipe(Effect.mapError(writeOutcome))
			if (Mcp.isInputRequiredResult(decoded))
				return inputRequired(decoded, (next) => callTool(params, call, next))
			if (decoded.isError === true)
				return yield* new ToolFailure({
					result: decoded,
				})
			if (outputSchema !== undefined)
				yield* validateDynamic(outputSchema, decoded.structuredContent).pipe(
					Effect.mapError(writeOutcome),
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
						{
							signal,
							...Record.filter(
								{ timeout: call.timeoutMs },
								Predicate.isNotUndefined,
							),
							...Record.filter(
								{ onprogress: call.onprogress },
								Predicate.isNotUndefined,
							),
							allowInputRequired: true,
						},
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
					{
						signal,
						...Record.filter(
							{ timeout: call.timeoutMs },
							Predicate.isNotUndefined,
						),
						...Record.filter(
							{ onprogress: call.onprogress },
							Predicate.isNotUndefined,
						),
						allowInputRequired: true,
					},
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
									Effect.mapError(
										() =>
											new ClientError({
												reason: "Schema",
												issue:
													"The input response does not match this operation.",
											}),
									),
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
									Effect.mapError(
										() =>
											new ClientError({
												reason: "Schema",
												issue:
													"The input response does not match this operation.",
											}),
									),
									Effect.flatMap((params) =>
										"uri" in params
											? Effect.succeed(params.uri)
											: Effect.try({
													try: () =>
														new Mcp.UriTemplate(params.uriTemplate).expand(
															params.values,
														),
													catch: () =>
														new ClientError({
															reason: "Schema",
															issue:
																"The input response does not match this operation.",
														}),
												}),
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
									Effect.mapError(
										() =>
											new ClientError({
												reason: "Schema",
												issue:
													"The input response does not match this operation.",
											}),
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
			notifications: Stream.fromQueue(queue),
			listTools: lists.tools,
			modelTools: allTools("model"),
			listResources: lists.resources,
			listResourceTemplates: lists.templates,
			listPrompts: lists.prompts,
			callTool,
			readResource,
			getPrompt,
			readTemplate: Effect.fn("Client.readTemplate")(function* (input) {
				const template = (yield* allPages((cursor) =>
					lists.templates(cursor, "host", { singlePage: true }).pipe(
						Effect.map((page) => ({
							items: page.resourceTemplates,
							nextCursor: page.nextCursor,
						})),
					),
				)).find((template) => template.uriTemplate === input.template)
				if (template === undefined)
					return yield* new ClientError({
						reason: "Schema",
						issue: "Unknown resource template",
					})
				const uri = yield* Effect.try({
					try: () =>
						new Mcp.UriTemplate(template.uriTemplate).expand(input.values),
					catch: () =>
						new ClientError({
							reason: "Schema",
							issue: "Invalid resource template arguments",
						}),
				})
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
					closed: Effect.tryPromise({
						try: () => subscription.closed,
						catch: () =>
							new ClientError({
								reason: "Protocol",
								issue: "Subscription failed",
							}),
					}),
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
