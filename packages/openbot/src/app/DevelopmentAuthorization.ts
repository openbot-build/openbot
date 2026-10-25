import { Network } from "@openbot-build/protocol"
import { Context, Effect, HashMap, HashSet, Layer, Option, Ref } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as ClientMetadata from "../apps/ClientMetadata.ts"
import { Scenarios, type Mode } from "./DevelopmentScenarios.ts"

const origin = "https://app.development.test"
const resource = origin + "/protected"
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

export const layer = (publicOrigin: string) =>
	Layer.effect(
		Authorization,
		Effect.gen(function* () {
			const metadata = yield* ClientMetadata.metadata(publicOrigin)
			const scenarios = yield* Scenarios
			const codes = yield* Ref.make(HashMap.empty<string, URLSearchParams>())
			const tokens = yield* Ref.make(HashSet.empty<string>())
			const refreshes = yield* Ref.make(HashSet.empty<string>())
			return Authorization.of({
				scenario: scenarios.mode,
				document: (url) => {
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
					return value === undefined
						? Effect.fail(
								new Network.NetworkError({
									reason: "Transport",
									message: "Invalid simulated authorization request",
								}),
							)
						: Effect.succeed(JSON.stringify(value))
				},
				validToken: (token) =>
					Effect.gen(function* () {
						return (
							(yield* scenarios.mode) !== "authorization-expired" &&
							HashSet.has(yield* Ref.get(tokens), token)
						)
					}),
				consent: (query, cancel) =>
					Effect.gen(function* () {
						const params = new URLSearchParams(query)
						if (
							params.get("client_id") !== metadata.client_id ||
							!metadata.redirect_uris.includes(
								params.get("redirect_uri") ?? "",
							) ||
							params.get("resource") !== resource ||
							params.get("code_challenge_method") !== "S256" ||
							(params.get("state") ?? "") === "" ||
							(params.get("code_challenge") ?? "") === ""
						)
							return yield* new Network.NetworkError({
								reason: "Transport",
								message: "Invalid simulated authorization request",
							})
						const callback = new URL(
							params.get("redirect_uri") ?? metadata.redirect_uris[0],
						)
						callback.searchParams.set("state", params.get("state") ?? "")
						callback.searchParams.set("iss", origin)
						if (cancel) callback.searchParams.set("error", "access_denied")
						else {
							const code = yield* Effect.sync(randomUUID)
							yield* Ref.update(codes, (values) =>
								HashMap.set(values, code, params),
							)
							callback.searchParams.set("code", code)
						}
						return callback.href
					}),
				grant: (body, revoke) =>
					Effect.gen(function* () {
						const mode = yield* scenarios.mode
						if (
							(revoke && mode === "cleanup-failure") ||
							(!revoke &&
								mode === "authorization-expired" &&
								new URLSearchParams(body).get("grant_type") === "refresh_token")
						)
							return yield* new Network.NetworkError({
								reason: "Transport",
								message: "Invalid simulated authorization request",
							})
						const form = new URLSearchParams(body)
						if (form.get("client_id") !== metadata.client_id)
							return yield* new Network.NetworkError({
								reason: "Transport",
								message: "Invalid simulated authorization request",
							})
						if (revoke) {
							yield* Ref.update(refreshes, (values) =>
								HashSet.remove(values, form.get("token") ?? ""),
							)
							yield* Ref.set(tokens, HashSet.empty())
							return "{}"
						}
						if (form.get("resource") !== resource)
							return yield* new Network.NetworkError({
								reason: "Transport",
								message: "Invalid simulated authorization request",
							})
						if (form.get("grant_type") === "authorization_code") {
							const code = form.get("code") ?? ""
							const params = yield* Ref.modify(
								codes,
								(values) =>
									[
										HashMap.get(values, code),
										HashMap.remove(values, code),
									] as const,
							)
							const matches = Option.exists(
								params,
								(params) =>
									form.get("redirect_uri") === params.get("redirect_uri") &&
									createHash("sha256")
										.update(form.get("code_verifier") ?? "")
										.digest("base64url") === params.get("code_challenge"),
							)
							if (!matches)
								return yield* new Network.NetworkError({
									reason: "Transport",
									message: "Invalid simulated authorization request",
								})
						} else if (
							form.get("grant_type") !== "refresh_token" ||
							!(yield* Ref.get(refreshes).pipe(
								Effect.map((values) =>
									HashSet.has(values, form.get("refresh_token") ?? ""),
								),
							))
						)
							return yield* new Network.NetworkError({
								reason: "Transport",
								message: "Invalid simulated authorization request",
							})
						const access = yield* Effect.sync(randomUUID)
						yield* scenarios.set("available")
						const refresh = yield* Effect.sync(randomUUID)
						yield* Ref.update(tokens, (values) => HashSet.add(values, access))
						yield* Ref.update(refreshes, (values) =>
							HashSet.add(values, refresh),
						)
						return JSON.stringify({
							access_token: access,
							refresh_token: refresh,
							token_type: "Bearer",
							expires_in: 3600,
							scope: "documents",
						})
					}),
			})
		}),
	)
const escape = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
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
						`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated App authorization</title><style>*{box-sizing:border-box}html{font:100%/1.5 system-ui;color-scheme:light dark}body{margin:0;padding:clamp(1rem,4vw,3rem);overflow-wrap:anywhere}main{max-width:40rem;margin-inline:auto}h1{font-size:clamp(1.5rem,5vw,2rem);line-height:1.25}form{max-width:32rem}button{font:inherit;max-width:100%;padding:.5rem .75rem;margin:.25rem 0}</style><main><h1>Simulated App authorization</h1><p>Allow OpenBot to access simulated documents? This development flow stays inside OpenBot.</p><form method="post"><input type="hidden" name="query" value="${escape(new URL(request.url, "https://localhost").search.slice(1))}"><button name="decision" value="allow">Allow simulated access</button><button name="decision" value="cancel">Cancel</button></form></main></html>`,
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
