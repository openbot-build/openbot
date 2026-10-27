import { Array as Arr, Effect, Layer, Schema, String as Str } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Authorization, OAuthError, predefined } from "./Authorization.ts"
import {
	OAuthMode,
	issuer,
	readScope,
	scopes,
	type Settings,
} from "./Scenarios.ts"
import { consentPage, html, page } from "./Pages.ts"

const headers = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
}
const errorResponse = (error: OAuthError) =>
	HttpServerResponse.jsonUnsafe(
		{ error: error.error, error_description: error.description },
		{
			status: error.status ?? 400,
			headers: {
				...headers,
				...(error.error === "invalid_client"
					? { "www-authenticate": 'Basic realm="Protocol Test token endpoint"' }
					: {}),
			},
		},
	)
const respond = <E, R>(
	effect: Effect.Effect<
		HttpServerResponse.HttpServerResponse,
		E | OAuthError,
		R
	>,
) =>
	effect.pipe(
		Effect.catchIf(Schema.is(OAuthError), (error) =>
			Effect.succeed(errorResponse(error)),
		),
	)

export const layer = ({ origin }: Settings) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const auth = yield* Authorization
			return Layer.mergeAll(
				Layer.empty,
				...Arr.flatMap(OAuthMode.literals, (mode) => {
					const base = issuer(origin)(mode)
					const metadata = {
						issuer: base,
						authorization_endpoint: base + "/authorize",
						token_endpoint: base + "/token",
						revocation_endpoint: base + "/revoke",
						...(mode === "dcr"
							? { registration_endpoint: base + "/register" }
							: {}),
						client_id_metadata_document_supported: mode === "cimd",
						authorization_response_iss_parameter_supported: true,
						response_types_supported: ["code"],
						grant_types_supported:
							mode === "client-credentials"
								? ["client_credentials"]
								: ["authorization_code", "refresh_token"],
						code_challenge_methods_supported: ["S256"],
						token_endpoint_auth_methods_supported: [
							"none",
							"client_secret_basic",
							"client_secret_post",
						],
						scopes_supported: scopes,
					}
					return [
						...Arr.map(
							[
								".well-known/oauth-authorization-server/oauth/" + mode,
								".well-known/openid-configuration/oauth/" + mode,
								"oauth/" + mode + "/.well-known/openid-configuration",
							],
							(path) =>
								HttpRouter.add(
									"GET",
									`/${path}`,
									Effect.succeed(
										HttpServerResponse.jsonUnsafe(metadata, {
											headers: { "cache-control": "public, max-age=60" },
										}),
									),
								),
						),
						HttpRouter.add("GET", `/oauth/${mode}/authorize`, (request) =>
							respond(
								auth
									.prepare(
										mode,
										new URL(request.originalUrl, origin).searchParams,
									)
									.pipe(
										Effect.map((consent) =>
											html(consentPage(consent))({
												headers: {
													...headers,
													"content-security-policy":
														"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
												},
											}),
										),
									),
							),
						),
						HttpRouter.add("POST", `/oauth/${mode}/token`, (request) =>
							respond(
								Effect.gen(function* () {
									const form = new URLSearchParams(yield* request.text)
									return HttpServerResponse.jsonUnsafe(
										yield* auth.exchange(
											mode,
											form,
											request.headers["authorization"],
										),
										{ headers },
									)
								}),
							),
						),
						HttpRouter.add("POST", `/oauth/${mode}/register`, (request) =>
							respond(
								Effect.gen(function* () {
									const data = yield* request.json
									return HttpServerResponse.jsonUnsafe(
										yield* auth.register(mode, data),
										{ status: 201, headers },
									)
								}),
							),
						),
						HttpRouter.add("POST", `/oauth/${mode}/revoke`, (request) =>
							respond(
								Effect.gen(function* () {
									yield* auth.revoke(
										mode,
										new URLSearchParams(yield* request.text),
										request.headers["authorization"],
									)
									return HttpServerResponse.empty({ status: 200, headers })
								}),
							),
						),
					]
				}),
				HttpRouter.add("POST", "/consent", (request) =>
					respond(
						Effect.gen(function* () {
							if (
								request.headers["origin"] !== undefined &&
								request.headers["origin"] !== origin
							)
								return HttpServerResponse.empty({ status: 403 })
							const form = new URLSearchParams(yield* request.text)
							const decision = form.get("decision")
							if (decision !== "allow" && decision !== "deny")
								return HttpServerResponse.empty({ status: 400 })
							const callback = yield* auth.decide(
								form.get("request") ?? "",
								decision === "allow",
								form.get("account") ?? "",
							)
							return HttpServerResponse.empty({
								status: 303,
								headers: { ...headers, location: callback },
							})
						}),
					),
				),
				HttpRouter.add(
					"GET",
					"/clients/public.json",
					Effect.succeed(
						HttpServerResponse.jsonUnsafe({
							client_id: origin + "/clients/public.json",
							client_name: "Protocol Test CIMD client",
							redirect_uris: Arr.filter(
								predefined(origin)[0]!.redirect_uris,
								Str.startsWith("https://"),
							),
							token_endpoint_auth_method: "none",
							grant_types: ["authorization_code", "refresh_token"],
							response_types: ["code"],
						}),
					),
				),
				HttpRouter.add(
					"GET",
					"/callback",
					Effect.succeed(
						html(
							page("Protocol Test callback")(
								"<main><h1>Protocol Test callback</h1><p>Return this complete callback URL to your trusted test client to finish authorization. The page does not exchange the code or call an App.</p></main>",
							),
						)({ headers }),
					),
				),
				HttpRouter.add(
					"GET",
					"/.well-known/oauth-protected-resource",
					Effect.succeed(
						HttpServerResponse.jsonUnsafe({
							resource: origin + "/mcp/oauth-cimd",
							authorization_servers: [issuer(origin)("cimd")],
							scopes_supported: [readScope],
							bearer_methods_supported: ["header"],
						}),
					),
				),
			)
		}),
	)
