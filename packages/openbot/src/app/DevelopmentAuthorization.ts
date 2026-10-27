import { Network } from "@openbot-build/protocol"
import {
	Array as Arr,
	Context,
	Crypto,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Option,
	Ref,
	Schema,
	String as Str,
	pipe,
} from "effect"
import { Base64Url } from "effect/encoding"
import {
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
	UrlParams,
} from "effect/http"
import * as ClientMetadata from "../apps/ClientMetadata.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"
import { Scenarios, type Mode } from "./DevelopmentScenarios.ts"

const origin = "https://app.development.test"
const resource = origin + "/protected"
const TokenResponse = Schema.fromJsonString(
	Schema.Struct({
		access_token: Schema.String,
		refresh_token: Schema.String,
		token_type: Schema.Literal("Bearer"),
		expires_in: Schema.Int,
		scope: Schema.String,
	}),
)
/** The query of the consent page, as the OAuth client of OpenBot sends it. */
const ConsentQuery = Schema.Struct({
	client_id: Schema.String,
	redirect_uri: Schema.String,
	resource: Schema.Literal(resource),
	code_challenge_method: Schema.Literal("S256"),
	state: Schema.NonEmptyString,
	code_challenge: Schema.NonEmptyString,
})
/** The form of a token request: a code exchange or a refresh. */
const TokenForm = Schema.Union([
	Schema.Struct({
		grant_type: Schema.Literal("authorization_code"),
		client_id: Schema.String,
		resource: Schema.Literal(resource),
		code: Schema.String,
		code_verifier: Schema.String,
		redirect_uri: Schema.String,
	}),
	Schema.Struct({
		grant_type: Schema.Literal("refresh_token"),
		client_id: Schema.String,
		resource: Schema.Literal(resource),
		refresh_token: Schema.String,
	}),
])
/** The form of a revoke request. */
const RevokeForm = Schema.Struct({
	client_id: Schema.String,
	token: Schema.optionalKey(Schema.String),
})

const invalid = (detail?: string) =>
	Network.NetworkError.make({
		reason: "Transport",
		message:
			detail === undefined
				? "Invalid simulated authorization request"
				: "Invalid simulated authorization request: " + detail,
	})

/** The fields of URL-encoded text, such as a query or a form. */
const fields = (text: string) =>
	UrlParams.toReadonlyRecord(UrlParams.fromInput(new URLSearchParams(text)))
/** A query or a form of the wrong form is an invalid request. */
const rejected = (error: Schema.SchemaError) => invalid(error.message)

export class Authorization extends Context.Service<
	Authorization,
	{
		readonly scenario: Effect.Effect<Mode>
		readonly document: (
			url: string,
		) => Effect.Effect<string, Network.NetworkError>
		readonly validToken: (token: string) => Effect.Effect<boolean>
		readonly grant: (
			body: string,
			revoke: boolean,
		) => Effect.Effect<string, Network.NetworkError>
		readonly consent: (
			query: string,
			cancel: boolean,
		) => Effect.Effect<string, Network.NetworkError>
	}
>()("@openbot-build/openbot/app/DevelopmentAuthorization/Authorization") {}

/**
 * The simulated App. It plays a service outside of OpenBot, and it knows the
 * address of OpenBot from the public origin in the platform settings. It reads
 * it each time it needs it, so a new origin works at once.
 */
export const layer = Layer.effect(
	Authorization,
	Effect.gen(function* () {
		const settings = yield* Settings
		const scenarios = yield* Scenarios
		const crypto = yield* Crypto.Crypto
		/** The public origin of OpenBot and its client metadata, as they are now. */
		const client = Platform.publicOriginOr(settings, () =>
			Network.NetworkError.make({
				reason: "Transport",
				message: "The simulated App cannot read the address of OpenBot.",
			}),
		).pipe(
			Effect.flatMap((publicOrigin) =>
				Effect.map(ClientMetadata.metadata(publicOrigin), (metadata) => ({
					publicOrigin,
					metadata,
				})),
			),
		)
		// A platform without secure random numbers or SHA-256 is broken, so these failures are defects.
		const randomId = () => crypto.randomUUIDv4().pipe(Effect.orDie)
		const challenge = (verifier: string) =>
			crypto
				.digest("SHA-256", new TextEncoder().encode(verifier))
				.pipe(Effect.map(Base64Url.encode), Effect.orDie)
		const codes = yield* Ref.make(
			HashMap.empty<
				string,
				{ readonly redirectUri: string; readonly codeChallenge: string }
			>(),
		)
		const tokens = yield* Ref.make(HashSet.empty<string>())
		const refreshes = yield* Ref.make(HashSet.empty<string>())
		return Authorization.of({
			scenario: scenarios.mode,
			document: (url) =>
				Effect.gen(function* () {
					const { publicOrigin, metadata } = yield* client
					const value =
						url === metadata.client_id
							? metadata
							: url === origin + "/.well-known/oauth-protected-resource"
								? {
										resource,
										authorization_servers: [origin],
										scopes_supported: ["documents"],
									}
								: url === origin + "/.well-known/oauth-authorization-server"
									? {
											issuer: origin,
											authorization_endpoint:
												publicOrigin + "/development/apps/authorize",
											token_endpoint: origin + "/token",
											revocation_endpoint: origin + "/revoke",
											client_id_metadata_document_supported: true,
											authorization_response_iss_parameter_supported: true,
											code_challenge_methods_supported: ["S256"],
											response_types_supported: ["code"],
											token_endpoint_auth_methods_supported: ["none"],
										}
									: undefined
					if (value === undefined) return yield* invalid()
					// The document is made here, so a failure to encode it is a defect.
					return yield* Schema.encodeEffect(
						Schema.fromJsonString(Schema.Unknown),
					)(value).pipe(Effect.orDie)
				}),
			validToken: (token) =>
				Effect.gen(function* () {
					return (
						(yield* scenarios.mode) !== "authorization-expired" &&
						HashSet.has(yield* Ref.get(tokens), token)
					)
				}),
			consent: (query, cancel) =>
				Effect.gen(function* () {
					const { metadata } = yield* client
					const input = yield* Schema.decodeUnknownEffect(ConsentQuery)(
						fields(query),
					).pipe(Effect.mapError(rejected))
					if (
						input.client_id !== metadata.client_id ||
						!Arr.contains(metadata.redirect_uris, input.redirect_uri)
					)
						return yield* invalid()
					const callback = new URL(input.redirect_uri)
					callback.searchParams.set("state", input.state)
					callback.searchParams.set("iss", origin)
					if (cancel) callback.searchParams.set("error", "access_denied")
					else {
						const code = yield* randomId()
						yield* Ref.update(codes, (values) =>
							HashMap.set(values, code, {
								redirectUri: input.redirect_uri,
								codeChallenge: input.code_challenge,
							}),
						)
						callback.searchParams.set("code", code)
					}
					return callback.href
				}),
			grant: (body, revoke) =>
				Effect.gen(function* () {
					const { metadata } = yield* client
					if (revoke) {
						const form = yield* Schema.decodeUnknownEffect(RevokeForm)(
							fields(body),
						).pipe(Effect.mapError(rejected))
						if ((yield* scenarios.mode) === "cleanup-failure")
							return yield* invalid()
						if (form.client_id !== metadata.client_id) return yield* invalid()
						const token = form.token
						if (token !== undefined)
							yield* Ref.update(refreshes, (values) =>
								HashSet.remove(values, token),
							)
						yield* Ref.set(tokens, HashSet.empty())
						return "{}"
					}
					const form = yield* Schema.decodeUnknownEffect(TokenForm)(
						fields(body),
					).pipe(Effect.mapError(rejected))
					if (
						(yield* scenarios.mode) === "authorization-expired" &&
						form.grant_type === "refresh_token"
					)
						return yield* invalid()
					if (form.client_id !== metadata.client_id) return yield* invalid()
					if (form.grant_type === "authorization_code") {
						const {
							code,
							code_verifier: verifier,
							redirect_uri: redirectUri,
						} = form
						const stored = yield* Ref.modify(
							codes,
							(values) =>
								[
									HashMap.get(values, code),
									HashMap.remove(values, code),
								] as const,
						)
						const computed = yield* challenge(verifier)
						const matches = Option.exists(
							stored,
							(stored) =>
								redirectUri === stored.redirectUri &&
								computed === stored.codeChallenge,
						)
						if (!matches) return yield* invalid()
					} else if (
						!HashSet.has(yield* Ref.get(refreshes), form.refresh_token)
					)
						return yield* invalid()
					const access = yield* randomId()
					yield* scenarios.set("available")
					const refresh = yield* randomId()
					yield* Ref.update(tokens, (values) => HashSet.add(values, access))
					yield* Ref.update(refreshes, (values) => HashSet.add(values, refresh))
					// The token response is made here, so a failure to encode it is a defect.
					return yield* Schema.encodeEffect(TokenResponse)({
						access_token: access,
						refresh_token: refresh,
						token_type: "Bearer",
						expires_in: 3600,
						scope: "documents",
					}).pipe(Effect.orDie)
				}),
		})
	}),
)
const escape = (value: string) =>
	pipe(
		value,
		Str.replaceAll("&", "&amp;"),
		Str.replaceAll('"', "&quot;"),
		Str.replaceAll("<", "&lt;"),
	)
const invalidResponse = () =>
	Effect.succeed(
		HttpServerResponse.text("The simulated authorization request is invalid.", {
			status: 400,
		}),
	)
export const layerRoutes = Layer.unwrap(
	Effect.map(Authorization, (authorization) =>
		Layer.merge(
			HttpRouter.add("GET", "/development/apps/authorize", (request) =>
				Effect.succeed(
					HttpServerResponse.text(
						`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated App authorization</title><style>*{box-sizing:border-box}html{font:100%/1.5 system-ui;color-scheme:light dark}body{margin:0;padding:clamp(1rem,4vw,3rem);overflow-wrap:anywhere}main{max-width:40rem;margin-inline:auto}h1{font-size:clamp(1.5rem,5vw,2rem);line-height:1.25}form{max-width:32rem}button{font:inherit;max-width:100%;padding:.5rem .75rem;margin:.25rem 0}</style><main><h1>Simulated App authorization</h1><p>Allow OpenBot to access simulated documents? This development flow stays inside OpenBot.</p><form method="post"><input type="hidden" name="query" value="${escape(Str.slice(1)(new URL(request.url, "https://localhost").search))}"><button name="decision" value="allow">Allow simulated access</button><button name="decision" value="cancel">Cancel</button></form></main></html>`,
						{
							contentType: "text/html",
							headers: {
								"cache-control": "no-store",
								"referrer-policy": "no-referrer",
							},
						},
					),
				),
			),
			HttpRouter.add("POST", "/development/apps/authorize", () =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const form = new URLSearchParams(yield* request.text)
					const location = yield* authorization.consent(
						form.get("query") ?? "",
						form.get("decision") !== "allow",
					)
					return HttpServerResponse.empty({
						status: 303,
						headers: { location, "cache-control": "no-store" },
					})
				}).pipe(
					Effect.catchTags({
						NetworkError: invalidResponse,
						HttpServerError: invalidResponse,
					}),
				),
			),
		),
	),
)
