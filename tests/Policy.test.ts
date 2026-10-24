import { assert, describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Equal, Exit, Schema } from "effect"
import {
	Condition,
	Decision,
	Domain,
	Policy,
	Principal,
	Resource,
	Rule,
} from "../src/index.ts"
import {
	alice,
	aliceBot,
	aliceTrigger,
	App,
	Bot,
	bob,
	Caller,
	sharedBot,
	Trigger,
} from "./fixtures.ts"

type App = typeof App

const tagOf = (decision: Decision.Decision) => decision._tag

// A principal from a loader may have no user id, for example a guest. The
// Schema of `Caller` does not let this happen, so the test makes it by hand.
const guest = {
	organizationId: "acme",
	role: "guest",
} as unknown as Caller

describe("Policy", () => {
	describe("algorithms", () => {
		const rules = (_: Rule.Builder<App>) => [
			_.allow("update", Bot),
			_.deny("update", Bot, {
				when: ($) => $.eq("ownerUserId", null),
				reason: "Shared Bots are locked",
			}),
			_.allow("update", Bot, { when: ($) => $.eq("ownerUserId", null) }),
		]
		it("gives each algorithm its own winner", () => {
			const make = (algorithm: Policy.Algorithm) =>
				Policy.define(App, { algorithm })(function* (_) {
					yield* rules(_)
				})
			const decide = (algorithm: Policy.Algorithm) =>
				Policy.decideSync(make(algorithm), {
					principal: alice,
					action: "update",
					resource: sharedBot,
				})
			assert.strictEqual(tagOf(decide("denyOverrides")), "Deny")
			assert.strictEqual(tagOf(decide("permitOverrides")), "Allow")
			assert.strictEqual(tagOf(decide("firstApplicable")), "Allow")
			assert.strictEqual(tagOf(decide("lastApplicable")), "Allow")
			assert.strictEqual(
				Decision.reason(decide("denyOverrides")),
				"Shared Bots are locked",
			)
		})

		it("is not applicable when no rule applies", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("read", Trigger)
			})
			assert.strictEqual(
				tagOf(
					Policy.decideSync(policy, {
						principal: alice,
						action: "update",
						resource: aliceBot,
					}),
				),
				"NotApplicable",
			)
			assert.strictEqual(
				tagOf(
					Policy.decideSync(Policy.empty(App), {
						principal: alice,
						action: "read",
						resource: aliceBot,
					}),
				),
				"NotApplicable",
			)
		})
	})

	describe("principal fields with no value", () => {
		const decide = (policy: Policy.Policy<App>, principal: Caller) =>
			tagOf(
				Policy.decideSync(policy, {
					principal,
					action: "update",
					resource: sharedBot,
				}),
			)
		const residual = (policy: Policy.Policy<App>, principal: Caller) =>
			Policy.residual(policy, { principal, action: "update", kind: "Bot" })

		it("never lets a principal with no id match a resource with no owner", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("update", Bot, {
					when: ($) => $.eq("ownerUserId", $.principal("userId")),
				})
			})
			assert.strictEqual(decide(policy, guest), "NotApplicable")
			assert.deepStrictEqual(residual(policy, guest), Condition.never)
		})

		it("never matches with in, ne or under", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("update", Bot, {
					when: ($) => $.in("ownerUserId", [$.principal("userId")]),
				})
				yield* _.allow("update", Bot, {
					when: ($) => $.ne("ownerUserId", $.principal("userId")),
				})
				yield* _.allow("update", Bot, {
					when: ($) =>
						$.under(
							"org",
							$.principal("organizationId"),
							"user",
							$.principal("userId"),
						),
				})
			})
			assert.strictEqual(decide(policy, guest), "NotApplicable")
			assert.deepStrictEqual(residual(policy, guest), Condition.never)
		})

		it("lets a deny rule with not apply", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("update", Bot)
				yield* _.deny("update", Bot, {
					when: ($) => $.not($.eq("ownerUserId", $.principal("userId"))),
					reason: "Only the owner may change a Bot",
				})
			})
			assert.strictEqual(decide(policy, guest), "Deny")
			assert.deepStrictEqual(residual(policy, guest), Condition.never)
		})

		it("keeps a fixed null value as a test for null", () => {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("update", Bot, {
					when: ($) => $.eq("ownerUserId", null),
				})
			})
			assert.strictEqual(decide(policy, guest), "Allow")
		})
	})

	describe("fields", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("update", Bot, {
				when: ($) => $.eq("ownerUserId", $.principal("userId")),
			})
			yield* _.deny("update", Bot, { fields: ["settings.*"] })
			yield* _.allow("read", Bot, { fields: ["name", "settings.**"] })
		})

		it("matches field patterns", () => {
			const decide = (action: "read" | "update", field: string) =>
				tagOf(
					Policy.decideSync(policy, {
						principal: alice,
						action,
						resource: aliceBot,
						field: field as never,
					}),
				)
			assert.strictEqual(decide("update", "name"), "Allow")
			assert.strictEqual(decide("update", "settings.secret"), "Deny")
			assert.strictEqual(decide("read", "settings.model"), "Allow")
			assert.strictEqual(decide("read", "level"), "NotApplicable")
		})

		it("gives the permitted fields in the same way as decide", () => {
			const fields = Effect.runSync(
				Policy.permittedFields(policy, {
					principal: alice,
					action: "update",
					resource: aliceBot,
				}),
			)
			assert.deepStrictEqual(fields, [
				"id",
				"organizationId",
				"ownerUserId",
				"name",
				"level",
			])
		})

		it("lets an allow rule with fields cover a request for the whole value", () => {
			assert.strictEqual(
				tagOf(
					Policy.decideSync(policy, {
						principal: bob,
						action: "read",
						resource: aliceBot,
					}),
				),
				"Allow",
			)
		})
	})

	describe("OpenBot roles, tokens and the platform ceiling", () => {
		// An OpenBot policy covers a resource key and every key under it. Here a
		// key is the path of a resource, and `{org}` and `{self}` are fields of
		// the principal.
		const member = Policy.define(App)(function* (_) {
			yield* _.allow(["read", "update", "delete"], Bot, {
				when: ($) =>
					$.under(
						"org",
						$.principal("organizationId"),
						"user",
						$.principal("userId"),
					),
			})
			yield* _.allow("read", "*", {
				when: ($) => $.under("org", $.principal("organizationId")),
			})
			yield* _.deny("delete", Bot, {
				when: ($) => $.eq("level", 5),
				reason: "Level 5 Bots stay",
			})
		})
		const token = Policy.define(App)(function* (_) {
			yield* _.allow("read", "*")
		})
		const platform = Policy.define(App)(function* (_) {
			yield* _.deny("*", "*", {
				when: ($) => $.under("org", "blocked"),
				reason: "This organization is blocked",
			})
		})
		const session = member.pipe(Policy.ceiling(platform))
		const withToken = Policy.all([member, token]).pipe(Policy.ceiling(platform))
		const blockedBot = Bot.make({ ...aliceBot, organizationId: "blocked" })

		const decide = (
			policy: Policy.Policy<App>,
			action: "read" | "update" | "delete",
			resource: Bot,
		) =>
			tagOf(Policy.decideSync(policy, { principal: alice, action, resource }))

		it("lets a member act on their own Bots and read the organization", () => {
			assert.strictEqual(decide(session, "update", aliceBot), "Allow")
			assert.strictEqual(decide(session, "update", sharedBot), "NotApplicable")
			assert.strictEqual(decide(session, "read", sharedBot), "Allow")
		})

		it("never lets a token do more than its member", () => {
			assert.strictEqual(decide(withToken, "read", aliceBot), "Allow")
			assert.strictEqual(decide(withToken, "update", aliceBot), "NotApplicable")
		})

		it("lets the ceiling deny but never allow", () => {
			assert.strictEqual(decide(session, "read", blockedBot), "Deny")
			assert.strictEqual(
				decide(Policy.empty(App).pipe(Policy.ceiling(token)), "read", aliceBot),
				"NotApplicable",
			)
		})

		it("gives the condition for a list of readable Bots", () => {
			const residual = Policy.residual(withToken, {
				principal: alice,
				action: "read",
				kind: "Bot",
			})
			assert.isTrue(Condition.evaluateSync(residual, { value: aliceBot }))
			assert.isFalse(Condition.evaluateSync(residual, { value: blockedBot }))
			assert.deepStrictEqual(
				Policy.residual(withToken, {
					principal: alice,
					action: "update",
					kind: "Bot",
				}),
				Condition.never,
			)
		})

		it("explains a decision", () => {
			const explanation = Effect.runSync(
				Policy.explain(session, {
					principal: alice,
					action: "delete",
					resource: sharedBot,
				}),
			)
			assert.strictEqual(explanation.decision._tag, "Deny")
			assert.deepStrictEqual(
				explanation.steps.map((step) => [step.path, step.applies]),
				[
					[[0, 0], false],
					[[1, 2], true],
				],
			)
		})
	})

	describe("grants and rules in order", () => {
		const grants = Policy.define(App)(function* (_) {
			yield* _.allow("delegate", Bot, {
				when: ($) => $.eq("id", "b1"),
				meta: { scope: "once" },
			})
		})
		const rules = Policy.define(App)(function* (_) {
			yield* _.deny("delegate", Bot)
		})

		it("lets the first policy with an answer win", () => {
			const policy = Policy.firstOf([grants, rules])
			const decision = Policy.decideSync(policy, {
				principal: alice,
				action: "delegate",
				resource: aliceBot,
			})
			assert.strictEqual(decision._tag, "Allow")
			assert.deepStrictEqual(
				decision._tag === "Allow" ? decision.rule?.meta : undefined,
				{ scope: "once" },
			)
			assert.strictEqual(
				tagOf(
					Policy.decideSync(policy, {
						principal: alice,
						action: "delegate",
						resource: sharedBot,
					}),
				),
				"Deny",
			)
		})

		it("lets one allow win with any", () => {
			assert.strictEqual(
				tagOf(
					Policy.decideSync(Policy.any([rules, grants]), {
						principal: alice,
						action: "delegate",
						resource: aliceBot,
					}),
				),
				"Allow",
			)
		})
	})

	describe("predicates", () => {
		it.effect("keeps the errors of predicates in the error channel", () =>
			Effect.gen(function* () {
				const policy = Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot, {
						when: ($) =>
							$.predicate("quota", () =>
								Effect.fail({ _tag: "QuotaError" as const }),
							),
					})
				})
				const exit = yield* Effect.exit(
					Policy.decide(policy, {
						principal: alice,
						action: "read",
						resource: aliceBot,
					}),
				)
				assert.isTrue(Exit.isFailure(exit))
			}),
		)
	})

	describe("schema", () => {
		const PolicySchema = Policy.schema(App)

		it("keeps a policy tree as JSON", () => {
			const policy = Policy.all([
				Policy.define(App)(function* (_) {
					yield* _.allow("read", Bot, {
						when: ($) => $.under("org", $.principal("organizationId")),
						fields: ["name", "settings.*"],
						reason: "Read",
						id: "r1",
						meta: { scope: "chat" },
					})
				}),
				Policy.define(App, { algorithm: "lastApplicable" })(function* (_) {
					yield* _.deny("*", "*")
				}),
			])
			const json = JSON.parse(
				JSON.stringify(Schema.encodeSync(PolicySchema)(policy)),
			)
			const decoded = Schema.decodeUnknownSync(PolicySchema)(json)
			assert.isTrue(Equal.equals(decoded, policy))
		})

		const decodeMessage = (rule: Policy.EncodedRule) => {
			const result = Schema.decodeExit(PolicySchema)({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [rule],
			})
			assert.isTrue(Exit.isFailure(result))
			return String(Exit.isFailure(result) ? result.cause : "")
		}

		it("checks names against the domain", () => {
			const message = decodeMessage({
				_tag: "Allow",
				actions: ["fly"],
				resources: ["Ghost", "Trigger"],
				fields: ["level"],
				when: {
					_tag: "Compare",
					op: "eq",
					field: "enabled",
					value: { _tag: "Principal", path: "tenant" },
				},
			})
			Arr.map(["Ghost", "fly", "level", "tenant"], (part) =>
				assert.include(message, part),
			)
		})

		it("checks the extra data of a rule with the Schema of the domain", () => {
			assert.include(
				decodeMessage({
					_tag: "Allow",
					actions: ["read"],
					resources: ["Bot"],
					meta: { scope: "forever" },
				}),
				`Expected "once" | "chat" | "lifetime"`,
			)
		})
	})

	describe("properties", () => {
		const Spec = Schema.Struct({
			tag: Schema.Literals(["Allow", "Deny"]),
			action: Schema.Literals(["read", "update", "*"]),
			when: Schema.Literals([
				"none",
				"owner",
				"shared",
				"level",
				"under",
				"notName",
				"either",
				"notOwner",
				"ownerIn",
				"underUser",
			]),
			fields: Schema.Boolean,
		})
		const BotInput = Schema.Struct({
			organizationId: Schema.Literals(["acme", "other"]),
			ownerUserId: Schema.NullOr(Schema.Literals(["alice", "bob"])),
			name: Schema.Literals(["Helper", "Team"]),
			level: Schema.Literals([0, 2, 5]),
		})
		const Request = Schema.Struct({
			action: Schema.Literals(["read", "update"]),
			field: Schema.Literals(["none", "name", "level"]),
			algorithm: Schema.Literals([
				"denyOverrides",
				"permitOverrides",
				"firstApplicable",
				"lastApplicable",
			]),
			shape: Schema.Literals(["rules", "all", "any", "firstOf", "ceiling"]),
			principal: Schema.Literals(["alice", "guest"]),
		})
		const principals = { alice, guest }

		type BotBuilder = Condition.Builder<Rule.DataFor<App, "Bot">, Bot, Caller>
		const conditions: Record<
			Exclude<(typeof Spec.Type)["when"], "none">,
			($: BotBuilder) => Condition.Test<Bot, Caller>
		> = {
			owner: ($) => $.eq("ownerUserId", $.principal("userId")),
			shared: ($) => $.eq("ownerUserId", null),
			level: ($) => $.gte("level", 2),
			under: ($) => $.under("org", $.principal("organizationId")),
			notName: ($) => $.not($.eq("name", "Team")),
			either: ($) => $.or($.eq("level", 5), $.exists("ownerUserId")),
			notOwner: ($) => $.not($.eq("ownerUserId", $.principal("userId"))),
			ownerIn: ($) => $.in("ownerUserId", [$.principal("userId"), "bob"]),
			underUser: ($) =>
				$.under(
					"org",
					$.principal("organizationId"),
					"user",
					$.principal("userId"),
				),
		}

		const toRule = (
			_: Rule.Builder<App>,
			spec: typeof Spec.Type,
		): Rule.Rule<never, never, never, App, Condition.Reads<Bot, Caller>> => {
			const make = spec.tag === "Allow" ? _.allow : _.deny
			return make(spec.action, Bot, {
				...(spec.fields ? { fields: ["name"] } : {}),
				...(spec.when === "none" ? {} : { when: conditions[spec.when] }),
			})
		}

		const build = (
			specs: ReadonlyArray<typeof Spec.Type>,
			request: typeof Request.Type,
		): Policy.Policy<App> => {
			const half = Math.floor(specs.length / 2)
			const withAlgorithm = (part: ReadonlyArray<typeof Spec.Type>) =>
				Policy.define(App, { algorithm: request.algorithm })(function* (_) {
					yield* Arr.map(part, (spec) => toRule(_, spec))
				})
			const left = withAlgorithm(specs.slice(0, half))
			const right = withAlgorithm(specs.slice(half))
			switch (request.shape) {
				case "rules":
					return withAlgorithm(specs)
				case "all":
					return Policy.all([left, right])
				case "any":
					return Policy.any([left, right])
				case "firstOf":
					return Policy.firstOf([left, right])
				case "ceiling":
					return Policy.ceiling(left, right)
			}
		}

		it.prop(
			"gives a residual condition that agrees with decide",
			{
				specs: Schema.Array(Spec),
				bot: BotInput,
				request: Request,
			},
			({ specs, bot, request }) => {
				const policy = build(specs, request)
				const value = Bot.make({
					...bot,
					id: "b9",
					settings: { model: "small", secret: "s" },
				})
				const field = request.field === "none" ? undefined : request.field
				const principal = principals[request.principal]
				const decision = Policy.decideSync(policy, {
					principal,
					action: request.action,
					resource: value,
					...(field === undefined ? {} : { field }),
				})
				const residual = Policy.residual(policy, {
					principal,
					action: request.action,
					kind: "Bot",
					...(field === undefined ? {} : { field }),
				})
				return (
					Condition.evaluateSync(residual, { value }) ===
					(decision._tag === "Allow")
				)
			},
		)

		it.prop(
			"keeps every policy the same through JSON",
			{ specs: Schema.Array(Spec), request: Request },
			({ specs, request }) => {
				const policy = build(specs, request)
				const PolicySchema = Policy.schema(App)
				const json = JSON.parse(
					JSON.stringify(Schema.encodeSync(PolicySchema)(policy)),
				)
				return Equal.equals(
					Schema.decodeUnknownSync(PolicySchema)(json),
					policy,
				)
			},
		)

		it.prop(
			"keeps the meaning of a condition when it makes it smaller",
			{
				specs: Schema.Array(Spec),
				bot: BotInput,
				principal: Request.fields.principal,
			},
			({ specs, bot, principal }) => {
				const value = Bot.make({
					...bot,
					id: "b9",
					settings: { model: "small", secret: "s" },
				})
				const _ = Policy.define(App)
				const policy = _(function* (builder) {
					yield* Arr.map(specs, (spec) => toRule(builder, spec))
				})
				const node = policy.node as Policy.RulesNode
				// A node keeps no types. These rules have no predicates.
				const conditions = node.rules.flatMap((rule) =>
					rule.when === undefined ? [] : [rule.when as Condition.Condition],
				)
				const whole = Condition.not(
					Condition.or(...conditions, Condition.and(...conditions)),
				)
				const input = {
					value,
					principal: principals[principal],
					path: [
						"org",
						{ _tag: "Field", field: "organizationId" },
						"user",
						{ _tag: "Field", field: "ownerUserId" },
					] as const,
				}
				return (
					Condition.evaluateSync(whole, input) ===
					Condition.evaluateSync(
						Condition.simplify(Condition.partial(whole, input)),
						{ value },
					)
				)
			},
		)

		const scopes = {
			all: undefined,
			acme: ($) => $.under("org", "acme"),
			ownOrganization: ($) => $.under("org", $.principal("organizationId")),
			own: ($) =>
				$.under(
					"org",
					$.principal("organizationId"),
					"user",
					$.principal("userId"),
				),
			team: ($) => $.eq("name", "Team"),
			high: ($) => $.gte("level", 2),
			sharedOrLow: ($) => $.or($.eq("ownerUserId", null), $.lt("level", 2)),
		} satisfies Record<string, Policy.Scope<App, "Bot"> | undefined>
		const ScopeName = Schema.Literals([
			"all",
			"acme",
			"ownOrganization",
			"own",
			"team",
			"high",
			"sharedOrLow",
		])

		// Every value that `BotInput` can make.
		const everyBot = BotInput.fields.organizationId.literals.flatMap(
			(organizationId) =>
				[...BotInput.fields.ownerUserId.members[0].literals, null].flatMap(
					(ownerUserId) =>
						BotInput.fields.name.literals.flatMap((name) =>
							BotInput.fields.level.literals.map((level) =>
								Bot.make({
									id: "b9",
									organizationId,
									ownerUserId,
									name,
									level,
									settings: { model: "small", secret: "s" },
								}),
							),
						),
				),
		)

		/** A plain value of the kind, made from an example of a search. */
		const fromExample = (example: Condition.Example) => ({
			...aliceBot,
			_tag: "Bot",
			...example,
		})

		const scopedRequest = (
			request: typeof Request.Type,
			scope: typeof ScopeName.Type,
		) => {
			const field = request.field === "none" ? undefined : request.field
			const within = scopes[scope]
			return {
				principal: principals[request.principal],
				action: request.action,
				kind: "Bot" as const,
				...(field === undefined ? {} : { field }),
				...(within === undefined ? {} : { within }),
			}
		}

		const inScope = (
			scope: typeof ScopeName.Type,
			principal: Caller,
			value: object,
		) => {
			const within = scopes[scope]
			return (
				within === undefined ||
				Condition.evaluateSync(within(Condition.builder()), {
					value,
					principal,
					path: Bot.descriptor.path,
				})
			)
		}

		const allows = (
			policy: Policy.Policy<App>,
			request: ReturnType<typeof scopedRequest>,
			value: object,
		) =>
			Policy.decideSync(policy, {
				principal: request.principal,
				action: request.action,
				resource: value as Bot,
				...(request.field === undefined ? {} : { field: request.field }),
			})._tag === "Allow"

		it.prop(
			"gives a residual in a scope that agrees with decide",
			{
				specs: Schema.Array(Spec),
				bot: BotInput,
				request: Request,
				scope: ScopeName,
			},
			({ specs, bot, request, scope }) => {
				const policy = build(specs, request)
				const value = Bot.make({
					...bot,
					id: "b9",
					settings: { model: "small", secret: "s" },
				})
				const scoped = scopedRequest(request, scope)
				const residual = Policy.residual(policy, scoped)
				return (
					Condition.evaluateSync(residual, { value }) ===
					(inScope(scope, scoped.principal, value) &&
						allows(policy, scoped, value))
				)
			},
		)

		it.prop(
			"gives a coverage that agrees with decide, with examples",
			{ specs: Schema.Array(Spec), request: Request, scope: ScopeName },
			({ specs, request, scope }) => {
				const policy = build(specs, request)
				const scoped = scopedRequest(request, scope)
				const covered = Policy.coverage(policy, scoped)
				const inside = everyBot.filter((value) =>
					inScope(scope, scoped.principal, value),
				)
				// The condition is the exact filter, for every case.
				const exact = everyBot.every(
					(value) =>
						Condition.evaluateSync(covered.condition, { value }) ===
						(inScope(scope, scoped.principal, value) &&
							allows(policy, scoped, value)),
				)
				switch (covered._tag) {
					case "All":
						return (
							exact &&
							inside.length > 0 &&
							inside.every((value) => allows(policy, scoped, value))
						)
					case "None":
						return (
							exact && inside.every((value) => !allows(policy, scoped, value))
						)
					case "Some": {
						// The examples prove the answer: one value in the scope is
						// allowed, and one is not.
						const allowed = fromExample(covered.allowed)
						const refused = fromExample(covered.refused)
						return (
							exact &&
							inScope(scope, scoped.principal, allowed) &&
							allows(policy, scoped, allowed) &&
							inScope(scope, scoped.principal, refused) &&
							!allows(policy, scoped, refused)
						)
					}
					case "Unknown":
						// These policies have no predicates, and they are small.
						return false
				}
			},
		)
	})

	it("checks the trigger rules too", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("write", Trigger, {
				when: ($) => $.eq("enabled", true),
			})
		})
		assert.strictEqual(
			tagOf(
				Policy.decideSync(policy, {
					principal: alice,
					action: "write",
					resource: aliceTrigger,
				}),
			),
			"Allow",
		)
	})

	it.effect("gives a new trace each time an explanation runs", () =>
		Effect.gen(function* () {
			const policy = Policy.define(App)(function* (_) {
				yield* _.allow("read", Bot)
			})
			const explain = Policy.explain(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})
			const first = yield* explain
			const second = yield* explain
			assert.strictEqual(first.steps.length, 1)
			assert.strictEqual(second.steps.length, 1)
		}),
	)

	describe("keeps a predicate that may fail in the residual", () => {
		const _ = Rule.builder(App)
		const offline = (tag: "allow" | "deny") =>
			_[tag]("read", Bot, {
				when: ($) => $.predicate("offline", () => Effect.fail("offline")),
			})
		const request = {
			principal: alice,
			action: "read",
			kind: "Bot",
		} as const
		const valueRequest = {
			principal: alice,
			action: "read",
			resource: aliceBot,
		} as const
		const check = (policy: Policy.Policy<App, string, never, any>) =>
			Effect.gen(function* () {
				const decision = yield* Effect.exit(Policy.decide(policy, valueRequest))
				assert.isTrue(Exit.isFailure(decision))
				const residual = Policy.residual(policy, request)
				assert.notStrictEqual(residual._tag, "True")
				const result = yield* Effect.exit(
					Condition.evaluate(residual, { value: aliceBot }),
				)
				assert.isTrue(Exit.isFailure(result))
			})

		it.effect("in the deny rules of permitOverrides", () =>
			check(
				Policy.rules(App, [offline("deny")], {
					algorithm: "permitOverrides",
				}),
			),
		)

		it.effect("does not run a child of all after a deny", () =>
			Effect.gen(function* () {
				const policy = Policy.any([
					Policy.all([
						Policy.rules(App, [_.deny("read", Bot)]),
						Policy.rules(App, [offline("allow")]),
					]),
					Policy.rules(App, [_.allow("read", Bot)]),
				])
				const residual = Policy.residual(policy, request)
				assert.deepStrictEqual(
					yield* Effect.exit(Condition.evaluate(residual, { value: aliceBot })),
					Exit.succeed(true),
				)
			}),
		)

		it.effect("runs each predicate as many times as decide", () =>
			Effect.gen(function* () {
				let calls = 0
				const policy = Policy.all([
					Policy.rules(App, [
						_.deny("read", Bot, {
							when: ($) =>
								$.predicate("first", () => {
									calls = calls + 1
									return calls === 1
								}),
						}),
						_.allow("read", Bot),
					]),
				])
				const decision = yield* Policy.decide(policy, valueRequest)
				assert.strictEqual(decision._tag, "Deny")
				calls = 0
				const residual = Policy.residual(policy, request)
				assert.isFalse(yield* Condition.evaluate(residual, { value: aliceBot }))
				assert.strictEqual(calls, 1)
			}),
		)

		it.effect("in a list of rules", () =>
			check(
				Policy.rules(App, [offline("allow"), _.allow("read", Bot)], {
					algorithm: "firstApplicable",
				}),
			),
		)

		it.effect("in a child of all after a child with no answer", () =>
			check(
				Policy.any([
					Policy.all([
						Policy.empty(App),
						Policy.rules(App, [offline("allow")]),
					]),
					Policy.rules(App, [_.allow("read", Bot)]),
				]),
			),
		)

		it.effect("in a child that does not allow", () =>
			check(
				Policy.any([
					Policy.rules(App, [offline("deny")], {
						algorithm: "permitOverrides",
					}),
					Policy.rules(App, [_.allow("read", Bot)]),
				]),
			),
		)
	})

	it("gives the fields inside an optional struct", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				settings: Schema.optionalKey(
					Schema.Struct({ open: Schema.String, secret: Schema.String }),
				),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note)
			yield* _.deny("read", Note, { fields: ["settings.secret"] })
		})
		const fields = Effect.runSync(
			Policy.permittedFields(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ settings: { open: "a", secret: "b" } }),
			}),
		)
		assert.deepStrictEqual(fields, ["settings.open"])
	})

	it("decodes a rule with a field of an optional principal struct", () => {
		class User extends Principal.Class<User>("User")({
			user: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
		}) {}
		const Blog = Domain.make({ principal: User, resources: [Bot] })
		const policy = Policy.define(Blog)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.eq("ownerUserId", $.principal("user.id")),
			})
		})
		const PolicySchema = Policy.schema(Blog)
		const json = Schema.encodeSync(PolicySchema)(policy)
		assert.isTrue(Equal.equals(Schema.decodeSync(PolicySchema)(json), policy))
	})

	it("gives the fields inside a suspended struct", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				settings: Schema.suspend(() =>
					Schema.Struct({ open: Schema.String, secret: Schema.String }),
				),
			},
		})
		assert.deepStrictEqual(Resource.descriptor(Note).fieldPaths, [
			"settings.open",
			"settings.secret",
		])
	})

	it("leaves out a record field when a deny rule names a part of it", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				title: Schema.String,
				settings: Schema.Record(Schema.String, Schema.String),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.rules(Notes, [
			Rule.builder(Notes).allow("read", Note),
			Rule.make({
				_tag: "Deny",
				actions: ["read"],
				resources: ["Note"],
				fields: ["settings.*"],
			}),
		])
		const fields = Effect.runSync(
			Policy.permittedFields(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ title: "a", settings: { secret: "b" } }),
			}),
		)
		assert.deepStrictEqual(fields, ["title"])
	})

	it("matches field patterns", () => {
		assert.isTrue(Rule.matchesField("address.*", "address.city"))
		assert.isFalse(Rule.matchesField("address.*", "address.city.code"))
		assert.isTrue(Rule.matchesField("address.**", "address.city.code"))
		assert.isTrue(Rule.matchesField("**", "name"))
		assert.isTrue(Rule.matchesField("*.city", "address.city"))
		assert.isFalse(Rule.matchesField("*.city", "city"))
		assert.isTrue(Rule.matchesField("a*c", "abbc"))
		assert.isFalse(Rule.matchesField("a*c", "a.c"))
		assert.isTrue(Rule.matchesInside("settings.*", "settings"))
		assert.isTrue(Rule.matchesInside("**", "settings"))
		assert.isFalse(Rule.matchesInside("settings", "settings"))
		assert.isFalse(Rule.matchesInside("name.*", "settings"))
		assert.isTrue(Rule.matchesInside("settings.", "settings"))
	})

	it("matches patterns by Unicode code points", () => {
		assert.isTrue(Rule.matchesField("🔒*", "🔒secret"))
		assert.isTrue(Rule.matchesField("a*", "a🔒"))
		assert.isFalse(Rule.matchesField("🔒*", "🔓secret"))
	})

	it("takes a rule on a part of a record field", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { settings: Schema.Record(Schema.String, Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note, {
				when: ($) => $.eq("settings.mode", "open"),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ settings: { mode: "open" } }),
			})._tag,
			"Allow",
		)
		const PolicySchema = Policy.schema(Notes)
		const json = Schema.encodeSync(PolicySchema)(policy)
		assert.isTrue(Equal.equals(Schema.decodeSync(PolicySchema)(json), policy))
	})

	it("stops in a short time when a residual is too large", () => {
		const policy = Arr.reduce(
			Arr.range(0, 23),
			Policy.define(App)(function* (_) {
				yield* _.allow("read", Bot, { when: ($) => $.eq("level", 1) })
				yield* _.deny("read", Bot, { when: ($) => $.eq("name", "Team") })
			}) as Policy.Policy<App>,
			(inner, depth) =>
				depth % 2 === 0 ? Policy.any([inner]) : Policy.all([inner]),
		)
		const start = Date.now()
		assert.throws(() =>
			Policy.residual(policy, {
				principal: alice,
				action: "read",
				kind: "Bot",
			}),
		)
		assert.isBelow(Date.now() - start, 1000)
	})

	it("does the work on a shared child only one time", () => {
		const base: Policy.Policy<App> = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
		})
		const any = Arr.reduce(Arr.range(0, 23), base, (inner) =>
			Policy.any([inner, inner]),
		)
		const all = Arr.reduce(Arr.range(0, 23), base, (inner) =>
			Policy.all([inner, inner]),
		)
		const request = { principal: alice, action: "read", kind: "Bot" } as const
		const start = Date.now()
		assert.deepStrictEqual(Policy.residual(any, request), Condition.always)
		assert.deepStrictEqual(Policy.residual(all, request), Condition.always)
		assert.strictEqual(
			Policy.decideSync(all, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
		assert.isBelow(Date.now() - start, 1000)
	})

	it("does the work on a shared part of a condition only one time", () => {
		const condition = Arr.reduce(
			Arr.range(0, 23),
			Condition.builder<Rule.DataFor<App, "Bot">, Bot, Caller>().eq(
				"level",
				2,
			) as Condition.Test<Bot>,
			(inner) => Condition.and(inner, inner),
		)
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { when: () => condition })
		})
		const start = Date.now()
		const residual = Policy.residual(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		assert.isTrue(Condition.evaluateSync(residual, { value: aliceBot }))
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
		assert.isBelow(Date.now() - start, 1000)
	})

	it("finds the fields of a class in a JSON string codec", () => {
		class User extends Schema.Class<User>("User")({ id: Schema.String }) {}
		const Json = Domain.make({
			principal: Schema.fromJsonString(User),
			resources: [Bot],
		})
		const policy = Policy.define(Json)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.eq("ownerUserId", $.principal("id")),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: User.make({ id: "alice" }),
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
	})

	it("decides again each time the Effect runs", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { owner: Schema.mutableKey(Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.all([
			Policy.define(Notes)(function* (_) {
				yield* _.allow("read", Note, {
					when: ($) => $.eq("owner", $.principal("userId")),
				})
			}),
		])
		const note = Note.make({ owner: "alice" })
		const decide = Policy.decide(policy, {
			principal: alice,
			action: "read",
			resource: note,
		})
		assert.strictEqual(Effect.runSync(decide)._tag, "Allow")
		note.owner = "bob"
		assert.strictEqual(Effect.runSync(decide)._tag, "NotApplicable")
	})

	it("leaves out a field that holds a struct in one branch of a union", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				data: Schema.Union([
					Schema.Struct({ value: Schema.Null }),
					Schema.Struct({ value: Schema.Struct({ secret: Schema.String }) }),
				]),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note)
			yield* _.deny("read", Note, { fields: ["data.value.secret"] })
		})
		const fields = Effect.runSync(
			Policy.permittedFields(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ data: { value: { secret: "s" } } }),
			}),
		)
		assert.notInclude(fields, "data.value")
		assert.notInclude(fields, "data.value.secret")
	})

	it("does not find fields inside an Option codec", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				owner: Schema.OptionFromNullOr(Schema.Struct({ id: Schema.String })),
			},
		})
		const schema = Resource.descriptor(Note).schema
		assert.isTrue(Resource.hasPath(schema, "owner"))
		assert.isFalse(Resource.hasPath(schema, "owner.id"))
	})

	it("keeps a field that holds a scalar or a struct", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				data: Schema.Union([
					Schema.String,
					Schema.Struct({ secret: Schema.String }),
				]),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Policy.define(Notes)(function* (_) {
			yield* _.allow("read", Note)
		})
		const fields = Effect.runSync(
			Policy.permittedFields(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ data: "text" }),
			}),
		)
		assert.include(fields, "data")
	})

	it("simplifies a condition with many shared parts in a short time", () => {
		const $ = Condition.builder<Rule.DataFor<App, "Bot">, Bot, Caller>()
		const build = (seed: number) =>
			Arr.reduce(
				Arr.range(0, 21),
				$.eq("level", 0) as Condition.Test<Bot, Caller>,
				(c, level) => {
					const a = $.eq("name", `${String(seed)}-${String(level)}-a`)
					const b = $.eq("name", `${String(seed)}-${String(level)}-b`)
					return level % 2 === 0
						? $.and($.or(c, a), $.or(c, b))
						: $.or($.and(c, a), $.and(c, b))
				},
			)
		const condition = $.or(build(1), build(2))
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { when: () => condition })
		})
		const start = Date.now()
		try {
			Policy.residual(policy, { principal: alice, action: "read", kind: "Bot" })
		} catch {
			// A residual that is too large is an error. This test is about time.
		}
		assert.isBelow(Date.now() - start, 2000)
	})

	it("does not load JSON of a policy with a number that JSON can not hold", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
			yield* _.deny("read", Bot, { when: ($) => $.lt("level", Infinity) })
		})
		const json: unknown = JSON.parse(JSON.stringify(policy))
		assert.throws(() => Schema.decodeUnknownSync(Policy.schema(App))(json))
	})

	it("simplifies shared predicate branches in a short time", () => {
		const $ = Condition.builder<Rule.DataFor<App, "Bot">, Bot, Caller>()
		const shared = Arr.reduce(
			Arr.range(0, 17),
			$.predicate("never", () => false) as Condition.Condition<
				never,
				never,
				Condition.Opaque,
				Condition.Reads<Bot, Caller>
			>,
			(inner) => $.and(inner, inner),
		)
		const start = Date.now()
		assert.doesNotThrow(() => Condition.simplify(shared))
		assert.doesNotThrow(() => Condition.partial(shared, { principal: alice }))
		assert.isBelow(Date.now() - start, 1000)
	})

	it("keeps tests with numbers that JSON can not hold apart", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot)
			yield* _.deny("read", Bot, {
				when: ($) =>
					$.or(
						$.lt("level", Number.NEGATIVE_INFINITY),
						$.lt("level", Infinity),
					),
			})
		})
		const request = { principal: alice, action: "read", kind: "Bot" } as const
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"Deny",
		)
		assert.isFalse(
			Condition.evaluateSync(Policy.residual(policy, request), {
				value: aliceBot,
			}),
		)
	})

	it("is not applicable for an action that the kind does not have", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("*", "*")
		})
		const request = {
			principal: alice,
			action: "write",
			resource: aliceBot,
		} as unknown as Policy.Request<App>
		assert.strictEqual(Policy.decideSync(policy, request)._tag, "NotApplicable")
	})

	it("gives a predicate residual no answer for a value of another kind", () => {
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
		assert.isFalse(
			Effect.runSync(
				// The types stop a Trigger here. The test casts, to check the code.
				Condition.evaluate(
					residual as unknown as Condition.Condition<
						never,
						never,
						Condition.Opaque
					>,
					{ value: aliceTrigger },
				),
			),
		)
	})

	it("does not let a rule for no fields cover a request", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { fields: [] })
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: aliceBot,
			})._tag,
			"NotApplicable",
		)
		assert.deepStrictEqual(
			Policy.residual(policy, {
				principal: alice,
				action: "read",
				kind: "Bot",
			}),
			Condition.never,
		)
	})

	it("lists the fields of a deep shared policy in a short time", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				title: Schema.String,
				settings: Schema.Record(Schema.String, Schema.String),
			},
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		const policy = Arr.reduce(
			Arr.range(0, 29),
			Policy.define(Notes)(function* (_) {
				yield* _.allow("read", Note)
			}) as Policy.Policy<typeof Notes>,
			(inner) => Policy.all([inner, inner]),
		)
		const start = Date.now()
		const fields = Effect.runSync(
			Policy.permittedFields(policy, {
				principal: alice,
				action: "read",
				resource: Note.make({ title: "a", settings: {} }),
			}),
		)
		assert.deepStrictEqual(fields, ["title", "settings"])
		assert.isBelow(Date.now() - start, 1000)
	})

	it("gives the residual of many ordered rules in a short time", () => {
		const ids = Array.from({ length: 4000 }, (_, index) => `b${String(index)}`)
		const policy = Policy.define(App, { algorithm: "firstApplicable" })(
			function* (_) {
				yield* Arr.map(ids, (id) =>
					_.allow("read", Bot, { when: ($) => $.eq("id", id) }),
				)
			},
		)
		const start = Date.now()
		const residual = Policy.residual(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		assert.isBelow(Date.now() - start, 1000)
		assert.isTrue(Condition.evaluateSync(residual, { value: aliceBot }))
	})

	it("simplifies a long list of tests in a short time", () => {
		const ids = Array.from({ length: 4000 }, (_, index) => `b${String(index)}`)
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.or(...ids.map((id) => $.eq("id", id))),
			})
		})
		const start = Date.now()
		const residual = Policy.residual(policy, {
			principal: alice,
			action: "read",
			kind: "Bot",
		})
		assert.isBelow(Date.now() - start, 2000)
		assert.isTrue(Condition.evaluateSync(residual, { value: aliceBot }))
	})

	it("takes a principal field inside a record", () => {
		class User extends Principal.Class<User>("User")({
			claims: Schema.Record(Schema.String, Schema.String),
		}) {}
		const Claims = Domain.make({ principal: User, resources: [Bot] })
		const policy = Policy.define(Claims)(function* (_) {
			yield* _.allow("read", Bot, {
				when: ($) => $.eq("ownerUserId", $.principal("claims.userId")),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: User.make({ claims: { userId: "alice" } }),
				action: "read",
				resource: aliceBot,
			})._tag,
			"Allow",
		)
	})

	it("does not take a path inside a suspended string", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { id: Schema.suspend(() => Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		assert.throws(() =>
			Schema.decodeSync(Policy.schema(Notes))({
				_tag: "Rules",
				algorithm: "denyOverrides",
				rules: [
					{
						_tag: "Allow",
						actions: ["read"],
						resources: ["Note"],
						when: {
							_tag: "Compare",
							op: "eq",
							field: "id.missing",
							value: { _tag: "Literal", value: null },
						},
					},
				],
			}),
		)
	})

	it("checks a path past a key of a record against the record values", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: { settings: Schema.Record(Schema.String, Schema.String) },
		})
		const Notes = Domain.make({ principal: Caller, resources: [Note] })
		assert.isTrue(
			Resource.hasPath(Resource.descriptor(Note).schema, "settings.mode"),
		)
		assert.isFalse(
			Resource.hasPath(Resource.descriptor(Note).schema, "settings.mode.x"),
		)
		assert.throws(() =>
			Policy.rules(Notes, [
				Rule.make({
					_tag: "Allow",
					actions: ["read"],
					resources: ["Note"],
					fields: ["settings.mode.x"],
				}),
			]),
		)
	})

	it("checks a key of a record against the Schema of the keys", () => {
		const Note = Resource.make("Note", {
			actions: ["read"],
			fields: {
				settings: Schema.Record(
					Schema.TemplateLiteral(["public-", Schema.String]),
					Schema.String,
				),
			},
		})
		const schema = Resource.descriptor(Note).schema
		assert.isTrue(Resource.hasPath(schema, "settings.public-mode"))
		assert.isFalse(Resource.hasPath(schema, "settings.private-mode"))
	})

	it("takes a deep path in a recursive Schema", () => {
		interface Tree {
			readonly name: string
			readonly child?: Tree
		}
		const Tree: Schema.Codec<Tree> = Schema.Struct({
			name: Schema.String,
			child: Schema.optionalKey(Schema.suspend(() => Tree)),
		})
		const Forest = Resource.make("Forest", {
			actions: ["read"],
			fields: { tree: Tree },
		})
		const Woods = Domain.make({ principal: Caller, resources: [Forest] })
		const policy = Policy.define(Woods)(function* (_) {
			yield* _.allow("read", Forest, {
				when: ($) => $.eq("tree.child.child.name", "a"),
			})
		})
		assert.strictEqual(
			Policy.decideSync(policy, {
				principal: alice,
				action: "read",
				resource: Forest.make({
					tree: { name: "x", child: { name: "y", child: { name: "a" } } },
				}),
			})._tag,
			"Allow",
		)
	})

	it("does not let a field name be empty", () => {
		assert.throws(() =>
			Resource.make("Note", {
				actions: ["read"],
				fields: { "": Schema.Struct({ secret: Schema.String }) },
			}),
		)
	})

	it("does not call a policy with a predicate a plain policy", () => {
		const policy = Policy.define(App)(function* (_) {
			yield* _.allow("read", Bot, { when: ($) => $.predicate("p", () => true) })
		})
		assert.isFalse(Schema.is(Policy.schema(App))(policy))
	})

	it("matches long patterns in a short time", () => {
		const start = Date.now()
		// Two stars or more match any number of parts.
		assert.isTrue(Rule.matchesField("*".repeat(10_000), "name.x"))
		assert.isTrue(Rule.matchesField("*".repeat(10_000), "name"))
		assert.isFalse(Rule.matchesField(`${"x".repeat(40_000)}*`, "name"))
		assert.isBelow(Date.now() - start, 1000)
	})

	it("keeps the getters of a resource class after a check of its paths", () => {
		class Doc extends Resource.Class<Doc>()("Doc", {
			actions: ["read"],
			fields: { flags: Schema.Record(Schema.String, Schema.Boolean) },
		}) {
			get blocked() {
				return this.flags["blocked"] === true
			}
		}
		const Docs = Domain.make({ principal: Caller, resources: [Doc] })
		Policy.define(Docs)(function* (_) {
			yield* _.allow("read", Doc, { when: ($) => $.eq("flags.active", true) })
		})
		const doc = Doc.make({ flags: { blocked: true } })
		assert.isTrue(doc instanceof Doc)
		assert.isTrue(doc.blocked)
	})

	it("matches a pattern with many stars in a short time", () => {
		const start = Date.now()
		assert.isFalse(
			Rule.matchesField(`${"*".repeat(80)}Z`, "organizationIdentifier"),
		)
		assert.isBelow(Date.now() - start, 1000)
	})

	it("does not let a field name have a dot", () => {
		assert.throws(() =>
			Resource.make("Note", {
				actions: ["read"],
				fields: { "owner.id": Schema.String },
			}),
		)
	})

	it("does not let a resource have a field named _tag", () => {
		assert.throws(() =>
			Resource.make("Secret", {
				actions: ["read"],
				fields: { _tag: Schema.String, id: Schema.String },
			}),
		)
	})

	it("does not take a rule from the builder of a domain with the same types", () => {
		const First = Domain.make({ principal: Caller, resources: [Bot] })
		const Second = Domain.make({ principal: Caller, resources: [Bot] })
		const rule = Rule.builder(First).allow("read", Bot)
		assert.throws(() => Policy.rules(Second, [rule]))
		assert.doesNotThrow(() => Policy.rules(First, [rule]))
	})

	it("does not take a rule of another domain", () => {
		const Small = Resource.make("Bot", {
			actions: ["read"],
			fields: { id: Schema.String },
		})
		const Other = Domain.make({ principal: Caller, resources: [Small] })
		const rule = Rule.builder(App).allow("read", Bot, {
			when: ($) => $.eq("ownerUserId", null),
		})
		// The types stop this. The test casts the rule, to check the code too.
		assert.throws(() => Policy.rules(Other, [rule as Rule.Any]))
	})
})
