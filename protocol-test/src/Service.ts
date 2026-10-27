import {
	Array as Arr,
	Effect,
	HashSet,
	Layer,
	Match,
	String as Str,
} from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { McpPublisher, Protection, Publisher } from "@openbot-build/protocol"
import { Authorization } from "./Authorization.ts"
import * as AuthorizationRoutes from "./AuthorizationRoutes.ts"
import * as Discovery from "./Discovery.ts"
import * as Capabilities from "./Capabilities.ts"
import * as Pagination from "./Pagination.ts"
import {
	card,
	cardUrl,
	catalog,
	catalogUrl,
	etag,
	issuer,
	modified,
	readScope,
	resource,
	scenarios,
	writeScope,
	type Settings,
} from "./Scenarios.ts"

const writes = HashSet.make("write_note", "delete_note")
const requiredScope = (operation: Protection.Operation) =>
	operation.target !== undefined && HashSet.has(writes, operation.target)
		? writeScope
		: readScope
const policy = Layer.succeed(Protection.AccessPolicy, {
	check: (identity, operation) => {
		const scope = requiredScope(operation)
		return identity.scopes.includes(scope)
			? Effect.void
			: Effect.fail(Protection.AccessDenied.make({ scopes: [scope] }))
	},
	visible: (identity, operation) =>
		Effect.succeed(identity.scopes.includes(requiredScope(operation))),
})

const headerProtection = (options: {
	readonly path: string
	readonly name: string
	readonly value: string
}) =>
	HttpRouter.middleware(
		Effect.succeed((http) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				if (
					new URL(request.originalUrl, "https://protocol-test.invalid")
						.pathname !== options.path ||
					request.method === "OPTIONS"
				)
					return yield* http
				if (request.headers[Str.toLowerCase(options.name)] !== options.value)
					return HttpServerResponse.jsonUnsafe(
						{
							error: "invalid_credentials",
							description:
								"Use the public test credential documented for this scenario.",
						},
						{
							status: 401,
							headers: {
								"cache-control": "no-store",
								...(Str.startsWith("Basic ")(options.value)
									? { "www-authenticate": 'Basic realm="Protocol Test"' }
									: Str.startsWith("Bearer ")(options.value)
										? {
												"www-authenticate":
													'Bearer realm="Protocol Test", error="invalid_token"',
											}
										: {}),
							},
						},
					)
				return yield* http
			}),
		),
	)

const cors = (settings: Settings) =>
	HttpRouter.middleware(
		Effect.succeed((http) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				const origin = request.headers["origin"]
				if (origin !== undefined && !settings.allowedOrigins.includes(origin))
					return HttpServerResponse.empty({ status: 403 })
				const response =
					request.method === "OPTIONS"
						? HttpServerResponse.empty({ status: 204 })
						: yield* http
				if (origin === undefined) return response
				return HttpServerResponse.setHeaders(response, {
					"access-control-allow-origin": origin,
					"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
					"access-control-allow-headers":
						"Authorization, Content-Type, Accept, X-API-Key, Mcp-Method, Mcp-Name, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID",
					"access-control-expose-headers":
						"WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version, Link, ETag, Retry-After",
					"access-control-max-age": "600",
					vary: "Origin",
				})
			}),
		),
	)

/** The caller provides the test authorization, network and platform services. */
export const layer = (settings: Settings) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const auth = yield* Authorization
			const apps = Arr.map(scenarios, (scenario) => {
				const publication = Publisher.Publication.make({
					card: card(settings.origin)(scenario),
					cardUrl: cardUrl(settings.origin)(scenario),
					catalogUrl: catalogUrl(settings.origin)(scenario),
					catalog: catalog(settings.origin)([scenario]),
					mcpUrl: resource(settings.origin)(scenario),
					allowedOrigins: settings.allowedOrigins,
					etag,
					lastModified: modified,
				})
				const register = Capabilities.register({ ...settings, scenario })
				return Match.value(scenario.authentication).pipe(
					Match.when({ kind: "anonymous" }, () =>
						McpPublisher.layer({ publication, register }),
					),
					Match.when({ kind: "header" }, (authentication) =>
						McpPublisher.layer({ publication, register }).pipe(
							Layer.provide(
								headerProtection({
									path: new URL(publication.mcpUrl).pathname,
									...authentication,
								}).layer,
							),
						),
					),
					Match.when({ kind: "oauth" }, ({ mode }) =>
						McpPublisher.layerProtected({
							publication,
							register,
							protection: {
								metadataUrl:
									settings.origin +
									"/.well-known/oauth-protected-resource/mcp/" +
									scenario.id,
								authorizationServers: [issuer(settings.origin)(mode)],
								scopes: [readScope],
							},
						}).pipe(
							Layer.provide(
								Layer.merge(
									policy,
									Layer.succeed(Protection.TokenVerifier, {
										verify: auth.verify,
									}),
								),
							),
						),
					),
					Match.exhaustive,
					Layer.provide(Pagination.middleware.layer),
					Layer.fresh,
				)
			})
			return Layer.mergeAll(
				Discovery.layer(settings),
				AuthorizationRoutes.layer(settings),
				...apps,
			).pipe(Layer.provide(cors(settings).layer))
		}),
	)
