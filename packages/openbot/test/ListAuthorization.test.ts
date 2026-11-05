import { assert, layer } from "@effect/vitest"
import { NodeCrypto, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Authorizer, Policy } from "@nmnmcc/ability"
import { eq } from "drizzle-orm"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { migrationsFolder } from "@openbot-build/server-database/MigrationsFolder"
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"
import {
	AuthApi,
	Authorization as ApiAuthorization,
	OpenBotApi,
} from "@openbot-build/api"
import {
	Authorization,
	BotId,
	ConnectionId,
	TokenId,
	type Caller,
} from "@openbot-build/domain"
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
	Redacted,
	Ref,
	Schema,
	String as Str,
} from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { Auth } from "@openbot-build/identity-contract/auth/Auth"
import { Tokens } from "@openbot-build/identity-contract/auth/Tokens"
import { CredentialRejected } from "@openbot-build/server-kernel/auth/Model"
import { layerBotAuth } from "@openbot-build/plugin-auth/HttpMiddleware"
import { RateLimiter } from "@openbot-build/server-billing/billing/RateLimit"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import * as Connections from "../src/plugin-apps/Connections.ts"
import * as ConnectionHandlers from "../src/plugin-apps/ConnectionHttpHandlers.ts"
import * as StoredConnections from "@openbot-build/apps-contract/apps/StoredConnections"
import { ConnectionCommands } from "../src/plugin-apps/ConnectionCommands.ts"
import { AuthorizationCommands } from "../src/plugin-apps/AuthorizationCommands.ts"
import * as Governance from "../src/plugin-apps/Governance.ts"
import { IndexWork } from "@openbot-build/apps-contract/apps/IndexWork"
import { Probe } from "../src/plugin-apps/Probe.ts"
import * as Channels from "../src/plugin-channels/Channels.ts"
import * as ChannelHandlers from "../src/plugin-channels/HttpHandlers.ts"
import { ChannelConfig } from "../src/plugin-channels/ChannelConfig.ts"
import { ChannelRemoval } from "../src/plugin-channels/ChannelRemoval.ts"
import * as Files from "@openbot-build/plugin-files/Files"
import * as FileHandlers from "@openbot-build/plugin-files/HttpHandlers"
import { FileTasks } from "@openbot-build/plugin-files/FileTasks"
import * as Database from "../src/app/DatabasePostgres.ts"
import * as Db from "@openbot-build/server-database/Database"
import {
	appConnections,
	appRecords,
	files,
	organizations,
} from "@openbot-build/server-database/Schema"
import * as Records from "@openbot-build/server-kernel/errors/Records"
import * as HttpBoundary from "@openbot-build/server-kernel/errors/HttpBoundary"
import * as Secrets from "@openbot-build/server-kernel/secrets/Secrets"
import * as Fixture from "./OrganizationFixture.ts"
import * as Postgres from "./PostgresTest.ts"

interface Limits {
	readonly denied: ReadonlyArray<string>
	readonly token: ReadonlyArray<string>
	readonly revoked: boolean
}
class Current extends Context.Service<Current, Ref.Ref<Limits>>()(
	"@openbot-build/openbot/test/ListAuthorization.test/Current",
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
							yield* _.deny("read", Authorization.File, {
								when: ($) => $.in("id", limits.denied),
							})
							yield* _.deny("read", Authorization.Channel, {
								when: ($) => $.in("id", limits.denied),
							})
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
										yield* _.allow("read", Authorization.File, {
											when: ($) => $.in("id", limits.token),
										})
										yield* _.allow("read", Authorization.Channel, {
											when: ($) => $.in("id", limits.token),
										})
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
const auth = Layer.mock(Auth, {
	resolveSession: (credential) =>
		Redacted.value(credential) !== "session"
			? Effect.fail(CredentialRejected.make({ kind: "session" }))
			: Effect.succeed({
					userId: actor.userId,
					profile: {},
					platformAdmin: false,
					canCreateOrganization: false,
					memberships: [
						{
							organizationId: actor.organizationId,
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
	authenticate: (credential) => {
		const secret = Redacted.value(credential)
		return Arr.contains(["token", "limited", "other-user", "other-org"], secret)
			? Effect.succeed({
					kind: "user_token" as const,
					organizationId:
						secret === "other-org" ? "other" : actor.organizationId,
					userId: secret === "other-user" ? "other" : actor.userId,
					tokenId: TokenId.make(secret),
				})
			: Effect.fail(CredentialRejected.make({ kind: "token" }))
	},
})
const database = Layer.effectDiscard(
	Effect.gen(function* () {
		const db = yield* Db.make
		yield* migrate(db, {
			migrationsFolder,
		})
	}),
).pipe(
	Layer.provideMerge(
		Layer.unwrap(
			Effect.map(Postgres.start, (database) =>
				Database.layer({ databaseUrl: Redacted.make(database.url) }),
			),
		),
	),
)
const api = HttpApi.make("openbot-api")
	.add(OpenBotApi.groups.files)
	.add(OpenBotApi.groups.connections)
	.add(OpenBotApi.groups.channels)
const routes = HttpApiBuilder.layer(api).pipe(
	Layer.provide([
		FileHandlers.layer,
		ConnectionHandlers.layer,
		ChannelHandlers.layer,
	]),
	Layer.provide(HttpBoundary.layer),
	Layer.provide(
		AbilityHttpApi.layer(ApiAuthorization.Authorize, Authorization.Auth),
	),
	Layer.provide(
		layerBotAuth.pipe(
			Layer.provide([
				auth,
				tokens,
				Fixture.layerEveryoneAdministrator,
				Layer.mock(RateLimiter, { hit: () => Effect.void }),
			]),
		),
	),
	Layer.provide([
		Layer.mock(ConnectionCommands, {}),
		Layer.mock(AuthorizationCommands, {}),
		Layer.mock(ChannelConfig, {}),
		Layer.mock(ChannelRemoval, {}),
		Layer.mock(AuditLog, {}),
	]),
)
const services = HttpRouter.serve(routes, {
	disableLogger: true,
	disableListenLog: true,
}).pipe(
	Layer.provideMerge(
		Layer.mergeAll(Files.layer, Connections.layer, Channels.layer),
	),
	Layer.provide([
		Layer.mock(FileTasks, {}),
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
	Layer.provide(Fixture.layerSettings({ publicOrigin: origin })),
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
const seed = (id: string, owner: Caller, createdAt: number) =>
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
		yield* db.insert(files).values({
			id,
			organizationId: owner.organizationId,
			userId: owner.userId,
			filename: id + ".txt",
			mediaType: "text/plain",
			bytes: 1,
			status: "ready",
			objectKey: id,
			createdAt,
			updatedAt: createdAt,
		})
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
		const channel = yield* (yield* Channels.Channels).create({
			caller: owner,
			name: id,
			bot: BotId.make("bot"),
			enabled: true,
			linkPath: null,
			credentials: {
				kind: "custom",
				endpoint: "https://channel.example.com",
				secret: null,
			},
		})
		return channel.id
	})
const cookie = HttpClientRequest.setHeaders({
	cookie: `${AuthApi.SessionCookie}=session`,
	origin,
})
const token = (value: string) => HttpClientRequest.bearerToken(value)
const read = (path: string, credential = token("token")) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const response = yield* client.execute(
			HttpClientRequest.get(path).pipe(credential),
		)
		assert.equal(response.status, 200)
		return yield* response.json
	})
const ids = (data: unknown) =>
	Schema.decodeUnknownEffect(
		Schema.Array(Schema.Struct({ id: Schema.String })),
	)(data).pipe(
		Effect.map((rows) =>
			Arr.sort(
				Arr.map(rows, (row) => row.id),
				Str.Order,
			),
		),
	)
const filePage = Schema.Struct({
	items: Schema.Array(Schema.Struct({ id: Schema.String })),
	next: Schema.NullOr(Schema.String),
})

layer(services, { excludeTestServices: true, timeout: "60 seconds" })((it) => {
	it.effect(
		"lists filter current member and token rights before paging or opening records",
		() =>
			Effect.gen(function* () {
				const first = yield* seed("one", actor, 2)
				const second = yield* seed("two", actor, 1)
				const denied = yield* seed("denied", actor, 3)
				const otherUser = yield* seed(
					"outside-user",
					{ ...actor, userId: "other" },
					4,
				)
				const otherOrg = yield* seed(
					"outside-org",
					{ ...actor, organizationId: "other" },
					5,
				)
				const current = yield* Current
				yield* Ref.set(current, {
					denied: ["denied", denied, otherUser],
					token: ["one", first],
					revoked: false,
				})
				// The hidden encrypted row cannot be opened. Filtering must happen in SQL.
				const db = yield* Db.make
				yield* db
					.update(appConnections)
					.set({ body: "not a sealed record" })
					.where(eq(appConnections.id, "denied"))
				for (const credential of [token("token"), cookie]) {
					assert.deepEqual(
						yield* ids(yield* read("/v1/connections", credential)),
						["one", "two"],
					)
					assert.deepEqual(
						yield* ids(yield* read("/v1/organization/channels", credential)),
						Arr.sort([first, second], Str.Order),
					)
					const page = yield* Schema.decodeUnknownEffect(filePage)(
						yield* read("/v1/files?limit=1", credential),
					)
					assert.deepEqual(page, { items: [{ id: "one" }], next: "one" })
					assert.deepEqual(
						yield* Schema.decodeUnknownEffect(filePage)(
							yield* read("/v1/files?limit=1&after=one", credential),
						),
						{ items: [{ id: "two" }], next: null },
					)
				}
				assert.deepEqual(
					yield* ids(yield* read("/v1/connections", token("limited"))),
					["one"],
				)
				assert.deepEqual(
					yield* ids(
						yield* read("/v1/organization/channels", token("limited")),
					),
					[first],
				)
				assert.deepEqual(
					yield* Schema.decodeUnknownEffect(filePage)(
						yield* read("/v1/files?limit=1", token("limited")),
					),
					{ items: [{ id: "one" }], next: null },
				)
				assert.deepEqual(
					yield* ids(yield* read("/v1/connections", token("other-user"))),
					["outside-user"],
				)
				assert.deepEqual(
					yield* ids(yield* read("/v1/connections", token("other-org"))),
					["outside-org"],
				)
				assert.deepEqual(
					yield* ids(
						yield* read("/v1/organization/channels", token("other-org")),
					),
					[otherOrg],
				)
				for (const [credential, expected] of [
					[token("other-user"), "outside-user"],
					[token("other-org"), "outside-org"],
				] as const)
					assert.deepEqual(
						(yield* Schema.decodeUnknownEffect(filePage)(
							yield* read("/v1/files", credential),
						)).items,
						[{ id: expected }],
					)
				const client = yield* HttpClient.HttpClient
				for (const path of [
					"/v1/files",
					"/v1/connections",
					"/v1/organization/channels",
				])
					assert.equal(
						(yield* client.execute(HttpClientRequest.get(path))).status,
						401,
					)
				for (const request of [
					HttpClientRequest.post("/v1/files/uploads").pipe(
						HttpClientRequest.bodyJsonUnsafe({
							filename: "new.txt",
							mediaType: "text/plain",
							bytes: 1,
						}),
					),
					HttpClientRequest.post("/v1/connection-drafts").pipe(
						HttpClientRequest.bodyJsonUnsafe({
							input: "https://app.example.com/card",
						}),
					),
					HttpClientRequest.post("/v1/organization/channels").pipe(
						HttpClientRequest.bodyJsonUnsafe({
							commandKey: "create",
							name: "New",
							bot: "bot",
							credentials: {
								kind: "custom",
								endpoint: "https://channel.example.com",
							},
						}),
					),
				])
					assert.equal(
						(yield* client.execute(request.pipe(token("limited")))).status,
						403,
					)
				assert.equal(
					(yield* client.execute(
						HttpClientRequest.get("/v1/files?after=two").pipe(token("limited")),
					)).status,
					400,
				)
				for (const cursor of [
					"denied",
					"outside-user",
					"outside-org",
					"missing",
				])
					assert.equal(
						(yield* client.execute(
							HttpClientRequest.get("/v1/files?after=" + cursor).pipe(cookie),
						)).status,
						400,
					)
				yield* Ref.update(current, (limits) => ({ ...limits, revoked: true }))
				for (const credential of [token("token"), cookie]) {
					assert.deepEqual(
						yield* ids(yield* read("/v1/connections", credential)),
						[],
					)
					assert.deepEqual(
						yield* ids(yield* read("/v1/organization/channels", credential)),
						[],
					)
					assert.deepEqual(
						yield* Schema.decodeUnknownEffect(filePage)(
							yield* read("/v1/files", credential),
						),
						{ items: [], next: null },
					)
				}
			}),
	)
})
