import { Context, Effect, Schema } from "effect"
import { describe, expect, it } from "tstyche"
import * as HttpApi from "../src/HttpApi.ts"
import {
	Authorizer,
	Condition,
	type Decision,
	Domain,
	Policy,
	Resource,
	Rule,
} from "../src/index.ts"
import {
	alice,
	aliceBot,
	aliceTrigger,
	App,
	Bot,
	Caller,
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
			// @ts-expect-error 'OperandOf<number, any>'
			when: ($) => $.eq("level", "high"),
		})
		_.allow("read", Bot, {
			// The principal has no field with this name.
			// @ts-expect-error Argument of type '"tenantId"'
			when: ($) => $.eq("ownerUserId", $.principal("tenantId")),
		})
		_.allow("read", Bot, {
			// The role is not a number.
			// @ts-expect-error 'OperandOf<number, any>'
			when: ($) => $.eq("level", $.principal("role")),
		})
		_.allow("read", Bot, {
			// A string field is not a number field.
			// @ts-expect-error 'OperandOf<number, any>'
			when: ($) => $.gt("level", "x"),
		})
	})

	it("keeps the types of a predicate", () => {
		const rule = _.allow("read", Bot, {
			when: ($) => $.predicate("quota", () => Effect.fail("no quota" as const)),
		})
		expect(rule).type.toBe<
			Rule.Rule<
				"no quota",
				never,
				Condition.Opaque,
				App,
				Condition.Reads<Bot, Caller>
			>
		>()
		expect(_.allow("read", Bot)).type.toBe<
			Rule.Rule<never, never, never, App>
		>()
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

	it("does not take a node made by hand", () => {
		expect(Rule.builder(App).allow).type.not.toBeCallableWith("read", Bot, {
			when: ($: Condition.Builder<Rule.DataFor<App, "Bot">, Bot, Caller>) => ({
				_tag: "Not" as const,
				condition: $.predicate("quota", () => Effect.fail("empty" as const)),
			}),
		})
	})

	it("takes only rules of its own domain", () => {
		const Other = Domain.make({ principal: Caller, resources: [Trigger] })
		const rule = Rule.builder(App).allow("read", Bot)
		expect(Policy.rules).type.toBeCallableWith(App, [rule])
		expect(Policy.rules).type.not.toBeCallableWith(Other, [rule])
		expect(Policy.define(Other)).type.not.toBeCallableWith(function* () {
			yield* rule
		})
	})

	it("keeps the domain of a policy", () => {
		const Other = Domain.make({ principal: Caller, resources: [Bot] })
		const other = Policy.empty(Other)
		expect<Policy.Policy<App>>().type.not.toBeAssignableFrom(other)
	})

	it("takes only common actions for one target of a union type", () => {
		const _ = Rule.builder(App)
		const target = Bot as typeof Bot | typeof Trigger
		expect(_.allow).type.toBeCallableWith("read", target)
		expect(_.allow).type.not.toBeCallableWith("write", target)
		expect(_.allow).type.toBeCallableWith("write", [Bot, Trigger])
	})

	it("does not let the test of a predicate node be called with any value", () => {
		const named = Condition.builder<unknown, Bot, Caller>().predicate(
			"named",
			(bot) => bot.name.length > 0,
		)
		if (named._tag === "Predicate") {
			expect(named.run).type.not.toBeCallableWith(aliceTrigger, alice)
		}
	})

	it("keeps a predicate in rules of its own kind", () => {
		const _ = Rule.builder(App)
		const leveled = Condition.builder<
			Rule.DataFor<App, "Bot">,
			Bot,
			Caller
		>().predicate("leveled", (bot) => bot.level >= 1)
		expect(_.deny).type.toBeCallableWith("read", Bot, { when: () => leveled })
		expect(_.deny).type.not.toBeCallableWith("read", Trigger, {
			when: () => leveled,
		})
	})

	it("ties the types of a node to its children", () => {
		const failing = Condition.builder<unknown, Bot, Caller>().predicate(
			"failing",
			() => Effect.fail("no" as const),
		)
		expect<Condition.Condition>().type.not.toBeAssignableFrom({
			...Condition.always,
			_tag: "Not" as const,
			condition: failing,
		})
		expect<Condition.Condition>().type.not.toBeAssignableFrom({
			...Condition.always,
			_tag: "Predicate" as const,
			name: "hidden",
			run: () => Effect.fail("no" as const),
		})
	})

	it("keeps what the condition of a rule reads", () => {
		const _ = Rule.builder(App)
		const rule = _.allow("read", Bot, {
			when: ($) => $.predicate("level", (bot) => bot.level !== 0),
		})
		expect(_.allow).type.not.toBeCallableWith("read", Trigger, {
			when: () => rule.when ?? Condition.never,
		})
	})

	it("needs the principal that a predicate reads in partial", () => {
		const named = Condition.builder<unknown, Bot, Caller>().predicate(
			"named",
			(_, user) => user.userId.length > 0,
		)
		expect(Condition.partial).type.toBeCallableWith(named, {
			principal: alice,
		})
		expect(Condition.partial).type.not.toBeCallableWith(named, {
			principal: {},
		})
	})

	it("keeps the kind of a residual with the request first", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.predicate("named", (bot) => bot.name !== ""),
			})
		})
		const residual = Policy.residual({
			principal: alice,
			action: "read",
			kind: "Bot",
		})(policy)
		expect(Condition.evaluate).type.not.toBeCallableWith(residual, {
			value: aliceTrigger,
		})
		const fly = Policy.residual({
			principal: alice,
			action: "fly",
			kind: "Bot",
		})
		expect(fly).type.not.toBeCallableWith(policy)
	})

	it("takes a scope only with the policy first", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
		})
		expect(
			Policy.coverage(policy, {
				principal: alice,
				action: "read",
				kind: "Bot",
				within: ($) => $.eq("ownerUserId", $.principal("userId")),
			}),
		).type.toBe<
			Policy.Coverage<never, never, never, Policy.ResidualReads<App, "Bot">>
		>()
		expect(Policy.residual).type.not.toBeCallableWith({
			principal: alice,
			action: "read",
			kind: "Bot",
			within: (_: any) => Condition.always,
		})
	})

	it("keeps the resource of a plain test", () => {
		const _ = Rule.builder(App)
		const enabled = Condition.builder<
			Rule.DataFor<App, "Trigger">,
			Rule.ValueFor<App, "Trigger">,
			Caller
		>().eq("enabled", true)
		expect(_.allow).type.toBeCallableWith("read", "Trigger", {
			when: () => enabled,
		})
		expect(_.allow).type.not.toBeCallableWith("read", Bot, {
			when: () => enabled,
		})
	})

	it("does not let a condition from a node go into another rule", () => {
		const _ = Rule.builder(App)
		const node = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.predicate("level", (bot) => bot.level !== 0),
			})
		}).node
		if (node._tag === "Rules") {
			const when = node.rules[0]!.when!
			expect(_.allow).type.not.toBeCallableWith("read", "Trigger", {
				when: () => when,
			})
		}
	})

	it("keeps the principal of a test with a principal field", () => {
		class Numbered extends Schema.Class<Numbered>("Numbered")({
			userId: Schema.Finite,
		}) {}
		const Other = Domain.make({ principal: Numbered, resources: [Bot] })
		const $ = Condition.builder<Rule.DataFor<App, "Bot">, Bot, Caller>()
		const owned = $.eq("ownerUserId", $.principal("userId"))
		expect(Rule.builder(Other).deny).type.not.toBeCallableWith("read", Bot, {
			when: () => owned,
		})
	})

	it("keeps the principal of a reference from another builder", () => {
		class Numbered extends Schema.Class<Numbered>("Numbered")({
			userId: Schema.Finite,
			name: Schema.String,
		}) {}
		const Other = Domain.make({ principal: Numbered, resources: [Bot] })
		const foreign = Condition.builder<unknown, unknown, Caller>().principal(
			"userId",
		)
		expect(Rule.builder(Other).deny).type.not.toBeCallableWith("read", Bot, {
			when: (
				$: Condition.Builder<Rule.DataFor<typeof Other, "Bot">, Bot, Numbered>,
			) => $.eq("ownerUserId", foreign),
		})
	})

	it("does not let a reference with no principal type go into a rule", () => {
		const id: Condition.Ref<string> = Condition.builder<
			unknown,
			unknown,
			Caller
		>().principal("userId")
		const $ = Condition.builder<Rule.DataFor<App, "Bot">, Bot, Caller>()
		expect($.eq).type.not.toBeCallableWith("ownerUserId", id)
	})

	it("takes a value that fits every field of a union of fields", () => {
		const $ = Condition.builder<Rule.DataFor<App, "Bot">, Bot, Caller>()
		const either = "level" as "level" | "name"
		expect($.ne).type.not.toBeCallableWith(either, "blocked")
		expect($.ne).type.toBeCallableWith("name", "blocked")
	})

	it("lets a rule name an array field", () => {
		const Doc = Resource.make("Doc", {
			actions: ["read"],
			fields: { secrets: Schema.Array(Schema.String) },
		})
		const Docs = Domain.make({ principal: Caller, resources: [Doc] })
		expect(Rule.builder(Docs).deny).type.toBeCallableWith("read", Doc, {
			fields: ["secrets"],
		})
	})

	it("does not go into a map in a field path", () => {
		const $ = Condition.builder<
			{ readonly roles: ReadonlyMap<string, string> },
			unknown,
			Caller
		>()
		expect($.exists).type.toBeCallableWith("roles")
		expect($.gt).type.not.toBeCallableWith("roles.size", 0)
	})

	it("checks each member of a union of inputs", () => {
		const named = Condition.builder<unknown, Bot, Caller>().predicate(
			"named",
			(bot) => bot.name.length > 0,
		)
		const input = { value: aliceBot, principal: alice } as
			| { readonly value: Bot; readonly principal: Caller }
			| { readonly value: typeof aliceTrigger; readonly principal: Caller }
		expect(Condition.evaluate(input)).type.not.toBeCallableWith(named)
		const request = { principal: alice, action: "read", kind: "Bot" } as
			| {
					readonly principal: Caller
					readonly action: "read"
					readonly kind: "Bot"
			  }
			| {
					readonly principal: Caller
					readonly action: "fly"
					readonly kind: "Bot"
			  }
		expect(Policy.residual(request)).type.not.toBeCallableWith(
			Policy.empty(App),
		)
	})

	it("keeps the domain of the rules of a node", () => {
		const Other = Domain.make({ principal: Caller, resources: [Bot] })
		const node = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
		}).node
		if (node._tag === "Rules") {
			expect(Policy.rules).type.not.toBeCallableWith(Other, node.rules)
		}
	})

	it("does not let a residual for a union of kinds read either value", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.predicate("level", (bot) => bot.level !== 0),
			})
		})
		const of = (kind: "Bot" | "Trigger") =>
			Policy.residual(policy, { principal: alice, action: "read", kind })
		expect(Condition.evaluate).type.not.toBeCallableWith(of("Bot"), {
			value: aliceTrigger,
		})
	})

	it("keeps the kind of a residual", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.predicate("level", (bot) => bot.level !== 0),
			})
		})
		const residual = Policy.residual(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		expect(Condition.evaluate).type.toBeCallableWith(residual, {
			value: aliceBot,
		})
		expect(Condition.evaluate).type.not.toBeCallableWith(residual, {
			value: aliceTrigger,
		})
	})

	it("does not let a rule hide in the node of a plain policy", () => {
		const quota = Rule.builder(App).allow("read", Bot, {
			when: ($) => $.predicate("quota", () => Effect.map(Quota, (n) => n > 0)),
		})
		const plain = Policy.empty(App).node
		expect<Policy.TypedNode>().type.not.toBeAssignableFrom({
			_tag: "Rules" as const,
			algorithm: "denyOverrides" as const,
			rules: [quota],
			"~Node": plain["~Node"],
		})
	})

	it("does not let the node of a policy go into a policy of other types", () => {
		expect<Policy.Policy<App>>().type.not.toBeAssignableFrom({
			...Policy.empty(App),
			node: effectful.node,
		})
	})

	it("does not let a reference with no type stand for any field", () => {
		const $ = Condition.builder<Rule.DataFor<App, "Bot">, Bot, Caller>()
		const ref: Condition.PrincipalRef = $.principal("role")
		expect($.ne).type.not.toBeCallableWith("level", ref)
	})

	it("gives a predicate what it reads", () => {
		const leveled = Condition.builder<unknown, Bot, Caller>().predicate(
			"leveled",
			(bot) => bot.level >= 1,
		)
		expect(Condition.evaluate).type.toBeCallableWith(leveled, {
			value: aliceBot,
			principal: alice,
		})
		expect(Condition.evaluate).type.not.toBeCallableWith(leveled, {
			value: aliceTrigger,
			principal: alice,
		})
	})

	it("takes only principal fields with a scalar type", () => {
		const $ = Condition.builder<
			{ readonly owner: string },
			unknown,
			{ readonly id: bigint; readonly name: string }
		>()
		expect($.principal).type.toBeCallableWith("name")
		expect($.principal).type.not.toBeCallableWith("id")
	})

	it("takes only a meta Schema with no services", () => {
		class Store extends Context.Service<Store, number>()(
			"@nmnmcc/ability/tests/Ability.tst/Store",
		) {}
		const meta = Schema.String as unknown as Schema.Codec<
			string,
			string,
			Store,
			never
		>
		expect(Domain.make).type.not.toBeCallableWith({
			principal: Caller,
			resources: [Bot],
			meta,
		})
	})

	it("keeps the types of predicates", () => {
		const rule = Rule.builder(App).allow("read", Bot, {
			when: ($) => $.predicate("quota", () => Effect.fail("empty" as const)),
		})
		expect(rule.when).type.toBe<
			| Condition.Condition<
					"empty",
					never,
					Condition.Opaque,
					Condition.Reads<Bot & { readonly _tag: "Bot" }, Caller>
			  >
			| undefined
		>()
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
		expect(Policy.permittedFields).type.toBeCallableWith(policy, {
			principal: alice,
			action: "read",
			resource: aliceBot,
		})
		expect(Policy.permittedFields).type.not.toBeCallableWith(policy, {
			principal: alice,
			action: "write",
			resource: aliceBot,
		})
	})

	it("needs the domain of a request with no policy", () => {
		expect(
			policy.pipe(
				Policy.decideSync({
					principal: alice,
					action: "read",
					resource: aliceBot,
				}),
			),
		).type.toBe<Decision.Decision>()
		expect(Policy.decideSync<App>).type.toBeCallableWith({
			principal: alice,
			action: "read",
			resource: aliceBot,
		})
		expect(Policy.decideSync<App>).type.not.toBeCallableWith({
			principal: alice,
			action: "fly",
			resource: aliceBot,
		})
		expect(Policy.decideSync).type.not.toBeCallableWith({
			principal: alice,
			action: "fly",
			resource: aliceBot,
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
		expect(Auth.permittedFields).type.not.toBeCallableWith({
			action: "write",
			resource: aliceBot,
		})
	})

	it("takes a value or a kind, not both", () => {
		// A variable, so the check of extra keys of a literal does not run.
		const target = {
			action: "write",
			kind: "Trigger",
			resource: aliceBot,
		} as const
		expect(Auth.check).type.not.toBeCallableWith(target)
	})

	it("takes only a read action of the kind of the target", () => {
		expect(Auth.guard).type.toBeCallableWith(
			{ action: "update", resource: aliceBot },
			{ hide: () => "hidden" },
		)
		expect(Auth.guard).type.not.toBeCallableWith(
			{ action: "update", resource: aliceBot },
			{ read: "write", hide: () => "hidden" },
		)
	})

	it("needs a read action of every kind of a union target", () => {
		const target = { action: "update", resource: aliceBot } as
			| Policy.Target<App>
			| { readonly action: "write"; readonly resource: typeof aliceTrigger }
		expect(Auth.guard).type.not.toBeCallableWith(target, {
			read: "update",
			hide: () => "hidden",
		})
	})

	it("takes only an action of every kind of a requirement", () => {
		const loose = (kind: "Bot" | "Trigger") =>
			expect(HttpApi.requires).type.not.toBeCallableWith(Auth, "delete", kind)
		loose("Bot")
		expect(HttpApi.requires).type.toBeCallableWith(Auth, "delete", "Bot")
	})

	it("keeps a loaded policy opaque", () => {
		const policy = Effect.gen(function* () {
			const auth = yield* Auth
			return yield* auth.policy
		})
		expect(policy).type.toBe<
			Effect.Effect<
				Policy.Policy<App, "no session", never, Condition.Opaque>,
				Authorizer.PolicyUnavailable | "no session",
				Identity | Auth
			>
		>()
	})

	it("types the scope of a target", () => {
		type CheckOf = Effect.Effect<
			void,
			| Authorizer.Forbidden
			| Authorizer.Pending
			| Authorizer.PolicyUnavailable
			| "no session",
			Identity | Auth
		>
		expect(
			Auth.check({
				action: "update",
				kind: "Bot",
				within: ($) => $.under("org", $.principal("organizationId")),
			}),
		).type.toBe<CheckOf>()
		expect(
			Auth.check({
				action: "update",
				kind: "Bot",
				within: ($) => $.and($.eq("level", 2), $.exists("ownerUserId")),
			}),
		).type.toBe<CheckOf>()
		const otherField = Auth.check({
			action: "update",
			kind: "Bot",
			// @ts-expect-error Argument of type '"enabled"'
			within: ($) => $.eq("enabled", true),
		})
		const otherType = Auth.check({
			action: "update",
			kind: "Bot",
			// @ts-expect-error 'OperandOf<number, any>'
			within: ($) => $.eq("level", "high"),
		})
		expect(otherField).type.toBe<CheckOf>()
		expect(otherType).type.toBe<CheckOf>()
		const enabled = Condition.builder<
			Rule.DataFor<App, "Trigger">,
			Rule.ValueFor<App, "Trigger">,
			Caller
		>().eq("enabled", true)
		expect(Auth.check).type.not.toBeCallableWith({
			action: "update",
			kind: "Bot",
			within: () => enabled,
		})
		expect(Auth.check).type.not.toBeCallableWith({
			action: "update",
			kind: "Bot",
			within: ($: Condition.Builder<Rule.DataFor<App, "Bot">, Bot, Caller>) =>
				$.predicate("shared", (bot) => bot.shared),
		})
		const robot = Condition.builder<
			object,
			object,
			{ readonly robotId: string }
		>().principal("robotId")
		expect(Auth.check).type.not.toBeCallableWith({
			action: "update",
			kind: "Bot",
			within: ($: Condition.Builder<Rule.DataFor<App, "Bot">, Bot, Caller>) =>
				$.eq("name", robot),
		})
	})

	it("gives the coverage of a scope", () => {
		expect(
			Auth.coverage({
				action: "read",
				kind: "Bot",
				within: ($) => $.under("org", "acme"),
			}),
		).type.toBe<
			Effect.Effect<
				Policy.Coverage<
					"no session",
					never,
					Condition.Opaque,
					Policy.ResidualReads<App, "Bot">
				>,
				Authorizer.PolicyUnavailable | "no session",
				Identity | Auth
			>
		>()
	})

	it("takes a scope in HttpApi with the fields of the kind", () => {
		expect(HttpApi.requires).type.toBeCallableWith(Auth, "update", "Bot", {
			within:
				(params: HttpApi.Params) =>
				($: Condition.Builder<Rule.DataFor<App, "Bot">, Bot, Caller>) =>
					$.under("org", params["org"] ?? null),
		})
		expect(HttpApi.lists).type.not.toBeCallableWith(Auth, "read", "Bot", {
			within:
				() =>
				($: Condition.Builder<Rule.DataFor<App, "Trigger">, object, Caller>) =>
					$.eq("enabled", true),
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
