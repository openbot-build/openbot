import { AuthApi } from "@openbot-build/api"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Model, Provider } from "@openbot-build/core"
import {
	Auth,
	DatabasePostgres,
	HostTools,
	OpenBot,
	Server,
} from "../src/index.ts"
import {
	Array as Arr,
	Console,
	Context,
	Effect,
	Exit,
	HashMap,
	HashSet,
	Layer,
	Option,
	pipe,
	Redacted,
	Ref,
	Schema,
	Scope,
	Stream,
	String as Str,
	SynchronizedRef,
} from "effect"
import { LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/ai"
import {
	Cookies,
	FetchHttpClient,
	Headers,
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	HttpServer,
} from "effect/http"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import * as Caller from "./Caller.ts"
import * as DefaultBot from "./DefaultBot.ts"
import * as PostgresTest from "./PostgresTest.ts"
import type { Discovery, Network } from "@openbot-build/protocol"
import type { AppIndexApi, Settings as SettingsApi } from "@openbot-build/api"
import * as Probe from "../src/apps/Probe.ts"
import * as AppHost from "../src/apps/AppHost.ts"
import * as DomainControl from "../src/apps/DomainControl.ts"
import * as AppDiscovery from "../src/apps/Discovery.ts"
import * as OutboundPolicy from "../src/network/OutboundPolicy.ts"
import { organizationDomains } from "../src/database/Schema.ts"
import { Settings } from "../src/settings/Settings.ts"
import type { PlatformDocument } from "../src/settings/Documents.ts"
import * as Db from "../src/database/Database.ts"
import * as Drivers from "../src/computers/Drivers.ts"
import type { LiveBackends } from "../src/models/LiveBackends.ts"
import * as VaultReaders from "../src/vaults/Readers.ts"

/** How a test host starts. */
export interface Options {
	readonly publicOrigin: string
	readonly port?: number
	readonly model?: typeof LanguageModel.LanguageModel.Service
	readonly contextWindow?: number
	readonly hostTools?: Layer.Layer<HostTools.HostTools>
	readonly discovery?: Layer.Layer<Discovery.Discovery>
	readonly appProbe?: Layer.Layer<Probe.Probe>
	readonly appNetwork?: Layer.Layer<AppHost.AppNetwork>
	readonly indexPublicNetwork?: Layer.Layer<Network.PublicNetwork>
	readonly appReadRules?: ReadonlyArray<{
		readonly cardUrl: string
		readonly tool: string
	}>
	readonly appRestrictions?: ReadonlyArray<AppIndexApi.Restriction>
	/** Turns Code Mode on for the platform, with these limits. */
	readonly codeMode?: SettingsApi.CodeMode
	/**
	 * Test accounts have verified emails at example.com. By default the
	 * organization of the first account verifies that domain, so every later
	 * account joins it. Set false to give each account its own organization.
	 */
	readonly sharedDomain?: boolean
	readonly domainControl?: Layer.Layer<DomainControl.DomainControl>
	/** People with these emails are platform admins. */
	readonly platformAdmins?: ReadonlyArray<string>
	/**
	 * The platform has no fixture model, as in production: no built-in model
	 * and no default model. Then each Chat or its Bot must name a stored model.
	 * Without it, every organization can use the fixture model, and each new
	 * Chat gets it.
	 */
	readonly registryModels?: boolean
	readonly indexWork?: {
		readonly intervalMs?: number
		readonly retryMs?: number
	}
	/** How often the trigger worker looks for schedules that are due. */
	/** How often the Channel worker looks for new events and messages. */

	/**
	 * Answers the HTTP calls of the server to other places, such as Slack.
	 * Without it, such a call fails.
	 */
	readonly platformFetch?: (
		request: globalThis.Request,
	) => Effect.Effect<globalThis.Response>
	/** The drivers of the Computer providers. */
	readonly computerDrivers?: Layer.Layer<Drivers.Drivers>
	/** The Live backends. */
	readonly liveBackends?: Layer.Layer<LiveBackends>
	readonly vaultReaders?: Layer.Layer<VaultReaders.Readers>
	/** Organization settings for the Bots of each new organization. */
	readonly bots?: {
		readonly memory?: boolean
		readonly requestTimeoutMs?: number
	}
}

/** The server called the test identity provider at a place that it does not know. */
export class UnexpectedProviderCall extends Schema.TaggedError<
	UnexpectedProviderCall,
	{ readonly brand: unique symbol }
>()("UnexpectedProviderCall", { url: Schema.String }) {
	override get message() {
		return "Unexpected fixture provider origin: " + this.url
	}
}

/** A test account could not sign in, or could not get an organization. */
export class LoginFailed extends Schema.TaggedError<
	LoginFailed,
	{ readonly brand: unique symbol }
>()("LoginFailed", { subject: Schema.String, message: Schema.String }) {}

/** The services that `start` needs: the Node services and the fetch HTTP client. */
export const layerPlatform = Layer.merge(
	NodeServices.layer,
	FetchHttpClient.layer,
)

const issuer = "https://id.example.com"

/** The code that the test identity provider gives back, as JSON text. */
const Code = Schema.fromJsonString(
	Schema.Struct({ subject: Schema.String, nonce: Schema.String }),
)

const SignInStart = Schema.Struct({ url: Schema.String })

/** Whether a fetch call goes to the test identity provider. */
const isIssuer = (input: string | URL | globalThis.Request) =>
	new URL(input instanceof globalThis.Request ? input.url : String(input))
		.origin === issuer

const isUser = (message: Prompt.Message): message is Prompt.UserMessage =>
	message.role === "user"

const usage = {
	inputTokens: { total: 12, uncached: 12, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 6, text: 6, reasoning: 0 },
}

/**
 * Starts a disposable OpenBot host with a real PostgreSQL and signed OIDC test
 * identities. Everything stops when the scope closes. Give it `layerPlatform`,
 * and run the test with `it.live`, because the host uses real time.
 */
export const start = Effect.fn("BrowserHost.start")(function* (
	options: Options,
) {
	const client = yield* HttpClient.HttpClient
	const context = yield* Effect.context<never>()
	const database = yield* PostgresTest.start
	const pair = yield* Effect.promise(() =>
		generateKeyPair("EdDSA", { extractable: true }),
	)
	const publicKey = yield* Effect.promise(() => exportJWK(pair.publicKey))

	/** Answers the calls of the server to the test identity provider. */
	const provider = Effect.fn("BrowserHost.provider")(function* (
		request: globalThis.Request,
	) {
		if (!isIssuer(request.url))
			return yield* UnexpectedProviderCall.make({ url: request.url })
		const url = new URL(request.url)
		if (url.pathname === "/.well-known/openid-configuration")
			return globalThis.Response.json({
				issuer,
				authorization_endpoint: issuer + "/authorize",
				token_endpoint: issuer + "/token",
				userinfo_endpoint: issuer + "/userinfo",
				jwks_uri: issuer + "/jwks",
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["client_secret_basic"],
				id_token_signing_alg_values_supported: ["EdDSA"],
			})
		if (url.pathname === "/jwks")
			return globalThis.Response.json({
				keys: [{ ...publicKey, kid: "browser-test", alg: "EdDSA", use: "sig" }],
			})
		if (url.pathname === "/userinfo") {
			const subject = pipe(
				Option.fromNullishOr(request.headers.get("authorization")),
				Option.map(Str.replace("Bearer access-", "")),
				Option.getOrElse(() => ""),
			)
			return globalThis.Response.json({
				sub: subject,
				name: "Browser User",
				email: subject + "@example.com",
				email_verified: true,
			})
		}
		const form = new URLSearchParams(
			yield* Effect.promise(() => request.text()),
		)
		const code = yield* Schema.decodeUnknownEffect(Code)(form.get("code"))
		const token = yield* Effect.promise(() =>
			new SignJWT({ nonce: code.nonce })
				.setProtectedHeader({ alg: "EdDSA", kid: "browser-test" })
				.setIssuer(issuer)
				.setAudience("browser-fixture")
				.setSubject(code.subject)
				.setExpirationTime("1 hour")
				.sign(pair.privateKey),
		)
		return globalThis.Response.json({
			access_token: "access-" + code.subject,
			id_token: token,
			token_type: "Bearer",
			scope: "openid profile email",
		})
	})
	/** Gives an Effect handler the shape of `fetch`, for code outside of Effect. */
	const toFetch =
		<E>(
			handle: (
				request: globalThis.Request,
			) => Effect.Effect<globalThis.Response, E>,
		): typeof fetch =>
		(input, init) =>
			Effect.runPromiseWith(context)(
				handle(new globalThis.Request(input, init)),
			)
	const providerFetch = toFetch(provider)
	// This file also runs alone as a script, outside of Vitest. better-auth
	// calls the global fetch, so the host changes it by hand and puts the real
	// one back when the scope closes.
	yield* Effect.acquireRelease(
		Effect.sync(() => {
			const actual = globalThis.fetch
			globalThis.fetch = (input, init) => {
				if (isIssuer(input)) return providerFetch(input, init)
				// @effect-diagnostics-next-line globalFetch:off -- better-auth calls the global fetch, so every other call must still reach the real network.
				return actual(input, init)
			}
			return actual
		}),
		(actual) =>
			Effect.sync(() => {
				globalThis.fetch = actual
			}),
	)

	const confirm = Tool.make("ConfirmChange", {
		description: "Apply the proposed change after approval",
		parameters: Schema.Struct({ description: Schema.String }),
		success: Schema.Struct({ applied: Schema.String }),
		needsApproval: true,
	})
	// A small store of named values, so a test can change state with a tool and check it.
	// A key in `locked` cannot change, unless the call sets `force`.
	const values = yield* Ref.make(HashMap.empty<string, string>())
	const locked = yield* Ref.make(HashSet.empty<string>())
	const setValue = Tool.make("SetValue", {
		description: "Set a named value",
		parameters: Schema.Struct({
			key: Schema.String,
			value: Schema.String,
			force: Schema.optionalKey(Schema.Boolean),
		}),
		success: Schema.Struct({ key: Schema.String, value: Schema.String }),
		failure: Schema.Struct({ error: Schema.String }),
		failureMode: "return",
	})
	const getValue = Tool.make("GetValue", {
		description: "Read a named value",
		parameters: Schema.Struct({ key: Schema.String }),
		success: Schema.Struct({ value: Schema.NullOr(Schema.String) }),
	})
	const toolkit = Toolkit.make(confirm, setValue, getValue)
	const toolCalls = yield* Ref.make(0)
	const handlers = toolkit.toLayer({
		ConfirmChange: ({ description }) =>
			Ref.update(toolCalls, (count) => count + 1).pipe(
				Effect.as({ applied: description }),
			),
		SetValue: ({ key, value, force }) =>
			Effect.gen(function* () {
				if (HashSet.has(yield* Ref.get(locked), key) && force !== true)
					return yield* Effect.fail({
						error: "The value " + key + " is locked.",
					})
				yield* Ref.update(values, HashMap.set(key, value))
				return { key, value }
			}),
		GetValue: ({ key }) =>
			Effect.map(Ref.get(values), (current) => ({
				value: Option.getOrNull(HashMap.get(current, key)),
			})),
	})
	const consolidations = yield* Ref.make(0)
	const model = yield* LanguageModel.make({
		generateText: () =>
			Ref.update(consolidations, (count) => count + 1).pipe(
				Effect.as([Response.makePart("text", { text: '{"changes":[]}' })]),
			),
		streamText: ({ prompt }) =>
			Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
				const found = Arr.findLastIndex(prompt.content, isUser)
				const lastUser = Option.getOrElse(found, () => -1)
				const input = pipe(
					found,
					Option.flatMap((index) => Arr.get(prompt.content, index)),
					Option.filter(isUser),
					Option.map((message) =>
						pipe(
							message.content,
							Arr.filter((part) => part.type === "text"),
							Arr.map((part) => part.text),
							Arr.join(""),
						),
					),
					Option.getOrElse(() => ""),
				)
				const answered = Arr.some(
					Arr.drop(prompt.content, lastUser + 1),
					(message) =>
						message.role === "tool" &&
						Arr.some(message.content, (part) => part.type === "tool-result"),
				)
				if (Str.includes("approval")(Str.toLowerCase(input)) && !answered)
					return Stream.make(
						Response.makePart("tool-call", {
							id: "fixture-call-" + lastUser,
							name: "ConfirmChange",
							params: { description: "Write the requested result" },
							providerExecuted: false,
						}),
						Response.makePart("finish", { reason: "tool-calls", usage }),
					)
				const chunks = Stream.fromIterable([
					"## A useful result\n\n",
					"Working through your request. ",
					"Progress stays with your Chat.\n\n",
					"- Evidence is recorded.\n- You can keep building from here.",
				]).pipe(
					Stream.mapEffect((text) =>
						Effect.sleep(
							Str.includes("slow")(input) ? "2 seconds" : "100 millis",
						).pipe(
							Effect.as(
								Response.makePart("text-delta", { id: "text", delta: text }),
							),
						),
					),
				)
				return Stream.make(
					Response.makePart("text-start", { id: "text" }),
				).pipe(
					Stream.concat(chunks),
					Stream.concat(
						Stream.make(
							Response.makePart("text-end", { id: "text" }),
							Response.makePart("finish", { reason: "stop", usage }),
						),
					),
				)
			}),
	})
	const provider_ = Provider.Id.make("fixture")
	const modelId = Model.Id.make("fixture-model")
	const catalog = {
		providers: [{ id: provider_, name: "Test provider" }],
		models: [
			Config.Model.make({
				provider: provider_,
				id: modelId,
				name: "Fixture model",
				description: "A model with fixed answers for browser integration tests",
				reasoningEfforts: ["low", "high"],
				serviceTiers: ["default", "priority"],
				contextWindow: options.contextWindow ?? 32000,
				maxOutputTokens: options.contextWindow === undefined ? 4000 : 100,
			}),
		],
	}
	const configuration = {
		...(options.platformAdmins === undefined
			? {}
			: { platformAdmins: options.platformAdmins }),
		...(options.indexWork === undefined
			? {}
			: { indexWork: options.indexWork }),

		host: "127.0.0.1",
		port: options.port ?? 0,
		databaseUrl: Redacted.make(database.url),
		clusterSecret: Redacted.make(
			"test-cluster-secret-with-at-least-32-characters",
		),
		secretKeys: Redacted.make(
			"test:" +
				"1111111111111111111111111111111111111111111111111111111111111111",
		),
		auth: {
			publicOrigin: options.publicOrigin,
			issuer,
			clientId: "browser-fixture",
			clientSecret: Redacted.make("fixture-secret"),
			secret: Redacted.make(
				"IntegrationSecretForBetterAuthMustStayStable123456",
			),
		},
		// Every organization can use the fixture model, and each new Chat gets it.
		...(options.registryModels === true
			? {}
			: {
					builtinModels: {
						...catalog,
						resolve: () => Effect.succeed(options.model ?? model),
						defaultModel: Config.Selection.make({
							provider: provider_,
							model: modelId,
						}),
					},
				}),
	}
	// The migration has its own database pool. It closes after the migration.
	yield* DatabasePostgres.migrate.pipe(
		Effect.provide(
			DatabasePostgres.layer(configuration).pipe(
				Layer.provide(NodeServices.layer),
			),
		),
	)
	const platformFetch = options.platformFetch
	/** The services from outside of OpenBot: the fakes of the test, or the real ones. */
	const outside = Layer.mergeAll(
		options.computerDrivers ?? Drivers.layer,
		options.liveBackends ?? OpenBot.layerLiveBackends,
		options.vaultReaders ?? VaultReaders.layer,
		options.appProbe ?? Probe.layer,
		options.appNetwork ?? AppHost.layerNetwork,
		options.domainControl ?? DomainControl.layer,
		options.indexPublicNetwork ?? OutboundPolicy.layerPublicNetwork,
		options.discovery ?? AppDiscovery.layerPublic,
	)
	const serverLayer = Server.layerFixed(configuration).pipe(
		Layer.provide(
			Layer.merge(
				outside,
				options.hostTools ??
					HostTools.layer({
						toolkit,
						handlers: () => handlers,
						instructions: Prompt.make([
							{
								role: "system",
								content: "The host tools belong to this test server.",
							},
						]),
					}),
			),
		),
		Layer.provideMerge(OpenBot.layerShared(configuration)),
		// The HTTP calls of the server go to the test identity provider or to `platformFetch`.
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(
			Layer.succeed(
				FetchHttpClient.Fetch,
				toFetch((request) =>
					!isIssuer(request.url) && platformFetch !== undefined
						? platformFetch(request)
						: provider(request),
				),
			),
		),
	)
	const scope = yield* Effect.scope
	/**
	 * Starts the server in its own scope, so that a restart can stop it alone.
	 * A new memo map builds every layer again, as in a new process.
	 */
	const launch = Effect.gen(function* () {
		const serverScope = yield* Scope.fork(scope)
		const services = yield* Layer.buildWithMemoMap(
			serverLayer,
			yield* Layer.makeMemoMap,
			serverScope,
		)
		return {
			scope: serverScope,
			services,
			address: HttpServer.formatAddress(
				Context.get(services, HttpServer.HttpServer).address,
			),
		}
	})
	const server = yield* SynchronizedRef.make(yield* launch)
	/** Runs an Effect with the services of the running server. */
	const run = <A, E>(
		effect: Effect.Effect<A, E, Layer.Success<typeof serverLayer>>,
	) =>
		Effect.flatMap(SynchronizedRef.get(server), (current) =>
			Effect.provideContext(effect, current.services),
		)
	const address = Effect.map(
		SynchronizedRef.get(server),
		(current) => current.address,
	)
	/** Changes the platform settings, when the platform has them. */
	const updatePlatform = (
		change: (document: PlatformDocument) => PlatformDocument,
	) =>
		run(
			Effect.gen(function* () {
				const settings = yield* Settings
				const current = yield* settings.platform
				if (Option.isNone(current)) return
				yield* settings.updatePlatform(current.value.version, (document) =>
					Effect.succeed(change(document)),
				)
			}),
		)
	if (options.appRestrictions !== undefined) {
		const restrictions = options.appRestrictions
		yield* updatePlatform((document) => ({
			...document,
			appRestrictions: restrictions,
		}))
	}
	if (options.codeMode !== undefined) {
		const codeMode = options.codeMode
		yield* updatePlatform((document) => ({ ...document, codeMode }))
	}
	/** Organizations that already have the test settings. */
	const prepared = yield* Ref.make(HashSet.empty<string>())
	/** Give a new organization the test settings, and the shared domain. */
	const prepare = (organizationId: string) =>
		run(
			Effect.gen(function* () {
				const before = yield* Ref.getAndUpdate(
					prepared,
					HashSet.add(organizationId),
				)
				if (HashSet.has(before, organizationId)) return
				const settings = yield* Settings
				const current = yield* settings.organization(organizationId)
				yield* settings.updateOrganization(
					organizationId,
					current.version,
					(document) =>
						Effect.succeed({
							...document,
							...(options.appReadRules === undefined
								? {}
								: { appReadRules: options.appReadRules }),
							...(options.bots?.memory === undefined
								? {}
								: { botMemory: options.bots.memory }),
							...(options.bots?.requestTimeoutMs === undefined
								? {}
								: { requestTimeoutMs: options.bots.requestTimeoutMs }),
						}),
				)
				if (options.sharedDomain === false || HashSet.size(before) > 0) return
				const db = yield* Db.make
				yield* db.insert(organizationDomains).values({
					organizationId,
					domain: "example.com",
					token: "openbot-verification=test",
					verifiedAt: 0,
					createdAt: 0,
				})
			}),
		)
	/** Calls the server as a signed-in browser. */
	const withCookie = Effect.map(address, (current) =>
		Caller.withCookie({
			address: current,
			publicOrigin: options.publicOrigin,
		}),
	)
	/** Makes an organization for a new account through the API. */
	const makeOrganization = Effect.fn("BrowserHost.makeOrganization")(function* (
		session: Redacted.Redacted<string>,
		subject: string,
	) {
		const call = yield* withCookie
		const created = yield* call(session, "/v1/organizations", "POST", {
			name: subject,
		})
		if (created.status < 200 || created.status >= 300)
			return yield* LoginFailed.make({
				subject,
				message:
					"The test account cannot make an organization: " +
					created.status +
					" " +
					(yield* created.text),
			})
	})
	/**
	 * Signs in a test account through the OIDC flow of the server. A new
	 * account makes its own organization, unless `organization` is false.
	 */
	const login = Effect.fn("BrowserHost.login")(
		function* (
			subject: string,
			returnTo?: string,
			loginOptions: { readonly organization?: boolean } = {},
		) {
			const current = yield* address
			const started = yield* HttpClientRequest.post(
				current + "/auth/sign-in/social",
				{ headers: { origin: options.publicOrigin } },
			).pipe(
				HttpClientRequest.bodyJson({
					provider: "oidc",
					callbackURL: options.publicOrigin + (returnTo ?? "/"),
					disableRedirect: true,
				}),
				Effect.flatMap(client.execute),
			)
			const authorization = new URL(
				(yield* HttpClientResponse.schemaBodyJson(SignInStart)(started)).url,
			)
			const code = yield* Schema.encodeEffect(Code)({
				subject,
				nonce: authorization.searchParams.get("nonce") ?? "",
			})
			const callback = yield* client
				.execute(
					HttpClientRequest.get(
						current +
							"/auth/callback/oidc?" +
							new URLSearchParams({
								state: authorization.searchParams.get("state") ?? "",
								iss: issuer,
								code,
							}),
						{
							headers: { cookie: Cookies.toCookieHeader(started.cookies) },
						},
					),
				)
				.pipe(
					Effect.provideService(FetchHttpClient.RequestInit, {
						redirect: "manual",
					}),
				)
			const session = Redacted.make(
				Option.getOrElse(
					Cookies.getValue(callback.cookies, AuthApi.SessionCookie),
					() => "",
				),
			)
			const resolve = run(
				Effect.flatMap(Auth.Auth, (auth) => auth.resolveSession(session)),
			)
			const first = yield* resolve
			// A new account has no organization. Like a person, it makes one for itself.
			const needsOrganization =
				Arr.isReadonlyArrayEmpty(first.memberships) &&
				loginOptions.organization !== false
			if (needsOrganization) yield* makeOrganization(session, subject)
			const info = needsOrganization ? yield* resolve : first
			const organizationId = pipe(
				Arr.head(info.memberships),
				Option.map((membership) => membership.organizationId),
				Option.getOrElse(() => ""),
			)
			if (organizationId === "" && loginOptions.organization !== false)
				return yield* LoginFailed.make({
					subject,
					message: "The test account has no organization",
				})
			if (organizationId !== "") yield* prepare(organizationId)
			return {
				session,
				identity: {
					kind: "member" as const,
					userId: info.userId,
					organizationId,
				},
				memberships: info.memberships,
				returnLocation: Headers.get(callback.headers, "location"),
			}
		},
		Effect.provideService(HttpClient.HttpClient, client),
	)
	/** Sets up a default Bot for the person, when they have none. */
	const defaultBot = (session: Redacted.Redacted<string>) =>
		Effect.flatMap(withCookie, (call) =>
			DefaultBot.ensure((path, method, payload) =>
				call(session, path, method, payload),
			),
		).pipe(Effect.provideService(HttpClient.HttpClient, client))
	return {
		/** The URL of the test database. */
		databaseUrl: database.url,
		/** The address of the running server, such as http://127.0.0.1:4000. A restart changes it. */
		address,
		run,
		/** Stops the server and starts a new one on the same database. */
		restart: SynchronizedRef.updateEffect(server, (current) =>
			Scope.close(current.scope, Exit.void).pipe(Effect.andThen(launch)),
		),
		login,
		defaultBot,
		/** How many times the ConfirmChange tool ran. */
		toolCalls: Ref.get(toolCalls),
		/** The named values of the SetValue and GetValue tools. */
		values,
		/** The names of values that only a forced SetValue call can change. */
		locked,
		/** How many times the fixture model gave a whole text answer. */
		consolidations: Ref.get(consolidations),
	}
})

/** A started test host. */
export type Host = Effect.Success<ReturnType<typeof start>>

// Run alone, the file starts a host on port 3000 and keeps it until the process stops.
if (import.meta.main) {
	const host = Layer.effectDiscard(
		Effect.andThen(
			start({ publicOrigin: "https://localhost:5173", port: 3000 }),
			Console.log("Browser test OpenBot is ready on http://127.0.0.1:3000"),
		),
	)
	NodeRuntime.runMain(Layer.launch(host.pipe(Layer.provide(layerPlatform))))
}
