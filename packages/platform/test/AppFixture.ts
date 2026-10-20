import { html } from "../src/app/DevelopmentAppUi.ts"
import { CatalogDiscovery, Document, Network } from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	Array as Arr,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Match,
	Option,
	Schema,
} from "effect"
import { createHash, randomUUID } from "node:crypto"
import { startHttps } from "../../protocol/test/Fixture.ts"
import * as Probe from "../src/apps/Probe.ts"

const Request = Schema.Struct({
	id: Schema.Union([Schema.String, Schema.Finite]),
	method: Schema.String,
	params: Schema.optionalKey(Schema.JsonObject),
})

/** A separate local publisher and MCP endpoint, shared by Platform integration tests. */
export const start = async (
	options: {
		readonly capabilities?: boolean
		readonly presentation?: boolean
	} = {},
) => {
	let origin = ""
	let revision = 0
	let publication = "published"
	let description = "Project documents"
	let websiteUrl: string | undefined
	let declarations: ReadonlyArray<string> | undefined
	let codes = HashMap.empty<string, URLSearchParams>()
	let accessTokens = HashSet.empty<string>()
	let refreshTokens = HashSet.empty<string>()
	let exchanges = 0
	let cimd = true
	let rejectGrant = false
	let operations: ReadonlyArray<string> = []
	let revocationSupported = true
	let revocationFails = false
	let tokenDelay = 0
	let inFlight = 0
	let maxInFlight = 0
	let businessCalls = 0
	let invalidOutput = false
	let inputRequired = false
	let dropResult = false
	let inputStarts = 0
	let pendingInputs = HashMap.empty<string, Schema.JsonObject>()
	let writes: ReadonlyArray<{
		readonly account: string
		readonly text: string
	}> = []
	const readTool = (name: string) => ({
		name,
		description: "Read a document from this business account",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		},
		outputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				account: { type: "string" },
				text: { type: "string" },
			},
			required: ["id", "account", "text"],
		},
		annotations: { readOnlyHint: true },
	})
	const issueCode = (authorizationUrl: string) => {
		const params = new URL(authorizationUrl).searchParams
		if (
			params.get("resource") !== origin + "/protected" ||
			params.get("code_challenge_method") !== "S256"
		)
			throw new Error("Unexpected authorization request")
		const code = randomUUID()
		codes = HashMap.set(codes, code, params)
		const callback = new URL(params.get("redirect_uri") ?? "")
		callback.searchParams.set("code", code)
		callback.searchParams.set("state", params.get("state") ?? "")
		callback.searchParams.set("iss", origin)
		return callback.href
	}
	let requests: ReadonlyArray<{
		readonly path: string
		readonly method: string
		readonly authorization: string | undefined
	}> = []
	const card = (second = false) => ({
		$schema: Document.cardSchemaUrl,
		name: second ? "fixture.test/second" : "fixture.test/documents",
		version: "1.0.0",
		...(options.presentation === true
			? {
					title: second ? "Project Notes" : "Shared Documents",
					icons: [{ src: origin + "/icon.svg", mimeType: "image/svg+xml" }],
					_meta: {
						[Document.presentationKey]: {
							version: "1",
							examples: [
								{
									id: "prepare",
									title: "Turn scattered notes into a clear plan",
									prompt:
										"Review my project notes and prepare a short plan for the week.",
									description:
										"Find what matters, connect the details, and decide what comes next.",
									preview: {
										src: origin + "/preview.svg",
										alt: "Illustrative project notes and weekly plan",
										width: 800,
										height: 500,
										mimeType: "image/svg+xml",
									},
								},
							],
						},
					},
				}
			: {}),
		description,
		...(websiteUrl === undefined ? {} : { websiteUrl }),
		remotes: [
			{
				type: "streamable-http",
				url: origin + (revision === 0 ? "/mcp" : "/mcp-updated"),
				supportedProtocolVersions: [Document.protocolVersion],
				headers: [
					{ name: "X-Account", isRequired: true, isSecret: false },
					{ name: "X-Secret", isRequired: true, isSecret: true },
				],
			},
			{
				type: "streamable-http",
				url: origin + "/protected",
				supportedProtocolVersions: [Document.protocolVersion],
			},
		],
	})
	const fixture = await startHttps((req, res) => {
		const path = new URL(req.url ?? "/", origin).pathname
		requests = Arr.append(requests, {
			path,
			method: req.method ?? "GET",
			authorization: req.headers.authorization,
		})
		res.setHeader("content-type", "application/json")
		if (
			options.presentation === true &&
			(path === "/icon.svg" || path === "/preview.svg")
		) {
			res.setHeader("content-type", "image/svg+xml")
			res.end(
				path === "/icon.svg"
					? '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" rx="20" fill="#71816a"/><path d="M25 20h22l10 10v30H25z" fill="#fff"/><path d="M33 38h16M33 45h16M33 52h10" stroke="#71816a" stroke-width="3"/></svg>'
					: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#edf0e8"/><rect x="75" y="105" width="290" height="295" rx="16" fill="#fff" transform="rotate(-7 220 250)"/><rect x="390" y="75" width="330" height="330" rx="16" fill="#fff"/><g font-family="sans-serif" fill="#343d30"><text x="125" y="170" font-size="14">PROJECT NOTES</text><text x="125" y="218" font-size="24">One good idea.</text><text x="125" y="252" font-size="24">A little clarity.</text><text x="425" y="130" font-size="13" fill="#71816a">YOUR WEEK, REIMAGINED</text><text x="425" y="180" font-size="26">A plan to move forward</text><text x="455" y="235" font-size="19">Find the essentials</text><text x="455" y="290" font-size="19">Bring the details together</text><text x="455" y="345" font-size="19">Make the next step clear</text></g><g fill="#aab7a2"><rect x="425" y="220" width="16" height="16" rx="4"/><rect x="425" y="275" width="16" height="16" rx="4"/><rect x="425" y="330" width="16" height="16" rx="4"/></g></svg>',
			)
			return
		}

		if (path === "/.well-known/oauth-protected-resource") {
			res.end(
				JSON.stringify({
					resource: origin + "/protected",
					authorization_servers: [origin],
					scopes_supported: ["documents"],
				}),
			)
			return
		}
		if (path === "/.well-known/oauth-authorization-server") {
			res.end(
				JSON.stringify({
					issuer: origin,
					authorization_endpoint: origin + "/authorize",
					token_endpoint: origin + "/token",
					...(revocationSupported
						? { revocation_endpoint: origin + "/revoke" }
						: {}),
					client_id_metadata_document_supported: cimd,
					authorization_response_iss_parameter_supported: true,
					code_challenge_methods_supported: ["S256"],
					response_types_supported: ["code"],
					token_endpoint_auth_methods_supported: ["none"],
				}),
			)
			return
		}
		if (path === "/token" || path === "/revoke") {
			let body = ""
			req.setEncoding("utf8")
			req.on("data", (part: string) => {
				body += part
			})
			req.on("end", () => {
				const form = new URLSearchParams(body)
				if (path === "/revoke") {
					if (revocationFails) {
						res.writeHead(503)
						res.end("{}")
						return
					}
					refreshTokens = HashSet.remove(refreshTokens, form.get("token") ?? "")
					accessTokens = HashSet.empty()
					res.end("{}")
					return
				}
				exchanges++
				const code = form.get("code") ?? ""
				const params = Option.getOrUndefined(HashMap.get(codes, code))
				codes = HashMap.remove(codes, code)
				const valid =
					Match.value(form.get("grant_type")).pipe(
						Match.when(
							"authorization_code",
							() =>
								params !== undefined &&
								form.get("client_id") === params.get("client_id") &&
								form.get("redirect_uri") === params.get("redirect_uri") &&
								createHash("sha256")
									.update(form.get("code_verifier") ?? "")
									.digest("base64url") === params.get("code_challenge"),
						),
						Match.when("refresh_token", () =>
							HashSet.has(refreshTokens, form.get("refresh_token") ?? ""),
						),
						Match.orElse(() => false),
					) &&
					form.get("resource") === origin + "/protected" &&
					!rejectGrant
				if (!valid) {
					res.writeHead(400)
					res.end(JSON.stringify({ error: "invalid_grant" }))
					return
				}
				const access = randomUUID()
				const refresh = randomUUID()
				accessTokens = HashSet.add(accessTokens, access)
				refreshTokens = HashSet.add(refreshTokens, refresh)
				inFlight++
				maxInFlight = Math.max(maxInFlight, inFlight)
				setTimeout(() => {
					inFlight--
					res.end(
						JSON.stringify({
							access_token: access,
							refresh_token: refresh,
							token_type: "Bearer",
							expires_in: 3600,
							scope: "documents",
						}),
					)
				}, tokenDelay)
			})
			return
		}
		if (!["/mcp", "/mcp-updated", "/protected"].includes(path)) {
			if (
				req.headers.authorization !== undefined ||
				req.headers.cookie !== undefined
			)
				throw new Error(
					"An anonymous publication request got account credentials",
				)
			res.setHeader("cache-control", "no-cache")
		}
		if (path === "/robots.txt") {
			res.setHeader("content-type", "text/plain")
			res.end(
				publication === "robots-denied"
					? "User-agent: *\nDisallow: /\n"
					: "User-agent: *\nAllow: /\n",
			)
			return
		}
		if (path === "/website") {
			res.setHeader("content-type", "text/html")
			res.end('<link rel="ai-catalog" href="/.well-known/ai-catalog.json">')
			return
		}
		if (path === "/card" || path === "/second") {
			if (publication === "unavailable") {
				res.statusCode = 503
				res.end("Unavailable")
				return
			}
			if (publication === "noindex") res.setHeader("x-robots-tag", "noindex")
			res.end(JSON.stringify(card(path === "/second")))
			return
		}
		if (path === "/.well-known/ai-catalog.json" || path === "/catalog") {
			res.end(
				JSON.stringify({
					specVersion: "1.0",
					entries: (publication === "withdrawn"
						? []
						: (declarations ??
							(path === "/catalog"
								? ["/card?edition=team", "/second"]
								: ["/card?edition=team"]))
					).map((url, index) => ({
						identifier: String(index),
						type: Document.cardMediaType,
						url: new URL(url, origin).href,
					})),
				}),
			)
			return
		}
		if (
			path === "/protected" &&
			!HashSet.has(
				accessTokens,
				req.headers.authorization?.replace(/^Bearer /, "") ?? "",
			)
		) {
			res.writeHead(401, {
				"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="documents"`,
			})
			res.end("{}")
			return
		}
		if (path === "/mcp" || path === "/mcp-updated" || path === "/protected") {
			let body = ""
			req.setEncoding("utf8")
			req.on("data", (part: string) => {
				body += part
			})
			req.on("end", () => {
				const request = Schema.decodeSync(Schema.fromJsonString(Request))(body)
				operations = Arr.append(operations, request.method)
				const result = Match.value(request.method).pipe(
					Match.when("server/discover", () => ({
						supportedVersions: [Document.protocolVersion],
						capabilities: { tools: {}, resources: {}, prompts: {} },
					})),
					Match.when("tools/list", () => ({
						tools:
							options.capabilities !== true
								? []
								: request.params?.["cursor"] === "later"
									? [
											readTool("read_later"),
											{
												...readTool("write_board"),
												description:
													"Write the reviewed document to this account",
												inputSchema: {
													type: "object",
													properties: {
														id: { type: "string" },
														text: { type: "string" },
													},
													required: ["id", "text"],
													additionalProperties: false,
												},
											},
											{
												...readTool("hidden_action"),
												_meta: { ui: { visibility: ["app"] } },
											},
										]
									: [
											{
												...readTool("read_document"),
												_meta: { ui: { resourceUri: "ui://fixture/document" } },
											},
										],
						...(options.capabilities === true &&
						request.params?.["cursor"] !== "later"
							? { nextCursor: "later" }
							: {}),
						ttlMs: 60000,
						cacheScope: "private",
					})),
					Match.when("resources/list", () => ({
						resources:
							options.capabilities === true
								? [
										{
											uri: "notes://documents/index",
											name: "Document index",
											mimeType: "text/plain",
										},
									]
								: [],
						ttlMs: 60000,
						cacheScope: "private",
					})),
					Match.when("resources/templates/list", () => ({
						resourceTemplates:
							options.capabilities === true &&
							request.params?.["cursor"] === "later"
								? [
										{
											uriTemplate: "notes://documents/{id}",
											name: "Document",
											mimeType: "text/plain",
										},
									]
								: [],
						...(options.capabilities === true &&
						request.params?.["cursor"] !== "later"
							? { nextCursor: "later" }
							: {}),
						ttlMs: 60000,
						cacheScope: "private",
					})),
					Match.when("prompts/list", () => ({
						prompts:
							options.capabilities === true
								? [
										{
											name: "review_document",
											description: "Read a review prompt",
											arguments: [{ name: "subject", required: true }],
										},
									]
								: [],
						ttlMs: 60000,
						cacheScope: "private",
					})),
					Match.when("tools/call", () => {
						const params = request.params ?? {}
						const argsValue = Schema.decodeUnknownSync(Schema.JsonObject)(
							params["arguments"],
						)
						if (inputRequired && params["requestState"] === undefined) {
							const state = randomUUID()
							pendingInputs = HashMap.set(pendingInputs, state, argsValue)
							inputStarts++
							return {
								resultType: "input_required",
								requestState: state,
								inputRequests: {
									consent: {
										method: "elicitation/create",
										params: {
											message: "Confirm this document operation",
											requestedSchema: {
												type: "object",
												properties: { confirmed: { type: "boolean" } },
												required: ["confirmed"],
											},
										},
									},
								},
							}
						}
						if (params["requestState"] !== undefined) {
							const state = String(params["requestState"])
							const original = HashMap.get(pendingInputs, state)
							if (
								Option.isNone(original) ||
								!Schema.toEquivalence(Schema.JsonObject)(
									original.value,
									argsValue,
								)
							)
								throw new Error(
									"The continuation does not match its saved request",
								)
							pendingInputs = HashMap.remove(pendingInputs, state)
						}
						businessCalls++
						const account = String(
							req.headers["x-account"] ?? "Protected account",
						)
						const args = Schema.decodeUnknownSync(
							Schema.Struct({ id: Schema.String }),
						)(request.params?.["arguments"])
						if (params["name"] === "write_board")
							writes = Arr.append(writes, {
								account,
								text: String(argsValue["text"]),
							})
						return {
							content: [
								{
									type: "text",
									text: "Read document " + args.id + " for " + account,
								},
							],
							structuredContent: {
								id: invalidOutput ? 17 : args.id,
								account,
								text: "Document content " + args.id,
							},
							_meta: { fixtureProof: "handler-executed" },
						}
					}),
					Match.when("resources/read", () => ({
						contents: [
							{
								uri: String(request.params?.["uri"] ?? ""),
								mimeType:
									request.params?.["uri"] === "ui://fixture/document"
										? Document.uiMediaType
										: "text/plain",
								text:
									request.params?.["uri"] === "ui://fixture/document"
										? html("write_board")
										: "Resource content for " +
											String(req.headers["x-account"] ?? "Protected account"),
							},
						],
					})),
					Match.when("prompts/get", () => ({
						messages: [
							{
								role: "user",
								content: { type: "text", text: "External prompt content" },
							},
						],
					})),
					Match.orElse(() => ({})),
				)
				const meta = Option.getOrElse(
					Schema.decodeUnknownOption(
						Schema.Struct({ _meta: Schema.JsonObject }),
					)(result),
					() => ({ _meta: {} }),
				)._meta
				if (dropResult && request.method === "tools/call") {
					res.destroy()
					return
				}
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: request.id,
						result: {
							resultType: "complete",
							...(request.method === "resources/read"
								? { ttlMs: 60000, cacheScope: "private" }
								: {}),
							...result,
							_meta: {
								...meta,
								"io.modelcontextprotocol/serverInfo": {
									name: "Platform fixture",
									version: "1.0.0",
								},
							},
						},
					}),
				)
			})
			return
		}
		res.statusCode = 404
		res.end("{}")
	})
	origin = fixture.ipOrigin
	const network = (owner: string) =>
		NodeHttpServer.layerUserNetwork({
			owner,
			allowedOrigins: [origin],
			allowAddress: (ip) => ip === "127.0.0.1",
			ca: fixture.ca,
		})
	return {
		origin,
		operations: () => operations,
		businessCalls: () => businessCalls,
		writes: () => writes,
		inputStarts: () => inputStarts,
		setInputRequired: (value: boolean) => {
			inputRequired = value
		},
		setDropResult: (value: boolean) => {
			dropResult = value
		},
		setInvalidOutput: (value: boolean) => {
			invalidOutput = value
		},
		maxTokenRequests: () => maxInFlight,
		setTokenDelay: (value: number) => {
			tokenDelay = value
		},
		setRevocationSupported: (value: boolean) => {
			revocationSupported = value
		},
		setRevocationFails: (value: boolean) => {
			revocationFails = value
		},
		issueCode,
		exchanges: () => exchanges,
		setCimd: (value: boolean) => {
			cimd = value
		},
		setRejectGrant: (value: boolean) => {
			rejectGrant = value
		},
		ca: fixture.ca,
		setPublication: (
			value:
				"published" | "withdrawn" | "noindex" | "unavailable" | "robots-denied",
		) => {
			publication = value
		},
		setDescription: (value: string) => {
			description = value
		},
		setWebsite: (value: string) => {
			websiteUrl = value
		},
		setDeclarations: (value: ReadonlyArray<string>) => {
			declarations = value
		},
		publicNetwork: (
			additional: {
				readonly origins: ReadonlyArray<string>
				readonly cas: ReadonlyArray<Buffer>
			} = { origins: [], cas: [] },
		) =>
			Layer.effect(
				Network.PublicNetwork,
				Effect.map(Network.Network, (network) =>
					Network.PublicNetwork.of({
						readDocument: ({ url, followRedirects, validators }) =>
							network.readDocument({
								url,
								...(followRedirects === undefined ? {} : { followRedirects }),
								headers: {
									"user-agent": Network.publicProductToken,
									...(validators?.etag === undefined
										? {}
										: { "if-none-match": validators.etag }),
									...(validators?.lastModified === undefined
										? {}
										: { "if-modified-since": validators.lastModified }),
								},
							}),
					}),
				),
			).pipe(
				Layer.provide(
					NodeHttpServer.layerUserNetwork({
						owner: "anonymous-public-fixture",
						allowedOrigins: [origin, ...additional.origins],
						allowAddress: (ip) => ip === "127.0.0.1",
						ca: [fixture.ca, ...additional.cas],
					}),
				),
			),
		discovery: CatalogDiscovery.layer().pipe(
			Layer.provide(CatalogDiscovery.layerRules),
			Layer.provide(network("anonymous-fixture")),
		),
		probe: Probe.layerWithNetwork((connection) => network(connection.owner)),
		changeCard: () => {
			revision++
		},
		requests: () => requests,
		close: fixture.close,
	}
}
