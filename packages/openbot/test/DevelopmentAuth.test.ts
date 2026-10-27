import { assert, it } from "@effect/vitest"
import { NodeHttpServer } from "@effect/platform-node"

import {
	AuthApi,
	Caller,
	Identity,
	OpenBotApi,
	UserTokensApi,
} from "@openbot-build/api"
import {
	Context,
	Effect,
	Layer,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"

import {
	HttpClient,
	HttpClientRequest,
	HttpRouter,
	HttpServer,
} from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	OpenApi,
} from "effect/http-api"
// OrganizationFixture uses the source files, so the Auth layer must come from them too.
import * as Auth from "../src/auth/index.ts"
import * as HttpBoundary from "../src/errors/HttpBoundary.ts"
import { Records } from "../src/errors/Records.ts"
import { Execution } from "@openbot-build/domain"

import * as Development from "../dist/Development.js"
import * as OrganizationFixture from "./OrganizationFixture.ts"

const publicOrigin = "https://localhost:8443"
const authSecret = "DevelopmentIntegrationSecretMustStayStable123456"

it.effect(
	"the development sign-in secret comes from the first secret key and stays the same",
	() =>
		Effect.sync(() => {
			const keys = Redacted.make(
				"dev:" + Str.repeat(32)("11") + ",old:" + Str.repeat(32)("22"),
			)
			const first = Redacted.value(Development.developmentSecret(keys))
			assert.strictEqual(
				first,
				Redacted.value(Development.developmentSecret(keys)),
			)
			assert.ok(first.length >= 32)
			assert.notStrictEqual(
				first,
				Redacted.value(
					Development.developmentSecret(
						Redacted.make("dev:" + Str.repeat(32)("33")),
					),
				),
			)
		}),
)

it.effect(
	"development authentication accepts only origins on this computer in standard form",
	() =>
		Effect.gen(function* () {
			const decode = (publicOrigin: string) =>
				Schema.decodeEffect(Auth.Model.Configuration)({
					mode: "development",
					publicOrigin,
					secret: Redacted.make(authSecret),
				}).pipe(Effect.result)
			assert.strictEqual(
				(yield* decode("https://localhost:8443"))._tag,
				"Success",
			)
			assert.strictEqual(
				(yield* decode("https://127.0.0.1:8443"))._tag,
				"Success",
			)
			assert.strictEqual((yield* decode("https://[::1]:8443"))._tag, "Success")
			assert.strictEqual(
				(yield* decode("https://openbot.localhost"))._tag,
				"Success",
			)
			assert.strictEqual(
				(yield* decode("https://openbot.localhost.example.com"))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* decode("https://e.example.com"))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* decode("http://openbot.localhost"))._tag,
				"Success",
			)
			assert.strictEqual(
				(yield* decode("http://e.example.com"))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* decode("https://localhost:8443/path"))._tag,
				"Failure",
			)
			assert.strictEqual((yield* decode("invalid"))._tag, "Failure")
		}),
)

// The probe API runs on a real test server, so this test needs the real clock.
it.live(
	"business authentication keeps session Origin checks and typed failures",
	() =>
		Effect.gen(function* () {
			const unavailable = yield* Ref.make(true)
			const failure = Effect.fail(
				Auth.Model.AuthUnavailable.make({ dependency: "storage" }),
			)
			const auth = Layer.mock(Auth.Auth, {
				handle: () => Effect.succeed(new Response(null, { status: 503 })),
				signInProvider: () => Effect.succeedNone,
				resolveSession: (credential) =>
					Redacted.value(credential) !== "signed-session"
						? Effect.fail(
								Auth.Model.CredentialRejected.make({ kind: "session" }),
							)
						: Effect.flatMap(Ref.get(unavailable), (down) =>
								down
									? failure
									: Effect.succeed({
											userId: "session-user",
											memberships: [
												{
													organizationId: "session-user",
													name: "Session",
													status: "active" as const,
													roles: ["super_administrator"],
												},
											],
											platformAdmin: false,
											profile: {},
											expiresAt: "2099-01-01T00:00:00.000Z",
											setCookies: [],
										}),
							),
			})
			const tokens = Layer.mock(Auth.Tokens, {
				authenticate: (credential) =>
					Redacted.value(credential) === "obut_valid"
						? Effect.succeed({
								kind: "user_token" as const,
								userId: "key-user",
								organizationId: "key-user",
								tokenId: UserTokensApi.TokenId.make("key-1"),
							})
						: Effect.fail(
								Auth.Model.CredentialRejected.make({ kind: "token" }),
							),
			})
			const api = HttpApi.make("auth-probe").add(
				HttpApiGroup.make("probe")
					.add(
						HttpApiEndpoint.get("identity", "/identity", { success: Caller }),
						HttpApiEndpoint.post("write", "/identity", {
							payload: Schema.Struct({}),
							success: Caller,
						}),
					)
					.middleware(AuthApi.BotAuth),
			)
			const handlers = HttpApiBuilder.group(api, "probe", (handlers) =>
				handlers
					.handle("identity", () => Identity)
					.handle("write", () => Identity),
			)
			const app = HttpApiBuilder.layer(api).pipe(
				Layer.provide(handlers),
				Layer.provide(
					Auth.HttpHandlers.layer.pipe(
						Layer.provide(OrganizationFixture.layerSettings({ publicOrigin })),
					),
				),
				Layer.provide(auth),
				Layer.provide(tokens),
				Layer.provide(OrganizationFixture.layerEveryoneAdministrator),
				Layer.provide(OrganizationFixture.layerUnusedPlatform),
				Layer.provide(OrganizationFixture.layerNoAudit),
				Layer.provide(
					HttpBoundary.layer.pipe(
						Layer.provide(
							Layer.mock(Records, {
								record: (_cause, category) =>
									Effect.succeed({
										category,
										errorId: Execution.ErrorId.make("auth-test-error"),
									}),
							}),
						),
					),
				),
				Layer.provide(HttpServer.layerServices),
			)
			// The test client sends each request to the test server.
			const client = Context.get(
				yield* Layer.build(
					HttpRouter.serve(app, {
						disableLogger: true,
						disableListenLog: true,
					}).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
				),
				HttpClient.HttpClient,
			)
			const cookie = { cookie: AuthApi.SessionCookie + "=signed-session" }
			const failed = yield* client.get("/identity", { headers: cookie })
			assert.strictEqual(failed.status, 503)
			assert.deepStrictEqual(yield* failed.json, {
				_tag: "AuthenticationUnavailable",
			})
			yield* Ref.set(unavailable, false)
			const session = yield* client.get("/identity", { headers: cookie })
			assert.deepStrictEqual(yield* session.json, {
				kind: "member",
				userId: "session-user",
				organizationId: "session-user",
			})
			for (const headers of [
				{},
				{ authorization: "Bearer retired" },
				{ cookie: AuthApi.SessionCookie + "=invalid" },
			]) {
				assert.strictEqual(
					(yield* client.get("/identity", { headers })).status,
					401,
				)
			}
			const write = (headers: Readonly<Record<string, string>>) =>
				HttpClientRequest.post("/identity", { headers }).pipe(
					HttpClientRequest.bodyJson({}),
					Effect.flatMap(client.execute),
				)
			assert.strictEqual((yield* write(cookie)).status, 403)
			assert.strictEqual(
				(yield* write({ ...cookie, origin: "https://other.example" })).status,
				403,
			)
			assert.strictEqual(
				(yield* write({ ...cookie, origin: publicOrigin })).status,
				200,
			)
			assert.strictEqual(
				(yield* write({ authorization: "Bearer retired" })).status,
				401,
			)
			const keyed = yield* write({ authorization: "Bearer obut_valid" })
			assert.strictEqual(keyed.status, 200)
			assert.deepStrictEqual(yield* keyed.json, {
				kind: "user_token",
				userId: "key-user",
				organizationId: "key-user",
				tokenId: "key-1",
			})
			const spec = OpenApi.fromApi(OpenBotApi)
			assert.deepStrictEqual(
				spec.paths["/v1/bots/{botId}/messages"]?.post?.security,
				[{ token: [] }, { session: [] }],
			)
			assert.strictEqual(spec.components.securitySchemes["bearer"], undefined)
			assert.deepStrictEqual(spec.components.securitySchemes["session"], {
				type: "apiKey",
				in: "cookie",
				name: AuthApi.SessionCookie,
			})
		}),
)

it.effect(
	"return destinations accept same-origin client paths and reject open redirects",
	() =>
		Effect.sync(() => {
			const accepts = Schema.is(AuthApi.ReturnTo)
			for (const target of [
				"/",
				"/docs",
				"/developer/tests/test-1",
				"/apps?query=documents",
				"/chats/chat-1",
			])
				assert.strictEqual(accepts(target), true, target)
			for (const target of [
				"https://external.example/developer",
				"//external.example/developer",
				"/\\external.example",
				"/developer/../auth/callback",
				"/auth/login",
				"/v1/chats",
				"/development/sign-in",
			])
				assert.strictEqual(accepts(target), false, target)
		}),
)
