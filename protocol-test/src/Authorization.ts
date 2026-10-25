import {
	Clock,
	Context,
	Crypto,
	Data,
	Effect,
	Layer,
	Match,
	Option,
	Redacted,
	Schema,
} from "effect"
import { Base64Url } from "effect/encoding"
import {
	Network,
	OAuthAuthorization,
	Protection,
} from "@openbot-build/protocol"
import { issuer, scopes, type OAuthMode } from "./Scenarios.ts"
import * as Temporary from "./Temporary.ts"

export class OAuthError extends Data.TaggedError("OAuthError")<{
	readonly error: string
	readonly description: string
	readonly status?: number
}> {}

const fail = (error: string, description: string, status = 400) =>
	new OAuthError({ error, description, status })
const Client = Schema.Struct({
	client_id: Schema.String,
	client_name: Schema.String,
	redirect_uris: Schema.Array(Schema.String),
	token_endpoint_auth_method: Schema.Literals([
		"none",
		"client_secret_basic",
		"client_secret_post",
	]),
	client_secret: Schema.optional(Schema.String),
})
type Client = typeof Client.Type
const Registration = Schema.Struct({
	client_name: Schema.optional(Schema.String),
	redirect_uris: Schema.NonEmptyArray(Schema.String),
	token_endpoint_auth_method: Schema.optional(
		Schema.Literals(["none", "client_secret_basic", "client_secret_post"]),
	),
	grant_types: Schema.optional(
		Schema.Array(Schema.Literals(["authorization_code", "refresh_token"])),
	),
	response_types: Schema.optional(Schema.Array(Schema.Literal("code"))),
})
interface Grant {
	readonly mode: OAuthMode
	readonly client: Client
	readonly subject: string
	readonly resource: string
	readonly scopes: ReadonlyArray<string>
	readonly family: string
}
export interface Consent {
	readonly id: string
	readonly clientName: string
	readonly resource: string
	readonly scopes: ReadonlyArray<string>
}
interface Pending {
	readonly mode: OAuthMode
	readonly client: Client
	readonly redirect: string
	readonly challenge: string
	readonly state: string | undefined
	readonly resource: string
	readonly scopes: ReadonlyArray<string>
}
interface Code extends Pending {
	readonly subject: string
}
interface Token {
	readonly grant: Grant
	readonly refresh: boolean
	readonly expiresAt: number
}
export class Authorization extends Context.Service<
	Authorization,
	{
		readonly prepare: (
			mode: OAuthMode,
			params: URLSearchParams,
		) => Effect.Effect<Consent, OAuthError>
		readonly decide: (
			id: string,
			allow: boolean,
			account: string,
		) => Effect.Effect<string, OAuthError>
		readonly register: (
			mode: OAuthMode,
			input: unknown,
		) => Effect.Effect<Schema.JsonObject, OAuthError>
		readonly exchange: (
			mode: OAuthMode,
			form: URLSearchParams,
			authorization?: string,
		) => Effect.Effect<Schema.JsonObject, OAuthError>
		readonly revoke: (
			mode: OAuthMode,
			form: URLSearchParams,
			authorization?: string,
		) => Effect.Effect<void, OAuthError>
		readonly verify: Protection.TokenVerifier["Service"]["verify"]
	}
>()("@openbot-build/protocol-test/Authorization") {}

/** These public clients and secrets are fake on purpose and are documented. */
export const predefined = (origin: string): ReadonlyArray<Client> => [
	{
		client_id: "protocol-test-public",
		client_name: "Protocol Test public client",
		redirect_uris: [
			origin + "/callback",
			"http://127.0.0.1:8765/callback",
			"http://localhost:8765/callback",
		],
		token_endpoint_auth_method: "none",
	},
	{
		client_id: "protocol-test-confidential-basic",
		client_name: "Protocol Test confidential Basic client",
		redirect_uris: [origin + "/callback"],
		token_endpoint_auth_method: "client_secret_basic",
		client_secret: "protocol-test-client-secret",
	},
	{
		client_id: "protocol-test-confidential-post",
		client_name: "Protocol Test confidential POST client",
		redirect_uris: [origin + "/callback"],
		token_endpoint_auth_method: "client_secret_post",
		client_secret: "protocol-test-client-secret",
	},
]

const redirectAllowed = (value: string): boolean => {
	if (!URL.canParse(value)) return false
	const url = new URL(value)
	return (
		url.hash === "" &&
		url.username === "" &&
		url.password === "" &&
		(url.protocol === "https:" ||
			(url.protocol === "http:" &&
				["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
	)
}

export const layer = (origin: string) =>
	Layer.effect(
		Authorization,
		Effect.gen(function* () {
			const crypto = yield* Crypto.Crypto
			const network = yield* Network.Network
			const clients = Temporary.make<Client>(86_400_000)()
			const pending = Temporary.make<Pending>(600_000)()
			const codes = Temporary.make<Code>(60_000)()
			const tokens = Temporary.make<Token>(3_600_000)()
			const families = Temporary.make<Grant>(3_600_000)()
			const protect = <A, R>(
				effect: Effect.Effect<A, Temporary.CapacityExceeded, R>,
			) =>
				effect.pipe(
					Effect.mapError(() =>
						fail(
							"temporarily_unavailable",
							"The test state is full. Try again after some entries expire.",
							503,
						),
					),
				)
			const random = () =>
				crypto.randomBytes(32).pipe(
					Effect.map(Base64Url.encode),
					Effect.mapError(() =>
						fail("server_error", "Could not create test state.", 500),
					),
				)
			const lookupClient = Effect.fn(function* (
				mode: OAuthMode,
				id: string,
				redirect?: string,
			) {
				const known = predefined(origin).find(
					(client) => client.client_id === id,
				)
				if (known !== undefined) return known
				const registered = Option.getOrUndefined(yield* clients.get(id))
				if (registered !== undefined && (mode === "dcr" || mode === "cimd"))
					return registered
				if (mode !== "cimd" || redirect === undefined)
					return yield* fail("invalid_client", "Unknown client.", 401)
				const metadata = yield* OAuthAuthorization.readClientMetadata({
					clientId: id,
					redirectUri: redirect,
				}).pipe(
					Effect.provideService(Network.Network, network),
					Effect.mapError(() =>
						fail(
							"invalid_client",
							"The client metadata or redirect URI is not valid.",
							401,
						),
					),
				)
				if (metadata.token_endpoint_auth_method !== "none")
					return yield* fail(
						"invalid_client",
						"CIMD test clients must use public PKCE.",
						401,
					)
				const client: Client = {
					client_id: id,
					client_name: metadata.client_name ?? "Synthetic CIMD client",
					redirect_uris: metadata.redirect_uris,
					token_endpoint_auth_method: "none",
				}
				yield* protect(clients.put(id, client))
				return client
			})
			const authenticate = Effect.fn(function* (
				mode: OAuthMode,
				form: URLSearchParams,
				header?: string,
				known?: Client,
			) {
				const basic =
					header?.startsWith("Basic ") === true
						? yield* Effect.try({
								try: () => {
									const decoded = Buffer.from(
										header.slice(6),
										"base64",
									).toString("utf8")
									const index = decoded.indexOf(":")
									if (index < 1) throw new Error("Invalid Basic credentials")
									return {
										id: decodeURIComponent(decoded.slice(0, index)),
										secret: decodeURIComponent(decoded.slice(index + 1)),
									}
								},
								catch: () =>
									fail(
										"invalid_client",
										"The client authentication is not valid.",
										401,
									),
							})
						: undefined
				if (header !== undefined && basic === undefined)
					return yield* fail(
						"invalid_client",
						"This client authentication method is not supported.",
						401,
					)
				const id = basic?.id ?? form.get("client_id") ?? ""
				const client = known ?? (yield* lookupClient(mode, id))
				if (
					id !== client.client_id ||
					(basic !== undefined && form.has("client_secret")) ||
					(basic !== undefined &&
						form.has("client_id") &&
						form.get("client_id") !== id)
				)
					return yield* fail(
						"invalid_client",
						"The client does not match the request.",
						401,
					)
				const valid = Match.value(client.token_endpoint_auth_method).pipe(
					Match.when(
						"none",
						() => basic === undefined && !form.has("client_secret"),
					),
					Match.when(
						"client_secret_basic",
						() => basic?.secret === client.client_secret && basic !== undefined,
					),
					Match.when(
						"client_secret_post",
						() =>
							basic === undefined &&
							form.get("client_secret") === client.client_secret,
					),
					Match.exhaustive,
				)
				if (!valid)
					return yield* fail(
						"invalid_client",
						"Client authentication failed.",
						401,
					)
				return client
			})
			const selectedScopes = (
				raw: string | null,
				allowed: ReadonlyArray<string> = scopes,
			) => {
				const selected = (raw ?? "test:read").split(/\s+/).filter(Boolean)
				return selected.length > 0 &&
					selected.every((scope) => allowed.includes(scope))
					? Effect.succeed(selected)
					: Effect.fail(
							fail("invalid_scope", "The requested scope is not allowed."),
						)
			}
			const issue = Effect.fn(function* (grant: Grant, refresh: boolean) {
				const now = yield* Clock.currentTimeMillis
				const access = yield* random()
				yield* protect(
					tokens.put(access, {
						grant,
						refresh: false,
						expiresAt: now + 300_000,
					}),
				)
				const refreshToken = refresh ? yield* random() : undefined
				if (refreshToken !== undefined)
					yield* protect(
						tokens.put(refreshToken, {
							grant,
							refresh: true,
							expiresAt: now + 3_600_000,
						}),
					)
				return {
					access_token: access,
					token_type: "Bearer",
					expires_in: 300,
					scope: grant.scopes.join(" "),
					...(refreshToken === undefined
						? {}
						: { refresh_token: refreshToken }),
				}
			})
			return Authorization.of({
				prepare: Effect.fn(function* (mode, params) {
					if (mode === "client-credentials")
						return yield* fail(
							"unsupported_response_type",
							"This scenario uses the client_credentials token grant.",
						)
					const redirect = params.get("redirect_uri") ?? ""
					const client = yield* lookupClient(
						mode,
						params.get("client_id") ?? "",
						redirect,
					)
					if (
						!redirectAllowed(redirect) ||
						!client.redirect_uris.includes(redirect)
					)
						return yield* fail(
							"invalid_request",
							"The redirect URI must exactly match a registered one.",
						)
					const target = origin + "/mcp/oauth-" + mode
					if (
						params.get("response_type") !== "code" ||
						params.get("code_challenge_method") !== "S256" ||
						!/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "") ||
						params.getAll("resource").length !== 1 ||
						params.get("resource") !== target
					)
						return yield* fail(
							"invalid_request",
							"Use response type code, S256 PKCE and the resource of this scenario.",
						)
					const selected = yield* selectedScopes(params.get("scope"))
					const id = yield* random()
					yield* protect(
						pending.put(id, {
							mode,
							client,
							redirect,
							resource: target,
							challenge: params.get("code_challenge") ?? "",
							state: params.get("state") ?? undefined,
							scopes: selected,
						}),
					)
					return {
						id,
						clientName: client.client_name,
						resource: target,
						scopes: selected,
					}
				}),
				decide: Effect.fn(function* (id, allow, account) {
					if (!["alice", "bob"].includes(account))
						return yield* fail("invalid_request", "Choose a test account.")
					const request = Option.getOrUndefined(yield* pending.take(id))
					if (request === undefined)
						return yield* fail(
							"invalid_request",
							"The consent request expired or was already used.",
						)
					const callback = new URL(request.redirect)
					if (request.state !== undefined)
						callback.searchParams.set("state", request.state)
					callback.searchParams.set("iss", issuer(origin)(request.mode))
					if (allow) {
						const code = yield* random()
						yield* protect(codes.put(code, { ...request, subject: account }))
						callback.searchParams.set("code", code)
					} else callback.searchParams.set("error", "access_denied")
					return callback.href
				}),
				register: Effect.fn(function* (mode, input) {
					if (mode !== "dcr")
						return yield* fail(
							"invalid_request",
							"Dynamic registration is available only in the DCR scenario.",
						)
					const data = yield* Schema.decodeUnknownEffect(Registration)(
						input,
					).pipe(
						Effect.mapError(() =>
							fail(
								"invalid_client_metadata",
								"The registration document is not valid.",
							),
						),
					)
					if (!data.redirect_uris.every(redirectAllowed))
						return yield* fail(
							"invalid_redirect_uri",
							"Use an HTTPS callback or a loopback HTTP callback, with no credentials or fragment.",
						)
					const method = data.token_endpoint_auth_method ?? "none"
					const id = "dcr-" + (yield* random())
					const secret = method === "none" ? undefined : yield* random()
					const client: Client = {
						client_id: id,
						client_name: data.client_name ?? "Synthetic dynamic client",
						redirect_uris: data.redirect_uris,
						token_endpoint_auth_method: method,
						...(secret === undefined ? {} : { client_secret: secret }),
					}
					yield* protect(clients.put(id, client))
					return {
						client_id: client.client_id,
						client_name: client.client_name,
						redirect_uris: client.redirect_uris,
						token_endpoint_auth_method: client.token_endpoint_auth_method,
						...(secret === undefined ? {} : { client_secret: secret }),
						grant_types: ["authorization_code", "refresh_token"],
						response_types: ["code"],
						client_id_issued_at: Math.floor(
							(yield* Clock.currentTimeMillis) / 1000,
						),
						...(secret === undefined
							? {}
							: {
									client_secret_expires_at: Math.floor(
										((yield* Clock.currentTimeMillis) + 86_400_000) / 1000,
									),
								}),
					}
				}),
				exchange: Effect.fn(function* (mode, form, header) {
					const target = origin + "/mcp/oauth-" + mode
					if (
						form.getAll("resource").length !== 1 ||
						form.get("resource") !== target
					)
						return yield* fail(
							"invalid_target",
							"The resource must match this scenario.",
						)
					return yield* Match.value(form.get("grant_type")).pipe(
						Match.when("authorization_code", () =>
							Effect.gen(function* () {
								const key = form.get("code") ?? ""
								const code = Option.getOrUndefined(yield* codes.get(key))
								if (
									code === undefined ||
									code.mode !== mode ||
									code.redirect !== form.get("redirect_uri") ||
									code.resource !== target
								)
									return yield* fail(
										"invalid_grant",
										"The code is not valid, has expired or is bound to a different request.",
									)
								yield* authenticate(mode, form, header, code.client)
								const verifier = form.get("code_verifier") ?? ""
								if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
									return yield* fail(
										"invalid_grant",
										"The PKCE verifier is not valid.",
									)
								const challenge = yield* crypto
									.digest("SHA-256", new TextEncoder().encode(verifier))
									.pipe(
										Effect.map(Base64Url.encode),
										Effect.mapError(() =>
											fail("server_error", "The PKCE check failed.", 500),
										),
									)
								if (challenge !== code.challenge)
									return yield* fail("invalid_grant", "The PKCE check failed.")
								const consumed = yield* codes.take(key)
								if (Option.isNone(consumed))
									return yield* fail(
										"invalid_grant",
										"The code was already used.",
									)
								const grant: Grant = {
									mode,
									client: code.client,
									subject: code.subject,
									resource: target,
									scopes: code.scopes,
									family: yield* random(),
								}
								yield* protect(families.put(grant.family, grant))
								return yield* issue(grant, true)
							}),
						),
						Match.when("refresh_token", () =>
							Effect.gen(function* () {
								const key = form.get("refresh_token") ?? ""
								const token = Option.getOrUndefined(yield* tokens.get(key))
								const now = yield* Clock.currentTimeMillis
								if (
									token === undefined ||
									!token.refresh ||
									token.expiresAt <= now ||
									token.grant.mode !== mode ||
									Option.isNone(yield* families.get(token.grant.family))
								)
									return yield* fail(
										"invalid_grant",
										"The refresh token is not valid, was revoked or has expired.",
									)
								yield* authenticate(mode, form, header, token.grant.client)
								const selected = form.has("scope")
									? yield* selectedScopes(form.get("scope"), token.grant.scopes)
									: token.grant.scopes
								if (Option.isNone(yield* tokens.take(key)))
									return yield* fail(
										"invalid_grant",
										"The refresh token was already used.",
									)
								return yield* issue({ ...token.grant, scopes: selected }, true)
							}),
						),
						Match.when("client_credentials", () =>
							Effect.gen(function* () {
								if (mode !== "client-credentials")
									return yield* fail(
										"unsupported_grant_type",
										"Use the client credentials scenario for this grant.",
									)
								const client = yield* authenticate(mode, form, header)
								if (client.token_endpoint_auth_method === "none")
									return yield* fail(
										"unauthorized_client",
										"The client credentials grant needs a confidential client.",
									)
								const grant: Grant = {
									mode,
									client,
									subject: client.client_id,
									resource: target,
									scopes: yield* selectedScopes(form.get("scope")),
									family: yield* random(),
								}
								yield* protect(families.put(grant.family, grant))
								return yield* issue(grant, false)
							}),
						),
						Match.orElse(() =>
							Effect.fail(
								fail(
									"unsupported_grant_type",
									"This grant type is not supported.",
								),
							),
						),
					)
				}),
				revoke: Effect.fn(function* (mode, form, header) {
					const token = Option.getOrUndefined(
						yield* tokens.get(form.get("token") ?? ""),
					)
					const client = yield* authenticate(
						mode,
						form,
						header,
						token?.grant.client,
					)
					if (
						token !== undefined &&
						token.grant.mode === mode &&
						token.grant.client.client_id === client.client_id
					)
						yield* families.remove(token.grant.family)
				}),
				verify: Effect.fn(function* (redacted) {
					const token = Option.getOrUndefined(
						yield* tokens.get(Redacted.value(redacted)),
					)
					const now = yield* Clock.currentTimeMillis
					if (
						token === undefined ||
						token.refresh ||
						Option.isNone(yield* families.get(token.grant.family))
					)
						return yield* Protection.TokenRejected.make({ reason: "Invalid" })
					if (token.expiresAt <= now)
						return yield* Protection.TokenRejected.make({ reason: "Expired" })
					return {
						subject: token.grant.subject,
						issuer: issuer(origin)(token.grant.mode),
						audiences: [token.grant.resource] as const,
						expiresAt: token.expiresAt,
						scopes: token.grant.scopes,
					}
				}),
			})
		}),
	)
