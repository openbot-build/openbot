// Each test gives its own layer, so it uses Effect.provide.
// @effect-diagnostics strictEffectProvide:off
import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Context, Effect, Exit, Layer, Ref, Schema } from "effect"
import {
	Authorizer,
	Condition,
	Decision,
	Domain,
	Policy,
	Principal,
} from "../src/index.ts"
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
	"@nmnmcc/ability/tests/Authorizer.test/Identity",
) {}

class Auth extends Authorizer.Service<Auth, { requires: Identity }>()(
	"test/Auth",
	App,
) {}

const policyFor = (caller: Caller) =>
	Policy.define(App)(function* (_) {
		yield* _.allow("read", Bot, {
			when: ($) => $.under("org", $.principal("organizationId")),
		})
		yield* _.allow(["update", "delete"], Bot, {
			when: ($) => $.eq("ownerUserId", $.principal("userId")),
		})
		yield* _.deny("delete", Bot, {
			when: ($) => $.gte("level", 2),
			reason: "This Bot is in use",
		})
		if (caller.role === "admin") {
			yield* _.allow("*", "*")
		}
	})

const makeLayer = (options: {
	readonly loads: Ref.Ref<number>
	readonly fail?: boolean
	readonly decider?: Authorizer.Options<
		typeof App,
		never,
		Identity,
		never,
		never,
		never
	>["decider"]
}) =>
	Authorizer.layer(Auth, {
		principal: Identity,
		policy: (caller) =>
			Ref.update(options.loads, (n) => n + 1).pipe(
				Effect.andThen(
					options.fail === true
						? Effect.fail("database is down")
						: Effect.succeed(policyFor(caller)),
				),
			),
		...(options.decider === undefined ? {} : { decider: options.decider }),
	})

const run = <A, E>(
	effect: Effect.Effect<A, E, Auth | Identity>,
	options: {
		readonly caller?: Caller
		readonly fail?: boolean
		readonly decider?: Parameters<typeof makeLayer>[0]["decider"]
	} = {},
) =>
	Effect.gen(function* () {
		const loads = yield* Ref.make(0)
		const exit = yield* effect.pipe(
			Effect.provideService(Identity, options.caller ?? alice),
			Effect.provide(makeLayer({ loads, ...options })),
			Effect.exit,
		)
		return { exit, loads: yield* Ref.get(loads) }
	})

const failureTag = (exit: Exit.Exit<unknown, unknown>) =>
	Exit.isFailure(exit)
		? Exit.findErrorOption(exit).pipe((option) =>
				option._tag === "Some"
					? (option.value as { readonly _tag: string })._tag
					: "Defect",
			)
		: "Success"

describe("Authorizer", () => {
	it.effect("passes a check that the policy allows", () =>
		Effect.gen(function* () {
			const { exit } = yield* run(
				Auth.check({ action: "update", resource: aliceBot }),
			)
			assert.isTrue(Exit.isSuccess(exit))
		}),
	)

	it.effect("fails a check with Forbidden and the reason of the rule", () =>
		Effect.gen(function* () {
			const { exit } = yield* run(
				Auth.check({ action: "delete", resource: aliceBot }),
			)
			assert.strictEqual(failureTag(exit), "Forbidden")
			const error = Exit.findErrorOption(exit)
			assert.deepStrictEqual(
				error._tag === "Some" ? error.value : undefined,
				Authorizer.Forbidden.make({
					action: "delete",
					kind: "Bot",
					reason: "This Bot is in use",
				}),
			)
		}),
	)

	it.effect("checks a kind only when every value is allowed", () =>
		Effect.gen(function* () {
			const member = yield* run(Auth.check({ action: "read", kind: "Bot" }))
			assert.strictEqual(failureTag(member.exit), "Forbidden")
			const admin = yield* run(Auth.check({ action: "read", kind: "Bot" }), {
				caller: Caller.make({ ...alice, role: "admin" }),
			})
			assert.isTrue(Exit.isSuccess(admin.exit))
		}),
	)

	it.effect("hides a resource that the principal may not read", () =>
		Effect.gen(function* () {
			const other = Bot.make({ ...aliceBot, organizationId: "other" })
			const hidden = yield* run(
				Auth.guard(
					{ action: "update", resource: other },
					{ hide: () => ({ _tag: "BotNotFound" as const }) },
				),
			)
			assert.strictEqual(failureTag(hidden.exit), "BotNotFound")
			const seen = yield* run(
				Auth.guard(
					{ action: "update", resource: aliceBot },
					{ hide: () => ({ _tag: "BotNotFound" as const }) },
				),
				{ caller: bob },
			)
			assert.strictEqual(failureTag(seen.exit), "Forbidden")
		}),
	)

	it.effect("gives a filter for queries", () =>
		Effect.gen(function* () {
			const { exit } = yield* run(
				Effect.gen(function* () {
					const condition = yield* Auth.filter({
						action: "update",
						kind: "Bot",
					})
					return [
						yield* Condition.evaluate(condition, { value: aliceBot }),
						yield* Condition.evaluate(condition, { value: sharedBot }),
					]
				}),
			)
			assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value : [], [
				true,
				false,
			])
		}),
	)

	describe("scopes", () => {
		it.effect("checks every value in a scope", () =>
			Effect.gen(function* () {
				const acme = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: ($) => $.under("org", "acme"),
					}),
				)
				assert.isTrue(Exit.isSuccess(acme.exit))
				const own = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: ($) => $.under("org", $.principal("organizationId")),
					}),
				)
				assert.isTrue(Exit.isSuccess(own.exit))
				const other = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: ($) => $.under("org", "other"),
					}),
				)
				assert.strictEqual(failureTag(other.exit), "Forbidden")
			}),
		)

		it.effect("checks a new value that has no id yet", () =>
			Effect.gen(function* () {
				const target = {
					action: "update",
					kind: "Bot",
					within: ($) => $.under("org", "acme", "user", "alice"),
				} satisfies Authorizer.Target<typeof App>
				const owner = yield* run(Auth.check(target))
				assert.isTrue(Exit.isSuccess(owner.exit))
				const other = yield* run(Auth.check(target), { caller: bob })
				assert.strictEqual(failureTag(other.exit), "Forbidden")
			}),
		)

		it.effect("never passes a check on an empty scope", () =>
			Effect.gen(function* () {
				const { exit } = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: ($) => $.and($.eq("name", "a"), $.eq("name", "b")),
					}),
					{ caller: Caller.make({ ...alice, role: "admin" }) },
				)
				assert.strictEqual(failureTag(exit), "Forbidden")
			}),
		)

		it.effect("gives a filter in a scope, and an empty one with no value", () =>
			Effect.gen(function* () {
				const other = Bot.make({ ...aliceBot, organizationId: "other" })
				const { exit } = yield* run(
					Effect.gen(function* () {
						const acme = yield* Auth.filter({
							action: "read",
							kind: "Bot",
							within: ($) => $.under("org", "acme"),
						})
						const none = yield* Auth.filter({
							action: "update",
							kind: "Bot",
							within: ($) => $.under("org", "acme", "user", "bob"),
						})
						return [
							yield* Condition.evaluate(acme, { value: aliceBot }),
							yield* Condition.evaluate(acme, { value: other }),
							none._tag,
						]
					}),
				)
				assert.deepStrictEqual(Exit.isSuccess(exit) ? exit.value : [], [
					true,
					false,
					"False",
				])
			}),
		)

		it.effect("tells how much of a scope the principal may act on", () =>
			Effect.gen(function* () {
				const { exit } = yield* run(
					Effect.all([
						Auth.coverage({ action: "read", kind: "Bot" }),
						Auth.coverage({
							action: "update",
							kind: "Bot",
							within: ($) => $.under("org", "acme", "user", "alice"),
						}),
						Auth.coverage({
							action: "read",
							kind: "Bot",
							within: ($) => $.under("org", "other"),
						}),
					]),
				)
				assert.deepStrictEqual(
					Exit.isSuccess(exit) ? exit.value.map((value) => value._tag) : [],
					["Some", "All", "None"],
				)
			}),
		)

		it.effect(
			"asks the decider only when no value in the scope is denied",
			() =>
				Effect.gen(function* () {
					const decider = () => Effect.succeed(Decision.Allow({}))
					const delegate = yield* run(
						Auth.check({
							action: "delegate",
							kind: "Bot",
							within: ($) => $.under("org", "acme"),
						}),
						{ decider },
					)
					assert.isTrue(Exit.isSuccess(delegate.exit))
					// Alice may delete her Bots, but not the ones in use.
					const remove = yield* run(
						Auth.check({
							action: "delete",
							kind: "Bot",
							within: ($) => $.under("org", "acme", "user", "alice"),
						}),
						{ decider },
					)
					assert.strictEqual(failureTag(remove.exit), "Forbidden")
					const unused = yield* run(
						Auth.check({
							action: "delete",
							kind: "Bot",
							within: ($) =>
								$.and(
									$.under("org", "acme", "user", "alice"),
									$.lt("level", 2),
								),
						}),
					)
					assert.isTrue(Exit.isSuccess(unused.exit))
				}),
		)

		it.effect("stops a scope that is not plain data", () =>
			Effect.gen(function* () {
				const predicate = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: (($: Condition.Builder<object, Bot, Caller>) =>
							$.predicate("shared", (bot) => bot.shared)) as never,
					}),
				)
				assert.strictEqual(failureTag(predicate.exit), "Defect")
				const missing = yield* run(
					Auth.check({
						action: "read",
						kind: "Bot",
						within: ($) => $.under("org", undefined as unknown as string),
					}),
				)
				assert.strictEqual(failureTag(missing.exit), "Defect")
			}),
		)
	})

	it.effect("loads the policy of a principal once", () =>
		Effect.gen(function* () {
			const { loads } = yield* run(
				Effect.gen(function* () {
					yield* Auth.check({ action: "read", resource: aliceBot })
					yield* Auth.check({ action: "read", resource: sharedBot })
					yield* Effect.provideService(
						Auth.check({ action: "read", resource: sharedBot }),
						Identity,
						bob,
					)
					yield* Auth.check({ action: "update", resource: aliceBot })
				}),
			)
			assert.strictEqual(loads, 2)
		}),
	)

	it.effect("loads the policy again after invalidate", () =>
		Effect.gen(function* () {
			const { loads } = yield* run(
				Effect.gen(function* () {
					const auth = yield* Auth
					yield* auth.check({ action: "read", resource: aliceBot })
					yield* auth.invalidate(alice)
					yield* auth.check({ action: "read", resource: aliceBot })
				}),
			)
			assert.strictEqual(loads, 2)
		}),
	)

	it.effect("fails closed when the policy can not be loaded", () =>
		Effect.gen(function* () {
			const { exit, loads } = yield* run(
				Effect.gen(function* () {
					yield* Effect.ignore(
						Auth.check({ action: "read", resource: aliceBot }),
					)
					yield* Auth.check({ action: "read", resource: aliceBot })
				}),
				{ fail: true },
			)
			assert.strictEqual(failureTag(exit), "PolicyUnavailable")
			assert.strictEqual(loads, 2)
		}),
	)

	it.effect("asks the decider when no rule gives an answer", () =>
		Effect.gen(function* () {
			const decider: Parameters<typeof makeLayer>[0]["decider"] = (request) =>
				request.action === "delegate"
					? Effect.fail(Authorizer.Pending.make({ ticket: "req-1" }))
					: Effect.succeed(Decision.Allow({}))
			const pending = yield* run(
				Auth.check({ action: "delegate", resource: aliceBot }),
				{ decider },
			)
			assert.strictEqual(failureTag(pending.exit), "Pending")
			const allowed = yield* run(
				Auth.check({ action: "update", resource: sharedBot }),
				{ decider },
			)
			assert.isTrue(Exit.isSuccess(allowed.exit))
			const denied = yield* run(
				Auth.check({ action: "delete", resource: aliceBot }),
				{ decider },
			)
			assert.strictEqual(failureTag(denied.exit), "Forbidden")
		}),
	)

	it.effect("gives the services of predicates from the layer", () =>
		Effect.gen(function* () {
			class Quota extends Context.Service<Quota, { readonly left: number }>()(
				"@nmnmcc/ability/tests/Authorizer.test/Quota",
			) {}
			class Auth2 extends Authorizer.Service<Auth2, { requires: Identity }>()(
				"test/Auth2",
				App,
			) {}
			const layer = Authorizer.layer(Auth2, {
				principal: Identity,
				policy: () =>
					Effect.succeed(
						Policy.define(App)(function* (_) {
							yield* _.allow("read", Bot, {
								when: ($) =>
									$.predicate("quota", () =>
										Effect.map(Quota, (quota) => quota.left > 0),
									),
							})
						}),
					),
			}).pipe(Layer.provide(Layer.succeed(Quota, { left: 1 })))
			const exit = yield* Auth2.check({
				action: "read",
				resource: aliceBot,
			}).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
				Effect.exit,
			)
			assert.isTrue(Exit.isSuccess(exit))
			const filtered = yield* Effect.gen(function* () {
				const condition = yield* Auth2.filter({ action: "read", kind: "Bot" })
				return yield* Condition.evaluate(condition, { value: aliceBot })
			}).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
				Effect.exit,
			)
			assert.isTrue(Exit.isSuccess(filtered) && filtered.value)
		}),
	)

	it.effect("does not let the decider allow a kind with a denied value", () =>
		Effect.gen(function* () {
			class Auth3 extends Authorizer.Service<Auth3, { requires: Identity }>()(
				"test/Auth3",
				App,
			) {}
			const layer = Authorizer.layer(Auth3, {
				principal: Identity,
				policy: () =>
					Effect.succeed(
						Policy.define(App)(function* (_) {
							yield* _.allow("read", Bot)
							yield* _.deny("read", Bot, { when: ($) => $.eq("id", "b1") })
						}),
					),
				decider: () => Effect.succeed(Decision.Allow({})),
			})
			const exit = yield* Auth3.check({ action: "read", kind: "Bot" }).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
				Effect.exit,
			)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect("does not give one cached policy to two principals", () =>
		Effect.gen(function* () {
			class User extends Principal.Class<User>("User")({
				claims: Schema.ReadonlyMap(Schema.String, Schema.String),
			}) {}
			const Shop = Domain.make({ principal: User, resources: [Bot] })
			class Current extends Context.Service<Current, User>()(
				"@nmnmcc/ability/tests/Authorizer.test/Current",
			) {}
			class ShopAuth extends Authorizer.Service<
				ShopAuth,
				{ requires: Current }
			>()("test/ShopAuth", Shop) {}
			const layer = Authorizer.layer(ShopAuth, {
				principal: Current,
				policy: (user) =>
					Effect.succeed(
						Policy.define(Shop)(function* (_) {
							if (user.claims.get("role") === "admin") {
								yield* _.allow("read", Bot)
							}
						}),
					),
			})
			const admin = User.make({ claims: new Map([["role", "admin"]]) })
			const guest = User.make({ claims: new Map([["role", "guest"]]) })
			const exit = yield* Effect.gen(function* () {
				yield* Effect.provideService(
					ShopAuth.check({ action: "read", resource: aliceBot }),
					Current,
					admin,
				)
				yield* Effect.provideService(
					ShopAuth.check({ action: "read", resource: aliceBot }),
					Current,
					guest,
				)
			}).pipe(Effect.provide(layer), Effect.exit)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect("keeps the types of principal values in the cache key", () =>
		Effect.gen(function* () {
			class User extends Principal.Class<User>("User")({
				id: Schema.Union([Schema.BigInt, Schema.String]),
			}) {}
			const Shop = Domain.make({ principal: User, resources: [Bot] })
			class ShopUser extends Context.Service<ShopUser, User>()(
				"@nmnmcc/ability/tests/Authorizer.test/ShopUser",
			) {}
			class ShopAuth extends Authorizer.Service<
				ShopAuth,
				{ requires: ShopUser }
			>()("test/ShopAuth2", Shop) {}
			const layer = Authorizer.layer(ShopAuth, {
				principal: ShopUser,
				policy: (user) =>
					Effect.succeed(
						Policy.define(Shop)(function* (_) {
							if (typeof user.id === "bigint") {
								yield* _.allow("read", Bot)
							}
						}),
					),
			})
			const exit = yield* Effect.gen(function* () {
				yield* Effect.provideService(
					ShopAuth.check({ action: "read", resource: aliceBot }),
					ShopUser,
					User.make({ id: 1n }),
				)
				yield* Effect.provideService(
					ShopAuth.check({ action: "read", resource: aliceBot }),
					ShopUser,
					User.make({ id: "1" }),
				)
			}).pipe(Effect.provide(layer), Effect.exit)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect("does not give one cached policy to two URL values", () =>
		Effect.gen(function* () {
			class Site extends Principal.Class<Site>("Site")({
				url: Schema.URL,
			}) {}
			const Web = Domain.make({ principal: Site, resources: [Bot] })
			class CurrentSite extends Context.Service<CurrentSite, Site>()(
				"@nmnmcc/ability/tests/Authorizer.test/CurrentSite",
			) {}
			class WebAuth extends Authorizer.Service<
				WebAuth,
				{ requires: CurrentSite }
			>()("test/WebAuth", Web) {}
			const layer = Authorizer.layer(WebAuth, {
				principal: CurrentSite,
				policy: (site) =>
					Effect.succeed(
						Policy.define(Web)(function* (_) {
							if (site.url.host === "admin.example") {
								yield* _.allow("read", Bot)
							}
						}),
					),
			})
			const exit = yield* Effect.gen(function* () {
				yield* Effect.provideService(
					WebAuth.check({ action: "read", resource: aliceBot }),
					CurrentSite,
					Site.make({ url: new URL("https://admin.example") }),
				)
				yield* Effect.provideService(
					WebAuth.check({ action: "read", resource: aliceBot }),
					CurrentSite,
					Site.make({ url: new URL("https://guest.example") }),
				)
			}).pipe(Effect.provide(layer), Effect.exit)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect(
		"does not give one cached policy to two classes with one name",
		() =>
			Effect.gen(function* () {
				const make = (identifier: string) =>
					class User extends Principal.Class<User>(identifier)({
						id: Schema.String,
					}) {}
				const Admin = make("Admin")
				const Guest = make("Guest")
				const Team = Domain.make({
					principal: Schema.Union([Admin, Guest]),
					resources: [Bot],
				})
				class CurrentUser extends Context.Service<
					CurrentUser,
					InstanceType<typeof Admin> | InstanceType<typeof Guest>
				>()("@nmnmcc/ability/tests/Authorizer.test/CurrentUser") {}
				class TeamAuth extends Authorizer.Service<
					TeamAuth,
					{ requires: CurrentUser }
				>()("test/TeamAuth", Team) {}
				const layer = Authorizer.layer(TeamAuth, {
					principal: CurrentUser,
					policy: (user) =>
						Effect.succeed(
							Policy.define(Team)(function* (_) {
								if (user instanceof Admin) {
									yield* _.allow("read", Bot)
								}
							}),
						),
				})
				const exit = yield* Effect.gen(function* () {
					yield* Effect.provideService(
						TeamAuth.check({ action: "read", resource: aliceBot }),
						CurrentUser,
						Admin.make({ id: "1" }),
					)
					yield* Effect.provideService(
						TeamAuth.check({ action: "read", resource: aliceBot }),
						CurrentUser,
						Guest.make({ id: "1" }),
					)
				}).pipe(Effect.provide(layer), Effect.exit)
				assert.strictEqual(failureTag(exit), "Forbidden")
			}),
	)

	describe("does not cache a principal with data that the key can not see", () => {
		class Member extends Context.Service<Member, object>()(
			"@nmnmcc/ability/tests/Authorizer.test/Member",
		) {}
		const Plain = Domain.make({
			principal: Schema.Struct({
				role: Schema.String,
				roles: Schema.Array(Schema.String),
			}),
			resources: [Bot],
		})
		class PlainAuth extends Authorizer.Service<
			PlainAuth,
			{ requires: Member }
		>()("test/PlainAuth", Plain) {}
		const roleOf = (principal: object): unknown => {
			const roles = (principal as { readonly roles: Record<string, unknown> })
				.roles
			return (
				(principal as { readonly role: unknown }).role ??
				roles["role"] ??
				roles["4294967295"]
			)
		}
		const layer = Authorizer.layer(PlainAuth, {
			principal: Member as never,
			policy: (principal) =>
				Effect.succeed(
					Policy.define(Plain)(function* (_) {
						if (roleOf(principal) === "admin") {
							yield* _.allow("read", Bot)
						}
					}),
				),
		})
		const run = (admin: object, guest: object) =>
			Effect.gen(function* () {
				yield* Effect.provideService(
					PlainAuth.check({ action: "read", resource: aliceBot }),
					Member,
					admin,
				)
				yield* Effect.provideService(
					PlainAuth.check({ action: "read", resource: aliceBot }),
					Member,
					guest,
				)
			}).pipe(Effect.provide(layer), Effect.exit)

		it.effect("in a field that a loop can not see", () =>
			Effect.gen(function* () {
				const hidden = (role: string) =>
					Object.defineProperty({ roles: [] }, "role", {
						value: role,
						enumerable: false,
					})
				assert.strictEqual(
					failureTag(yield* run(hidden("admin"), hidden("guest"))),
					"Forbidden",
				)
			}),
		)

		it.effect("in a key of an array past its length", () =>
			Effect.gen(function* () {
				const withRole = (role: string) => ({
					role: undefined,
					roles: Object.assign(Array<string>(1), { 4294967295: role }),
				})
				assert.strictEqual(
					failureTag(yield* run(withRole("admin"), withRole("guest"))),
					"Forbidden",
				)
			}),
		)

		it.effect("in an extra key of an array", () =>
			Effect.gen(function* () {
				const withRole = (role: string) => {
					const roles = Object.assign(["user"], { role })
					return { role: undefined, roles }
				}
				assert.strictEqual(
					failureTag(yield* run(withRole("admin"), withRole("guest"))),
					"Forbidden",
				)
			}),
		)
	})

	it.effect("fails a check on a kind when the residual is too large", () =>
		Effect.gen(function* () {
			class Deep extends Authorizer.Service<Deep, { requires: Identity }>()(
				"test/Deep",
				App,
			) {}
			const policy = Arr.reduce(
				Arr.range(0, 23),
				Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot, { when: ($) => $.eq("level", 1) })
					yield* _.deny("read", Bot, { when: ($) => $.eq("name", "Team") })
				}) as Policy.Policy<typeof App>,
				(inner, depth) =>
					depth % 2 === 0 ? Policy.any([inner]) : Policy.all([inner]),
			)
			const layer = Authorizer.layer(Deep, {
				principal: Identity,
				policy: () => Effect.succeed(policy),
				decider: () => Effect.succeed(Decision.Allow({})),
			})
			const exit = yield* Deep.check({ action: "read", kind: "Bot" }).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
				Effect.exit,
			)
			assert.isTrue(Exit.isFailure(exit))
		}),
	)

	it.effect("does not give one cached policy to two orders of a map", () =>
		Effect.gen(function* () {
			class Ranked extends Principal.Class<Ranked>("Ranked")({
				roles: Schema.ReadonlyMap(Schema.String, Schema.String),
			}) {}
			const Ranks = Domain.make({ principal: Ranked, resources: [Bot] })
			class CurrentRanked extends Context.Service<CurrentRanked, Ranked>()(
				"@nmnmcc/ability/tests/Authorizer.test/CurrentRanked",
			) {}
			class RankAuth extends Authorizer.Service<
				RankAuth,
				{ requires: CurrentRanked }
			>()("test/RankAuth", Ranks) {}
			const layer = Authorizer.layer(RankAuth, {
				principal: CurrentRanked,
				policy: (user) =>
					Effect.succeed(
						Policy.define(Ranks)(function* (_) {
							if (Array.from(user.roles.values())[0] === "admin") {
								yield* _.allow("read", Bot)
							}
						}),
					),
			})
			const exit = yield* Effect.gen(function* () {
				yield* Effect.provideService(
					RankAuth.check({ action: "read", resource: aliceBot }),
					CurrentRanked,
					Ranked.make({
						roles: new Map([
							["a", "admin"],
							["b", "guest"],
						]),
					}),
				)
				yield* Effect.provideService(
					RankAuth.check({ action: "read", resource: aliceBot }),
					CurrentRanked,
					Ranked.make({
						roles: new Map([
							["b", "guest"],
							["a", "admin"],
						]),
					}),
				)
			}).pipe(Effect.provide(layer), Effect.exit)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect("fails closed when the loaded policy has another domain", () =>
		Effect.gen(function* () {
			const Other = Domain.make({ principal: Caller, resources: [Bot] })
			class Mixed extends Authorizer.Service<Mixed, { requires: Identity }>()(
				"test/Mixed",
				App,
			) {}
			const layer = Authorizer.layer(Mixed, {
				principal: Identity,
				policy: () =>
					Effect.succeed(
						Policy.define(Other)(function* (_) {
							yield* _.allow("read", Bot)
						}) as never,
					),
			})
			const exit = yield* Mixed.check({
				action: "read",
				resource: aliceBot,
			}).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
				Effect.exit,
			)
			assert.strictEqual(failureTag(exit), "PolicyUnavailable")
		}),
	)

	it.effect("does not give one cached policy to two orders of a record", () =>
		Effect.gen(function* () {
			class Holder extends Principal.Class<Holder>("Holder")({
				roles: Schema.Record(Schema.String, Schema.String),
			}) {}
			const Holders = Domain.make({ principal: Holder, resources: [Bot] })
			class CurrentHolder extends Context.Service<CurrentHolder, Holder>()(
				"@nmnmcc/ability/tests/Authorizer.test/CurrentHolder",
			) {}
			class HolderAuth extends Authorizer.Service<
				HolderAuth,
				{ requires: CurrentHolder }
			>()("test/HolderAuth", Holders) {}
			const layer = Authorizer.layer(HolderAuth, {
				principal: CurrentHolder,
				policy: (user) =>
					Effect.succeed(
						Policy.define(Holders)(function* (_) {
							if (Object.values(user.roles)[0] === "admin") {
								yield* _.allow("read", Bot)
							}
						}),
					),
			})
			const exit = yield* Effect.gen(function* () {
				yield* Effect.provideService(
					HolderAuth.check({ action: "read", resource: aliceBot }),
					CurrentHolder,
					Holder.make({ roles: { a: "admin", b: "guest" } }),
				)
				yield* Effect.provideService(
					HolderAuth.check({ action: "read", resource: aliceBot }),
					CurrentHolder,
					Holder.make({ roles: { b: "guest", a: "admin" } }),
				)
			}).pipe(Effect.provide(layer), Effect.exit)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect("does not cache a principal with one object in two places", () =>
		Effect.gen(function* () {
			class Role extends Schema.Class<Role>("Role")({ name: Schema.String }) {}
			class Chooser extends Principal.Class<Chooser>("Chooser")({
				selected: Role,
				allowed: Schema.ReadonlySet(Role),
			}) {}
			const Choosers = Domain.make({ principal: Chooser, resources: [Bot] })
			class CurrentChooser extends Context.Service<CurrentChooser, Chooser>()(
				"@nmnmcc/ability/tests/Authorizer.test/CurrentChooser",
			) {}
			class ChooserAuth extends Authorizer.Service<
				ChooserAuth,
				{ requires: CurrentChooser }
			>()("test/ChooserAuth", Choosers) {}
			const layer = Authorizer.layer(ChooserAuth, {
				principal: CurrentChooser,
				policy: (user) =>
					Effect.succeed(
						Policy.define(Choosers)(function* (_) {
							if (user.allowed.has(user.selected)) {
								yield* _.allow("read", Bot)
							}
						}),
					),
			})
			const admin = Role.make({ name: "admin" })
			const exit = yield* Effect.gen(function* () {
				yield* Effect.provideService(
					ChooserAuth.check({ action: "read", resource: aliceBot }),
					CurrentChooser,
					Chooser.make({ selected: admin, allowed: new Set([admin]) }),
				)
				yield* Effect.provideService(
					ChooserAuth.check({ action: "read", resource: aliceBot }),
					CurrentChooser,
					Chooser.make({
						selected: Role.make({ name: "admin" }),
						allowed: new Set([admin]),
					}),
				)
			}).pipe(Effect.provide(layer), Effect.exit)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect("keeps the shared children of a loaded policy", () =>
		Effect.gen(function* () {
			class Wide extends Authorizer.Service<Wide, { requires: Identity }>()(
				"test/Wide",
				App,
			) {}
			const policy = Arr.reduce(
				Arr.range(0, 23),
				Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot)
				}) as Policy.Policy<typeof App>,
				(inner) => Policy.all([inner, inner]),
			)
			const layer = Authorizer.layer(Wide, {
				principal: Identity,
				policy: () => Effect.succeed(policy),
			})
			const start = Date.now()
			const exit = yield* Wide.check({
				action: "read",
				resource: aliceBot,
			}).pipe(
				Effect.provideService(Identity, alice),
				Effect.provide(layer),
				Effect.exit,
			)
			assert.isTrue(Exit.isSuccess(exit))
			assert.isBelow(Date.now() - start, 1000)
		}),
	)

	it.effect("does not cache a principal with an object in a set", () =>
		Effect.gen(function* () {
			class Role extends Schema.Class<Role>("Role")({ name: Schema.String }) {}
			const admin = Role.make({ name: "admin" })
			class Member extends Principal.Class<Member>("Member")({
				roles: Schema.ReadonlySet(Role),
			}) {}
			const Members = Domain.make({ principal: Member, resources: [Bot] })
			class CurrentMember extends Context.Service<CurrentMember, Member>()(
				"@nmnmcc/ability/tests/Authorizer.test/CurrentMember",
			) {}
			class MemberAuth extends Authorizer.Service<
				MemberAuth,
				{ requires: CurrentMember }
			>()("test/MemberAuth", Members) {}
			const layer = Authorizer.layer(MemberAuth, {
				principal: CurrentMember,
				policy: (user) =>
					Effect.succeed(
						Policy.define(Members)(function* (_) {
							if (user.roles.has(admin)) {
								yield* _.allow("read", Bot)
							}
						}),
					),
			})
			const exit = yield* Effect.gen(function* () {
				yield* Effect.provideService(
					MemberAuth.check({ action: "read", resource: aliceBot }),
					CurrentMember,
					Member.make({ roles: new Set([admin]) }),
				)
				yield* Effect.provideService(
					MemberAuth.check({ action: "read", resource: aliceBot }),
					CurrentMember,
					Member.make({ roles: new Set([Role.make({ name: "admin" })]) }),
				)
			}).pipe(Effect.provide(layer), Effect.exit)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect("does not cache a principal with objects in an array", () =>
		Effect.gen(function* () {
			class Role extends Schema.Class<Role>("Role")({ name: Schema.String }) {}
			const admin = Role.make({ name: "admin" })
			class Staff extends Principal.Class<Staff>("Staff")({
				roles: Schema.Array(Role),
			}) {}
			const Staffs = Domain.make({ principal: Staff, resources: [Bot] })
			class CurrentStaff extends Context.Service<CurrentStaff, Staff>()(
				"@nmnmcc/ability/tests/Authorizer.test/CurrentStaff",
			) {}
			class StaffAuth extends Authorizer.Service<
				StaffAuth,
				{ requires: CurrentStaff }
			>()("test/StaffAuth", Staffs) {}
			const layer = Authorizer.layer(StaffAuth, {
				principal: CurrentStaff,
				policy: (user) =>
					Effect.succeed(
						Policy.define(Staffs)(function* (_) {
							if (user.roles.includes(admin)) {
								yield* _.allow("read", Bot)
							}
						}),
					),
			})
			const exit = yield* Effect.gen(function* () {
				yield* Effect.provideService(
					StaffAuth.check({ action: "read", resource: aliceBot }),
					CurrentStaff,
					Staff.make({ roles: [admin] }),
				)
				yield* Effect.provideService(
					StaffAuth.check({ action: "read", resource: aliceBot }),
					CurrentStaff,
					Staff.make({ roles: [Role.make({ name: "admin" })] }),
				)
			}).pipe(Effect.provide(layer), Effect.exit)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)

	it.effect("keeps a principal with objects as the values of a map", () =>
		Effect.gen(function* () {
			class Holder extends Principal.Class<Holder>("MapHolder")({
				roles: Schema.ReadonlyMap(
					Schema.String,
					Schema.Struct({ role: Schema.String }),
				),
			}) {}
			const Holders = Domain.make({ principal: Holder, resources: [Bot] })
			class CurrentMapHolder extends Context.Service<
				CurrentMapHolder,
				Holder
			>()("@nmnmcc/ability/tests/Authorizer.test/CurrentMapHolder") {}
			class MapAuth extends Authorizer.Service<
				MapAuth,
				{ requires: CurrentMapHolder }
			>()("test/MapAuth", Holders) {}
			const loads = yield* Ref.make(0)
			const layer = Authorizer.layer(MapAuth, {
				principal: CurrentMapHolder,
				policy: () =>
					Ref.update(loads, (n) => n + 1).pipe(
						Effect.as(
							Policy.define(Holders)(function* (_) {
								yield* _.allow("read", Bot)
							}),
						),
					),
			})
			const user = Holder.make({ roles: new Map([["a", { role: "admin" }]]) })
			yield* Effect.gen(function* () {
				yield* MapAuth.check({ action: "read", resource: aliceBot })
				yield* MapAuth.check({ action: "read", resource: aliceBot })
			}).pipe(
				Effect.provideService(CurrentMapHolder, user),
				Effect.provide(layer),
			)
			assert.strictEqual(yield* Ref.get(loads), 1)
		}),
	)

	it.effect("says no to an action of another kind before the decider", () =>
		Effect.gen(function* () {
			const { exit } = yield* run(
				Auth.check({
					action: "write",
					resource: aliceBot,
				} as unknown as Policy.Target<typeof App>),
				{ decider: () => Effect.succeed(Decision.Allow({})) },
			)
			assert.strictEqual(failureTag(exit), "Forbidden")
		}),
	)
})
