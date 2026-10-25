import { AuthApi } from "@openbot-build/api"
import { NodeServices } from "@effect/platform-node"
import { Config, Model, Provider } from "@openbot-build/core"
import { Auth, Server, DatabasePostgres } from "@openbot-build/openbot"
import {
	Option,
	Match,
	Effect,
	Layer,
	ManagedRuntime,
	Redacted,
	Schema,
	Stream,
} from "effect"
import { LanguageModel, Response, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient, HttpServer } from "effect/http"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import * as DefaultBot from "./DefaultBot.ts"
import * as PostgresTest from "./PostgresTest.ts"
import type { Discovery, Network } from "@openbot-build/protocol"
import type { AppIndexApi, Settings as SettingsApi } from "@openbot-build/api"
import type { Probe } from "../src/apps/Probe.ts"
import type { AppNetwork } from "../src/apps/AppHost.ts"
import type { DomainControl } from "../src/apps/DomainControl.ts"
import { organizationDomains } from "../src/database/Schema.ts"
import { Settings } from "../src/settings/Settings.ts"
import * as Db from "../src/database/Database.ts"
import type { Drivers } from "../src/computers/Drivers.ts"
import type { LiveBackends } from "../src/models/LiveBackends.ts"

/** A disposable OpenBot host with real PostgreSQL and signed OIDC test identities. */
export async function start(options: {
	readonly publicOrigin: string
	readonly port?: number
	readonly model?: typeof LanguageModel.LanguageModel.Service
	readonly discovery?: Layer.Layer<Discovery.Discovery>
	readonly appProbe?: Layer.Layer<Probe>
	readonly appNetwork?: Layer.Layer<AppNetwork>
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
	readonly domainControl?: Layer.Layer<DomainControl>
	/** People with these emails are platform admins. */
	readonly platformAdmins?: ReadonlyArray<string>
	/**
	 * Chats use the stored model providers, as in production, instead of the
	 * fixture model. Then each Chat or its Bot must name a model, and model calls are metered.
	 */
	readonly registryModels?: boolean
	readonly indexWork?: {
		readonly intervalMs?: number
		readonly retryMs?: number
	}
	/** How often the trigger worker looks for schedules that are due. */
	readonly triggerIntervalMs?: number
	/** How often the Channel worker looks for new events and messages. */
	readonly channelIntervalMs?: number
	/** How often the file garbage collector runs. */
	readonly fileIntervalMs?: number
	/** Answers the HTTP calls of the server to other places, such as Slack. */
	readonly platformFetch?: typeof fetch
	/** The drivers of the Computer providers. */
	readonly computerDrivers?: Layer.Layer<Drivers>
	/** The Live backends. */
	readonly liveBackends?: Layer.Layer<LiveBackends>
	/** Organization settings for the Bots of each new organization. */
	readonly bots?: {
		readonly memory?: boolean
		readonly requestTimeoutMs?: number
	}
}) {
	const database = await PostgresTest.start()
	const issuer = "https://id.example.com"
	const pair = await generateKeyPair("EdDSA", { extractable: true })
	const publicKey = await exportJWK(pair.publicKey)
	const codeSchema = Schema.Struct({
		subject: Schema.String,
		nonce: Schema.String,
	})
	const json = (value: unknown) =>
		new globalThis.Response(JSON.stringify(value), {
			headers: { "content-type": "application/json" },
		})
	const providerFetch: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		if (url.origin !== issuer)
			throw new Error("Unexpected fixture provider origin")
		if (url.pathname === "/.well-known/openid-configuration")
			return json({
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
			return json({
				keys: [{ ...publicKey, kid: "browser-test", alg: "EdDSA", use: "sig" }],
			})
		if (url.pathname === "/userinfo") {
			const subject =
				new Headers(init?.headers)
					.get("authorization")
					?.replace("Bearer access-", "") ?? ""
			return json({
				sub: subject,
				name: "Browser User",
				email: subject + "@example.com",
				email_verified: true,
			})
		}
		const form = new URLSearchParams(
			await new globalThis.Response(init?.body).text(),
		)
		const code = Schema.decodeUnknownSync(Schema.fromJsonString(codeSchema))(
			form.get("code"),
		)
		const token = await new SignJWT({ nonce: code.nonce })
			.setProtectedHeader({ alg: "EdDSA", kid: "browser-test" })
			.setIssuer(issuer)
			.setAudience("browser-fixture")
			.setSubject(code.subject)
			.setExpirationTime("1 hour")
			.sign(pair.privateKey)
		return json({
			access_token: "access-" + code.subject,
			id_token: token,
			token_type: "Bearer",
			scope: "openid profile email",
		})
	}
	// This file also runs alone as a script, outside of Vitest, so it changes
	// fetch by hand and puts the real one back when it closes.
	const actualFetch = globalThis.fetch
	globalThis.fetch = (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		return url.origin === issuer
			? providerFetch(input, init)
			: actualFetch(input, init)
	}
	const restoreFetch = () => {
		globalThis.fetch = actualFetch
	}
	const confirm = Tool.make("ConfirmChange", {
		description: "Apply the proposed change after approval",
		parameters: Schema.Struct({ description: Schema.String }),
		success: Schema.Struct({ applied: Schema.String }),
		needsApproval: true,
	})
	// A small store of named values, so a test can change state with a tool and check it.
	// A key in `locked` cannot change, unless the call sets `force`.
	const values = new Map<string, string>()
	const locked = new Set<string>()
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
	let toolCalls = 0
	const handlers = toolkit.toLayer({
		ConfirmChange: ({ description }) =>
			Effect.sync(() => {
				toolCalls++
				return { applied: description }
			}),
		SetValue: ({ key, value, force }) =>
			locked.has(key) && force !== true
				? Effect.fail({ error: "The value " + key + " is locked." })
				: Effect.sync(() => {
						values.set(key, value)
						return { key, value }
					}),
		GetValue: ({ key }) =>
			Effect.sync(() => ({ value: values.get(key) ?? null })),
	})
	const usage = {
		inputTokens: { total: 12, uncached: 12, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 6, text: 6, reasoning: 0 },
	}
	let consolidations = 0
	const model = await Effect.runPromise(
		LanguageModel.make({
			generateText: () =>
				Effect.sync(() => {
					consolidations++
					return [Response.makePart("text", { text: '{"changes":[]}' })]
				}),
			streamText: ({ prompt }) =>
				Stream.suspend((): Stream.Stream<Response.StreamPartEncoded> => {
					const lastUser = prompt.content.findLastIndex(
						(message) => message.role === "user",
					)
					const message = prompt.content[lastUser]
					const input = Match.value(message).pipe(
						Match.when({ role: "user" }, (message) =>
							message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join(""),
						),
						Match.orElse(() => "" as const),
					)
					const answered = prompt.content
						.slice(lastUser + 1)
						.some(
							(message) =>
								message.role === "tool" &&
								message.content.some((part) => part.type === "tool-result"),
						)
					if (input.toLowerCase().includes("approval") && !answered)
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
								input.includes("slow") ? "2 seconds" : "100 millis",
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
		}),
	)
	const provider = Provider.Id.make("fixture")
	const modelId = Model.Id.make("fixture-model")
	const catalog = {
		providers: [{ id: provider, name: "Test provider" }],
		models: [
			Config.Model.make({
				provider,
				id: modelId,
				name: "Fixture model",
				description: "A model with fixed answers for browser integration tests",
				reasoningEfforts: ["low", "high"],
				serviceTiers: ["default", "priority"],
				contextWindow: 32000,
				maxOutputTokens: 4000,
			}),
		],
	}
	const configuration = {
		...(options.platformAdmins === undefined
			? {}
			: { platformAdmins: options.platformAdmins }),
		...(options.domainControl === undefined
			? {}
			: { domainControl: options.domainControl }),
		...(options.appNetwork === undefined
			? {}
			: { appNetwork: options.appNetwork }),
		...(options.indexPublicNetwork === undefined
			? {}
			: { indexPublicNetwork: options.indexPublicNetwork }),
		...(options.indexWork === undefined
			? {}
			: { indexWork: options.indexWork }),
		...(options.triggerIntervalMs === undefined
			? {}
			: { triggers: { interval: options.triggerIntervalMs } }),
		...(options.channelIntervalMs === undefined
			? {}
			: { channels: { interval: options.channelIntervalMs } }),
		...(options.fileIntervalMs === undefined
			? {}
			: { files: { interval: options.fileIntervalMs } }),
		...(options.computerDrivers === undefined
			? {}
			: { computerDrivers: options.computerDrivers }),
		...(options.liveBackends === undefined
			? {}
			: { liveBackends: options.liveBackends }),
		...(options.discovery === undefined
			? {}
			: { discovery: options.discovery }),
		...(options.appProbe === undefined ? {} : { appProbe: options.appProbe }),
		host: "127.0.0.1",
		port: options.port ?? 0,
		databaseUrl: Redacted.make(database.url),
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
		chats: {
			runtime: { toolkit },
			layerExecution: () => handlers,
			...(options.registryModels === true
				? {}
				: {
						modelCatalog: Effect.succeed(catalog),
						defaults: Effect.succeed({
							model: Config.Selection.make({ provider, model: modelId }),
						}),
						resolveModel: () => Effect.succeed(options.model ?? model),
					}),
		},
	}
	const migration = ManagedRuntime.make(
		DatabasePostgres.layer(configuration).pipe(
			Layer.provide(NodeServices.layer),
		),
	)
	try {
		await migration.runPromise(DatabasePostgres.migrate)
		const makeRuntime = () =>
			ManagedRuntime.make(
				Server.layerFixed(configuration).pipe(
					Layer.provide(
						Layer.mergeAll(
							handlers,
							Layer.succeed(FetchHttpClient.Fetch, (input, init) => {
								const url = new URL(
									input instanceof Request ? input.url : String(input),
								)
								return url.origin !== issuer &&
									options.platformFetch !== undefined
									? options.platformFetch(input, init)
									: providerFetch(input, init)
							}),
							Layer.succeed(LanguageModel.LanguageModel, model),
						),
					),
				),
			)
		let runtime = makeRuntime()
		let address = await runtime.runPromise(
			Effect.map(HttpServer.HttpServer, (server) =>
				HttpServer.formatAddress(server.address),
			),
		)
		if (options.appRestrictions !== undefined) {
			const restrictions = options.appRestrictions
			await runtime.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings
					const current = yield* settings.platform
					if (Option.isNone(current)) return
					yield* settings.updatePlatform(current.value.version, (document) =>
						Effect.succeed({ ...document, appRestrictions: restrictions }),
					)
				}),
			)
		}
		if (options.codeMode !== undefined) {
			const codeMode = options.codeMode
			await runtime.runPromise(
				Effect.gen(function* () {
					const settings = yield* Settings
					const current = yield* settings.platform
					if (Option.isNone(current)) return
					yield* settings.updatePlatform(current.value.version, (document) =>
						Effect.succeed({ ...document, codeMode }),
					)
				}),
			)
		}
		/** Organizations that already have the test settings. */
		const prepared = new Set<string>()
		/** Give a new organization the test settings, and the shared domain. */
		const prepare = (organizationId: string) =>
			runtime.runPromise(
				Effect.gen(function* () {
					if (prepared.has(organizationId)) return
					prepared.add(organizationId)
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
					if (options.sharedDomain === false || prepared.size > 1) return
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
		/** With `organization: false`, a new account keeps no organization. */
		const login = async (
			subject: string,
			returnTo?: string,
			loginOptions: { readonly organization?: boolean } = {},
		) => {
			const start = await fetch(address + "/auth/sign-in/social", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: options.publicOrigin,
				},
				body: JSON.stringify({
					provider: "oidc",
					callbackURL: options.publicOrigin + (returnTo ?? "/"),
					disableRedirect: true,
				}),
			})
			const authorization = new URL(
				((await start.json()) as { readonly url: string }).url,
			)
			const browser = start.headers
				.getSetCookie()
				.map((cookie) => cookie.split(";")[0])
				.join("; ")
			const code = JSON.stringify({
				subject,
				nonce: authorization.searchParams.get("nonce"),
			})
			const callback = await fetch(
				address +
					"/auth/callback/oidc?" +
					new URLSearchParams({
						state: authorization.searchParams.get("state") ?? "",
						iss: issuer,
						code,
					}),
				{ headers: { cookie: browser }, redirect: "manual" },
			)
			const cookie =
				callback.headers
					.getSetCookie()
					.find((value) => value.startsWith(AuthApi.SessionCookie + "="))
					?.split(";")[0] ?? ""
			const session = Redacted.make(
				decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)),
			)
			const resolve = () =>
				runtime.runPromise(
					Effect.flatMap(Auth.Auth, (auth) => auth.resolveSession(session)),
				)
			let info = await resolve()
			// A new account has no organization. Like a person, it makes one for itself.
			if (
				info.memberships.length === 0 &&
				loginOptions.organization !== false
			) {
				const created = await fetch(address + "/v1/organizations", {
					method: "POST",
					headers: {
						cookie:
							AuthApi.SessionCookie +
							"=" +
							encodeURIComponent(Redacted.value(session)),
						origin: options.publicOrigin,
						"content-type": "application/json",
					},
					body: JSON.stringify({ name: subject }),
				})
				if (!created.ok)
					throw new Error(
						"The test account cannot make an organization: " +
							created.status +
							" " +
							(await created.text()),
					)
				info = await resolve()
			}
			const organizationId = info.memberships[0]?.organizationId ?? ""
			if (organizationId === "" && loginOptions.organization !== false)
				throw new Error("The test account has no organization")
			if (organizationId !== "") await prepare(organizationId)
			return {
				session,
				identity: {
					kind: "member" as const,
					userId: info.userId,
					organizationId,
				},
				memberships: info.memberships,
				returnLocation: callback.headers.get("location"),
			}
		}
		/** Sets up a default Bot for the person, when they have none. */
		const defaultBot = (session: Redacted.Redacted<string>) =>
			DefaultBot.ensure((path, method, payload) =>
				fetch(address + path, {
					method,
					headers: {
						cookie:
							AuthApi.SessionCookie +
							"=" +
							encodeURIComponent(Redacted.value(session)),
						origin: options.publicOrigin,
						...(payload === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
				}),
			)
		return {
			databaseUrl: database.url,
			get runtime() {
				return runtime
			},
			get address() {
				return address
			},
			restart: async () => {
				await runtime.dispose()
				runtime = makeRuntime()
				address = await runtime.runPromise(
					Effect.map(HttpServer.HttpServer, (server) =>
						HttpServer.formatAddress(server.address),
					),
				)
			},
			login,
			defaultBot,
			toolCalls: () => toolCalls,
			values,
			locked,
			consolidations: () => consolidations,
			close: async () => {
				await runtime.dispose()
				restoreFetch()
				await migration.dispose()
				await database.close()
			},
		}
	} catch (error) {
		restoreFetch()
		await migration.dispose()
		await database.close()
		throw error
	}
}
if (import.meta.main) {
	const host = await start({
		publicOrigin: "https://localhost:5173",
		port: 3000,
	})
	process.stdout.write(
		"Browser test OpenBot is ready on http://127.0.0.1:3000\n",
	)
	const close = () => {
		void host.close().then(() => process.exit(0))
	}
	process.once("SIGINT", close)
	process.once("SIGTERM", close)
}
