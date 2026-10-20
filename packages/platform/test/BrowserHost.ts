import { mock } from "node:test"
import { AuthApi } from "@openbot-build/platform-api"
import { NodeServices } from "@effect/platform-node"
import { Config, Model, Provider } from "@openbot-build/core"
import { Auth, Server, DatabasePostgres } from "@openbot-build/platform"
import {
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
import * as PostgresTest from "./PostgresTest.ts"
import type { Discovery, Network } from "@openbot-build/protocol"
import type { AppIndexApi } from "@openbot-build/platform-api"
import type { Probe } from "../src/apps/Probe.ts"
import type { AppNetwork } from "../src/apps/AppHost.ts"

/** A disposable Platform host with real PostgreSQL and signed OIDC test identities. */
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
	readonly indexWork?: {
		readonly intervalMs?: number
		readonly retryMs?: number
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
	const actualFetch = globalThis.fetch
	const providerNetwork = mock.method(
		globalThis,
		"fetch",
		(input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			return url.origin === issuer
				? providerFetch(input, init)
				: actualFetch(input, init)
		},
	)
	const confirm = Tool.make("ConfirmChange", {
		description: "Apply the proposed change after approval",
		parameters: Schema.Struct({ description: Schema.String }),
		success: Schema.Struct({ applied: Schema.String }),
		needsApproval: true,
	})
	const toolkit = Toolkit.make(confirm)
	let toolCalls = 0
	const handlers = toolkit.toLayer({
		ConfirmChange: ({ description }) =>
			Effect.sync(() => {
				toolCalls++
				return { applied: description }
			}),
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
						"Progress stays with your Session.\n\n",
						"- Evidence is recorded.\n- You can keep building from this Version.",
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
		...(options.appReadRules === undefined
			? {}
			: { appReadRules: options.appReadRules }),
		...(options.appNetwork === undefined
			? {}
			: { appNetwork: options.appNetwork }),
		...(options.indexPublicNetwork === undefined
			? {}
			: { indexPublicNetwork: options.indexPublicNetwork }),
		...(options.indexWork === undefined
			? {}
			: { indexWork: options.indexWork }),
		...(options.appRestrictions === undefined
			? {}
			: { appRestrictions: options.appRestrictions }),
		...(options.discovery === undefined
			? {}
			: { discovery: options.discovery }),
		...(options.appProbe === undefined ? {} : { appProbe: options.appProbe }),
		host: "127.0.0.1",
		port: options.port ?? 0,
		databaseUrl: Redacted.make(database.url),
		appEncryptionKey: Redacted.make(
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
		sessions: {
			runtime: { toolkit },
			layerExecution: () => handlers,
			modelCatalog: Effect.succeed(catalog),
			defaults: Effect.succeed({
				model: Config.Selection.make({ provider, model: modelId }),
			}),
			resolveModel: () => Effect.succeed(options.model ?? model),
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
				Server.layer(configuration).pipe(
					Layer.provide(
						Layer.mergeAll(
							handlers,
							Layer.succeed(FetchHttpClient.Fetch, providerFetch),
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
		const login = async (subject: string, returnTo?: string) => {
			const redirect = await fetch(
				address +
					"/auth/login" +
					(returnTo === undefined
						? ""
						: "?" + new URLSearchParams({ returnTo })),
				{
					redirect: "manual",
				},
			)
			const authorization = new URL(redirect.headers.get("location") ?? "")
			const browser = redirect.headers
				.getSetCookie()
				.map((cookie) => cookie.split(";")[0])
				.join("; ")
			const code = JSON.stringify({
				subject,
				nonce: authorization.searchParams.get("nonce"),
			})
			const callback = await fetch(
				address +
					"/auth/callback?" +
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
			return runtime.runPromise(
				Effect.gen(function* () {
					const auth = yield* Auth.Auth
					const info = yield* auth.resolveSession(session)
					return {
						session,
						identity: info.identity,
						returnLocation: callback.headers.get("location"),
					}
				}),
			)
		}
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
			toolCalls: () => toolCalls,
			consolidations: () => consolidations,
			close: async () => {
				await runtime.dispose()
				providerNetwork.mock.restore()
				await migration.dispose()
				await database.close()
			},
		}
	} catch (error) {
		providerNetwork.mock.restore()
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
		"Browser test Platform is ready on http://127.0.0.1:3000\n",
	)
	const close = () => {
		void host.close().then(() => process.exit(0))
	}
	process.once("SIGINT", close)
	process.once("SIGTERM", close)
}
