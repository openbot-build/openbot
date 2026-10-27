import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { AuthApi, FailureApi } from "@openbot-build/api"
import {
	Billing,
	Caller,
	Execution,
	Identity,
	TokenId,
} from "@openbot-build/domain"
import { Cause, Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
} from "effect/http-api"
import { Auth } from "../src/auth/Auth.ts"
import { layerBotAuth } from "../src/auth/HttpMiddleware.ts"
import { AuthUnavailable, CredentialRejected } from "../src/auth/Model.ts"
import { Tokens } from "../src/auth/Tokens.ts"
import { RateLimiter } from "../src/billing/RateLimit.ts"
import * as Boundary from "../src/errors/HttpBoundary.ts"
import * as Failures from "../src/errors/Failures.ts"
import { Records } from "../src/errors/Records.ts"
import * as Reporting from "../src/errors/Reporting.ts"
import { codec, snapshot } from "../src/errors/Snapshot.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"

const origin = "https://openbot.example.com"
class Inside extends Schema.TaggedError<
	Inside,
	{ readonly brand: unique symbol }
>()("Inside", { detail: Schema.String }) {}
class Api extends HttpApi.make("failure-auth-test")
	.add(
		HttpApiGroup.make("probe")
			.add(
				HttpApiEndpoint.get("read", "/identity", { success: Caller }),
				HttpApiEndpoint.post("write", "/identity", {
					payload: Schema.Struct({}),
					success: Caller,
				}),
			)
			.middleware(AuthApi.BotAuth),
	)
	.middleware(FailureApi.FailureBoundary) {}

it.live(
	"the failure boundary keeps token, cookie, origin, and rate limit checks",
	() => {
		let saved: ReadonlyArray<Cause.Cause<unknown>> = []
		let sessions = 0
		const auth = Layer.mock(Auth, {
			resolveSession: (credential) =>
				Effect.suspend(
					(): ReturnType<(typeof Auth.Service)["resolveSession"]> => {
						sessions++
						const secret = Redacted.value(credential)
						if (secret === "unavailable")
							return Effect.fail(
								Inside.make({ detail: "private-auth-secret" }),
							).pipe(
								Failures.replace("The sign-in store failed.", () =>
									AuthUnavailable.make({ dependency: "storage" }),
								),
							)
						if (secret !== "session" && secret !== "limited-session")
							return Effect.fail(CredentialRejected.make({ kind: "session" }))
						return Effect.succeed({
							userId: secret === "limited-session" ? "limited-user" : "user",
							profile: {},
							platformAdmin: false,
							memberships: [
								{
									organizationId: "org",
									name: "Org",
									status: "active",
									roles: ["member"],
								},
							],
							expiresAt: "2099-01-01T00:00:00.000Z",
							setCookies: [],
						})
					},
				),
		})
		const tokens = Layer.mock(Tokens, {
			authenticate: (credential) => {
				const secret = Redacted.value(credential)
				return secret === "token" || secret === "limited"
					? Effect.succeed({
							kind: "user_token",
							organizationId: "org",
							userId: "user",
							tokenId: TokenId.make(secret),
						})
					: Effect.fail(CredentialRejected.make({ kind: "token" }))
			},
		})
		const limit = Layer.succeed(RateLimiter, {
			hit: (caller) =>
				caller.userId === "limited-user" ||
				(caller.kind === "user_token" && caller.tokenId === "limited")
					? Effect.fail(Billing.RateLimited.make({ retryAfterSeconds: 23 }))
					: Effect.void,
		})
		const records = Layer.succeed(Records, {
			record: (cause, category) =>
				Effect.sync(() => {
					saved = [...saved, cause]
					return {
						errorId: Execution.ErrorId.make(`auth-failure-${saved.length}`),
						category,
					}
				}),
		})
		const handlers = HttpApiBuilder.group(Api, "probe", (handlers) =>
			handlers.handle("read", () => Identity).handle("write", () => Identity),
		)
		const routes = HttpApiBuilder.layer(Api).pipe(
			Layer.provide(handlers),
			Layer.provide(
				layerBotAuth.pipe(
					Layer.provide(
						Layer.mergeAll(
							auth,
							tokens,
							limit,
							OrganizationFixture.layerEveryoneAdministrator,
							OrganizationFixture.layerSettings({ publicOrigin: origin }),
						),
					),
				),
			),
			Layer.provide(Boundary.layer),
		)
		const server = HttpRouter.serve(Layer.merge(routes, Reporting.layerHttp), {
			disableLogger: true,
			disableListenLog: true,
		}).pipe(
			Layer.provide(records),
			Layer.provideMerge(NodeHttpServer.layerTest),
			Layer.provide(NodeServices.layer),
		)
		const cookie = (value: string) => ({
			cookie: `${AuthApi.SessionCookie}=${value}`,
		})
		return Effect.gen(function* () {
			const client = yield* HttpClient.HttpClient
			// A valid token over its limit must not try the valid session as a second caller.
			const limited = yield* client.get("/identity", {
				headers: { authorization: "Bearer limited", ...cookie("session") },
			})
			assert.strictEqual(limited.status, 429)
			assert.deepStrictEqual(yield* limited.json, {
				_tag: "RateLimited",
				retryAfterSeconds: 23,
			})
			assert.strictEqual(sessions, 0)
			const limitedSession = yield* client.get("/identity", {
				headers: cookie("limited-session"),
			})
			assert.strictEqual(limitedSession.status, 429)
			assert.deepStrictEqual(yield* limitedSession.json, {
				_tag: "RateLimited",
				retryAfterSeconds: 23,
			})
			for (const [headers, kind] of [
				[{ authorization: "Bearer token" }, "user_token"],
				[cookie("session"), "member"],
			] as const) {
				const response = yield* client.get("/identity", { headers })
				assert.strictEqual(response.status, 200)
				const caller = yield* response.json.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(Caller)),
				)
				assert.strictEqual(caller.kind, kind)
				assert.strictEqual(caller.organizationId, "org")
				assert.strictEqual(caller.userId, "user")
			}
			for (const headers of [
				{},
				{ authorization: "Bearer bad" },
				cookie("bad"),
			]) {
				const response = yield* client.get("/identity", { headers })
				assert.strictEqual(response.status, 401)
			}
			const write = (headers: Readonly<Record<string, string>>) =>
				client.execute(
					HttpClientRequest.post("/identity", { headers }).pipe(
						HttpClientRequest.bodyJsonUnsafe({}),
					),
				)
			assert.strictEqual((yield* write(cookie("session"))).status, 403)
			assert.strictEqual(
				(yield* write({
					...cookie("session"),
					origin: "https://other.example.com",
				})).status,
				403,
			)
			assert.strictEqual(
				(yield* write({ ...cookie("session"), origin })).status,
				200,
			)
			assert.strictEqual(
				(yield* write({ authorization: "Bearer token" })).status,
				200,
			)
			assert.strictEqual(saved.length, 0)
			const unavailable = yield* client.get("/identity", {
				headers: cookie("unavailable"),
			})
			assert.strictEqual(unavailable.status, 503)
			const failure = yield* unavailable.json.pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(FailureApi.RequestFailed)),
			)
			assert.strictEqual(failure.category, "unavailable")
			assert.strictEqual(
				unavailable.headers[Boundary.errorIdHeader],
				failure.errorId,
			)
			assert.strictEqual(saved.length, 1)
			assert.include(
				yield* saved[0]!.pipe(snapshot, Schema.encodeEffect(codec)),
				"private-auth-secret",
			)
		}).pipe(Effect.provide(server))
	},
)
