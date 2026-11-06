import * as TestDatabase from "@openbot-build/server-database/Testing"
import { type Caller, Identity } from "@openbot-build/domain/Identity"
import { ConnectionId } from "@openbot-build/domain/ConnectionId"
import { TokenId } from "@openbot-build/domain/TokenId"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { NodeCrypto, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { eq } from "drizzle-orm"
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"
import {
	AuthApi,
	Authorization as ApiAuthorization,
	OpenBotApi,
} from "@openbot-build/api"
import { Authorization } from "@openbot-build/domain"
import {
	CatalogDiscovery,
	Discovery,
	Document,
	Store as ProtocolStore,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Record as Rec,
	Redacted,
	Ref,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import * as StoredConnections from "@openbot-build/apps-contract/apps/StoredConnections"
import { IndexWork } from "@openbot-build/apps-contract/apps/IndexWork"
import { Probe } from "@openbot-build/apps-contract/apps/Probe"
import * as Db from "@openbot-build/server-database/Database"
import * as Migrations from "@openbot-build/server-database/Migrations"
import {
	appConnections,
	appRecords,
	organizations,
} from "@openbot-build/server-database/Schema"
import {
	memberDefaults,
	organizationDefaults,
	platformDefaults,
} from "@openbot-build/server-kernel/Documents"
import * as HttpBoundary from "@openbot-build/server-kernel/HttpBoundary"
import * as Records from "@openbot-build/server-kernel/Records"
import * as Secrets from "@openbot-build/server-kernel/Secrets"
import { Settings } from "@openbot-build/server-kernel/Settings"
import { AuthorizationCommands } from "../src/AuthorizationCommands.ts"
import { ConnectionCommands } from "../src/ConnectionCommands.ts"
import * as ConnectionHandlers from "../src/ConnectionHttpHandlers.ts"
import * as Connections from "../src/Connections.ts"
import * as Governance from "../src/Governance.ts"

interface Limits {
	readonly denied: ReadonlyArray<string>
	readonly token: ReadonlyArray<string>
	readonly revoked: boolean
}
class Current extends Context.Service<Current, Ref.Ref<Limits>>()(
	"@openbot-build/plugin-apps/test/ListAuthorization.test/Current",
) {}
const actor: Caller = {
	kind: "member",
	organizationId: "org",
	userId: "member",
}
const origin = "https://openbot.example.com"
const policy = Layer.unwrap(
	Effect.map(Current, (current) =>
		Authorizer.layer(Authorization.Auth, {
			policy: (caller) =>
				Ref.get(current).pipe(
					Effect.map((limits) => {
						if (limits.revoked) return Authorization.emptyPolicy
						const member = Policy.define(Authorization.OpenBot)(function* (_) {
							yield* _.allow("*", "*")
							yield* _.deny("read", Authorization.Connection, {
								when: ($) =>
									$.in(
										"id",
										Arr.map(limits.denied, (id) => ConnectionId.make(id)),
									),
							})
						})
						return caller.tokenId === "limited"
							? Policy.all([
									member,
									Policy.define(Authorization.OpenBot)(function* (_) {
										yield* _.allow("read", Authorization.Connection, {
											when: ($) =>
												$.in(
													"id",
													Arr.map(limits.token, (id) => ConnectionId.make(id)),
												),
										})
									}),
								])
							: member
					}),
				),
		}),
	),
)
/** The caller of each test token. */
const tokens: Readonly<Record<string, Caller>> = Rec.map(
	{
		token: actor,
		limited: actor,
		"other-user": { ...actor, userId: "other" },
		"other-org": { ...actor, organizationId: "other" },
	},
	(owner, secret): Caller => ({
		kind: "user_token",
		organizationId: owner.organizationId,
		userId: owner.userId,
		tokenId: TokenId.make(secret),
	}),
)
/** The member of each test session. */
const sessions: Readonly<Record<string, Caller>> = { session: actor }
/** Runs the route as the caller of a known credential. Any other fails with 401. */
const as = <A, E, R>(
	callers: Readonly<Record<string, Caller>>,
	credential: Redacted.Redacted<string>,
	route: Effect.Effect<A, E, R | Identity>,
) =>
	Rec.get(callers, Redacted.value(credential)).pipe(
		Effect.fromOption,
		Effect.catchTag("NoSuchElementError", () =>
			Effect.fail(AuthApi.AuthenticationRequired.make({})),
		),
		Effect.flatMap((caller) => Effect.provideService(route, Identity, caller)),
	)
/**
 * Each known test token or session names its caller. The auth plugin checks
 * real credentials and the browser origin, and its own tests check them.
 * This test checks the rights of the connection list.
 */
const layerBotAuth = Layer.succeed(AuthApi.BotAuth, {
	token: (route, { credential }) => as(tokens, credential, route),
	session: (route, { credential }) => as(sessions, credential, route),
})
/** Settings in memory: the public origin of the test and the defaults. */
const layerSettings = Layer.mock(Settings, {
	platform: Effect.succeedSome({
		document: {
			...platformDefaults,
			publicOrigin: origin,
			authSecret: "unused",
			identityProvider: null,
		},
		version: 1,
		updatedAt: 0,
	}),
	organization: () =>
		Effect.succeed({
			document: organizationDefaults,
			version: 0,
			updatedAt: 0,
		}),
	member: () =>
		Effect.succeed({ document: memberDefaults, version: 0, updatedAt: 0 }),
	notify: () => Effect.void,
	changes: Stream.never,
})
const database = Layer.effectDiscard(Migrations.migrate).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(TestDatabase.start, (database) =>
				PgClient.layer({ url: Redacted.make(database.url) }),
			),
		),
	),
)
const api = HttpApi.make("openbot-api").add(OpenBotApi.groups.connections)
const routes = HttpApiBuilder.layer(api).pipe(
	Layer.provide(ConnectionHandlers.layer),
	Layer.provide(HttpBoundary.layer),
	Layer.provide(
		AbilityHttpApi.layer(ApiAuthorization.Authorize, Authorization.Auth),
	),
	Layer.provide(layerBotAuth),
	Layer.provide([
		Layer.mock(ConnectionCommands, {}),
		Layer.mock(AuthorizationCommands, {}),
		Layer.mock(AuditLog, {}),
	]),
)
const services = HttpRouter.serve(routes, {
	disableLogger: true,
	disableListenLog: true,
}).pipe(
	Layer.provideMerge(Connections.layer),
	Layer.provide([
		Layer.mock(Discovery.Discovery, {}),
		CatalogDiscovery.layerRules,
		Layer.mock(Probe, {}),
		Layer.mock(IndexWork, {}),
		Governance.layer,
	]),
	Layer.provideMerge(Records.layer),
	Layer.provideMerge(policy),
	Layer.provideMerge(
		Layer.effect(
			Current,
			Ref.make<Limits>({ denied: [], token: [], revoked: false }),
		),
	),
	Layer.provide(layerSettings),
	Layer.provideMerge(
		Secrets.layer(Redacted.make("test:" + Str.repeat(32)("17"))),
	),
	Layer.provideMerge(database),
	Layer.provideMerge(NodeHttpServer.layerTest),
	Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
)
const encodeConnection = Schema.encodeEffect(
	Schema.fromJsonString(Schema.toCodecJson(StoredConnections.StoredConnection)),
)
const encodeApp = Schema.encodeEffect(StoredConnections.appCodec)
const encodeBinding = Schema.encodeEffect(
	Schema.fromJsonString(
		Schema.Tuple([Schema.Literal("connection"), Schema.String, Schema.String]),
	),
)
const seed = (id: string, owner: Caller) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		const secrets = yield* Secrets.Secrets
		yield* db
			.insert(organizations)
			.values({
				id: owner.organizationId,
				name: "Org",
				status: "active",
				createdAt: 0,
			})
			.onConflictDoNothing()
		const key = StoredConnections.ownerKey(owner)
		const connection = yield* ProtocolStore.UserConnection.decode({
			owner: key,
			connectionId: id,
			cardUrl: "https://app.example.com/card",
			endpoint: "https://app.example.com/mcp",
			remoteIndex: 0,
			configuration: Redacted.make({}),
			headers: Redacted.make({}),
			state: "Enabled",
			authorization: { _tag: "Unprotected" },
		})
		const app = yield* ProtocolStore.AppRecord.decode({
			cardUrl: connection.cardUrl,
			card: {
				$schema: Document.cardSchemaUrl,
				name: "example.com/app",
				version: "1.0.0",
				description: "App",
				remotes: [
					{
						type: "streamable-http",
						url: connection.endpoint,
						supportedProtocolVersions: ["2026-07-28"],
					},
				],
			},
			sources: [],
		})
		yield* db
			.insert(appRecords)
			.values({
				owner: key,
				cardUrl: connection.cardUrl,
				body: yield* encodeApp(app),
			})
			.onConflictDoNothing()
		const body = yield* encodeConnection({
			connection,
			name: id,
			revision: 0,
			verification: null,
		})
		yield* db.insert(appConnections).values({
			owner: key,
			id,
			name: id,
			revision: 0,
			body: yield* secrets.seal(
				body,
				yield* encodeBinding(["connection", key, id]),
			),
		})
	})
const cookie = HttpClientRequest.setHeaders({
	cookie: `${AuthApi.SessionCookie}=session`,
})
const token = (value: string) => HttpClientRequest.bearerToken(value)
const ids = (
	credential: (
		request: HttpClientRequest.HttpClientRequest,
	) => HttpClientRequest.HttpClientRequest,
) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const response = yield* client.execute(
			HttpClientRequest.get("/v1/connections").pipe(credential),
		)
		assert.equal(response.status, 200)
		const rows = yield* Schema.decodeUnknownEffect(
			Schema.Array(Schema.Struct({ id: Schema.String })),
		)(yield* response.json)
		return Arr.sort(
			Arr.map(rows, (row) => row.id),
			Str.Order,
		)
	})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"the connection list filters current member and token rights before it opens records",
		() =>
			Effect.gen(function* () {
				yield* seed("one", actor)
				yield* seed("two", actor)
				yield* seed("denied", actor)
				yield* seed("outside-user", { ...actor, userId: "other" })
				yield* seed("outside-org", { ...actor, organizationId: "other" })
				const current = yield* Current
				yield* Ref.set(current, {
					denied: ["denied"],
					token: ["one"],
					revoked: false,
				})
				// The hidden encrypted row cannot be opened. Filtering must happen in SQL.
				const db = yield* Db.make
				yield* db
					.update(appConnections)
					.set({ body: "not a sealed record" })
					.where(eq(appConnections.id, "denied"))
				for (const credential of [token("token"), cookie])
					assert.deepEqual(yield* ids(credential), ["one", "two"])
				assert.deepEqual(yield* ids(token("limited")), ["one"])
				assert.deepEqual(yield* ids(token("other-user")), ["outside-user"])
				assert.deepEqual(yield* ids(token("other-org")), ["outside-org"])
				const client = yield* HttpClient.HttpClient
				assert.equal(
					(yield* client.execute(HttpClientRequest.get("/v1/connections")))
						.status,
					401,
				)
				assert.equal(
					(yield* client.execute(
						HttpClientRequest.post("/v1/connection-drafts").pipe(
							HttpClientRequest.bodyJsonUnsafe({
								input: "https://app.example.com/card",
							}),
							token("limited"),
						),
					)).status,
					403,
				)
				yield* Ref.update(current, (limits) => ({ ...limits, revoked: true }))
				for (const credential of [token("token"), cookie])
					assert.deepEqual(yield* ids(credential), [])
			}),
	)
})
