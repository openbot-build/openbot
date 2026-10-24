import { Context, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import {
	Authorizer,
	type Condition,
	type Decision,
	Policy,
	Rule,
} from "../src/index.ts"
import {
	alice,
	aliceBot,
	aliceTrigger,
	App,
	Bot,
	type Caller,
	Trigger,
} from "./fixtures.ts"

type App = typeof App

describe("Resource", () => {
	it("makes a class that is a Schema and a resource", () => {
		expect(aliceBot._tag).type.toBe<"Bot">()
		expect(aliceBot.shared).type.toBe<boolean>()
		expect(Bot.kind).type.toBe<"Bot">()
		expect(Bot.actions).type.toBe<
			readonly ["read", "update", "delete", "delegate"]
		>()
		expect(Schema.decodeUnknownSync(Bot)({})).type.toBe<Bot>()
	})

	it("makes plain values with a tag", () => {
		expect(aliceTrigger._tag).type.toBe<"Trigger">()
		expect(Trigger.make).type.not.toBeCallableWith({ id: "t" })
	})
})

describe("Rule", () => {
	const _ = Rule.builder(App)

	it("takes only the actions of the resource", () => {
		expect(_.allow).type.toBeCallableWith("delegate", Bot)
		expect(_.allow).type.toBeCallableWith(["read", "write"], "Trigger")
		expect(_.allow).type.toBeCallableWith("*", "*")
		expect(_.allow).type.not.toBeCallableWith("write", Bot)
		expect(_.allow).type.not.toBeCallableWith("read", "Ghost")
	})

	it("takes only the fields of the resource, with their types", () => {
		expect(_.allow).type.toBeCallableWith("read", Bot, {
			when: ($: Condition.Builder<Rule.DataFor<App, "Bot">, Bot, Caller>) =>
				$.and(
					$.eq("ownerUserId", $.principal("userId")),
					$.eq("ownerUserId", null),
					$.gt("level", 3),
					$.eq("settings.model", "large"),
				),
			fields: ["name", "settings.*"],
		})
		expect(_.allow).type.not.toBeCallableWith("read", Bot, {
			fields: ["color"],
		})
	})

	it("checks the type of each value", () => {
		_.allow("read", Bot, {
			// There is no field with this name.
			// @ts-expect-error Argument of type '"color"'
			when: ($) => $.eq("color", "red"),
		})
		_.allow("read", Bot, {
			// The level is a number.
			// @ts-expect-error 'OperandOf<number>'
			when: ($) => $.eq("level", "high"),
		})
		_.allow("read", Bot, {
			// The principal has no field with this name.
			// @ts-expect-error Argument of type '"tenantId"'
			when: ($) => $.eq("ownerUserId", $.principal("tenantId")),
		})
		_.allow("read", Bot, {
			// The role is not a number.
			// @ts-expect-error 'OperandOf<number>'
			when: ($) => $.eq("level", $.principal("role")),
		})
		_.allow("read", Bot, {
			// A string field is not a number field.
			// @ts-expect-error 'OperandOf<number>'
			when: ($) => $.gt("level", "x"),
		})
	})

	it("keeps the types of a predicate", () => {
		const rule = _.allow("read", Bot, {
			when: ($) => $.predicate("quota", () => Effect.fail("no quota" as const)),
		})
		expect(rule).type.toBe<Rule.Rule<"no quota", never, Condition.Opaque>>()
		expect(_.allow("read", Bot)).type.toBe<Rule.Rule>()
	})

	it("checks the extra data", () => {
		expect(_.allow).type.toBeCallableWith("read", Bot, {
			meta: { scope: "once" },
		})
		expect(_.allow).type.not.toBeCallableWith("read", Bot, {
			meta: { scope: "forever" },
		})
	})
})

describe("Policy", () => {
	const policy = Policy.define(App)(function* (_) {
		yield* _.allow("read", Bot)
	})
	class Quota extends Context.Service<Quota, number>()(
		"@nmnmcc/ability/tests/Ability.tst/Quota",
	) {}
	const effectful = Policy.define(App)(function* (_) {
		yield* _.allow("read", Bot, {
			when: ($) =>
				$.predicate("quota", () =>
					Effect.flatMap(Quota, (left) =>
						left > 0 ? Effect.succeed(true) : Effect.fail("empty" as const),
					),
				),
		})
	})

	it("keeps the types of predicates", () => {
		expect(policy).type.toBe<Policy.Policy<App>>()
		expect(effectful).type.toBe<
			Policy.Policy<App, "empty", Quota, Condition.Opaque>
		>()
		expect(
			Policy.decide(effectful, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			}),
		).type.toBe<Effect.Effect<Decision.Decision, "empty", Quota>>()
		expect(Policy.all([policy, effectful])).type.toBe<
			Policy.Policy<App, "empty", Quota, Condition.Opaque>
		>()
	})

	it("takes only requests of the domain", () => {
		expect(Policy.decideSync).type.toBeCallableWith(policy, {
			principal: alice,
			action: "update",
			resource: aliceBot,
			field: "settings.secret",
		})
		expect(Policy.decideSync).type.not.toBeCallableWith(policy, {
			principal: alice,
			action: "write",
			resource: aliceBot,
		})
		expect(Policy.decideSync).type.not.toBeCallableWith(policy, {
			principal: alice,
			action: "read",
			resource: aliceBot,
			field: "color",
		})
		expect(Policy.residual).type.toBeCallableWith(policy, {
			principal: alice,
			action: "write",
			kind: "Trigger",
		})
	})

	it("lets decideSync and the schema take only plain policies", () => {
		expect(Policy.decideSync).type.not.toBeCallableWith(effectful, {
			principal: alice,
			action: "read",
			resource: aliceBot,
		})
		expect(Schema.encodeSync(Policy.schema(App))).type.toBeCallableWith(policy)
		expect(Schema.encodeSync(Policy.schema(App))).type.not.toBeCallableWith(
			effectful,
		)
	})
})

describe("Authorizer", () => {
	class Identity extends Context.Service<Identity, Caller>()(
		"@nmnmcc/ability/tests/Ability.tst/Identity",
	) {}
	class Auth extends Authorizer.Service<
		Auth,
		{ requires: Identity; error: "no session" }
	>()("@nmnmcc/ability/tests/Ability.tst/Auth", App) {}

	it("puts the errors and services into a check", () => {
		expect(Auth.check({ action: "update", resource: aliceBot })).type.toBe<
			Effect.Effect<
				void,
				| Authorizer.Forbidden
				| Authorizer.Pending
				| Authorizer.PolicyUnavailable
				| "no session",
				Identity | Auth
			>
		>()
		expect(Auth.check).type.toBeCallableWith({
			action: "write",
			kind: "Trigger",
		})
		expect(Auth.check).type.not.toBeCallableWith({
			action: "write",
			resource: aliceBot,
		})
	})

	it("checks the options of the layer", () => {
		expect(Authorizer.layer).type.toBeCallableWith(Auth, {
			principal: Identity,
			policy: () => Effect.succeed(Policy.empty(App)),
		})
		expect(Authorizer.layer).type.not.toBeCallableWith(Auth, {
			principal: Effect.fail("other error" as const),
			policy: () => Effect.succeed(Policy.empty(App)),
		})
	})
})
