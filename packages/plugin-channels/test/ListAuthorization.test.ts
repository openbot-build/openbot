import * as TestDatabase from "@openbot-build/server-database/Testing"
import { Channels as ChannelsModel } from "@openbot-build/conversation-contract/channels/Channels"
import { type Caller, Identity } from "@openbot-build/domain/Identity"
import { TokenId } from "@openbot-build/domain/TokenId"
import { BotId } from "@openbot-build/domain/BotId"
import { PgClient } from "@effect/sql-pg"
import { assert, layer } from "@effect/vitest"
import { NodeCrypto, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Authorizer, Policy } from "@nmnmcc/ability"
import * as AbilityHttpApi from "@nmnmcc/ability/HttpApi"
import {
	AuthApi,
	Authorization as ApiAuthorization,
	OpenBotApi,
} from "@openbot-build/api"
import { Authorization, Execution } from "@openbot-build/domain"
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
import * as Db from "@openbot-build/server-database/Database"
import * as Migrations from "@openbot-build/server-database/Migrations"
import { organizations } from "@openbot-build/server-database/Schema"
import {
	memberDefaults,
	organizationDefaults,
	platformDefaults,
} from "@openbot-build/server-kernel/Documents"
import * as HttpBoundary from "@openbot-build/server-kernel/HttpBoundary"
import * as Records from "@openbot-build/server-kernel/Records"
import * as Secrets from "@openbot-build/server-kernel/Secrets"
import { Settings } from "@openbot-build/server-kernel/Settings"
import { ChannelConfig } from "../src/ChannelConfig.ts"
import { ChannelRemoval } from "../src/ChannelRemoval.ts"
import * as Channels from "../src/Channels.ts"
import * as ChannelHandlers from "../src/HttpHandlers.ts"

interface Limits {
	readonly denied: ReadonlyArray<string>
	readonly token: ReadonlyArray<string>
	readonly revoked: boolean
}
class Current extends Context.Service<Current, Ref.Ref<Limits>>()(
	"@openbot-build/plugin-channels/test/ListAuthorization.test/Current",
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
							yield* _.deny("read", Authorization.Channel, {
								when: ($) => $.in("id", limits.denied),
							})
						})
						return caller.tokenId === "limited"
							? Policy.all([
									member,
									Policy.define(Authorization.OpenBot)(function* (_) {
										yield* _.allow("read", Authorization.Channel, {
											when: ($) => $.in("id", limits.token),
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
 * This test checks the rights of the channel list.
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
const api = HttpApi.make("openbot-api").add(OpenBotApi.groups.channels)
const routes = HttpApiBuilder.layer(api).pipe(
	Layer.provide(ChannelHandlers.layer),
	Layer.provide(HttpBoundary.layer),
	Layer.provide(
		AbilityHttpApi.layer(ApiAuthorization.Authorize, Authorization.Auth),
	),
	Layer.provide(layerBotAuth),
	Layer.provide([
		Layer.mock(ChannelConfig, {}),
		Layer.mock(ChannelRemoval, {}),
		Layer.mock(AuditLog, {}),
	]),
)
const services = HttpRouter.serve(routes, {
	disableLogger: true,
	disableListenLog: true,
}).pipe(
	Layer.provideMerge(Channels.layer),
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
const seed = (id: string, owner: Caller) =>
	Effect.gen(function* () {
		const db = yield* Db.make
		yield* db
			.insert(organizations)
			.values({
				id: owner.organizationId,
				name: "Org",
				status: "active",
				createdAt: 0,
			})
			.onConflictDoNothing()
		const channel = yield* (yield* ChannelsModel).create({
			id: "chn_" + id,
			executionId: Execution.Id.make("channel-configuration"),
			at: 0,
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
})
const token = (value: string) => HttpClientRequest.bearerToken(value)
const ids = (path: string, credential = token("token")) =>
	Effect.gen(function* () {
		const client = yield* HttpClient.HttpClient
		const response = yield* client.execute(
			HttpClientRequest.get(path).pipe(credential),
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
		"the channel list filters current member and token rights before it opens records",
		() =>
			Effect.gen(function* () {
				const first = yield* seed("one", actor)
				const second = yield* seed("two", actor)
				const denied = yield* seed("denied", actor)
				const otherUser = yield* seed("outside-user", {
					...actor,
					userId: "other",
				})
				const otherOrg = yield* seed("outside-org", {
					...actor,
					organizationId: "other",
				})
				const current = yield* Current
				yield* Ref.set(current, {
					denied: [denied, otherUser],
					token: [first],
					revoked: false,
				})
				const path = "/v1/organization/channels"
				for (const credential of [token("token"), cookie])
					assert.deepEqual(
						yield* ids(path, credential),
						Arr.sort([first, second], Str.Order),
					)
				assert.deepEqual(yield* ids(path, token("limited")), [first])
				assert.deepEqual(yield* ids(path, token("other-org")), [otherOrg])
				const client = yield* HttpClient.HttpClient
				assert.equal(
					(yield* client.execute(HttpClientRequest.get(path))).status,
					401,
				)
				assert.equal(
					(yield* client.execute(
						HttpClientRequest.post(path).pipe(
							HttpClientRequest.bodyJsonUnsafe({
								commandKey: "create",
								name: "New",
								bot: "bot",
								credentials: {
									kind: "custom",
									endpoint: "https://channel.example.com",
								},
							}),
							token("limited"),
						),
					)).status,
					403,
				)
				yield* Ref.update(current, (limits) => ({ ...limits, revoked: true }))
				for (const credential of [token("token"), cookie])
					assert.deepEqual(yield* ids(path, credential), [])
			}),
	)
})
