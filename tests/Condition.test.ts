import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, pipe, Schema } from "effect"
import { Condition, type Resource } from "../src/index.ts"
import { alice, aliceBot, Bot, Caller, sharedBot } from "./fixtures.ts"

const $ = Condition.builder<Resource.Data<typeof Bot>, Bot, Caller>()

const path = [
	"org",
	{ _tag: "Field", field: "organizationId" },
	"user",
	{ _tag: "Field", field: "ownerUserId" },
	"bot",
	{ _tag: "Field", field: "id" },
] as const

const test = (
	condition: Condition.Test<Bot, Caller>,
	value: object = aliceBot,
) => Condition.evaluateSync(condition, { value, principal: alice, path })

const toSql = Condition.fold<string>({
	true: () => "TRUE",
	false: () => "FALSE",
	compare: (op, field, value) =>
		value === null
			? `${field} ${op === "eq" ? "IS" : "IS NOT"} NULL`
			: `${field} ${{ eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" }[op]} ${JSON.stringify(value)}`,
	in: (field, values) =>
		`${field} IN (${values.map((value) => JSON.stringify(value)).join(", ")})`,
	exists: (field) => `${field} IS NOT NULL`,
	and: (parts) => `(${parts.join(" AND ")})`,
	or: (parts) => `(${parts.join(" OR ")})`,
	not: (part) => `NOT ${part}`,
})

describe("Condition", () => {
	it("compares fields with values and with principal fields", () => {
		assert.isTrue(test($.eq("ownerUserId", "alice")))
		assert.isTrue(test($.eq("ownerUserId", $.principal("userId"))))
		assert.isFalse(test($.eq("ownerUserId", $.principal("userId")), sharedBot))
		assert.isTrue(test($.eq("ownerUserId", null), sharedBot))
		assert.isTrue(test($.ne("name", "Team")))
		assert.isTrue(test($.eq("settings.model", "small")))
	})

	it("compares only numbers with numbers and strings with strings", () => {
		assert.isTrue(test($.gt("level", 1)))
		assert.isTrue(test($.lte("level", 2)))
		assert.isFalse(test($.lt("level", 2)))
		assert.isTrue(test($.gte("name", "H")))
	})

	it("tests lists, missing values and logic", () => {
		assert.isTrue(test($.in("name", ["Helper", "Team"])))
		assert.isFalse(test($.in("name", [])))
		assert.isTrue(test($.exists("ownerUserId")))
		assert.isFalse(test($.exists("ownerUserId"), sharedBot))
		assert.isTrue(test($.and($.gt("level", 1), $.not($.eq("name", "Team")))))
		assert.isTrue(test($.or($.eq("name", "Team"), $.eq("name", "Helper"))))
		assert.isTrue(test($.and()))
		assert.isFalse(test($.or()))
	})

	it("tests the path of a resource", () => {
		assert.isTrue(test($.under("org", "acme")))
		assert.isTrue(
			test(
				$.under(
					"org",
					$.principal("organizationId"),
					"user",
					$.principal("userId"),
				),
			),
		)
		assert.isFalse(
			test($.under("org", "acme", "user", $.principal("userId")), sharedBot),
		)
		assert.isTrue(test($.under("org", "acme", "user", null), sharedBot))
		assert.isFalse(
			Condition.evaluateSync($.under("org"), {
				value: aliceBot,
				principal: alice,
			}),
		)
	})

	it("puts the principal in and expands the path", () => {
		const condition = $.and(
			$.under(
				"org",
				$.principal("organizationId"),
				"user",
				$.principal("userId"),
			),
			$.gt("level", 0),
		)
		const residual = Condition.partial(condition, { principal: alice, path })
		assert.deepStrictEqual(
			Effect.runSync(toSql(residual)),
			`(organizationId = "acme" AND ownerUserId = "alice" AND level > 0)`,
		)
		assert.deepStrictEqual(
			Condition.partial($.under("team"), { principal: alice, path }),
			Condition.never,
		)
		assert.deepStrictEqual(
			Condition.partial($.under("org"), { principal: alice, path }),
			Condition.always,
		)
	})

	it("makes conditions smaller", () => {
		assert.deepStrictEqual(
			Condition.simplify(
				$.and(Condition.always, $.and($.eq("name", "a"), $.eq("name", "a"))),
			),
			$.eq("name", "a"),
		)
		assert.deepStrictEqual(
			Condition.simplify($.or(Condition.always, $.eq("name", "a"))),
			Condition.always,
		)
		assert.deepStrictEqual(
			Condition.simplify($.not($.not($.exists("name")))),
			$.exists("name"),
		)
		assert.deepStrictEqual(
			Condition.simplify($.not($.eq("name", "a"))),
			$.ne("name", "a"),
		)
	})

	it("fails to fold a condition that still has principal fields or paths", () => {
		const exit = Effect.runSyncExit(
			toSql($.eq("ownerUserId", $.principal("userId"))),
		)
		assert.isTrue(Exit.isFailure(exit))
		assert.isTrue(Exit.isFailure(Effect.runSyncExit(toSql($.under("org")))))
	})

	it.effect("runs predicates as Effects", () =>
		Effect.gen(function* () {
			const condition = $.and(
				$.eq("ownerUserId", "alice"),
				$.predicate("long name", (bot) => Effect.succeed(bot.name.length > 3)),
			)
			assert.isTrue(
				yield* Condition.evaluate(condition, {
					value: aliceBot,
					principal: alice,
					path,
				}),
			)
			const failing = $.predicate("broken", () =>
				Effect.fail("no data" as const),
			)
			const exit = yield* Effect.exit(
				Condition.evaluate(failing, { value: aliceBot, principal: alice }),
			)
			assert.isTrue(Exit.isFailure(exit))
		}),
	)

	it.effect("works in a pipe", () =>
		Effect.gen(function* () {
			const condition = $.and(
				$.under("org", $.principal("organizationId")),
				$.eq("ownerUserId", $.principal("userId")),
			)
			const input = { value: aliceBot, principal: alice, path }
			assert.isTrue(pipe(condition, Condition.evaluateSync(input)))
			assert.isTrue(yield* pipe(condition, Condition.evaluate(input)))
			assert.deepStrictEqual(
				pipe(condition, Condition.partial({ principal: alice, path })),
				Condition.partial(condition, { principal: alice, path }),
			)
		}),
	)

	it("keeps a condition as JSON", () => {
		const condition = $.and(
			$.under("org", $.principal("organizationId")),
			$.or($.in("name", ["a", "b"]), $.not($.exists("ownerUserId"))),
			$.gte("level", 3),
		)
		const json = JSON.parse(JSON.stringify(condition))
		const decoded = Schema.decodeUnknownSync(Condition.schema)(json)
		assert.deepStrictEqual(decoded, condition)
		assert.deepStrictEqual(Condition.fields(condition), [
			"name",
			"ownerUserId",
			"level",
		])
	})

	describe("keeps the work of predicates when it makes a condition smaller", () => {
		const failing = $.predicate("offline", () => Effect.fail("offline"))
		const run = (
			condition: Condition.Condition<
				string,
				never,
				Condition.Opaque,
				Condition.Reads<Bot, Caller>
			>,
		) =>
			Effect.exit(
				Condition.evaluate(condition, { value: aliceBot, principal: alice }),
			)

		it.effect("keeps the tests that guard a predicate", () =>
			Effect.gen(function* () {
				const condition = $.or($.eq("id", "b1"), failing, Condition.always)
				assert.deepStrictEqual(yield* run(condition), Exit.succeed(true))
				assert.deepStrictEqual(
					yield* run(Condition.simplify(condition)),
					Exit.succeed(true),
				)
			}),
		)

		it.effect("does not absorb a test past a predicate", () =>
			Effect.gen(function* () {
				const a = $.eq("id", "b1")
				const condition = $.or($.and(a, $.eq("name", "Helper")), failing, a)
				assert.deepStrictEqual(
					yield* run(Condition.simplify(condition)),
					Exit.succeed(true),
				)
			}),
		)

		it.effect("runs a predicate each time it is in the condition", () =>
			Effect.gen(function* () {
				let calls = 0
				const once = $.predicate("once", () => {
					calls = calls + 1
					return calls === 1
				})
				const condition = Condition.simplify($.and(once, once))
				assert.deepStrictEqual(
					yield* Effect.exit(
						Condition.evaluate(condition, {
							value: aliceBot,
							principal: alice,
						}),
					),
					Exit.succeed(false),
				)
			}),
		)
	})

	it("does not put a principal value that is not a scalar in a condition", () => {
		const principal = { ...alice, userId: 1n } as unknown as Caller
		const condition = $.eq("ownerUserId", $.principal("userId"))
		assert.deepStrictEqual(
			Condition.partial(condition, { principal, path }),
			Condition.never,
		)
	})

	describe("satisfiable", () => {
		const Shape = Schema.Struct({
			count: Schema.Int,
			ratio: Schema.Finite,
			// The test needs NaN and the infinities in this field.
			// @effect-diagnostics-next-line schemaNumber:off
			size: Schema.Number,
			name: Schema.String,
			state: Schema.Literals(["open", "closed"]),
			flag: Schema.Boolean,
			note: Schema.optionalKey(Schema.String),
			box: Schema.NullOr(Schema.Struct({ label: Schema.String })),
			when: Schema.Date,
			nothing: Schema.Never,
		})
		type Data = typeof Shape.Type
		const _ = Condition.builder<Data, Data, never>()
		// The types of a builder do not let a test name a struct field, or
		// compare a date with a string. These tests need both.
		const loose = Condition.builder<
			Record<string, Condition.Scalar>,
			object,
			never
		>()
		type Plain = Condition.Condition<never, never, never, any>
		const tagOf = (condition: Plain) =>
			Condition.satisfiable(condition, { schema: Shape })._tag

		/** Tests that the example makes the condition true. */
		const example = (condition: Plain) => {
			const answer = Condition.satisfiable(condition, { schema: Shape })
			assert.strictEqual(answer._tag, "Satisfiable")
			const value = answer._tag === "Satisfiable" ? answer.example : {}
			assert.isTrue(Condition.evaluateSync(condition, { value }))
			return value
		}

		it("knows that there is no integer between two integers", () => {
			assert.strictEqual(
				tagOf(
					_.not(_.or(_.lte("count", 0), _.eq("count", 1), _.gte("count", 2))),
				),
				"Unsatisfiable",
			)
			assert.deepStrictEqual(
				example(_.and(_.gt("count", 1), _.lt("count", 3))),
				{ count: 2 },
			)
		})

		it("finds the number next to a number", () => {
			assert.strictEqual(
				tagOf(_.and(_.gt("ratio", 1), _.lt("ratio", 1.0000000000000002))),
				"Unsatisfiable",
			)
			example(_.and(_.gt("ratio", 1), _.lt("ratio", 1.0000000000000004)))
			example(_.gt("ratio", Number.MAX_VALUE / 2))
		})

		it("keeps NaN and the infinities only where the Schema has them", () => {
			const neither = (field: "ratio" | "size") =>
				_.and(_.not(_.lt(field, 0)), _.not(_.gte(field, 0)))
			assert.strictEqual(tagOf(neither("ratio")), "Unsatisfiable")
			assert.isTrue(Number.isNaN(example(neither("size"))["size"]))
			assert.strictEqual(
				tagOf(_.gt("ratio", Number.MAX_VALUE)),
				"Unsatisfiable",
			)
			assert.deepStrictEqual(example(_.gt("size", Number.MAX_VALUE)), {
				size: Infinity,
			})
		})

		it("treats 0 and -0 as one value", () => {
			assert.strictEqual(
				tagOf(_.and(_.eq("size", 0), _.ne("size", -0))),
				"Unsatisfiable",
			)
		})

		it("finds the string next to a string", () => {
			assert.strictEqual(
				tagOf(_.and(_.gt("name", "a"), _.lt("name", "a\0"))),
				"Unsatisfiable",
			)
			assert.deepStrictEqual(
				example(_.and(_.gt("name", "a"), _.lt("name", "a\0\0"))),
				{ name: "a\0" },
			)
			assert.strictEqual(tagOf(_.lt("name", "")), "Unsatisfiable")
		})

		it("uses only the literals of a field", () => {
			assert.strictEqual(
				tagOf(_.and(_.ne("state", "open"), _.ne("state", "closed"))),
				"Unsatisfiable",
			)
			assert.strictEqual(
				tagOf(_.and(_.ne("flag", true), _.ne("flag", false))),
				"Unsatisfiable",
			)
		})

		it("lets an optional field be missing", () => {
			assert.deepStrictEqual(example(_.not(_.exists("note"))), {
				note: null,
			})
			assert.strictEqual(tagOf(_.not(_.exists("name"))), "Unsatisfiable")
		})

		it("makes the fields below a missing struct missing", () => {
			assert.strictEqual(
				tagOf(_.and(_.exists("box.label"), _.not(loose.exists("box")))),
				"Unsatisfiable",
			)
			assert.deepStrictEqual(
				example(_.and(_.eq("box.label", "x"), loose.exists("box"))),
				{ box: { label: "x" } },
			)
		})

		it("knows that a value with parts is equal to no scalar", () => {
			assert.strictEqual(
				tagOf(_.and(_.exists("when"), _.not(loose.ne("when", "x")))),
				"Unsatisfiable",
			)
		})

		it("has no value for a field of the type never", () => {
			assert.strictEqual(tagOf(_.exists("nothing")), "Unsatisfiable")
			assert.strictEqual(tagOf(_.not(_.exists("nothing"))), "Unsatisfiable")
		})

		it("lets a field have any value with no Schema", () => {
			const answer = Condition.satisfiable(
				_.and(_.not(_.lt("count", 0)), _.not(_.gte("count", 0))),
			)
			assert.strictEqual(answer._tag, "Satisfiable")
		})

		it("can not say with a predicate", () => {
			assert.deepStrictEqual(
				Condition.satisfiable($.predicate("shared", (bot) => bot.shared)),
				{ _tag: "Unknown", reason: "predicate" } as never,
			)
		})

		it("stops at its budget", () => {
			// Ten boolean fields with a test that is never true. The search
			// visits more than five nodes before it knows.
			const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]
			const free = Condition.builder<Record<string, boolean>, object, never>()
			const condition = Condition.and(
				Condition.or(...names.map((name) => free.eq(name, true))),
				...names.map((name) => free.ne(name, true)),
			)
			const Flags = Schema.Struct(
				Object.fromEntries(names.map((name) => [name, Schema.Boolean])),
			)
			assert.strictEqual(
				Condition.satisfiable(condition, { schema: Flags })._tag,
				"Unsatisfiable",
			)
			assert.strictEqual(
				Condition.satisfiable(condition, { schema: Flags, budget: 5 })._tag,
				"Unknown",
			)
		})

		it("needs a condition with the principal in it", () => {
			assert.throws(() =>
				Condition.satisfiable($.eq("ownerUserId", $.principal("userId"))),
			)
			assert.throws(() => Condition.satisfiable($.under("org", "acme")))
		})
	})
})
