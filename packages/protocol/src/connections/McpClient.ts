import {
	HashSet,
	Array as Arr,
	Cause,
	Clock,
	Effect,
	Equal,
	Exit,
	Layer,
	Queue,
	Redacted,
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

const decodeInputs = (
	continuation: Continuation,
	responses: Schema.JsonObject,
) =>
	Effect.gen(function* () {
		const invalid = () =>
			new ClientError({
				reason: "Schema",
				issue: "The input response does not match this operation.",
			})
		const parsed = yield* Effect.tryPromise({
			try: async () => {
				const value = await Mcp.withInputRequired(
					Mcp.specTypeSchemas.CallToolResult,
				)["~standard"].validate(continuation.request)
				if (
					value.issues !== undefined ||
					!Mcp.isInputRequiredResult(value.value)
				)
					throw new Error("Invalid input association")
				return value.value
			},
			catch: invalid,
		})
		const decoded: Mcp.InputResponses = {}
		for (const [id, request] of Object.entries(parsed.inputRequests ?? {})) {
			const response = responses[id]
			decoded[id] = yield* Match.value(request).pipe(
				Match.when({ method: "elicitation/create" }, () =>
					Effect.tryPromise({
						try: async () => {
							const result =
								await Mcp.specTypeSchemas.ElicitResult["~standard"].validate(
									response,
								)
							if (result.issues !== undefined)
								throw new Error("Invalid elicitation response")
							if (
								result.value.action === "accept" &&
								request.params !== undefined &&
								"requestedSchema" in request.params
							) {
								const content = await Mcp.fromJsonSchema(
									request.params.requestedSchema as Mcp.JsonSchemaType,
								)["~standard"].validate(result.value.content)
								if (content.issues !== undefined)
									throw new Error("Invalid form content")
							}
							return result.value
						},
						catch: invalid,
					}),
				),
				Match.when({ method: "sampling/createMessage" }, () =>
					Effect.tryPromise({
						try: async () => {
							const result =
								await Mcp.specTypeSchemas.CreateMessageResult[
									"~standard"
								].validate(response)
							if (result.issues !== undefined)
								throw new Error("Invalid sampling response")
							return result.value
						},
						catch: invalid,
					}),
				),
				Match.when({ method: "roots/list" }, () =>
					Effect.tryPromise({
						try: async () => {
							const result =
								await Mcp.specTypeSchemas.ListRootsResult["~standard"].validate(
									response,
								)
							if (result.issues !== undefined)
								throw new Error("Invalid roots response")
							return result.value
						},
						catch: invalid,
					}),
				),
				Match.exhaustive,
			)
		}
		if (
			Object.keys(responses).some(
				(id) => parsed.inputRequests?.[id] === undefined,
			)
		)
			return yield* invalid()
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
		let closed = false
		const guard = Effect.fn("Client.currentConnection")(function* () {
			if (closed)
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
		const context = yield* Effect.context<never>()
		const run = Effect.runPromiseExitWith(context)
		const token = async () => {
			const exit = await run(guard())
			return Match.value(exit).pipe(
				Match.tagsExhaustive({
					Failure: (exit) => {
						throw Cause.squash(exit.cause)
					},
					Success: (exit) => exit.value.token,
				}),
			)
		}
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
				closed = true
				yield* Effect.promise(() => sdk.close())
				yield* Effect.promise(() => transport.close())
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
			Effect.tryPromise({
				try: async () => {
					const result = await Mcp.fromJsonSchema(schema as Mcp.JsonSchemaType)[
						"~standard"
					].validate(value)
					if (result.issues !== undefined) throw new Error("Schema mismatch")
				},
				catch: () =>
					new ClientError({
						reason: "Schema",
						issue: "Value does not match the service JSON Schema",
					}),
			})
		const decodeStandard = <A>(
			schema: Mcp.StandardSchemaV1<unknown, A>,
			value: unknown,
		) =>
			Effect.tryPromise({
				try: async () => {
					const parsed = await schema["~standard"].validate(value)
					if (parsed.issues !== undefined)
						throw new Error("Invalid standard result")
					return parsed.value
				},
				catch: () =>
					new ClientError({
						reason: "Schema",
						issue: "Invalid standard result",
					}),
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
				return input.source === undefined
					? result
					: {
							...result,
							tools: result.tools.filter((tool) =>
								visibility(tool, input.source ?? "host"),
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
		) =>
			Effect.gen(function* () {
				let items: ReadonlyArray<A> = []
				let cursor: string | undefined
				let seen = HashSet.empty<string>()
				do {
					const page = yield* read(cursor)
					items = Arr.appendAll(items, page.items)
					cursor = page.nextCursor
					if (cursor !== undefined) {
						if (HashSet.has(seen, cursor))
							return yield* new ClientError({
								reason: "Protocol",
								issue: "The service repeated a capability cursor",
							})
						seen = HashSet.add(seen, cursor)
					}
				} while (cursor !== undefined)
				return items
			})
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
		const finish = <A>(
			result: A | Mcp.InputRequiredResult,
			resume: (
				responses: Mcp.InputResponses,
			) => Effect.Effect<OperationResult<A>, Error>,
		): OperationResult<A> => {
			if (!Mcp.isInputRequiredResult(result))
				return { _tag: "Completed", result }
			const respond = (responses: Mcp.InputResponses) =>
				Effect.gen(function* () {
					if (
						!Equal.equals(
							HashSet.fromIterable(Object.keys(responses)),
							HashSet.fromIterable(Object.keys(result.inputRequests ?? {})),
						)
					)
						return yield* new ClientError({
							reason: "Schema",
							issue:
								"Input responses must match the request IDs of this operation",
						})
					for (const request of Object.values(result.inputRequests ?? {})) {
						if (
							(request.method === "sampling/createMessage" &&
								capabilities.sampling === undefined) ||
							(request.method === "elicitation/create" &&
								capabilities.elicitation === undefined) ||
							(request.method === "roots/list" &&
								capabilities.roots === undefined)
						)
							return yield* new ClientError({
								reason: "InputUnavailable",
								issue: "Host did not declare this input capability",
							})
					}
					return yield* resume(responses)
				})
			const handle = Effect.gen(function* () {
				if (options.inputs === undefined)
					return yield* new ClientError({
						reason: "InputUnavailable",
						issue: "Host input handler is not installed",
					})
				const responses: Mcp.InputResponses = {}
				for (const [id, request] of Object.entries(result.inputRequests ?? {}))
					responses[id] = yield* options.inputs.handle(request)
				return yield* respond(responses)
			})
			return {
				_tag: "InputRequired",
				result,
				respond,
				handle,
			}
		}
		const callTool: (
			params: Mcp.CallToolRequest["params"],
			call: CallOptions,
			continuation?: {
				readonly requestState?: string | undefined
				readonly inputResponses: Mcp.InputResponses
			},
		) => Effect.Effect<OperationResult<Mcp.CallToolResult>, Error> = Effect.fn(
			"Client.callTool",
		)(function* (
			params: Mcp.CallToolRequest["params"],
			call: CallOptions,
			continuation?: {
				readonly requestState?: string | undefined
				readonly inputResponses: Mcp.InputResponses
			},
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
					{ ...params, ...continuation },
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
			const decoded = yield* Effect.tryPromise({
				try: async () => {
					const parsed = await Mcp.withInputRequired(
						Mcp.specTypeSchemas.CallToolResult,
					)["~standard"].validate(raw)
					if (parsed.issues !== undefined)
						throw new Error("Invalid standard tool result")
					return parsed.value
				},
				catch: () =>
					new ClientError({
						reason: "Schema",
						issue: "Invalid standard tool result",
					}),
			}).pipe(
				Effect.mapError((error) =>
					call.readOnly === true
						? error
						: new OutcomeUnknown({
								key: options.key,
								target: params.name,
								cause: "Schema",
							}),
				),
			)
			if (Mcp.isInputRequiredResult(decoded))
				return finish(decoded, (inputResponses) =>
					callTool(params, call, {
						requestState: decoded.requestState,
						inputResponses,
					}),
				)
			if (decoded.isError === true)
				return yield* new ToolFailure({
					result: decoded,
				})
			if (outputSchema !== undefined)
				yield* validateDynamic(outputSchema, decoded.structuredContent).pipe(
					Effect.mapError((error) =>
						call.readOnly === true
							? error
							: new OutcomeUnknown({
									key: options.key,
									target: params.name,
									cause: "Schema",
								}),
					),
				)
			return finish(decoded, () =>
				Effect.fail(
					new ClientError({
						reason: "Protocol",
						issue: "Operation already completed",
					}),
				),
			)
		})
		const readResource: (
			params: Mcp.ReadResourceRequest["params"],
			call: CallOptions,
			continuation?: {
				readonly requestState?: string | undefined
				readonly inputResponses: Mcp.InputResponses
			},
		) => Effect.Effect<OperationResult<Mcp.ReadResourceResult>, Error> =
			Effect.fn("Client.readResource")(function* (
				params: Mcp.ReadResourceRequest["params"],
				call: CallOptions,
				continuation?: {
					readonly requestState?: string | undefined
					readonly inputResponses: Mcp.InputResponses
				},
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
						{ ...params, ...continuation },
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
					Mcp.withInputRequired(Mcp.specTypeSchemas.ReadResourceResult),
					raw,
				)
				return finish(result, (inputResponses) =>
					readResource(params, call, {
						requestState: Mcp.isInputRequiredResult(result)
							? result.requestState
							: undefined,
						inputResponses,
					}),
				)
			})
		const getPrompt: (
			params: Mcp.GetPromptRequest["params"],
			call: CallOptions,
			continuation?: {
				readonly requestState?: string | undefined
				readonly inputResponses: Mcp.InputResponses
			},
		) => Effect.Effect<OperationResult<Mcp.GetPromptResult>, Error> = Effect.fn(
			"Client.getPrompt",
		)(function* (
			params: Mcp.GetPromptRequest["params"],
			call: CallOptions,
			continuation?: {
				readonly requestState?: string | undefined
				readonly inputResponses: Mcp.InputResponses
			},
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
							...continuation,
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
			return finish(result, (inputResponses) =>
				getPrompt(params, call, {
					requestState: Mcp.isInputRequiredResult(result)
						? result.requestState
						: undefined,
					inputResponses,
				}),
			)
		})
		const client: Client = {
			resume: (continuation, responses, call) =>
				Effect.gen(function* () {
					const invalid = () =>
						new ClientError({
							reason: "Schema",
							issue: "The input response does not match this operation.",
						})
					const { parsed, decoded } = yield* decodeInputs(
						continuation,
						responses,
					)
					const resume = (
						inputResponses: Mcp.InputResponses,
					): Effect.Effect<OperationResult<unknown>, Error> =>
						Match.value(continuation.method).pipe(
							Match.when("tools/call", () =>
								Schema.decodeUnknownEffect(
									Schema.Struct({
										name: Schema.String,
										arguments: Schema.optionalKey(Schema.JsonObject),
									}),
								)(continuation.params).pipe(
									Effect.mapError(invalid),
									Effect.flatMap((params) =>
										callTool(params, call, {
											requestState: parsed.requestState,
											inputResponses,
										}),
									),
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
									Effect.mapError(invalid),
									Effect.flatMap((params) =>
										Effect.gen(function* () {
											const uri =
												"uri" in params
													? params.uri
													: yield* Effect.try({
															try: () =>
																new Mcp.UriTemplate(params.uriTemplate).expand(
																	params.values,
																),
															catch: invalid,
														})
											return yield* readResource({ uri }, call, {
												requestState: parsed.requestState,
												inputResponses,
											})
										}),
									),
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
									Effect.mapError(invalid),
									Effect.flatMap((params) =>
										getPrompt(params, call, {
											requestState: parsed.requestState,
											inputResponses,
										}),
									),
								),
							),
							Match.exhaustive,
						)
					return yield* Match.value(finish<unknown>(parsed, resume)).pipe(
						Match.tag("InputRequired", (pending) => pending.respond(decoded)),
						Match.tag("Completed", () => Effect.fail(invalid())),
						Match.exhaustive,
					)
				}),
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
					(subscription) => Effect.promise(() => subscription.close()),
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
