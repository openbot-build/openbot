import * as ClientSdk from "@openbot-build/client"
import * as ErrorReporting from "@openbot-build/server-kernel/errors/Reporting"
import * as HttpFailureBoundary from "@openbot-build/server-kernel/errors/HttpBoundary"
import { NodeCrypto, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { AuthApi, ExecutionsApi, FailureApi } from "@openbot-build/api"
import {
	Authorization,
	Billing,
	Execution,
	TokenId,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import {
	HttpClient,
	HttpClientError,
	HttpClientRequest,
	HttpRouter,
} from "effect/http"
import { HttpApi, HttpApiBuilder, HttpApiMiddleware } from "effect/http-api"
import { SqlClient } from "effect/sql"
import { DatabasePostgres } from "@openbot-build/openbot"
import * as Store from "@openbot-build/server-execution/execution/Store"
import * as Observation from "@openbot-build/server-execution/execution/Observation"
import * as Commands from "@openbot-build/server-execution/execution/Commands"
import * as Handlers from "@openbot-build/server-execution/execution/HttpHandlers"
import * as Records from "@openbot-build/server-kernel/errors/Records"
import {
	type Registered,
	Unavailable,
	Workflows,
} from "@openbot-build/server-execution/execution/Workflows"
import * as Secrets from "@openbot-build/server-kernel/secrets/Secrets"
import { Auth } from "@openbot-build/identity-contract/auth/Auth"
import { Tokens } from "@openbot-build/identity-contract/auth/Tokens"
import { CredentialRejected } from "@openbot-build/server-kernel/auth/Model"
import { layerBotAuth } from "@openbot-build/plugin-auth/HttpMiddleware"
import { RateLimiter } from "@openbot-build/server-billing/billing/RateLimit"
import * as Check from "@openbot-build/identity-contract/authorization/Check"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import * as PostgresTest from "./PostgresTest.ts"

class Revoked extends Context.Service<Revoked, Ref.Ref<boolean>>()(
	"@openbot-build/server-testing/test/ExecutionHttp.test/Revoked",
) {}
class Limited extends Context.Service<Limited, Ref.Ref<boolean>>()(
	"@openbot-build/server-testing/test/ExecutionHttp.test/Limited",
) {}
const origin = "https://openbot.example.com"
const actor = { kind: "member", organizationId: "org", userId: "user" } as const
const database = Layer.effectDiscard(DatabasePostgres.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (db) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
			),
		),
	),
)
const member = Option.getOrThrow(
	Arr.findFirst(Authorization.builtinRoles, (role) => role.id === "member"),
).policy
const readOnly = Policy.define(Authorization.OpenBot)(function* (_) {
	yield* _.allow("read", Authorization.Chat)
})
const auth = Layer.mock(Auth, {
	resolveSession: (credential) =>
		Redacted.value(credential) !== "session"
			? Effect.fail(CredentialRejected.make({ kind: "session" }))
			: Effect.succeed({
					userId: "user",
					profile: {},
					platformAdmin: false,
					canCreateOrganization: false,
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
				}),
})
const tokens = Layer.mock(Tokens, {
	authenticate: (secret) =>
		!Arr.contains(
			["token", "read-only", "other-org", "other-user"],
			Redacted.value(secret),
		)
			? Effect.fail(CredentialRejected.make({ kind: "token" }))
			: Effect.succeed({
					kind: "user_token",
					organizationId:
						Redacted.value(secret) === "other-org" ? "other" : "org",
					userId: Redacted.value(secret) === "other-user" ? "other" : "user",
					tokenId: TokenId.make(Redacted.value(secret)),
				}),
})
const policy = Layer.unwrap(
	Effect.map(Revoked, (revoked) =>
		Authorizer.layer(Authorization.Auth, {
			policy: (caller) =>
				Ref.get(revoked).pipe(
					Effect.map((blocked) =>
						blocked
							? Authorization.emptyPolicy
							: caller.tokenId === "read-only"
								? Policy.all([member, readOnly])
								: member,
					),
				),
		}),
	),
)
const registry = Layer.effect(
	Workflows,
	Effect.gen(function* () {
		const store = yield* Store.Store
		const checks = yield* Check.make
		const registered: Registered = {
			authorize: Effect.fn(function* (key, caller, access) {
				if (caller.kind === "service")
					return yield* Execution.Forbidden.make({})
				const execution = yield* store.loadMember(key)
				const allowed = yield* checks
					.allows(caller, {
						action: access === "read" ? "read" : "write",
						resource: Authorization.Chat.make({
							organizationId: execution.identity.owner.organizationId,
							ownerUserId: execution.identity.owner.userId,
							id: execution.record.resource.id,
						}),
					})
					.pipe(
						Effect.mapError((cause) => Execution.StorageError.make({ cause })),
					)
				if (!allowed) return yield* Execution.Forbidden.make({})
			}),
		}
		// Only "http-test" has access rules. Any other workflow belongs to a feature that is not loaded.
		return Workflows.of({
			contribute: () => Effect.void,
			names: Effect.succeed(["http-test"]),
			current: Effect.succeed(HashMap.empty()),
			seal: Effect.succeed(HashMap.empty()),
			hold: () => Effect.void,
			changes: Stream.make(HashMap.empty()),
			acquire: Effect.succeed(HashMap.empty()),
			get: (name) =>
				Effect.succeed(
					name === "http-test" ? Option.some(registered) : Option.none(),
				),
			require: (name) =>
				name === "http-test"
					? Effect.succeed(registered)
					: Effect.fail(
							Unavailable.make({ workflow: name, feature: "unloaded" }),
						),
		})
	}),
)
const api = HttpApi.make("openbot-api").add(ExecutionsApi.ExecutionsApi)
const routes = HttpApiBuilder.layer(api).pipe(
	Layer.provide(Handlers.layer),
	Layer.provide(HttpFailureBoundary.layer),
	Layer.provide(
		layerBotAuth.pipe(
			Layer.provide(
				Layer.mergeAll(
					auth,
					tokens,
					OrganizationFixture.layerEveryoneAdministrator,
					OrganizationFixture.layerSettings({ publicOrigin: origin }),
					Layer.effect(
						RateLimiter,
						Effect.map(Limited, (limited) => ({
							hit: () =>
								Ref.get(limited).pipe(
									Effect.flatMap((value) =>
										value
											? Effect.fail(
													Billing.RateLimited.make({ retryAfterSeconds: 23 }),
												)
											: Effect.void,
									),
								),
						})),
					),
				),
			),
		),
	),
)
const services = HttpRouter.serve(
	Layer.merge(routes, ErrorReporting.layerHttp),
	{ disableLogger: true, disableListenLog: true },
).pipe(
	Layer.provideMerge(
		Commands.layer.pipe(
			Layer.provideMerge(registry),
			Layer.provideMerge(Observation.layer),
		),
	),
	Layer.provideMerge(Layer.merge(Store.layer, Records.layer)),
	Layer.provide(policy),
	Layer.provideMerge(Layer.effect(Revoked, Ref.make(false))),
	Layer.provideMerge(Layer.effect(Limited, Ref.make(false))),
	Layer.provide(Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11")))),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeHttpServer.layerTest),
	Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
)
const submit = Effect.fn(function* (name: string, workflow = "http-test") {
	const store = yield* Store.Store
	const receipt = yield* store.submit(
		name,
		Execution.CommandKey.make("start"),
		{
			workflow,
			resource: { kind: "Chat", id: name },
			identity: { owner: actor, actor },
			input: null,
		},
	)
	return { namespace: name, id: receipt.executionId }
})
const token = (value: string) => HttpClientRequest.bearerToken(value)
const cookie = HttpClientRequest.setHeaders({
	cookie: `${AuthApi.SessionCookie}=session`,
	origin,
})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"rate limits return the same HTTP error for a token and a session",
		() =>
			Effect.gen(function* () {
				const key = yield* submit("limited")
				const client = yield* HttpClient.HttpClient
				const limited = yield* Limited
				yield* Effect.acquireUseRelease(
					Ref.set(limited, true),
					() =>
						Effect.gen(function* () {
							for (const credential of [token("token"), cookie]) {
								const response = yield* client.execute(
									HttpClientRequest.get(`/v1/executions/${key.id}`).pipe(
										credential,
									),
								)
								assert.strictEqual(response.status, 429)
								assert.deepEqual(yield* response.json, {
									_tag: "RateLimited",
									retryAfterSeconds: 23,
								})
							}
						}),
					() => Ref.set(limited, false),
				)
			}),
	)

	it.effect(
		"an execution whose workflow has no policy answers 503 FeatureUnavailable",
		() =>
			Effect.gen(function* () {
				const key = yield* submit("unloaded", "http-unloaded")
				const client = yield* HttpClient.HttpClient
				const sql = yield* SqlClient.SqlClient
				const count = sql<{
					readonly count: string
				}>`select count(*)::text as count from openbot_execution_failures`
				const before = yield* count
				for (const credential of [token("token"), cookie]) {
					const response = yield* client.execute(
						HttpClientRequest.get(`/v1/executions/${key.id}`).pipe(credential),
					)
					assert.strictEqual(response.status, 503)
					assert.strictEqual(response.headers["retry-after"], "5")
					assert.strictEqual(
						response.headers[FailureApi.featureHeader],
						"unloaded",
					)
					assert.deepEqual(yield* response.json, {
						_tag: "FeatureUnavailable",
						feature: "unloaded",
					})
				}
				// Nothing failed, so the server keeps no error record.
				assert.deepStrictEqual(yield* count, before)
			}),
	)

	it.effect(
		"execution routes check the same resource for a token and a session",
		() =>
			Effect.gen(function* () {
				const key = yield* submit("read")
				const url = `/v1/executions/${key.id}`
				const client = yield* HttpClient.HttpClient
				for (const credential of [token("token"), cookie]) {
					const response = yield* client.execute(
						HttpClientRequest.get(url).pipe(credential),
					)
					assert.strictEqual(response.status, 200)
					assert.strictEqual(
						(yield* response.json.pipe(
							Effect.flatMap(Schema.decodeUnknownEffect(Execution.Record)),
						)).id,
						key.id,
					)
				}
				assert.strictEqual(
					(yield* client.execute(
						HttpClientRequest.get(url).pipe(token("other-user")),
					)).status,
					403,
				)
				assert.strictEqual(
					(yield* client.execute(
						HttpClientRequest.get(url).pipe(token("other-org")),
					)).status,
					404,
				)
				assert.strictEqual(
					(yield* client.execute(HttpClientRequest.get(url).pipe(token("bad"))))
						.status,
					401,
				)
			}),
	)
	it.effect(
		"cancel is idempotent and still checks the token ceiling and browser origin",
		() =>
			Effect.gen(function* () {
				const key = yield* submit("cancel-http")
				const client = yield* HttpClient.HttpClient
				const request = HttpClientRequest.post(
					`/v1/executions/${key.id}/cancel`,
				).pipe(HttpClientRequest.bodyJsonUnsafe({ commandKey: "cancel" }))
				assert.strictEqual(
					(yield* client.execute(request.pipe(token("read-only")))).status,
					403,
				)
				assert.strictEqual(
					(yield* client.execute(
						request.pipe(
							cookie,
							HttpClientRequest.setHeader(
								"origin",
								"https://other.example.com",
							),
						),
					)).status,
					403,
				)
				const first = yield* client.execute(request.pipe(cookie))
				const second = yield* client.execute(request.pipe(cookie))
				assert.strictEqual(first.status, 200)
				assert.deepStrictEqual(yield* first.json, yield* second.json)
				assert.strictEqual(
					(yield* (yield* Store.Store).get(key)).status,
					"cancelling",
				)
			}),
	)
	it.effect(
		"events resume at a query cursor and the saved end can be read again",
		() =>
			Effect.gen(function* () {
				const key = yield* submit("events-http")
				const store = yield* Store.Store
				const fence = yield* store.takeOver(key)
				yield* store.transition(fence, "completed")
				const client = yield* HttpClient.HttpClient
				const response = yield* client.execute(
					HttpClientRequest.get(
						`/v1/executions/${key.id}/observe?afterSequence=2`,
					).pipe(token("token")),
				)
				assert.strictEqual(response.status, 200)
				const text = yield* response.text
				assert.match(text, /id: 3/)
				assert.match(text, /completed/)
				assert.notMatch(text, /running/)
				const page = yield* client.execute(
					HttpClientRequest.get(
						`/v1/executions/${key.id}/events?afterSequence=2`,
					).pipe(cookie),
				)
				const result = yield* page.json.pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(ExecutionsApi.EventPage)),
				)
				assert.isTrue(result.terminal)
				assert.strictEqual(result.afterSequence, 3)
			}),
	)
	it.effect("permission is checked again after it is revoked", () =>
		Effect.gen(function* () {
			const key = yield* submit("revoked")
			const commands = yield* Commands.Commands
			const revoked = yield* Revoked
			yield* commands.get(key.id, actor)
			yield* Ref.set(revoked, true)
			const denied = yield* commands
				.cancel(key.id, actor, Execution.CommandKey.make("cancel"))
				.pipe(Effect.flip)
			assert.strictEqual(denied._tag, "ExecutionForbidden")
			assert.strictEqual(
				(yield* (yield* Store.Store).get(key)).status,
				"queued",
			)
			yield* Ref.set(revoked, false)
		}),
	)
	it.effect(
		"the SDK reuses its command key after a committed reply is lost",
		() =>
			Effect.gen(function* () {
				const key = yield* submit("sdk-retry")
				const client = yield* HttpClient.HttpClient
				const count = yield* Ref.make(0)
				const lostReply = HttpClient.transformResponse(client, (request) =>
					Effect.gen(function* () {
						const response = yield* request
						const attempt = yield* Ref.getAndUpdate(count, (value) => value + 1)
						if (attempt === 0) {
							yield* response.text
							return yield* new HttpClientError.HttpClientError({
								reason: new HttpClientError.TransportError({
									request: response.request,
									description: "The reply was lost.",
								}),
							})
						}
						return response
					}),
				)
				const sdk = yield* ClientSdk.make({ baseUrl: "" }).pipe(
					Effect.provideService(HttpClient.HttpClient, lostReply),
					Effect.provide(
						Layer.mergeAll(
							HttpApiMiddleware.layerClient(
								AuthApi.BotAuth,
								({ request, next }) => next(request.pipe(token("token"))),
							),
							HttpApiMiddleware.layerClient(
								AuthApi.AccountAuth,
								({ request, next }) => next(request),
							),
							HttpApiMiddleware.layerClient(
								AuthApi.SessionAuth,
								({ request, next }) => next(request),
							),
						),
					),
				)
				const command = yield* ClientSdk.Executions.cancel(key.id).pipe(
					Effect.provideService(ClientSdk.Client, sdk),
				)
				const receipt = yield* command.send
				assert.strictEqual(yield* Ref.get(count), 2)
				assert.strictEqual(receipt.commandKey, command.commandKey)
				assert.deepStrictEqual(yield* command.send, receipt)
				assert.strictEqual((yield* (yield* Store.Store).get(key)).sequence, 2)
			}),
	)
})
