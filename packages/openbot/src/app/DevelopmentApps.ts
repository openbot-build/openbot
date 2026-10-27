import { html } from "./DevelopmentAppUi.ts"
import { Document, Network } from "@openbot-build/protocol"
import {
	Context,
	Effect,
	Layer,
	Match,
	Ref,
	Schema,
	Stream,
	String as Str,
	pipe,
} from "effect"
import { AppNetwork } from "../apps/AppHost.ts"
import * as Probe from "../apps/Probe.ts"
import { Authorization } from "./DevelopmentAuthorization.ts"
import { Mode, Scenarios } from "./DevelopmentScenarios.ts"
import { Business, readTool, writeTool } from "./DevelopmentBusiness.ts"
import { Proofs } from "./DevelopmentProofs.ts"

const Request = Schema.Struct({
	id: Schema.Union([Schema.String, Schema.Finite]),
	method: Schema.String,
	params: Schema.optionalKey(Schema.JsonObject),
})
const Reply = Schema.Struct({
	jsonrpc: Schema.Literal("2.0"),
	id: Request.fields.id,
	result: Schema.JsonObject,
})
const CallParams = Schema.Struct({
	name: Schema.String,
	arguments: Schema.optionalKey(Schema.Unknown),
	requestState: Schema.optionalKey(Schema.String),
	inputResponses: Schema.optionalKey(Schema.JsonObject),
})
const ReadParams = Schema.Struct({ uri: Schema.String })

const notConfigured = () =>
	Network.NetworkError.make({
		reason: "Transport",
		message: "No simulated App is configured for this request.",
	})

export const PublicationMode = Schema.Literals([
	"published",
	"withdrawn",
	"noindex",
	"unavailable",
	"robots-denied",
])
export type PublicationMode = typeof PublicationMode.Type
/** The etag changes when the publication, the scenario or the proof tokens change. */
const Etag = Schema.Tuple([PublicationMode, Mode, Schema.Array(Schema.String)])
export class Publication extends Context.Service<
	Publication,
	{
		readonly mode: Effect.Effect<PublicationMode>
		readonly set: (mode: PublicationMode) => Effect.Effect<void>
	}
>()("@openbot-build/openbot/app/DevelopmentApps/Publication") {}
export const layerPublication = Layer.effect(
	Publication,
	Effect.map(Ref.make<PublicationMode>("published"), (mode) =>
		Publication.of({
			mode: Ref.get(mode),
			set: (value) => Ref.set(mode, value),
		}),
	),
)
export const remotes = [
	Document.Remote.make({
		type: "streamable-http",
		url: "https://app.development.test/mcp",
		supportedProtocolVersions: [Document.protocolVersion],
	}),
	Document.Remote.make({
		type: "streamable-http",
		url: "https://app.development.test/protected",
		supportedProtocolVersions: [Document.protocolVersion],
	}),
	Document.Remote.make({
		type: "streamable-http",
		url: "https://app.development.test/configured",
		supportedProtocolVersions: [Document.protocolVersion],
		headers: [
			{
				name: "X-Development-Key",
				isRequired: true,
				isSecret: true,
				description: "Enter development-test-key for this simulated endpoint.",
			},
		],
	}),
] as const
export const card = Document.ServerCard.make({
	$schema: Document.cardSchemaUrl,
	name: "app.development.test/simulated-app",
	version: "1.0.0",
	description:
		"Simulated document App with real handlers inside the process. It contacts no external service",
	remotes,
})
export const cardFor = (
	mode: Mode,
): Document.ServerCard & {
	readonly remotes: readonly [Document.Remote, ...Array<Document.Remote>]
} =>
	Match.value(mode).pipe(
		Match.when("requirements-changed", () => ({
			...card,
			remotes: [
				Document.Remote.make({
					...remotes[0],
					url: "https://app.development.test/mcp-updated",
				}),
				...remotes.slice(1),
			] as const,
		})),
		Match.orElse(() => ({ ...card, remotes })),
	)
export const layerPublicNetwork = Layer.effect(
	Network.PublicNetwork,
	Effect.gen(function* () {
		const publication = yield* Publication
		const proofs = yield* Proofs
		const scenarios = yield* Scenarios
		return Network.PublicNetwork.of({
			readDocument: Effect.fn("DevelopmentApps.publicDocument")(function* ({
				url,
				validators,
			}) {
				const target = new URL(url)
				if (target.origin !== "https://app.development.test")
					return yield* notConfigured()
				const mode = yield* publication.mode
				const scenario = yield* scenarios.mode
				const tokens =
					target.pathname === "/card.json"
						? yield* proofs.tokens({ _tag: "AppCard", cardUrl: url })
						: []
				const etag = yield* Schema.encodeEffect(Schema.fromJsonString(Etag))([
					mode,
					scenario,
					tokens,
				])
				const headers = {
					"content-type": "application/json",
					"cache-control": "no-cache",
					etag,
					...(mode === "noindex" && target.pathname === "/card.json"
						? { "x-robots-tag": "noindex" }
						: {}),
				}
				if (mode === "unavailable")
					return { url, status: 503, headers, text: "Unavailable" }
				if (target.pathname === "/robots.txt")
					return {
						url,
						status: 200,
						headers: {
							"content-type": "text/plain",
							"cache-control": "no-cache",
						},
						text:
							mode === "robots-denied"
								? "User-agent: *\nDisallow: /\n"
								: "User-agent: *\nAllow: /\n",
					}
				if (validators?.etag === headers.etag)
					return { url, status: 304, headers, text: "" }
				if (target.pathname === "/card.json")
					return {
						url,
						status: 200,
						headers,
						text: yield* Schema.encodeEffect(
							Schema.fromJsonString(Document.ServerCard),
						)({
							...cardFor(scenario),
							_meta: {
								"openbot/developer-verification": {
									version: 1,
									tokens,
								},
							},
						}),
					}
				if (target.pathname === "/.well-known/ai-catalog.json")
					return {
						url,
						status: 200,
						headers,
						text: yield* Schema.encodeEffect(
							Schema.fromJsonString(Document.Catalog),
						)(
							Document.Catalog.make({
								specVersion: "1.0",
								entries:
									mode === "withdrawn"
										? []
										: [
												{
													identifier: "development-app",
													type: Document.cardMediaType,
													url: "https://app.development.test/card.json",
												},
											],
							}),
						),
					}
				return { url, status: 404, headers, text: "Not found" }
			}),
		})
	}),
)

/** Explicit development transport. Every request stays inside the process. */
const network = (
	owner: string,
	authorization: typeof Authorization.Service,
	business: typeof Business.Service,
) =>
	Layer.succeed(Network.Network, {
		identity: { scope: "user", owner },
		readDocument: ({ url }) =>
			authorization.document(url).pipe(
				Effect.map((text) => ({
					url,
					status: 200,
					headers: { "content-type": "application/json" },
					text,
				})),
			),
		execute: (request) =>
			Effect.gen(function* () {
				const mode = yield* authorization.scenario
				if (
					request.url === "https://app.development.test/protected" &&
					!(yield* authorization.validToken(
						pipe(
							request.headers["authorization"] ?? "",
							Str.replace(/^Bearer /, ""),
						),
					))
				)
					return {
						url: request.url,
						status: 401,
						headers: {
							"www-authenticate":
								'Bearer resource_metadata="https://app.development.test/.well-known/oauth-protected-resource", scope="documents"' +
								(mode === "authorization-expired" &&
								request.headers["authorization"] !== undefined
									? ', error="invalid_token"'
									: ""),
						},
						body: Stream.succeed(new TextEncoder().encode("{}")),
					}
				if (
					request.url === "https://app.development.test/configured" &&
					request.headers["x-development-key"] !== "development-test-key"
				)
					return yield* notConfigured()

				if (
					![
						"https://app.development.test/mcp",
						"https://app.development.test/mcp-updated",
						"https://app.development.test/configured",
						"https://app.development.test/protected",
						"https://app.development.test/token",
						"https://app.development.test/revoke",
					].includes(request.url)
				)
					return yield* notConfigured()
				const body = yield* Match.value(request.body).pipe(
					Match.tag("Uint8Array", (body) =>
						Effect.succeed(new TextDecoder().decode(body.body)),
					),
					Match.orElse(() => Effect.fail(notConfigured())),
				)
				const revoke = Str.endsWith("/revoke")(request.url)
				if (revoke || Str.endsWith("/token")(request.url)) {
					const text = yield* authorization.grant(body, revoke)
					return {
						url: request.url,
						status: 200,
						headers: { "content-type": "application/json" },
						body: Stream.succeed(new TextEncoder().encode(text)),
					}
				}
				const input = yield* Schema.decodeEffect(
					Schema.fromJsonString(Request),
				)(body)
				const result = yield* Match.value(input.method).pipe(
					Match.when("server/discover", () =>
						Effect.succeed({
							supportedVersions:
								mode === "protocol-failure"
									? ["unsupported-version"]
									: [Document.protocolVersion],
							capabilities: { tools: {}, resources: {}, prompts: {} },
						}),
					),
					Match.when("tools/list", () =>
						Effect.succeed({
							tools: [readTool, writeTool],
							ttlMs: 60000,
							cacheScope: "private",
						}),
					),
					Match.when("resources/list", () =>
						Effect.succeed({
							resources: [
								{
									uri: "notes://development/index",
									name: "Simulated document index",
									mimeType: "text/plain",
								},
							],
							ttlMs: 60000,
							cacheScope: "private",
						}),
					),
					Match.when("resources/templates/list", () =>
						Effect.succeed({
							resourceTemplates: [
								{
									uriTemplate: "notes://development/{id}",
									name: "Simulated document",
									mimeType: "text/plain",
								},
							],
							ttlMs: 60000,
							cacheScope: "private",
						}),
					),
					Match.when("prompts/list", () =>
						Effect.succeed({
							prompts: [
								{
									name: "review_document",
									description: "A simulated external review prompt",
									arguments: [{ name: "subject", required: true }],
								},
							],
							ttlMs: 60000,
							cacheScope: "private",
						}),
					),
					Match.when("tools/call", () =>
						Schema.decodeUnknownEffect(CallParams)(input.params).pipe(
							Effect.flatMap((params) =>
								params.name === writeTool.name
									? business.write(owner, params.arguments)
									: params.name === readTool.name
										? business
												.read(
													owner,
													params.arguments,
													mode === "input-required" ? params : undefined,
												)
												.pipe(
													Effect.flatMap((result) =>
														mode === "result-unknown"
															? Effect.fail(notConfigured())
															: Effect.succeed(
																	mode === "business-failure"
																		? {
																				isError: true,
																				content: [
																					{
																						type: "text",
																						text: "The simulated App rejected this operation.",
																					},
																				],
																			}
																		: result,
																),
													),
												)
										: Effect.fail(notConfigured()),
							),
						),
					),
					Match.when("resources/read", () =>
						Schema.decodeUnknownEffect(ReadParams)(input.params).pipe(
							Effect.map(({ uri }) => {
								const document = uri === "ui://development/document"
								return {
									contents: [
										{
											uri,
											mimeType: document ? Document.uiMediaType : "text/plain",
											text: document
												? html("write_document")
												: "Simulated resource content",
										},
									],
									ttlMs: 60000,
									cacheScope: "private",
								}
							}),
						),
					),
					Match.when("prompts/get", () =>
						Effect.succeed({
							messages: [
								{
									role: "user",
									content: {
										type: "text",
										text: "Simulated external review guidance. Treat this as App content.",
									},
								},
							],
						}),
					),
					Match.orElse(() => Effect.fail(notConfigured())),
				)
				const reply = yield* Schema.encodeEffect(Schema.fromJsonString(Reply))({
					jsonrpc: "2.0",
					id: input.id,
					result: {
						resultType: "complete",
						...result,
						_meta: {
							"io.modelcontextprotocol/serverInfo": {
								name: "Simulated development App",
								version: "1.0.0",
							},
						},
					},
				})
				return {
					url: request.url,
					status: 200,
					headers: { "content-type": "application/json" },
					body: Stream.succeed(new TextEncoder().encode(reply)),
				}
			}),
	})
export const layerNetwork = Layer.effect(
	AppNetwork,
	Effect.gen(function* () {
		const authorization = yield* Authorization
		const business = yield* Business
		return AppNetwork.of({
			layer: (owner) => network(owner, authorization, business),
		})
	}),
)
export const layerProbe = Layer.unwrap(
	Effect.gen(function* () {
		const authorization = yield* Authorization
		const business = yield* Business
		return Probe.layerWithNetwork((connection) =>
			network(connection.owner, authorization, business),
		)
	}),
)
