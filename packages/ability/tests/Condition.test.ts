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

const test = (condition: Condition.Condition, value: object = aliceBot) =>
	Condition.evaluateSync(condition, { value, principal: alice, path })

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

	it("puts known field values into a condition", () => {
		const condition = $.and(
			$.eq("ownerUserId", "alice"),
			$.or($.gte("level", 2), $.eq("organizationId", "acme")),
		)
		assert.deepStrictEqual(
			Condition.assign(condition, {
				ownerUserId: "alice",
				organizationId: "acme",
			}),
			Condition.always,
		)
		assert.deepStrictEqual(
			Condition.assign(condition, { ownerUserId: "bob" }),
			Condition.never,
		)
		assert.deepStrictEqual(
			Condition.assign(condition, { ownerUserId: "alice" }),
			Condition.simplify(
				$.or($.gte("level", 2), $.eq("organizationId", "acme")),
			),
		)
		assert.deepStrictEqual(
			Condition.assign($.eq("ownerUserId", null), { ownerUserId: null }),
			Condition.always,
		)
		const withPrincipal = $.eq("ownerUserId", $.principal("userId"))
		assert.deepStrictEqual(
			Condition.assign(withPrincipal, { ownerUserId: "alice" }),
			withPrincipal,
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
				Condition.evaluate(failing, { value: aliceBot }),
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
})
