import { html } from "../src/app/DevelopmentAppUi.ts"
import { CatalogDiscovery, Document, Network } from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import { NodeHttpServerRequest } from "@effect/platform-node"
import {
	Array as Arr,
	Crypto,
	Deferred,
	Duration,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Match,
	Option,
	pipe,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { Base64Url } from "effect/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { serveHttps } from "../../protocol/test/Fixture.ts"
import * as Probe from "../src/apps/Probe.ts"
import type { PublicationMode } from "../src/app/DevelopmentApps.ts"

const RpcRequest = Schema.fromJsonString(
	Schema.Struct({
		id: Schema.Union([Schema.String, Schema.Finite]),
		method: Schema.String,
		params: Schema.optionalKey(Schema.JsonObject),
	}),
)
type RpcRequest = typeof RpcRequest.Type

const ReadArguments = Schema.Struct({ id: Schema.String })

const ResultMeta = Schema.Struct({ _meta: Schema.JsonObject })

/** How the publisher starts. */
export interface Options {
	/** The MCP endpoint lists tools, resources, templates and prompts. */
	readonly capabilities?: boolean
	/** The cards have a title, icons and examples with preview images. */
	readonly presentation?: boolean
}

/** A call to `issueCode` did not look like the authorization request of OpenBot. */
export class UnexpectedAuthorizationRequest extends Schema.TaggedError<
	UnexpectedAuthorizationRequest,
	{ readonly brand: unique symbol }
>()("UnexpectedAuthorizationRequest", { url: Schema.String }) {}

const icon =
	'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" rx="20" fill="#71816a"/><path d="M25 20h22l10 10v30H25z" fill="#fff"/><path d="M33 38h16M33 45h16M33 52h10" stroke="#71816a" stroke-width="3"/></svg>'
const preview =
	'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#edf0e8"/><rect x="75" y="105" width="290" height="295" rx="16" fill="#fff" transform="rotate(-7 220 250)"/><rect x="390" y="75" width="330" height="330" rx="16" fill="#fff"/><g font-family="sans-serif" fill="#343d30"><text x="125" y="170" font-size="14">PROJECT NOTES</text><text x="125" y="218" font-size="24">One good idea.</text><text x="125" y="252" font-size="24">A little clarity.</text><text x="425" y="130" font-size="13" fill="#71816a">YOUR WEEK, REIMAGINED</text><text x="425" y="180" font-size="26">A plan to move forward</text><text x="455" y="235" font-size="19">Find the essentials</text><text x="455" y="290" font-size="19">Bring the details together</text><text x="455" y="345" font-size="19">Make the next step clear</text></g><g fill="#aab7a2"><rect x="425" y="220" width="16" height="16" rx="4"/><rect x="425" y="275" width="16" height="16" rx="4"/><rect x="425" y="330" width="16" height="16" rx="4"/></g></svg>'

/** A JSON body given as text, with the JSON content type of every fixture answer. */
const jsonText = (body: string, status = 200) =>
	HttpServerResponse.text(body, { status, contentType: "application/json" })

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

/** The answers of the MCP methods that only read the lists of the endpoint. */
const listing = (request: RpcRequest, account: string, capabilities: boolean) =>
	Match.value(request.method).pipe(
		Match.when("server/discover", () => ({
			supportedVersions: [Document.protocolVersion],
			capabilities: { tools: {}, resources: {}, prompts: {} },
		})),
		Match.when("tools/list", () => ({
			tools: !capabilities
				? []
				: request.params?.["cursor"] === "later"
					? [
							readTool("read_later"),
							{
								...readTool("write_board"),
								description: "Write the reviewed document to this account",
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
			...(capabilities && request.params?.["cursor"] !== "later"
				? { nextCursor: "later" }
				: {}),
			ttlMs: 60000,
			cacheScope: "private",
		})),
		Match.when("resources/list", () => ({
			resources: capabilities
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
				capabilities && request.params?.["cursor"] === "later"
					? [
							{
								uriTemplate: "notes://documents/{id}",
								name: "Document",
								mimeType: "text/plain",
							},
						]
					: [],
			...(capabilities && request.params?.["cursor"] !== "later"
				? { nextCursor: "later" }
				: {}),
			ttlMs: 60000,
			cacheScope: "private",
		})),
		Match.when("prompts/list", () => ({
			prompts: capabilities
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
							: "Resource content for " + account,
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

/**
 * Starts a separate local publisher and MCP endpoint on HTTPS, shared by
 * OpenBot integration tests. It stops when the scope closes. Give it
 * `NodeServices.layer`. A test reads the state of the publisher with the
 * Effects in the result, and changes it with the `set...` functions.
 */
export const start = Effect.fn("AppFixture.start")(function* (
	options: Options = {},
) {
	const crypto = yield* Crypto.Crypto
	const uuid = crypto.randomUUIDv4().pipe(Effect.orDie)
	/** The origin of the server. It is known when the server listens. */
	const origin = yield* Deferred.make<string>()
	const revision = yield* Ref.make(0)
	const publication = yield* Ref.make<PublicationMode>("published")
	const description = yield* Ref.make("Project documents")
	const websiteUrl = yield* Ref.make(Option.none<string>())
	const declarations = yield* Ref.make(Option.none<ReadonlyArray<string>>())
	const codes = yield* Ref.make(HashMap.empty<string, URLSearchParams>())
	const accessTokens = yield* Ref.make(HashSet.empty<string>())
	const refreshTokens = yield* Ref.make(HashSet.empty<string>())
	const exchanges = yield* Ref.make(0)
	const cimd = yield* Ref.make(true)
	const rejectGrant = yield* Ref.make(false)
	const operations = yield* Ref.make<ReadonlyArray<string>>([])
	const revocationSupported = yield* Ref.make(true)
	const revocationFails = yield* Ref.make(false)
	const tokenDelay = yield* Ref.make(0)
	const inFlight = yield* Ref.make(0)
	const maxInFlight = yield* Ref.make(0)
	const businessCalls = yield* Ref.make(0)
	const invalidOutput = yield* Ref.make(false)
	const inputRequired = yield* Ref.make(false)
	const dropResult = yield* Ref.make(false)
	const inputStarts = yield* Ref.make(0)
	const pendingInputs = yield* Ref.make(
		HashMap.empty<string, Schema.JsonObject>(),
	)
	const writes = yield* Ref.make<
		ReadonlyArray<{ readonly account: string; readonly text: string }>
	>([])
	const requests = yield* Ref.make<
		ReadonlyArray<{
			readonly path: string
			readonly method: string
			readonly authorization: string | undefined
		}>
	>([])
	/** Broken rules of the fixture. They fail the test when the scope closes. */
	const problems = yield* Ref.make<ReadonlyArray<string>>([])
	yield* Effect.addFinalizer(() =>
		Effect.flatMap(Ref.get(problems), (found) =>
			Arr.isReadonlyArrayNonEmpty(found)
				? Effect.die(new Error(Arr.join(found, "\n")))
				: Effect.void,
		),
	)
	/** Stops the request and keeps the problem for the end of the test. */
	const fault = (problem: string) =>
		Ref.update(problems, Arr.append(problem)).pipe(
			Effect.andThen(Effect.die(new Error(problem))),
		)
	/** Turns a message from OpenBot that does not decode into a problem of the test. */
	const strict = <A, R>(
		what: string,
		decode: Effect.Effect<A, Schema.SchemaError, R>,
	) =>
		decode.pipe(
			Effect.catchTag("SchemaError", (error) =>
				fault(what + ": " + error.message),
			),
		)

	const card = (base: string, second: boolean) =>
		Effect.gen(function* () {
			const website = yield* Ref.get(websiteUrl)
			const current = yield* Ref.get(revision)
			return {
				$schema: Document.cardSchemaUrl,
				name: second ? "fixture.test/second" : "fixture.test/documents",
				version: "1.0.0",
				...(options.presentation === true
					? {
							title: second ? "Project Notes" : "Shared Documents",
							icons: [{ src: base + "/icon.svg", mimeType: "image/svg+xml" }],
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
												src: base + "/preview.svg",
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
				description: yield* Ref.get(description),
				...Option.match(website, {
					onNone: () => ({}),
					onSome: (websiteUrl) => ({ websiteUrl }),
				}),
				remotes: [
					{
						type: "streamable-http",
						url: base + (current === 0 ? "/mcp" : "/mcp-updated"),
						supportedProtocolVersions: [Document.protocolVersion],
						headers: [
							{ name: "X-Account", isRequired: true, isSecret: false },
							{ name: "X-Secret", isRequired: true, isSecret: true },
						],
					},
					{
						type: "streamable-http",
						url: base + "/protected",
						supportedProtocolVersions: [Document.protocolVersion],
					},
				],
			}
		})

	/** The S256 code challenge of a PKCE code verifier. */
	const challenge = (verifier: string) =>
		crypto
			.digest("SHA-256", new TextEncoder().encode(verifier))
			.pipe(Effect.map(Base64Url.encode), Effect.orDie)

	/** Checks a token request against its grant. */
	const grantValid = (
		form: URLSearchParams,
		params: Option.Option<URLSearchParams>,
	) =>
		Match.value(form.get("grant_type")).pipe(
			Match.when("authorization_code", () =>
				Option.match(params, {
					onNone: () => Effect.succeed(false),
					onSome: (params) =>
						form.get("client_id") === params.get("client_id") &&
						form.get("redirect_uri") === params.get("redirect_uri")
							? Effect.map(
									challenge(form.get("code_verifier") ?? ""),
									(value) => value === params.get("code_challenge"),
								)
							: Effect.succeed(false),
				}),
			),
			Match.when("refresh_token", () =>
				Effect.map(
					Ref.get(refreshTokens),
					HashSet.has(form.get("refresh_token") ?? ""),
				),
			),
			Match.orElse(() => Effect.succeed(false)),
		)

	/** The token endpoint of the authorization server. */
	const token = (base: string, form: URLSearchParams) =>
		Effect.gen(function* () {
			yield* Ref.update(exchanges, (count) => count + 1)
			const code = form.get("code") ?? ""
			const params = yield* Ref.modify(codes, (current) => [
				HashMap.get(current, code),
				HashMap.remove(current, code),
			])
			const valid =
				(yield* grantValid(form, params)) &&
				form.get("resource") === base + "/protected" &&
				!(yield* Ref.get(rejectGrant))
			if (!valid)
				return yield* HttpServerResponse.json(
					{ error: "invalid_grant" },
					{ status: 400 },
				)
			const access = yield* uuid
			const refresh = yield* uuid
			yield* Ref.update(accessTokens, HashSet.add(access))
			yield* Ref.update(refreshTokens, HashSet.add(refresh))
			const running = yield* Ref.updateAndGet(inFlight, (count) => count + 1)
			yield* Ref.update(maxInFlight, (count) => Math.max(count, running))
			yield* Effect.sleep(Duration.millis(yield* Ref.get(tokenDelay))).pipe(
				Effect.ensuring(Ref.update(inFlight, (count) => count - 1)),
			)
			return yield* HttpServerResponse.json({
				access_token: access,
				refresh_token: refresh,
				token_type: "Bearer",
				expires_in: 3600,
				scope: "documents",
			})
		})

	/** The places that anyone may read, without credentials. */
	const publicPlace = (base: string, path: string) =>
		Effect.gen(function* () {
			if (path === "/robots.txt")
				return HttpServerResponse.text(
					(yield* Ref.get(publication)) === "robots-denied"
						? "User-agent: *\nDisallow: /\n"
						: "User-agent: *\nAllow: /\n",
					{ contentType: "text/plain" },
				)
			if (path === "/website")
				return HttpServerResponse.text(
					'<link rel="ai-catalog" href="/.well-known/ai-catalog.json">',
					{ contentType: "text/html" },
				)
			if (path === "/card" || path === "/second") {
				const mode = yield* Ref.get(publication)
				if (mode === "unavailable") return jsonText("Unavailable", 503)
				const response = yield* HttpServerResponse.json(
					yield* card(base, path === "/second"),
				)
				return mode === "noindex"
					? HttpServerResponse.setHeader(response, "x-robots-tag", "noindex")
					: response
			}
			if (path === "/.well-known/ai-catalog.json" || path === "/catalog") {
				const mode = yield* Ref.get(publication)
				const declared = yield* Ref.get(declarations)
				const urls =
					mode === "withdrawn"
						? []
						: Option.getOrElse(declared, () =>
								path === "/catalog"
									? ["/card?edition=team", "/second"]
									: ["/card?edition=team"],
							)
				return yield* HttpServerResponse.json({
					specVersion: "1.0",
					entries: Arr.map(urls, (url, index) => ({
						identifier: String(index),
						type: Document.cardMediaType,
						url: new URL(url, base).href,
					})),
				})
			}
			return jsonText("{}", 404)
		})

	/** Runs `tools/call`, with the input requests and the writes of the tests. */
	const callTool = (account: string, request: RpcRequest) =>
		Effect.gen(function* () {
			const params = request.params ?? {}
			const argsValue = yield* strict(
				"OpenBot sent tool arguments that are not a JSON object",
				Schema.decodeUnknownEffect(Schema.JsonObject)(params["arguments"]),
			)
			if (
				(yield* Ref.get(inputRequired)) &&
				params["requestState"] === undefined
			) {
				const state = yield* uuid
				yield* Ref.update(pendingInputs, HashMap.set(state, argsValue))
				yield* Ref.update(inputStarts, (count) => count + 1)
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
				const original = HashMap.get(yield* Ref.get(pendingInputs), state)
				if (
					Option.isNone(original) ||
					!Schema.toEquivalence(Schema.JsonObject)(original.value, argsValue)
				)
					return yield* fault(
						"The continuation does not match its saved request",
					)
				yield* Ref.update(pendingInputs, HashMap.remove(state))
			}
			yield* Ref.update(businessCalls, (count) => count + 1)
			const args = yield* strict(
				"OpenBot sent tool arguments with no document id",
				Schema.decodeUnknownEffect(ReadArguments)(
					request.params?.["arguments"],
				),
			)
			if (params["name"] === "write_board")
				yield* Ref.update(
					writes,
					Arr.append({ account, text: String(argsValue["text"]) }),
				)
			return {
				content: [
					{
						type: "text",
						text: "Read document " + args.id + " for " + account,
					},
				],
				structuredContent: {
					id: (yield* Ref.get(invalidOutput)) ? 17 : args.id,
					account,
					text: "Document content " + args.id,
				},
				_meta: { fixtureProof: "handler-executed" },
			}
		})

	/** The MCP endpoints. Only `/protected` needs a token. */
	const mcp = (request: HttpServerRequest.HttpServerRequest) =>
		Effect.gen(function* () {
			const rpc = yield* strict(
				"OpenBot sent a bad MCP request",
				Schema.decodeEffect(RpcRequest)(yield* request.text),
			)
			yield* Ref.update(operations, Arr.append(rpc.method))
			const account = String(
				request.headers["x-account"] ?? "Protected account",
			)
			const result =
				rpc.method === "tools/call"
					? yield* callTool(account, rpc)
					: listing(rpc, account, options.capabilities === true)
			const meta = Option.getOrElse(
				Schema.decodeUnknownOption(ResultMeta)(result),
				() => ({ _meta: {} }),
			)._meta
			if ((yield* Ref.get(dropResult)) && rpc.method === "tools/call") {
				// The connection breaks with no answer, as when the network fails.
				yield* Effect.sync(() =>
					NodeHttpServerRequest.toServerResponse(request).destroy(),
				)
				return yield* Effect.never
			}
			return yield* HttpServerResponse.json({
				jsonrpc: "2.0",
				id: rpc.id,
				result: {
					resultType: "complete",
					...(rpc.method === "resources/read"
						? { ttlMs: 60000, cacheScope: "private" }
						: {}),
					...result,
					_meta: {
						...meta,
						"io.modelcontextprotocol/serverInfo": {
							name: "OpenBot fixture",
							version: "1.0.0",
						},
					},
				},
			})
		})

	const app = Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const base = yield* Deferred.await(origin)
		const path = new URL(request.url, base).pathname
		const authorization = request.headers["authorization"]
		yield* Ref.update(
			requests,
			Arr.append({ path, method: request.method, authorization }),
		)
		if (
			options.presentation === true &&
			(path === "/icon.svg" || path === "/preview.svg")
		)
			return HttpServerResponse.text(path === "/icon.svg" ? icon : preview, {
				contentType: "image/svg+xml",
			})
		if (path === "/.well-known/oauth-protected-resource")
			return yield* HttpServerResponse.json({
				resource: base + "/protected",
				authorization_servers: [base],
				scopes_supported: ["documents"],
			})
		if (path === "/.well-known/oauth-authorization-server")
			return yield* HttpServerResponse.json({
				issuer: base,
				authorization_endpoint: base + "/authorize",
				token_endpoint: base + "/token",
				...((yield* Ref.get(revocationSupported))
					? { revocation_endpoint: base + "/revoke" }
					: {}),
				client_id_metadata_document_supported: yield* Ref.get(cimd),
				authorization_response_iss_parameter_supported: true,
				code_challenge_methods_supported: ["S256"],
				response_types_supported: ["code"],
				token_endpoint_auth_methods_supported: ["none"],
			})
		if (path === "/token" || path === "/revoke") {
			const form = new URLSearchParams(yield* request.text)
			if (path === "/token") return yield* token(base, form)
			if (yield* Ref.get(revocationFails)) return jsonText("{}", 503)
			yield* Ref.update(refreshTokens, HashSet.remove(form.get("token") ?? ""))
			yield* Ref.set(accessTokens, HashSet.empty())
			return jsonText("{}")
		}
		if (!Arr.contains(["/mcp", "/mcp-updated", "/protected"], path)) {
			if (
				authorization !== undefined ||
				request.headers["cookie"] !== undefined
			)
				return yield* fault(
					"An anonymous publication request got account credentials",
				)
			return HttpServerResponse.setHeader(
				yield* publicPlace(base, path),
				"cache-control",
				"no-cache",
			)
		}
		const bearer = pipe(
			Option.fromNullishOr(authorization),
			Option.map(Str.replace(/^Bearer /, "")),
			Option.getOrElse(() => ""),
		)
		if (
			path === "/protected" &&
			!HashSet.has(yield* Ref.get(accessTokens), bearer)
		)
			return HttpServerResponse.text("{}", {
				status: 401,
				contentType: "application/json",
				headers: {
					"www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="documents"`,
				},
			})
		return yield* mcp(request)
	})

	const fixture = yield* serveHttps(app)
	yield* Deferred.succeed(origin, fixture.ipOrigin)
	const base = fixture.ipOrigin
	const network = (owner: string) =>
		NodeHttpServer.layerUserNetwork({
			owner,
			allowedOrigins: [base],
			allowAddress: (ip) => ip === "127.0.0.1",
			ca: fixture.ca,
		})
	/**
	 * Gives the redirect of the authorization server for an authorization URL
	 * of OpenBot, with a new code for the token endpoint.
	 */
	const issueCode = Effect.fn("AppFixture.issueCode")(function* (
		authorizationUrl: string,
	) {
		const params = new URL(authorizationUrl).searchParams
		if (
			params.get("resource") !== base + "/protected" ||
			params.get("code_challenge_method") !== "S256"
		)
			return yield* UnexpectedAuthorizationRequest.make({
				url: authorizationUrl,
			})
		const code = yield* uuid
		yield* Ref.update(codes, HashMap.set(code, params))
		const callback = new URL(params.get("redirect_uri") ?? "")
		callback.searchParams.set("code", code)
		callback.searchParams.set("state", params.get("state") ?? "")
		callback.searchParams.set("iss", base)
		return callback.href
	})
	return {
		/** The origin of the publisher, such as https://127.0.0.1:4000. */
		origin: base,
		/** The self-signed certificate of the publisher, as PEM text. */
		ca: fixture.ca,
		/** The MCP methods that the endpoints got, in order. */
		operations: Ref.get(operations),
		/** How many tool calls ran their business handler. */
		businessCalls: Ref.get(businessCalls),
		/** What the write_board tool wrote, in order. */
		writes: Ref.get(writes),
		/** How many tool calls asked for input. */
		inputStarts: Ref.get(inputStarts),
		/** Tool calls ask for input before they run. */
		setInputRequired: (value: boolean) => Ref.set(inputRequired, value),
		/** Tool calls break the connection instead of giving their result. */
		setDropResult: (value: boolean) => Ref.set(dropResult, value),
		/** Tool calls give structured content that does not match their schema. */
		setInvalidOutput: (value: boolean) => Ref.set(invalidOutput, value),
		/** The most token requests that ran at the same time. */
		maxTokenRequests: Ref.get(maxInFlight),
		/** Token answers wait this many milliseconds. */
		setTokenDelay: (value: number) => Ref.set(tokenDelay, value),
		/** The authorization server names a revocation endpoint. */
		setRevocationSupported: (value: boolean) =>
			Ref.set(revocationSupported, value),
		/** The revocation endpoint answers with status 503. */
		setRevocationFails: (value: boolean) => Ref.set(revocationFails, value),
		issueCode,
		/** How many token requests came in. */
		exchanges: Ref.get(exchanges),
		/** The authorization server says that it supports client ID metadata documents. */
		setCimd: (value: boolean) => Ref.set(cimd, value),
		/** The token endpoint refuses every grant. */
		setRejectGrant: (value: boolean) => Ref.set(rejectGrant, value),
		/** How the publisher gives its cards and catalog. */
		setPublication: (value: PublicationMode) => Ref.set(publication, value),
		/** The description of the cards. */
		setDescription: (value: string) => Ref.set(description, value),
		/** The website URL of the cards. */
		setWebsite: (value: string) => Ref.set(websiteUrl, Option.some(value)),
		/** The card URLs of the catalog. */
		setDeclarations: (value: ReadonlyArray<string>) =>
			Ref.set(declarations, Option.some(value)),
		/**
		 * A public network that may read the publisher and the other given
		 * origins, and trusts their certificates.
		 */
		publicNetwork: (
			additional: {
				readonly origins: ReadonlyArray<string>
				readonly cas: ReadonlyArray<string>
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
						allowedOrigins: [base, ...additional.origins],
						allowAddress: (ip) => ip === "127.0.0.1",
						ca: [fixture.ca, ...additional.cas],
					}),
				),
			),
		/** Catalog discovery that may read the publisher. */
		discovery: CatalogDiscovery.layer().pipe(
			Layer.provide(CatalogDiscovery.layerRules),
			Layer.provide(network("anonymous-fixture")),
		),
		/** The App probe, with a network that may read the publisher. */
		probe: Probe.layerWithNetwork((connection) => network(connection.owner)),
		/** The cards name a new MCP endpoint. */
		changeCard: Ref.update(revision, (count) => count + 1),
		/** Every request that the publisher got, in order. */
		requests: Ref.get(requests),
	}
})

/** A started publisher. */
export type Publisher = Effect.Success<ReturnType<typeof start>>
