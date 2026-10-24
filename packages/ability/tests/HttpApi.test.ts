// Each test builds its own server, so it uses Effect.provide.
// @effect-diagnostics strictEffectProvide:off
import { assert, describe, it } from "@effect/vitest"
import {
	Context,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
} from "effect"
import { Etag, HttpPlatform, HttpServerRequest } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiTest,
} from "effect/http-api"
import * as Authorization from "../src/HttpApi.ts"
import { Authorizer, Policy } from "../src/index.ts"
import {
	alice,
	aliceBot,
	App,
	Bot,
	bob,
	Caller,
	sharedBot,
} from "./fixtures.ts"

class Identity extends Context.Service<Identity, Caller>()(
	"@nmnmcc/ability/tests/HttpApi.test/Identity",
) {}

class Auth extends Authorizer.Service<Auth, { requires: Identity }>()(
	"@nmnmcc/ability/tests/HttpApi.test/Auth",
	App,
) {}

class BotNotFound extends Schema.TaggedError<BotNotFound>()("BotNotFound", {
	id: Schema.String,
}) {}

class Authentication extends HttpApiMiddleware.Service<
	Authentication,
	{ provides: Identity }
>()("@nmnmcc/ability/tests/HttpApi.test/Authentication") {}

class Authorize extends HttpApiMiddleware.Service<
	Authorize,
	{ requires: Identity }
>()("@nmnmcc/ability/tests/HttpApi.test/Authorize", {
	error: [...Authorization.errors, BotNotFound],
}) {}

const bots = new Map([
	[aliceBot.id, aliceBot],
	[sharedBot.id, sharedBot],
])

const findBot = (id: string | undefined) =>
	Effect.fromNullishOr(bots.get(id ?? "")).pipe(
		Effect.mapError(() => BotNotFound.make({ id: id ?? "" })),
	)

const Api = HttpApi.make("api").add(
	HttpApiGroup.make("bots")
		.add(
			HttpApiEndpoint.patch("rename", "/bots/:id", {
				params: { id: Schema.String },
				success: Schema.String,
			}).annotate(Authorization.Required, [
				Authorization.requires(Auth, "update", "Bot", (params) =>
					findBot(params["id"]),
				),
			]),
			HttpApiEndpoint.get("mine", "/users/:userId/bots", {
				params: { userId: Schema.String },
				success: Schema.String,
			}).annotate(Authorization.Required, [
				Authorization.requiresWhere(Auth, "update", "Bot", (params) => ({
					ownerUserId: params["userId"] ?? "",
				})),
			]),
			HttpApiEndpoint.get("count", "/bots/count", {
				success: Schema.Finite,
			}),
			HttpApiEndpoint.get("health", "/health", {
				success: Schema.String,
			}).annotate(Authorization.Required, []),
			HttpApiEndpoint.get("secret", "/secret", {
				success: Schema.String,
			}),
		)
		.annotate(Authorization.GroupRequired, {
			read: [Authorization.requires(Auth, "read", "Bot")],
			write: [],
		})
		.middleware(Authorize)
		.middleware(Authentication),
	HttpApiGroup.make("admin")
		.add(
			HttpApiEndpoint.get("stats", "/stats", {
				success: Schema.String,
			}),
		)
		.middleware(Authorize)
		.middleware(Authentication),
)

const BotsLive = HttpApiBuilder.group(Api, "bots", (handlers) =>
	Effect.succeed(
		handlers
			.handle("rename", ({ params }) => Effect.succeed(`renamed ${params.id}`))
			.handle("mine", ({ params }) =>
				Effect.succeed(`bots of ${params.userId}`),
			)
			.handle("count", () => Effect.succeed(bots.size))
			.handle("health", () => Effect.succeed("ok"))
			.handle("secret", () => Effect.succeed("secret")),
	),
)

const AdminLive = HttpApiBuilder.group(Api, "admin", (handlers) =>
	Effect.succeed(handlers.handle("stats", () => Effect.succeed("stats"))),
)

const AuthenticationLive = Layer.succeed(Authentication, (httpEffect) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest
		const caller =
			request.headers["x-user"] === "admin"
				? Caller.make({ ...alice, role: "admin" })
				: request.headers["x-user"] === "bob"
					? bob
					: alice
		return yield* Effect.provideService(httpEffect, Identity, caller)
	}),
)

const AuthLive = Authorizer.layer(Auth, {
	principal: Identity,
	policy: (caller) =>
		Effect.succeed(
			Policy.define(App)(function* (_) {
				yield* _.allow("update", Bot, {
					when: ($) => $.eq("ownerUserId", $.principal("userId")),
				})
				if (caller.role === "admin") {
					yield* _.allow("*", "*")
				}
			}),
		),
})

const MiddlewareLive = Layer.mergeAll(
	AuthenticationLive,
	Authorization.layer(Authorize, Auth),
).pipe(Layer.provide(AuthLive))

const PlatformLive = Layer.mergeAll(
	FileSystem.layerNoop({}),
	Path.layer,
	Etag.layer,
	HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
)

const ServerLive = Layer.mergeAll(BotsLive, AdminLive).pipe(
	Layer.provideMerge(MiddlewareLive),
	Layer.provideMerge(PlatformLive),
)

describe("HttpApi", () => {
	it.effect("checks a loaded resource for an endpoint", () =>
		Effect.gen(function* () {
			const client = yield* HttpApiTest.groups(Api, ["bots", "admin"])
			assert.strictEqual(
				yield* client.bots.rename({ params: { id: "b1" } }),
				"renamed b1",
			)
			const shared = yield* Effect.exit(
				client.bots.rename({ params: { id: "b2" } }),
			)
			assert.deepStrictEqual(
				Exit.findErrorOption(shared),
				Option.some(
					Authorizer.Forbidden.make({ action: "update", kind: "Bot" }),
				),
			)
			const missing = yield* Effect.exit(
				client.bots.rename({ params: { id: "nope" } }),
			)
			assert.isTrue(Exit.isFailure(missing))
		}).pipe(Effect.scoped, Effect.provide(ServerLive)),
	)

	it.effect("checks a part of a kind with where", () =>
		Effect.gen(function* () {
			const client = yield* HttpApiTest.groups(Api, ["bots", "admin"])
			assert.strictEqual(
				yield* client.bots.mine({ params: { userId: "alice" } }),
				"bots of alice",
			)
			const other = yield* Effect.exit(
				client.bots.mine({ params: { userId: "bob" } }),
			)
			assert.deepStrictEqual(
				Exit.findErrorOption(other),
				Option.some(
					Authorizer.Forbidden.make({ action: "update", kind: "Bot" }),
				),
			)
		}).pipe(Effect.scoped, Effect.provide(ServerLive)),
	)

	it.effect("uses the group default, and lets an empty list through", () =>
		Effect.gen(function* () {
			const client = yield* HttpApiTest.groups(Api, ["bots", "admin"])
			assert.strictEqual(yield* client.bots.health(), "ok")
			const count = yield* Effect.exit(client.bots.count())
			assert.isTrue(Exit.isFailure(count))
		}).pipe(Effect.scoped, Effect.provide(ServerLive)),
	)

	it.effect("closes an endpoint that does not say what it needs", () =>
		Effect.gen(function* () {
			const client = yield* HttpApiTest.groups(Api, ["bots", "admin"])
			const exit = yield* Effect.exit(client.admin.stats())
			assert.isTrue(Exit.isFailure(exit))
		}).pipe(Effect.scoped, Effect.provide(ServerLive)),
	)
})
