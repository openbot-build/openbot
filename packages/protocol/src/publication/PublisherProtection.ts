import {
	Clock,
	Context,
	Effect,
	Redacted,
	Schema,
	Stream,
	Match,
	Predicate,
	Record as RecordUtils,
	Array as ArrayUtils,
} from "effect"
import { McpSchema } from "effect/ai"
import { Sse } from "effect/encoding"
import {
	Headers,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import * as Authorization from "../connections/Authorization.ts"
import * as Document from "../Document.ts"
import {
	TokenRejected,
	Identity,
	TokenVerifier,
	AccessPolicy,
	type Operation,
	type Options,
} from "./Protection.ts"

const identities = new WeakMap<HttpServerRequest.HttpServerRequest, Identity>()

/** Use this only during an invocation. The key is the real HTTP request that Effect MCP keeps. */
export const currentIdentity = Effect.gen(function* () {
	yield* McpSchema.McpRequestContext
	const context = yield* Effect.context<never>()
	const request = Context.getOrUndefined(
		context,
		HttpServerRequest.HttpServerRequest,
	)
	const identity = request === undefined ? undefined : identities.get(request)
	if (identity === undefined)
		return yield* new TokenRejected({ reason: "Missing" })
	return identity
})

const Request = Schema.Struct({
	method: Schema.String,
	params: Schema.optional(Schema.JsonObject),
})

const Json = Schema.fromJsonString(Schema.JsonObject)

const targetOf = (method: string, params: Schema.JsonObject | undefined) => {
	const value = params?.[method.startsWith("resources/") ? "uri" : "name"]
	return Predicate.isString(value) ? value : undefined
}

const listFields: Readonly<Record<string, readonly [string, string]>> = {
	"tools/list": ["tools", "name"],
	"resources/list": ["resources", "uri"],
	"resources/templates/list": ["resourceTemplates", "uriTemplate"],
	"prompts/list": ["prompts", "name"],
}

const quote = (value: string) =>
	value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replace(/[\r\n]/g, "")

const challenge = (
	metadataUrl: string,
	error: "invalid_token" | "insufficient_scope",
	scopes: ReadonlyArray<string> = [],
) =>
	HttpServerResponse.empty({
		status: error === "invalid_token" ? 401 : 403,
		headers: {
			"www-authenticate": `Bearer resource_metadata="${quote(metadataUrl)}", error="${error}"${scopes.length === 0 ? "" : `, scope="${quote(scopes.join(" "))}"`}`,
			"cache-control": "no-store",
		},
	})

const filterResponse = (
	response: HttpServerResponse.HttpServerResponse,
	options: {
		readonly method: string
		readonly identity: Identity
		readonly policy: AccessPolicy["Service"]
	},
) =>
	Effect.gen(function* () {
		const fields = listFields[options.method]
		if (fields === undefined || response.status !== 200) return response
		const transform = (data: string) =>
			Effect.gen(function* () {
				const message = yield* Schema.decodeEffect(Json)(data)
				const rawResult = message["result"]
				if (!Schema.is(Schema.JsonObject)(rawResult)) return data
				const result = yield* Schema.decodeEffect(Schema.JsonObject)(rawResult)
				const entries = result[fields[0]]
				if (!ArrayUtils.isArray(entries)) return data
				const visible = yield* Effect.filter(entries, (entry) => {
					if (!Schema.is(Schema.JsonObject)(entry)) return Effect.succeed(false)
					const target = entry[fields[1]]
					return Predicate.isString(target)
						? options.policy.visible(options.identity, {
								method: options.method,
								target,
							})
						: Effect.succeed(false)
				})
				return JSON.stringify({
					...message,
					result: {
						...result,
						[fields[0]]: visible,
						cacheScope: "private",
					},
				})
			})
		const encoder = new TextEncoder()
		const optionsResponse = {
			status: response.status,
			headers: Headers.remove(response.headers, "content-length"),
			cookies: response.cookies,
		}
		const bytes = Match.value(response.body).pipe(
			Match.tag("Uint8Array", (body) => Stream.succeed(body.body)),
			Match.tag("Stream", (body) =>
				body.stream.pipe(
					Stream.mapError(
						() =>
							new Document.InvalidDocument({
								kind: "Publication",
								issue: "Could not read the protected list response",
							}),
					),
				),
			),
			Match.orElse(() => Stream.empty),
		)
		if (
			(response.headers["content-type"] ?? "").startsWith("text/event-stream")
		) {
			const body = bytes.pipe(
				Stream.decodeText(),
				Stream.pipeThroughChannel(Sse.decode()),
				Stream.mapEffect((event) =>
					transform(event.data).pipe(
						Effect.map((data) => ({
							...event,
							data,
						})),
					),
				),
				Stream.pipeThroughChannel(Sse.encode()),
				Stream.map((text) => encoder.encode(text)),
			)
			return HttpServerResponse.stream(body, optionsResponse)
		}
		const text = yield* bytes.pipe(
			Stream.decodeText(),
			Stream.runFold(
				() => "",
				(all, chunk) => all + chunk,
			),
		)
		const lines = yield* Effect.forEach(text.trimEnd().split("\n"), transform)
		return HttpServerResponse.uint8Array(
			encoder.encode(lines.join("\n") + "\n"),
			optionsResponse,
		)
	})

export const middleware = (options: Options) =>
	HttpRouter.middleware(
		Effect.gen(function* () {
			// Both capabilities are required when the protected layer is built.
			const verifier = yield* TokenVerifier
			const policy = yield* AccessPolicy
			return (
				http: Effect.Effect<
					HttpServerResponse.HttpServerResponse,
					import("effect").Types.unhandled
				>,
			) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const url = new URL(request.originalUrl, options.resource)
					if (url.pathname !== new URL(options.resource).pathname)
						return yield* http
					if (url.search !== new URL(options.resource).search)
						return HttpServerResponse.empty({ status: 404 })
					const origin = request.headers["origin"]
					if (
						origin !== undefined &&
						!(options.allowedOrigins ?? []).includes(origin)
					)
						return HttpServerResponse.empty({ status: 403 })
					const match = /^Bearer ([^\s,]+)$/i.exec(
						request.headers["authorization"] ?? "",
					)
					if (match?.[1] === undefined)
						return challenge(options.metadataUrl, "invalid_token")
					const verified = yield* Effect.result(
						verifier
							.verify(Redacted.make(match[1]))
							.pipe(Effect.flatMap(Identity.decode)),
					)
					return yield* Match.value(verified).pipe(
						Match.tagsExhaustive({
							Failure: () =>
								Effect.succeed(challenge(options.metadataUrl, "invalid_token")),
							Success: ({ success: identity }) =>
								Effect.gen(function* () {
									const now = yield* Clock.currentTimeMillis
									if (
										!options.authorizationServers.includes(identity.issuer) ||
										!identity.audiences.includes(options.resource) ||
										identity.expiresAt <= now
									)
										return challenge(options.metadataUrl, "invalid_token")
									const missing = (options.scopes ?? []).filter(
										(scope) => !identity.scopes.includes(scope),
									)
									if (missing.length !== 0)
										return challenge(
											options.metadataUrl,
											"insufficient_scope",
											missing,
										)
									const parsed = yield* Effect.result(
										request.text.pipe(
											Effect.flatMap(
												Schema.decodeEffect(Schema.fromJsonString(Request)),
											),
										),
									)
									return yield* Match.value(parsed).pipe(
										Match.tagsExhaustive({
											Failure: () => http,
											Success: ({ success: { method, params } }) =>
												Effect.gen(function* () {
													const target = targetOf(method, params)
													const args = params?.["arguments"]
													const operation: Operation = {
														method,
														...RecordUtils.filter(
															{ target },
															Predicate.isNotUndefined,
														),
														...(Schema.is(Schema.JsonObject)(args)
															? { arguments: args }
															: {}),
													}
													const access = yield* Effect.result(
														policy.check(identity, operation),
													)
													return yield* Match.value(access).pipe(
														Match.tagsExhaustive({
															Failure: ({ failure }) =>
																Effect.succeed(
																	challenge(
																		options.metadataUrl,
																		"insufficient_scope",
																		failure.scopes,
																	),
																),
															Success: () =>
																Effect.gen(function* () {
																	identities.set(request, identity)
																	const response = yield* http
																	return yield* filterResponse(response, {
																		method,
																		identity,
																		policy,
																	}).pipe(
																		Effect.map((response) =>
																			HttpServerResponse.setHeader(
																				response,
																				"cache-control",
																				"no-store",
																			),
																		),
																		Effect.catchTag(
																			["SchemaError", "InvalidDocument"],
																			() =>
																				Effect.succeed(
																					HttpServerResponse.empty({
																						status: 502,
																					}),
																				),
																		),
																	)
																}),
														}),
													)
												}),
										}),
									)
								}),
						}),
					)
				})
		}),
	)

export const layerMetadata = (options: Options) =>
	HttpRouter.add(
		"GET",
		`/${new URL(options.metadataUrl).pathname.slice(1)}`,
		(request) =>
			new URL(request.originalUrl, options.metadataUrl).search !==
			new URL(options.metadataUrl).search
				? Effect.succeed(
						HttpServerResponse.empty({
							status: 404,
						}),
					)
				: Effect.map(
						Authorization.ResourceMetadata.decode({
							resource: options.resource,
							authorization_servers: options.authorizationServers,
							bearer_methods_supported: ["header"],
							...RecordUtils.filter(
								{ scopes_supported: options.scopes },
								Predicate.isNotUndefined,
							),
						}),
						(metadata) =>
							HttpServerResponse.jsonUnsafe(metadata, {
								headers: {
									"cache-control": "public, max-age=300",
								},
							}),
					),
	)

export const validate = Effect.fn("Protection.validate")(function* (
	options: Options,
) {
	for (const url of [
		options.resource,
		options.metadataUrl,
		...options.authorizationServers,
	])
		yield* Schema.decodeEffect(Document.Link)(url)
	if (
		options.authorizationServers.length === 0 ||
		new URL(options.resource).origin !== new URL(options.metadataUrl).origin ||
		new URL(options.resource).pathname === new URL(options.metadataUrl).pathname
	)
		return yield* new Document.InvalidDocument({
			kind: "Publication",
			issue:
				"PRM must use a separate path on the protected resource origin and declare an issuer",
		})
	return options
})
