import {
	Array as Arr,
	Option,
	HashMap,
	Clock,
	Crypto,
	Effect,
	Equal,
	HashSet,
	Layer,
	Redacted,
	Ref,
	Schema,
	Match,
	Predicate,
	Record as Rec,
	String as Str,
	pipe,
} from "effect"
import * as Sdk from "../network/Sdk.ts"
import * as AppConnections from "./AppConnections.ts"
import * as Mcp from "@modelcontextprotocol/client"

import { Base64Url } from "effect/encoding"
import { HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/http"
import * as Document from "../Document.ts"
import * as Network from "../network/Network.ts"
import * as App from "./App.ts"
import * as Store from "./Store.ts"
import {
	AuthorizationError,
	ClientMetadata,
	ResourceMetadata,
	ServerMetadata,
	Flow,
	FlowStore,
} from "./Authorization.ts"

export const layerMemoryFlows = Layer.effect(
	FlowStore,
	Effect.gen(function* () {
		const state = yield* Ref.make(
			HashMap.empty<
				string,
				{
					readonly flow: Flow
					readonly consumed: boolean
				}
			>(),
		)
		const matches = (flow: Flow, key: Store.ConnectionKey) =>
			flow.binding.owner === key.owner &&
			flow.binding.connectionId === key.connectionId
		return FlowStore.of({
			save: Effect.fn("FlowStore.save")(function* (input) {
				const flow = yield* Flow.decode(input).pipe(
					Effect.mapError((error) =>
						Store.StoreError.make({
							reason: "Invalid",
							operation: "FlowStore.save",
							cause: error,
						}),
					),
				)
				const saved = yield* Ref.modify(state, (old) =>
					HashMap.has(old, flow.flowId)
						? ([false, old] as const)
						: ([
								true,
								HashMap.set(old, flow.flowId, {
									flow,
									consumed: false,
								}),
							] as const),
				)
				if (!saved)
					return yield* Store.StoreError.make({
						reason: "AlreadyExists",
						operation: "FlowStore.save",
					})
			}),
			get: Effect.fn("FlowStore.get")(function* (input) {
				return yield* HashMap.get(yield* Ref.get(state), input.flowId).pipe(
					Option.filter((stored) => matches(stored.flow, input.key)),
					Option.match({
						onNone: () =>
							Effect.fail(
								AuthorizationError.make({
									reason: "CallbackMismatch",
									issue: "Flow does not belong to this connection",
								}),
							),
						onSome: (stored) =>
							stored.consumed
								? Effect.fail(
										AuthorizationError.make({
											reason: "AlreadyConsumed",
											issue: "Callback has already been consumed",
										}),
									)
								: Effect.succeed(stored.flow),
					}),
				)
			}),
			consume: Effect.fn("FlowStore.consume")(function* (input) {
				const claimed = yield* Ref.modify(state, (old) =>
					HashMap.get(old, input.flowId).pipe(
						Option.filter(
							(stored) => !stored.consumed && matches(stored.flow, input.key),
						),
						Option.match({
							onNone: () => [false, old] as const,
							onSome: (stored) =>
								[
									true,
									HashMap.set(old, input.flowId, {
										...stored,
										consumed: true,
									}),
								] as const,
						}),
					),
				)
				if (!claimed)
					return yield* AuthorizationError.make({
						reason: "AlreadyConsumed",
						issue: "Callback has already been consumed",
					})
			}),
		})
	}),
)

const https = (url: string) =>
	Schema.decodeEffect(Document.Link)(url).pipe(
		Effect.mapError((error) =>
			AuthorizationError.make({
				reason: "Metadata",
				issue: "Expected an absolute HTTPS URL without credentials",
				cause: error,
			}),
		),
		Effect.filterOrFail(
			() => new URL(url).hash === "",
			() =>
				AuthorizationError.make({
					reason: "Metadata",
					issue: "OAuth URL must not contain a fragment",
				}),
		),
	)

const clientIdUrl = (clientId: string) =>
	https(clientId).pipe(
		Effect.andThen(
			Effect.try({
				try: () => Mcp.validateClientMetadataUrl(clientId),
				catch: (error) =>
					AuthorizationError.make({
						reason: "ClientMetadata",
						issue: "client_id must be a HTTPS metadata document URL",
						cause: error,
					}),
			}),
		),
	)

const sdkMetadata = (metadata: typeof ServerMetadata.Encoded) =>
	metadata as Mcp.AuthorizationServerMetadata

export const readClientMetadata = Effect.fn("Authorization.readClientMetadata")(
	function* (options: {
		readonly clientId: string
		readonly redirectUri: string
	}) {
		yield* clientIdUrl(options.clientId)
		yield* https(options.redirectUri)
		const network = yield* Network.Network
		const response = yield* network.readDocument({
			url: options.clientId,
			headers: { accept: "application/json" },
		})
		if (response.status !== 200)
			return yield* AuthorizationError.make({
				reason: "ClientMetadata",
				issue: "Client metadata document is unavailable",
			})
		const metadata = yield* Schema.decodeEffect(
			Schema.fromJsonString(ClientMetadata),
		)(response.text).pipe(
			Effect.mapError((error) =>
				AuthorizationError.make({
					reason: "ClientMetadata",
					issue: error.message,
				}),
			),
		)
		if (
			metadata.client_id !== options.clientId ||
			!metadata.redirect_uris.includes(options.redirectUri) ||
			!metadata.grant_types.includes("authorization_code") ||
			!metadata.response_types.includes("code")
		)
			return yield* AuthorizationError.make({
				reason: "ClientMetadata",
				issue:
					"client_id and registered redirect must match exactly and support the code grant",
			})
		for (const redirect of metadata.redirect_uris) yield* https(redirect)
		return metadata
	},
)

/** Serve this public document at the exact client_id URL. */
export const layerClientMetadata = (input: ClientMetadata) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const metadata = yield* ClientMetadata.decode(input)
			yield* clientIdUrl(metadata.client_id)
			for (const redirect of metadata.redirect_uris) yield* https(redirect)
			return HttpRouter.add(
				"GET",
				`/${pipe(new URL(metadata.client_id).pathname, Str.slice(1))}`,
				(request) =>
					Effect.succeed(
						new URL(request.originalUrl, metadata.client_id).search ===
							new URL(metadata.client_id).search
							? HttpServerResponse.jsonUnsafe(metadata, {
									headers: {
										"cache-control": "public, max-age=300",
									},
								})
							: HttpServerResponse.empty({
									status: 404,
								}),
					),
			)
		}),
	)

export const discoverResource = Effect.fn("Authorization.discoverResource")(
	function* (options: {
		readonly resource: string
		readonly resourceMetadataUrl?: string
	}) {
		yield* https(options.resource)
		if (options.resourceMetadataUrl !== undefined)
			yield* https(options.resourceMetadataUrl)
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const fetch = yield* Sdk.fetch({ documents: true })
				const prm = yield* Effect.tryPromise({
					try: () =>
						Mcp.discoverOAuthProtectedResourceMetadata(
							options.resource,
							{
								protocolVersion: Document.protocolVersion,
								...Rec.filter(
									{ resourceMetadataUrl: options.resourceMetadataUrl },
									Predicate.isNotUndefined,
								),
							},
							fetch,
						),
					catch: (error) =>
						Schema.is(Network.NetworkError)(error)
							? error
							: AuthorizationError.make({
									reason: "Metadata",
									issue: "Protected Resource Metadata discovery failed",
									cause: error,
								}),
				})
				const resource = yield* ResourceMetadata.decode(prm)
				if (resource.resource !== options.resource)
					return yield* AuthorizationError.make({
						reason: "Metadata",
						issue: "Protected resource metadata does not match the connection.",
					})
				return resource
			}),
		)
	},
)

export const discover = Effect.fn("Authorization.discover")(
	function* (options: {
		readonly resource: string
		readonly issuer: string
		readonly resourceMetadataUrl?: string
	}) {
		yield* https(options.issuer)
		// discoverResource checks the resource URLs and the resource match.
		const resource = yield* discoverResource(options)
		if (!resource.authorization_servers.includes(options.issuer))
			return yield* AuthorizationError.make({
				reason: "Metadata",
				issue: "Resource or trusted issuer does not match the connection",
			})
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const fetch = yield* Sdk.fetch({
					documents: true,
				})
				let metadataDocument: unknown
				// @effect-diagnostics-next-line asyncFunction:off -- The SDK discovery needs a fetch function that returns a Promise.
				const fetchMetadata: Mcp.FetchLike = async (input, init) => {
					const response = await fetch(input, init)
					if (response.ok) metadataDocument = await response.clone().json()
					return response
				}
				yield* Effect.tryPromise({
					try: () =>
						Mcp.discoverAuthorizationServerMetadata(options.issuer, {
							fetchFn: fetchMetadata,
							protocolVersion: Document.protocolVersion,
						}),
					catch: (error) =>
						Schema.is(Network.NetworkError)(error)
							? error
							: AuthorizationError.make({
									reason: "Metadata",
									issue:
										"Authorization server discovery failed or issuer did not match",
									cause: error,
								}),
				})
				// SDK 2.3.1 checks OIDC but removes OAuth extension fields such as revocation_endpoint.
				// Keep the bounded source document only after the SDK has checked its issuer.
				const metadata = yield* ServerMetadata.decode(metadataDocument)
				if (metadata.issuer !== options.issuer)
					return yield* AuthorizationError.make({
						reason: "Metadata",
						issue: "Issuer must match exactly",
					})
				if (metadata.client_id_metadata_document_supported !== true)
					return yield* AuthorizationError.make({
						reason: "CimdUnsupported",
						issue:
							"Authorization server does not support Client ID Metadata Documents",
					})
				if (
					!metadata.code_challenge_methods_supported.includes("S256") ||
					!metadata.response_types_supported.includes("code") ||
					(metadata.token_endpoint_auth_methods_supported !== undefined &&
						!metadata.token_endpoint_auth_methods_supported.includes("none"))
				)
					return yield* AuthorizationError.make({
						reason: "Metadata",
						issue:
							"Authorization server must support code, S256 and a public client",
					})
				yield* https(metadata.authorization_endpoint)
				yield* https(metadata.token_endpoint)
				if (metadata.revocation_endpoint !== undefined)
					yield* https(metadata.revocation_endpoint)
				return { resource, metadata }
			}),
		)
	},
)

/** Check a snapshot before any grant request. */
const enabled = (connection: Store.UserConnection) =>
	connection.state === "Enabled"
		? Effect.void
		: Effect.fail(
				AuthorizationError.make({
					reason: "CallbackMismatch",
					issue: "Connection is not enabled",
				}),
			)

/** Prepare a flow. The host saves it before showing its URL. */
export const prepare = Effect.fn("Authorization.prepare")(function* (options: {
	readonly connection: Store.UserConnection
	readonly issuer: string
	readonly clientId: string
	readonly redirectUri: string
	readonly scopes: ReadonlyArray<string>
	readonly resourceMetadataUrl?: string
	readonly expiresInMs?: number
}) {
	const connection = options.connection
	yield* enabled(connection)
	if (
		Arr.some(
			options.scopes,
			(scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
		) ||
		(options.expiresInMs !== undefined &&
			(!Number.isFinite(options.expiresInMs) || options.expiresInMs <= 0))
	)
		return yield* AuthorizationError.make({
			reason: "Metadata",
			issue: "Invalid scopes or flow lifetime",
		})
	yield* readClientMetadata(options)
	const { metadata } = yield* discover({
		resource: connection.endpoint,
		issuer: options.issuer,
		...Rec.filter(
			{ resourceMetadataUrl: options.resourceMetadataUrl },
			Predicate.isNotUndefined,
		),
	})
	const crypto = yield* Crypto.Crypto
	// A platform without secure random bytes or SHA-256 is a defect, not a failure a caller can act on.
	const flowId = Base64Url.encode(
		yield* crypto.randomBytes(32).pipe(Effect.orDie),
	)
	const verifier = Base64Url.encode(
		yield* crypto.randomBytes(32).pipe(Effect.orDie),
	)
	const challenge = Base64Url.encode(
		yield* crypto
			.digest("SHA-256", new TextEncoder().encode(verifier))
			.pipe(Effect.orDie),
	)
	const url = new URL(metadata.authorization_endpoint)
	for (const [name, value] of Rec.toEntries({
		response_type: "code",
		client_id: options.clientId,
		redirect_uri: options.redirectUri,
		resource: connection.endpoint,
		scope: Arr.join(options.scopes, " "),
		state: flowId,
		code_challenge: challenge,
		code_challenge_method: "S256",
	}))
		url.searchParams.set(name, value)
	const now = yield* Clock.currentTimeMillis
	const flow = Flow.make({
		flowId,
		binding: {
			owner: connection.owner,
			connectionId: connection.connectionId,
			resource: connection.endpoint,
			issuer: metadata.issuer,
		},
		clientId: options.clientId,
		redirectUri: options.redirectUri,
		scopes: options.scopes,
		verifier: Redacted.make(verifier),
		expiresAt: now + (options.expiresInMs ?? 600000),
		metadata,
		...(options.resourceMetadataUrl === undefined
			? {}
			: { resourceMetadataUrl: options.resourceMetadataUrl }),
	})
	return {
		flow,
		pending: {
			_tag: "PendingAuthorization" as const,
			flowId,
			authorizationUrl: url.href,
			key: { owner: connection.owner, connectionId: connection.connectionId },
			resource: connection.endpoint,
			issuer: metadata.issuer,
			scopes: options.scopes,
		},
	}
})

export const begin = Effect.fn("Authorization.begin")(function* (options: {
	readonly key: Store.ConnectionKey
	readonly issuer: string
	readonly clientId: string
	readonly redirectUri: string
	readonly scopes: ReadonlyArray<string>
	readonly resourceMetadataUrl?: string
	readonly expiresInMs?: number
}) {
	const connection = yield* AppConnections.usable(options.key)
	const prepared = yield* prepare({ ...options, connection })
	yield* (yield* FlowStore).save(prepared.flow)
	return prepared.pending
})

const sameScopes = (
	left: ReadonlyArray<string>,
	right: ReadonlyArray<string>,
) => Equal.equals(HashSet.fromIterable(left), HashSet.fromIterable(right))

/** A grant is private data. Durable hosts must seal it before saving it. */
export const Grant = Schema.Struct({
	credential: Store.Credential,
	resourceMetadataUrl: Schema.optionalKey(Schema.String),
})
export type Grant = typeof Grant.Type

const readTokens = Effect.fn("Authorization.readTokens")(function* (options: {
	readonly binding: Store.CredentialBinding
	readonly clientId: string
	readonly scopes: ReadonlyArray<string>
	readonly tokens: Mcp.OAuthTokens
	readonly resourceMetadataUrl?: string
}) {
	if (Str.toLowerCase(options.tokens.token_type) !== "bearer")
		return yield* AuthorizationError.make({
			reason: "GrantRejected",
			issue: "Expected bearer resource credentials",
		})
	const scopes =
		options.tokens.scope === undefined
			? options.scopes
			: pipe(options.tokens.scope, Str.split(/\s+/), Arr.filter(Str.isNonEmpty))
	if (Arr.some(scopes, (scope) => !options.scopes.includes(scope)))
		return yield* AuthorizationError.make({
			reason: "ScopeRequired",
			issue: "Token response grants more than was requested",
		})
	const now = yield* Clock.currentTimeMillis
	// The tokens come from the authorization server, so check them like other outside data.
	const credential = yield* Store.Credential.decode({
		binding: options.binding,
		accessToken: Redacted.make(options.tokens.access_token),
		...(options.tokens.refresh_token === undefined
			? {}
			: {
					refreshToken: Redacted.make(options.tokens.refresh_token),
				}),
		...(options.tokens.expires_in === undefined
			? {}
			: {
					expiresAt: now + options.tokens.expires_in * 1000,
				}),
		scopes,
		clientId: options.clientId,
	})
	return Grant.make({
		credential,
		...(options.resourceMetadataUrl === undefined
			? {}
			: { resourceMetadataUrl: options.resourceMetadataUrl }),
	})
})

/** Install a grant for an in-memory or standalone host. Durable hosts commit it with their state. */
const install = Effect.fn("Authorization.install")(function* (options: {
	readonly grant: Grant
	readonly scopes: ReadonlyArray<string>
	readonly reconnect: boolean
}) {
	const { credential, resourceMetadataUrl } = options.grant
	const { binding, scopes } = credential

	const credentials = yield* Store.CredentialStore
	const apps = yield* Store.AppStore
	const connection = yield* apps.get(binding)
	if (
		connection.state !== "Enabled" ||
		connection.endpoint !== binding.resource
	)
		return yield* AuthorizationError.make({
			reason: "CallbackMismatch",
			issue: "Connection was disabled or changed",
		})
	const reference = yield* credentials.put(credential)
	const current = yield* apps.update({
		key: binding,
		change: (old) =>
			old.state === "Enabled" && old.endpoint === binding.resource
				? {
						...old,
						authorization: {
							_tag: "Authorized",
							binding: binding,
							credentialRef: reference,
							scopes,
							...(resourceMetadataUrl === undefined
								? {}
								: { resourceMetadataUrl: resourceMetadataUrl }),
						},
					}
				: old,
	})
	yield* Match.value(current).pipe(
		Match.when(
			{
				state: "Enabled",
				endpoint: binding.resource,
				authorization: {
					_tag: "Authorized",
					credentialRef: reference,
					binding: { issuer: binding.issuer },
				},
			},
			() => Effect.void,
		),
		Match.orElse(() =>
			Effect.gen(function* () {
				yield* credentials.deleteConnection(binding)
				return yield* AuthorizationError.make({
					reason: "CallbackMismatch",
					issue: "Connection was disabled during authorization",
				})
			}),
		),
	)
	// Live clients read the credential again for each request, so a refresh of the
	// same grant does not need to close them and cut off their running calls.
	if (options.reconnect || !sameScopes(scopes, options.scopes)) {
		const active = yield* App.ConnectionScopes
		yield* active.close(binding)
	}
	return current
})

/** Validate the full callback before consuming a flow or sending its code. */
export const validateCallback = Effect.fn("Authorization.validateCallback")(
	function* (
		connection: Store.UserConnection,
		flow: Flow,
		callbackUrl: string,
	) {
		yield* enabled(connection)
		if (
			connection.owner !== flow.binding.owner ||
			connection.connectionId !== flow.binding.connectionId
		)
			return yield* AuthorizationError.make({
				reason: "CallbackMismatch",
				issue: "Authorization owner changed",
			})

		if (connection.endpoint !== flow.binding.resource)
			return yield* AuthorizationError.make({
				reason: "CallbackMismatch",
				issue: "Authorization resource changed",
			})
		const now = yield* Clock.currentTimeMillis
		if (now >= flow.expiresAt)
			return yield* AuthorizationError.make({
				reason: "FlowExpired",
				issue: "Authorization callback expired",
			})
		const callback = yield* Effect.try({
			try: () => new URL(callbackUrl),
			catch: (error) =>
				AuthorizationError.make({
					reason: "CallbackMismatch",
					issue: "Invalid callback URL",
					cause: error,
				}),
		})
		const redirect = new URL(flow.redirectUri)
		if (
			callback.origin !== redirect.origin ||
			callback.pathname !== redirect.pathname ||
			callback.hash !== "" ||
			callback.username !== "" ||
			callback.password !== "" ||
			Arr.some(
				Arr.fromIterable(redirect.searchParams),
				([key, value]) => callback.searchParams.get(key) !== value,
			) ||
			callback.searchParams.getAll("state").length !== 1 ||
			callback.searchParams.get("state") !== flow.flowId ||
			callback.searchParams.getAll("code").length !== 1 ||
			callback.searchParams.has("error") ||
			callback.searchParams.getAll("iss").length > 1
		)
			return yield* AuthorizationError.make({
				reason: "CallbackMismatch",
				issue: "Callback redirect or flow state did not match",
			})
		const code = callback.searchParams.get("code")
		if (code === null || code === "")
			return yield* AuthorizationError.make({
				reason: "CallbackMismatch",
				issue: "Callback did not contain a code",
			})
		const iss = callback.searchParams.get("iss") ?? undefined
		yield* Effect.try({
			try: () =>
				Mcp.validateAuthorizationResponseIssuer({
					iss,
					expectedIssuer: flow.binding.issuer,
					issParameterSupported:
						flow.metadata.authorization_response_iss_parameter_supported ===
						true,
				}),
			catch: (error) =>
				AuthorizationError.make({
					reason: "CallbackMismatch",
					issue: "Authorization callback issuer did not match",
					cause: error,
				}),
		})
		return { code: Redacted.make(code), iss }
	},
)

/** Exchange one code. This does not consume a flow or write a credential store. */
export const redeem = Effect.fn("Authorization.redeem")(function* (options: {
	readonly connection: Store.UserConnection
	readonly flow: Flow
	readonly callbackUrl: string
}) {
	const { flow } = options
	const { code, iss } = yield* validateCallback(
		options.connection,
		flow,
		options.callbackUrl,
	)

	const tokens = yield* Effect.scoped(
		Effect.gen(function* () {
			const fetch = yield* Sdk.fetch({
				documents: true,
			})
			return yield* Effect.tryPromise({
				try: () =>
					Mcp.exchangeAuthorization(flow.binding.issuer, {
						metadata: sdkMetadata(flow.metadata),
						clientInformation: {
							client_id: flow.clientId,
						},
						authorizationCode: Redacted.value(code),
						...Rec.filter({ iss }, Predicate.isNotUndefined),
						codeVerifier: Redacted.value(flow.verifier),
						redirectUri: flow.redirectUri,
						resource: flow.binding.resource,
						fetchFn: fetch,
					}),
				catch: (error) =>
					Schema.is(Network.NetworkError)(error)
						? error
						: AuthorizationError.make({
								reason: "GrantRejected",
								issue: "Authorization code exchange failed",
								cause: error,
							}),
			})
		}),
	)
	return yield* readTokens({
		binding: flow.binding,
		clientId: flow.clientId,
		scopes: flow.scopes,
		...(flow.resourceMetadataUrl === undefined
			? {}
			: { resourceMetadataUrl: flow.resourceMetadataUrl }),
		tokens,
	})
})

/** Call this only from the trusted callback handler of a standalone host. */
export const complete = Effect.fn("Authorization.complete")(
	function* (options: {
		readonly key: Store.ConnectionKey
		readonly flowId: string
		readonly callbackUrl: string
	}) {
		const store = yield* FlowStore
		const flow = yield* store.get(options)
		const connection = yield* AppConnections.usable(options.key)
		yield* validateCallback(connection, flow, options.callbackUrl)
		// The standalone host has no durable call log. Its atomic claim prevents two exchanges.
		return yield* Effect.uninterruptible(
			store.consume(options).pipe(
				Effect.andThen(
					redeem({ connection, flow, callbackUrl: options.callbackUrl }),
				),
				Effect.flatMap((grant) =>
					install({ grant, scopes: flow.scopes, reconnect: true }),
				),
			),
		)
	},
)

/** A refresh can rotate its token. A durable host must record this call before sending it. */
export const renew = Effect.fn("Authorization.renew")(function* (options: {
	readonly connection: Store.UserConnection
	readonly credential: Store.Credential
	readonly metadata: ServerMetadata
	readonly resourceMetadataUrl?: string
}) {
	const { connection, credential, metadata } = options
	yield* enabled(connection)
	const { clientId, refreshToken, binding } = credential
	if (
		clientId === undefined ||
		refreshToken === undefined ||
		connection.owner !== binding.owner ||
		connection.connectionId !== binding.connectionId ||
		connection.endpoint !== binding.resource ||
		metadata.issuer !== binding.issuer
	)
		return yield* AuthorizationError.make({
			reason: "RefreshUnavailable",
			issue: "Refresh grant does not match the connection",
		})

	const tokens = yield* Effect.scoped(
		Effect.gen(function* () {
			const fetch = yield* Sdk.fetch({ documents: true })
			return yield* Effect.tryPromise({
				try: () =>
					Mcp.refreshAuthorization(credential.binding.issuer, {
						metadata: sdkMetadata(metadata),
						clientInformation: {
							client_id: clientId,
						},
						refreshToken: Redacted.value(refreshToken),
						resource: connection.endpoint,
						fetchFn: fetch,
					}),
				catch: (error) =>
					Schema.is(Network.NetworkError)(error)
						? error
						: AuthorizationError.make({
								reason: "RefreshFailed",
								issue: "Refresh grant was rejected",
								cause: error,
							}),
			})
		}),
	)
	return yield* readTokens({
		binding,
		clientId,
		scopes: credential.scopes,
		...(options.resourceMetadataUrl === undefined
			? {}
			: { resourceMetadataUrl: options.resourceMetadataUrl }),
		tokens: {
			...tokens,
			refresh_token: tokens.refresh_token ?? Redacted.value(refreshToken),
		},
	})
})

export const refresh = Effect.fn("Authorization.refresh")(function* (
	key: Store.ConnectionKey,
) {
	const connection = yield* AppConnections.usable(key)
	const auth = yield* Match.value(connection.authorization).pipe(
		Match.tag("Authorized", (auth) => Effect.succeed(auth)),
		Match.orElse(() =>
			Effect.fail(
				AuthorizationError.make({
					reason: "RefreshUnavailable",
					issue: "Connection has no bound authorization",
				}),
			),
		),
	)
	if (
		connection.endpoint !== auth.binding.resource ||
		key.owner !== auth.binding.owner ||
		key.connectionId !== auth.binding.connectionId
	)
		return yield* AuthorizationError.make({
			reason: "RefreshUnavailable",
			issue: "Authorization binding no longer matches the connection",
		})
	const credentials = yield* Store.CredentialStore
	const credential = yield* credentials.get({
		binding: auth.binding,
		reference: auth.credentialRef,
	})
	const { clientId, refreshToken } = credential
	if (refreshToken === undefined || clientId === undefined)
		return yield* AuthorizationError.make({
			reason: "RefreshUnavailable",
			issue: "Connection has no usable refresh grant",
		})
	const { metadata } = yield* discover({
		resource: connection.endpoint,
		issuer: auth.binding.issuer,
		...(auth.resourceMetadataUrl === undefined
			? {}
			: { resourceMetadataUrl: auth.resourceMetadataUrl }),
	})
	// A standalone host saves a rotated grant before releasing its caller.
	return yield* Effect.uninterruptible(
		renew({
			connection,
			credential,
			metadata,
			...(auth.resourceMetadataUrl === undefined
				? {}
				: { resourceMetadataUrl: auth.resourceMetadataUrl }),
		}).pipe(
			Effect.flatMap((grant) =>
				install({ grant, scopes: credential.scopes, reconnect: false }),
			),
		),
	)
})

/** Revoke this exact grant. Repeating the same request is safe. */
export const revokeCredential = Effect.fn("Authorization.revokeCredential")(
	function* (options: {
		readonly credential: Store.Credential
		readonly metadata: ServerMetadata
	}) {
		const { credential, metadata } = options
		if (metadata.issuer !== credential.binding.issuer)
			return yield* AuthorizationError.make({
				reason: "Metadata",
				issue: "Revocation issuer does not match the grant",
			})

		const endpoint = metadata.revocation_endpoint
		const clientId = credential.clientId
		if (endpoint === undefined || clientId === undefined)
			return { _tag: "LocalOnly" } as const
		const network = yield* Network.Network
		yield* Effect.scoped(
			Effect.gen(function* () {
				const response = yield* network.execute(
					HttpClientRequest.post(endpoint).pipe(
						HttpClientRequest.bodyUrlParams({
							token: Redacted.value(
								credential.refreshToken ?? credential.accessToken,
							),
							token_type_hint:
								credential.refreshToken === undefined
									? "access_token"
									: "refresh_token",
							client_id: clientId,
						}),
					),
				)
				if (response.status !== 200)
					return yield* AuthorizationError.make({
						reason: "RevocationFailed",
						issue: "Authorization server did not confirm revocation",
					})
			}),
		).pipe(
			Effect.timeoutOrElse({
				duration: 10_000,
				orElse: () =>
					Effect.fail(
						AuthorizationError.make({
							reason: "RevocationFailed",
							issue: "Authorization revocation timed out",
						}),
					),
			}),
		)
		return { _tag: "Revoked" } as const
	},
)

export const revokeRemote = Effect.fn("Authorization.revokeRemote")(function* (
	key: Store.ConnectionKey,
) {
	const apps = yield* Store.AppStore
	const connection = yield* apps.get(key)
	const credentials = yield* Store.CredentialStore
	const local = { _tag: "LocalOnly" } as const
	return yield* Match.value(connection.authorization).pipe(
		Match.tag("Authorized", (auth) =>
			Effect.gen(function* () {
				const credential = yield* credentials.get({
					binding: auth.binding,
					reference: auth.credentialRef,
				})
				const { metadata } = yield* discover({
					resource: auth.binding.resource,
					issuer: auth.binding.issuer,
					...(auth.resourceMetadataUrl === undefined
						? {}
						: { resourceMetadataUrl: auth.resourceMetadataUrl }),
				})
				return yield* revokeCredential({ credential, metadata })
			}),
		),
		Match.orElse(() => Effect.succeed(local)),
	)
})

export const revoke = Effect.fn("Authorization.revoke")(function* (
	key: Store.ConnectionKey,
) {
	const result = yield* revokeRemote(key)
	const credentials = yield* Store.CredentialStore
	const apps = yield* Store.AppStore
	yield* credentials.deleteConnection(key)
	yield* apps.update({
		key,
		change: (old) => ({
			...old,
			authorization:
				old.authorization._tag === "Unprotected"
					? old.authorization
					: {
							_tag: "PendingAuthorization",
							resource: old.endpoint,
							scopes: [],
						},
		}),
	})
	const active = yield* App.ConnectionScopes
	yield* active.close(key)
	return result
})
