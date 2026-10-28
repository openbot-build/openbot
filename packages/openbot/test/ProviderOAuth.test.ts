import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Model } from "@openbot-build/core"
import {
	organizationOwner,
	platformOwner,
	ModelProviders,
	view,
} from "../src/models/ModelProviders.ts"
import * as ModelProvidersPostgres from "../src/models/ModelProvidersPostgres.ts"
import * as Accounts from "@openbot-build/domain/ProviderOAuth"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import {
	Array as Arr,
	Clock,
	Context,
	Option,
	Effect,
	Layer,
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import * as Db from "../src/database/Database.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as ProviderOAuth from "../src/models/ProviderOAuth.ts"
import { ChatGptOAuth, Credentials } from "../src/providers/chatgpt/OAuth.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

const owner = organizationOwner("org_a")
const otherOwner = organizationOwner("org_b")
const redirectUri = "http://127.0.0.1:1455/auth/callback"
const encodeCredentials = Schema.encodeEffect(
	Schema.fromJsonString(Credentials),
)

const credentials = (subject: string, expiresAt: number): Credentials => ({
	clientId: "oaiapp_test",
	subject,
	email: subject + "@example.com",
	idToken: Redacted.make("id-token-" + subject),
	accessToken: Redacted.make("access-token-" + subject),
	refreshToken: Redacted.make("refresh-token-" + subject),
	expiresAt,
	scopes: ["chatgpt.tokens.use.direct", "resource.invoke"],
})

const startDatabase = Effect.gen(function* () {
	const database = yield* PostgresTest.start
	const databaseLayer = DatabasePostgres.layer({
		databaseUrl: Redacted.make(database.url),
	})
	yield* DatabasePostgres.migrate.pipe(Effect.provide(databaseLayer))
	return databaseLayer
})

const fixture = (databaseLayer: ReturnType<typeof DatabasePostgres.layer>) =>
	Effect.gen(function* () {
		const exchanges = yield* Ref.make(0)
		const refreshes = yield* Ref.make(0)
		const catalogs = yield* Ref.make(0)
		const revokes = yield* Ref.make(0)
		const rejectRefresh = yield* Ref.make(false)
		const networkFailure = yield* Ref.make(false)
		const expireExchange = yield* Ref.make(false)
		const oauth = ChatGptOAuth.of({
			exchange: (input) =>
				Effect.gen(function* () {
					yield* Ref.update(exchanges, (count) => count + 1)
					assert.strictEqual(input.clientId, "oaiapp_test")
					assert.ok(input.verifier.length > 40)
					assert.ok(input.nonce.length > 40)
					if (
						input.expectedSubject !== undefined &&
						input.expectedSubject !== input.code
					)
						return yield* Accounts.ModelProviderAuthorizationInvalid.make({
							message: "Use the same ChatGPT account.",
						})
					const now = yield* Clock.currentTimeMillis
					return credentials(
						input.code,
						now + ((yield* Ref.get(expireExchange)) ? -1 : 3_600_000),
					)
				}),
			refresh: (current) =>
				Effect.gen(function* () {
					yield* Ref.update(refreshes, (count) => count + 1)
					yield* Effect.sleep("50 millis")
					if (yield* Ref.get(networkFailure))
						return yield* Accounts.ModelProviderOAuthUnavailable.make({})
					if (yield* Ref.get(rejectRefresh))
						return yield* Accounts.ModelProviderLoginRequired.make({})
					return {
						...current,
						accessToken: Redacted.make("new-access-token"),
						refreshToken: Redacted.make("new-refresh-token"),
						expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
					}
				}),
			models: () =>
				Ref.update(catalogs, (count) => count + 1).pipe(
					Effect.as({
						items: [
							{
								id: Model.Id.make("test-model"),
								name: "Test model",
								reasoningEfforts: [],
								serviceTiers: [],
							},
						],
					}),
				),
			revoke: () => Ref.update(revokes, (count) => count + 1),
		})
		const services = yield* Layer.build(
			Layer.merge(ProviderOAuth.layer, ModelProvidersPostgres.layer).pipe(
				Layer.provide(Layer.succeed(ChatGptOAuth, oauth)),
				Layer.provideMerge(
					Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
				),
				Layer.provideMerge(databaseLayer),
			),
		)
		return {
			accounts: Context.get(services, ProviderOAuth.ProviderOAuth),
			providers: Context.get(services, ModelProviders),
			secrets: Context.get(services, Secrets.Secrets),
			sql: Context.get(services, PgClient.PgClient),
			exchanges,
			refreshes,
			catalogs,
			revokes,
			rejectRefresh,
			networkFailure,
			expireExchange,
		}
	})

const callback = (
	authorization: Accounts.ProviderOAuthAuthorization,
	code = "alice",
) => {
	const url = new URL(redirectUri)
	url.searchParams.set("code", code)
	url.searchParams.set(
		"state",
		new URL(authorization.url).searchParams.get("state") ?? "",
	)
	url.searchParams.set("client_id", "oaiapp_test")
	return { callbackUrl: url.toString() }
}

const create = (
	state: Effect.Success<ReturnType<typeof fixture>>,
	kind: "chatgpt" | "openai" = "chatgpt",
	target = owner,
) =>
	state.providers.create(target, {
		kind,
		name: "Test provider",
		models: [],
		availability: { _tag: "All" },
		...(kind === "openai" ? { apiKey: Redacted.make("old-api-key") } : {}),
	})
const connect = (
	state: Effect.Success<ReturnType<typeof fixture>>,
	id: string,
	version: number,
	code = "alice",
	target = owner,
) =>
	Effect.gen(function* () {
		const attempt = yield* state.accounts.start(target, id, "alice", {
			redirectUri,
			expectedVersion: version,
		})
		yield* state.accounts.complete(
			target,
			id,
			"alice",
			attempt.id,
			callback(attempt, code),
		)
		return attempt
	})

it.live(
	"provider sign-in is sealed, shared by callers, and kept after restart",
	() =>
		Effect.gen(function* () {
			const db = yield* startDatabase
			const first = yield* fixture(db)
			const provider = yield* create(first)
			assert.deepStrictEqual(view(provider).apiKey, { set: false, hint: null })
			const attempt = yield* first.accounts.start(owner, provider.id, "alice", {
				redirectUri,
				expectedVersion: provider.version,
			})
			const url = new URL(attempt.url)
			assert.strictEqual(
				url.searchParams.get("client_id"),
				"dynamic_agent_client",
			)
			assert.strictEqual(url.searchParams.get("agent_name_hint"), "OpenBot")
			assert.match(
				url.searchParams.get("ext_agent_host_id") ?? "",
				/^urn:uuid:/,
			)
			const pending = yield* first.sql<{
				request: string
			}>`select request from openbot_provider_oauth_authorizations`
			assert.ok(
				!Str.includes(url.searchParams.get("state")!)(pending[0]!.request),
			)
			assert.strictEqual(
				(yield* Effect.result(
					first.accounts.complete(
						owner,
						provider.id,
						"bob",
						attempt.id,
						callback(attempt),
					),
				))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* Effect.result(
					first.accounts.complete(
						otherOwner,
						provider.id,
						"alice",
						attempt.id,
						callback(attempt),
					),
				))._tag,
				"Failure",
			)
			yield* first.accounts.complete(
				owner,
				provider.id,
				"alice",
				attempt.id,
				callback(attempt),
			)
			assert.strictEqual(
				(yield* Effect.result(
					first.accounts.complete(
						owner,
						provider.id,
						"alice",
						attempt.id,
						callback(attempt),
					),
				))._tag,
				"Failure",
			)
			assert.strictEqual(yield* Ref.get(first.exchanges), 1)
			assert.strictEqual(
				Redacted.value(yield* first.accounts.accessToken(provider.id)),
				"access-token-alice",
			)
			const second = yield* fixture(db)
			const saved = yield* second.providers.get(owner, provider.id)
			assert.ok(Option.isSome(saved))
			assert.strictEqual(saved.value.oauth?.email, "alice@example.com")
			assert.strictEqual(saved.value.version, provider.version + 1)
			const next = yield* second.accounts.start(owner, provider.id, "bob", {
				redirectUri,
				expectedVersion: saved.value.version,
			})
			assert.strictEqual(
				new URL(next.url).searchParams.get("client_id"),
				"oaiapp_test",
			)
			assert.strictEqual(
				new URL(next.url).searchParams.get("ext_agent_host_id"),
				url.searchParams.get("ext_agent_host_id"),
			)
			assert.strictEqual(
				new URL(next.url).searchParams.has("id_token_hint"),
				false,
			)
			const rows = yield* first.sql<{
				credentials: string
				registration: string
			}>`select credentials, registration from openbot_provider_oauth`
			assert.ok(!Str.includes("access-token")(rows[0]!.credentials))
			assert.ok(!Str.includes("alice")(rows[0]!.registration))
			assert.deepStrictEqual(
				yield* second.accounts.models(owner, provider.id),
				{
					items: [
						{
							id: Model.Id.make("test-model"),
							name: "Test model",
							reasoningEfforts: [],
							serviceTiers: [],
						},
					],
				},
			)
			yield* second.accounts.disconnect(owner, provider.id)
			assert.strictEqual(yield* Ref.get(second.revokes), 1)
			assert.strictEqual(
				(yield* Effect.result(first.accounts.accessToken(provider.id)))._tag,
				"Failure",
			)
			const disconnected = yield* second.providers.get(owner, provider.id)
			assert.ok(Option.isSome(disconnected))
			const again = yield* second.accounts.start(owner, provider.id, "alice", {
				redirectUri,
				expectedVersion: disconnected.value.version,
			})
			assert.strictEqual(
				new URL(again.url).searchParams.get("client_id"),
				"oaiapp_test",
			)
			assert.strictEqual(
				(yield* Effect.result(
					second.accounts.complete(
						owner,
						provider.id,
						"alice",
						again.id,
						callback(again, "bob"),
					),
				))._tag,
				"Failure",
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live(
	"two instances refresh once without changing the provider version",
	() =>
		Effect.gen(function* () {
			const db = yield* startDatabase
			const first = yield* fixture(db)
			const second = yield* fixture(db)
			const provider = yield* create(first)
			yield* Ref.set(first.expireExchange, true)
			yield* connect(first, provider.id, provider.version)
			const tokens = yield* Effect.all(
				[
					first.accounts.accessToken(provider.id),
					second.accounts.accessToken(provider.id),
				],
				{ concurrency: "unbounded" },
			)
			assert.deepStrictEqual(Arr.map(tokens, Redacted.value), [
				"new-access-token",
				"new-access-token",
			])
			assert.strictEqual(
				(yield* Ref.get(first.refreshes)) + (yield* Ref.get(second.refreshes)),
				1,
			)
			const saved = yield* first.providers.get(owner, provider.id)
			assert.ok(Option.isSome(saved))
			assert.strictEqual(saved.value.version, provider.version + 1)
			const sealed = yield* first.secrets.seal(
				yield* encodeCredentials(credentials("alice", 1)),
				"openbot_provider_oauth:" + provider.id,
			)
			yield* first.sql`update openbot_provider_oauth set credentials = ${sealed}`
			yield* Ref.set(first.rejectRefresh, true)
			const failed = yield* first.accounts
				.accessToken(provider.id)
				.pipe(Effect.flip)
			assert.strictEqual(failed._tag, "ModelProviderLoginRequired")
			const invalid = yield* first.providers.get(owner, provider.id)
			assert.ok(Option.isSome(invalid))
			assert.strictEqual(invalid.value.oauth?.loginRequired, true)
			const attempt = yield* first.accounts.start(owner, provider.id, "alice", {
				redirectUri,
				expectedVersion: invalid.value.version,
			})
			assert.strictEqual(
				new URL(attempt.url).searchParams.get("client_id"),
				"oaiapp_test",
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live(
	"callbacks need the right state, time, provider, sender, and version",
	() =>
		Effect.gen(function* () {
			const state = yield* fixture(yield* startDatabase)
			const provider = yield* create(state)
			const other = yield* create(state)
			const attempt = yield* state.accounts.start(owner, provider.id, "alice", {
				redirectUri,
				expectedVersion: provider.version,
			})
			assert.strictEqual(
				(yield* Effect.result(
					state.accounts.complete(
						owner,
						other.id,
						"alice",
						attempt.id,
						callback(attempt),
					),
				))._tag,
				"Failure",
			)
			const wrong = new URL(callback(attempt).callbackUrl)
			wrong.searchParams.set("state", "wrong")
			assert.strictEqual(
				(yield* Effect.result(
					state.accounts.complete(owner, provider.id, "alice", attempt.id, {
						callbackUrl: wrong.href,
					}),
				))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* Effect.result(
					state.accounts.complete(
						owner,
						provider.id,
						"alice",
						attempt.id,
						callback(attempt),
					),
				))._tag,
				"Failure",
			)
			const expired = yield* state.accounts.start(owner, provider.id, "alice", {
				redirectUri,
				expectedVersion: provider.version,
			})
			yield* state.sql`update openbot_provider_oauth_authorizations set expires_at = 1`
			assert.strictEqual(
				(yield* Effect.result(
					state.accounts.complete(
						owner,
						provider.id,
						"alice",
						expired.id,
						callback(expired),
					),
				))._tag,
				"Failure",
			)
			const stale = yield* state.accounts.start(owner, provider.id, "alice", {
				redirectUri,
				expectedVersion: provider.version,
			})
			yield* state.providers.update(owner, provider.id, {
				expectedVersion: provider.version,
				name: "New name",
			})
			assert.strictEqual(
				(yield* state.accounts
					.complete(owner, provider.id, "alice", stale.id, callback(stale))
					.pipe(Effect.flip))._tag,
				"ModelProviderConflict",
			)
			assert.strictEqual(yield* Ref.get(state.exchanges), 0)
			const cancel = yield* state.accounts.start(owner, provider.id, "alice", {
				redirectUri,
				expectedVersion: provider.version + 1,
			})
			yield* state.accounts.disconnect(owner, provider.id)
			assert.strictEqual(
				(yield* Effect.result(
					state.accounts.complete(
						owner,
						provider.id,
						"alice",
						cancel.id,
						callback(cancel),
					),
				))._tag,
				"Failure",
			)
			yield* connect(state, other.id, other.version)
			const pending = yield* state.accounts.start(owner, other.id, "alice", {
				redirectUri,
				expectedVersion: other.version + 1,
			})
			yield* state.accounts.remove(owner, other.id)
			assert.strictEqual(
				(yield* Effect.result(
					state.accounts.complete(
						owner,
						other.id,
						"alice",
						pending.id,
						callback(pending),
					),
				))._tag,
				"Failure",
			)
			assert.strictEqual(
				(yield* state.sql`select * from openbot_provider_oauth where provider_id = ${other.id}`)
					.length,
				0,
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live("ChatGPT uses ordinary provider owners, keys, and model links", () =>
	Effect.gen(function* () {
		const state = yield* fixture(yield* startDatabase)
		const keyed = yield* create(state, "openai")
		assert.strictEqual(
			Redacted.value(yield* state.providers.openKey(keyed)),
			"old-api-key",
		)
		const platform = yield* create(state, "chatgpt", platformOwner)
		yield* connect(state, platform.id, platform.version, "alice", platformOwner)
		assert.ok(
			Arr.some(
				yield* state.providers.available("org_b"),
				(item) => item.id === platform.id,
			),
		)
		assert.strictEqual(
			(yield* Effect.result(
				state.accounts.start(owner, platform.id, "alice", {
					redirectUri,
					expectedVersion: platform.version,
				}),
			))._tag,
			"Failure",
		)
		assert.strictEqual(
			(yield* Effect.result(
				state.accounts.start(owner, keyed.id, "alice", {
					redirectUri,
					expectedVersion: keyed.version,
				}),
			))._tag,
			"Failure",
		)
		for (const input of [
			{
				kind: "openai" as const,
				name: "Missing key",
				models: [],
				availability: { _tag: "None" as const },
			},
			{
				kind: "chatgpt" as const,
				name: "Wrong key",
				apiKey: Redacted.make("key"),
				models: [],
				availability: { _tag: "None" as const },
			},
			{
				kind: "chatgpt" as const,
				name: "Wrong address",
				endpoint: "https://example.com",
				models: [],
				availability: { _tag: "None" as const },
			},
		])
			assert.strictEqual(
				(yield* state.providers.create(owner, input).pipe(Effect.flip))._tag,
				"ModelProviderInvalid",
			)
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live("the provider OAuth migration keeps old API keys", () =>
	Effect.gen(function* () {
		const database = yield* PostgresTest.start
		const databaseLayer = DatabasePostgres.layer({
			databaseUrl: Redacted.make(database.url),
		})
		const before = yield* MigrationTest.migrationsWhere(
			(name) => name < "20261028075530_provider_chatgpt_oauth",
		)
		yield* Effect.gen(function* () {
			const db = yield* Db.make
			const sql = yield* PgClient.PgClient
			yield* migrate(db, { migrationsFolder: before })
			yield* sql`insert into openbot_model_providers (id, owner_kind, owner_id, kind, name, api_key, version, created_at, updated_at) values ('prov_old', 'organization', 'org_a', 'openai', 'Old provider', 'sealed-key', 1, 1, 1)`
			yield* migrate(db, { migrationsFolder: yield* MigrationTest.folder })
			yield* DatabasePostgres.check
			const rows = yield* sql<{
				api_key: string
			}>`select api_key from openbot_model_providers where id = 'prov_old'`
			assert.strictEqual(rows[0]?.api_key, "sealed-key")
			assert.strictEqual(
				(yield* sql`select * from openbot_provider_oauth`).length,
				0,
			)
		}).pipe(Effect.provide(databaseLayer))
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live(
	"refresh waits for its allowed time and keeps tokens after a network failure",
	() =>
		Effect.gen(function* () {
			const state = yield* fixture(yield* startDatabase)
			const provider = yield* create(state)
			yield* connect(state, provider.id, provider.version)
			const now = yield* Clock.currentTimeMillis
			const save = (value: Credentials) =>
				Effect.gen(function* () {
					const sealed = yield* state.secrets.seal(
						yield* encodeCredentials(value),
						"openbot_provider_oauth:" + provider.id,
					)
					yield* state.sql`update openbot_provider_oauth set credentials = ${sealed} where provider_id = ${provider.id}`
				})
			yield* save({
				...credentials("alice", now + 30_000),
				earliestRefreshAt: now + 20_000,
			})
			yield* state.accounts.accessToken(provider.id)
			assert.strictEqual(yield* Ref.get(state.refreshes), 0)
			yield* save(credentials("alice", 1))
			yield* Ref.set(state.networkFailure, true)
			assert.strictEqual(
				(yield* state.accounts.accessToken(provider.id).pipe(Effect.flip))._tag,
				"ModelProviderOAuthUnavailable",
			)
			const rows = yield* state.sql<{
				credentials: string | null
			}>`select credentials from openbot_provider_oauth`
			assert.isNotNull(rows[0]!.credentials)
			const saved = yield* state.providers.get(owner, provider.id)
			assert.ok(Option.isSome(saved))
			assert.strictEqual(saved.value.oauth?.connected, true)
			assert.strictEqual(saved.value.version, provider.version + 1)
			yield* Ref.set(state.networkFailure, false)
			yield* Effect.all(
				[
					state.accounts.accessToken(provider.id),
					state.accounts.disconnect(owner, provider.id),
				],
				{ concurrency: "unbounded" },
			)
			assert.strictEqual(
				(yield* state.accounts.accessToken(provider.id).pipe(Effect.flip))._tag,
				"ModelProviderLoginRequired",
			)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live(
	"concurrent sign-in attempts keep only the last request and denial consumes it",
	() =>
		Effect.gen(function* () {
			const state = yield* fixture(yield* startDatabase)
			const provider = yield* create(state)
			const attempts = yield* Effect.all(
				[
					state.accounts.start(owner, provider.id, "alice", {
						redirectUri,
						expectedVersion: provider.version,
					}),
					state.accounts.start(owner, provider.id, "bob", {
						redirectUri,
						expectedVersion: provider.version,
					}),
				],
				{ concurrency: "unbounded" },
			)
			const rows = yield* state.sql<{
				id: string
				user_id: string
			}>`select id, user_id from openbot_provider_oauth_authorizations`
			assert.strictEqual(rows.length, 1)
			const current = rows[0]!
			const attempt = Arr.findFirst(attempts, (item) => item.id === current.id)
			assert.ok(Option.isSome(attempt))
			const denied = new URL(callback(attempt.value).callbackUrl)
			denied.searchParams.delete("code")
			denied.searchParams.set("error", "access_denied")
			assert.strictEqual(
				(yield* state.accounts
					.complete(owner, provider.id, current.user_id, current.id, {
						callbackUrl: denied.href,
					})
					.pipe(Effect.flip))._tag,
				"ModelProviderAuthorizationInvalid",
			)
			assert.strictEqual(
				(yield* state.sql`select * from openbot_provider_oauth_authorizations`)
					.length,
				0,
			)
			assert.strictEqual(yield* Ref.get(state.exchanges), 0)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)

it.live(
	"a rejected token needs sign-in but an old token cannot clear a new one",
	() =>
		Effect.gen(function* () {
			const state = yield* fixture(yield* startDatabase)
			const provider = yield* create(state)
			yield* Ref.set(state.expireExchange, true)
			yield* connect(state, provider.id, provider.version)
			const next = yield* state.accounts.accessToken(provider.id)
			yield* state.accounts.invalidate(
				provider.id,
				Redacted.make("access-token-alice"),
			)
			assert.strictEqual(
				Redacted.value(yield* state.accounts.accessToken(provider.id)),
				Redacted.value(next),
			)
			yield* state.accounts.invalidate(provider.id, next)
			assert.strictEqual(
				(yield* state.accounts.accessToken(provider.id).pipe(Effect.flip))._tag,
				"ModelProviderLoginRequired",
			)
			const saved = yield* state.providers.get(owner, provider.id)
			assert.ok(Option.isSome(saved))
			assert.strictEqual(saved.value.oauth?.loginRequired, true)
			assert.strictEqual(saved.value.version, provider.version + 2)
			yield* state.accounts.invalidate(provider.id, next)
			const unchanged = yield* state.providers.get(owner, provider.id)
			assert.ok(Option.isSome(unchanged))
			assert.strictEqual(unchanged.value.version, saved.value.version)
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
)
