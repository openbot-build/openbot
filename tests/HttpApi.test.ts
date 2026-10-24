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
	aliceTrigger,
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

// A wrapper that takes any kind. Its load function gives a Trigger, also when
// the kind is "Bot".
const readAny = (kind: "Bot" | "Trigger") =>
	Authorization.requires(Auth, "read", kind, () => Effect.succeed(aliceTrigger))

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
			HttpApiEndpoint.get("count", "/bots/count", {
				success: Schema.Finite,
			}),
			HttpApiEndpoint.get("health", "/health", {
				success: Schema.String,
			}).annotate(Authorization.Required, []),
			HttpApiEndpoint.get("secret", "/secret", {
				success: Schema.String,
			}),
			HttpApiEndpoint.get("mixed", "/mixed", {
				success: Schema.String,
			}).annotate(Authorization.Required, [readAny("Bot")]),
			HttpApiEndpoint.post("create", "/orgs/:org/users/:user/bots", {
				params: { org: Schema.String, user: Schema.String },
				success: Schema.String,
			}).annotate(Authorization.Required, [
				Authorization.requires(Auth, "update", "Bot", {
					within: (params) => ($) =>
						$.under(
							"org",
							params["org"] ?? null,
							"user",
							params["user"] ?? null,
						),
				}),
			]),
			HttpApiEndpoint.get("list", "/orgs/:org/bots", {
				params: { org: Schema.String },
				success: Schema.String,
			}).annotate(Authorization.Required, [
				Authorization.lists(Auth, "read", "Bot", {
					within: (params) => ($) => $.under("org", params["org"] ?? null),
				}),
			]),
			HttpApiEndpoint.get("strictList", "/orgs/:org/strict-bots", {
				params: { org: Schema.String },
				success: Schema.String,
			}).annotate(Authorization.Required, [
				Authorization.lists(Auth, "read", "Bot", {
					within: (params) => ($) => $.under("org", params["org"] ?? null),
					nonEmpty: true,
				}),
			]),
			HttpApiEndpoint.post("careless", "/careless", {
				success: Schema.String,
			}).annotate(Authorization.Required, [
				Authorization.requires(Auth, "update", "Bot", {
					// There is no `org` parameter, so the value is `undefined`.
					within: (params) => ($) => $.under("org", params["org"] as string),
				}),
			]),
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
			.handle("count", () => Effect.succeed(bots.size))
			.handle("health", () => Effect.succeed("ok"))
			.handle("secret", () => Effect.succeed("secret"))
			.handle("mixed", () => Effect.succeed("mixed"))
			.handle("create", ({ params }) =>
				Effect.succeed(`created in ${params.org}`),
			)
			.handle("list", () => Effect.succeed("listed"))
			.handle("strictList", () => Effect.succeed("listed"))
			.handle("careless", () => Effect.succeed("created")),
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

const BrokenServerLive = Layer.mergeAll(BotsLive, AdminLive).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			AuthenticationLive,
			Authorization.layer(Authorize, Auth),
		).pipe(
			Layer.provide(
				Authorizer.layer(Auth, {
					principal: Identity,
					policy: () => Effect.fail({ password: "secret" }),
				}),
			),
		),
	),
	Layer.provideMerge(PlatformLive),
)

const MixedServerLive = Layer.mergeAll(BotsLive, AdminLive).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			AuthenticationLive,
			Authorization.layer(Authorize, Auth),
		).pipe(
			Layer.provide(
				Authorizer.layer(Auth, {
					principal: Identity,
					policy: () =>
						Effect.succeed(
							Policy.define(App)(function* (_) {
								yield* _.allow("read", "Trigger")
								yield* _.deny("read", Bot)
							}),
						),
				}),
			),
		),
	),
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

	it.effect("does not send the cause of PolicyUnavailable", () =>
		Effect.gen(function* () {
			const client = yield* HttpApiTest.groups(Api, ["bots", "admin"])
			const exit = yield* Effect.exit(
				client.bots.rename({ params: { id: "b1" } }),
			)
			const error = Exit.findErrorOption(exit)
			assert.isTrue(
				error._tag === "Some" &&
					error.value instanceof Authorizer.PolicyUnavailable,
			)
			assert.notInclude(JSON.stringify(error), "secret")
		}).pipe(Effect.scoped, Effect.provide(BrokenServerLive)),
	)

	it.effect("checks a scope from the path parameters", () =>
		Effect.gen(function* () {
			const client = yield* HttpApiTest.groups(Api, ["bots", "admin"])
			assert.strictEqual(
				yield* client.bots.create({ params: { org: "acme", user: "alice" } }),
				"created in acme",
			)
			const other = yield* Effect.exit(
				client.bots.create({ params: { org: "acme", user: "bob" } }),
			)
			assert.deepStrictEqual(
				Exit.findErrorOption(other),
				Option.some(
					Authorizer.Forbidden.make({ action: "update", kind: "Bot" }),
				),
			)
			const careless = yield* Effect.exit(client.bots.careless())
			assert.isTrue(Exit.isFailure(careless))
		}).pipe(Effect.scoped, Effect.provide(ServerLive)),
	)

	it.effect("lets a list through when it is empty, unless it must not be", () =>
		Effect.gen(function* () {
			const client = yield* HttpApiTest.groups(Api, ["bots", "admin"])
			assert.strictEqual(
				yield* client.bots.list({ params: { org: "acme" } }),
				"listed",
			)
			const strict = yield* Effect.exit(
				client.bots.strictList({ params: { org: "acme" } }),
			)
			assert.deepStrictEqual(
				Exit.findErrorOption(strict),
				Option.some(Authorizer.Forbidden.make({ action: "read", kind: "Bot" })),
			)
		}).pipe(Effect.scoped, Effect.provide(ServerLive)),
	)

	it.effect("does not check a loaded value of another kind", () =>
		Effect.gen(function* () {
			const client = yield* HttpApiTest.groups(Api, ["bots", "admin"])
			const exit = yield* Effect.exit(client.bots.mixed())
			assert.isTrue(Exit.isFailure(exit))
		}).pipe(Effect.scoped, Effect.provide(MixedServerLive)),
	)
})
