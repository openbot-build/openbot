/**
 * Roles, user tokens and a platform limit, in the way OpenBot uses them.
 *
 * - A member may act on their own Bots and read every Bot of the
 *   organization.
 * - A user token may never do more than its member, so the two policies go
 *   together with `Policy.all`.
 * - The platform has deny rules for everyone. `Policy.ceiling` puts them on
 *   top. Their allow rules would do nothing.
 *
 * A resource path takes the place of a resource key such as
 * `openbot.org.<org>.user.<user>.bot.<id>`. `$.under(...)` is the same as a
 * policy for a key and every key below it.
 *
 * A scope (`within`) is a part of a kind, such as the Bots of one
 * organization. It answers three questions:
 * - May the user act on every value in the scope? This is the check for a new
 *   Bot, which has no id yet.
 * - Which values in the scope may the user act on? This is the list query.
 * - May the user act on some value in the scope? This is the test to show a
 *   button.
 */
import { Effect, Schema } from "effect"
import { Condition, Domain, Policy, Principal, Resource } from "../src/index.ts"

class Caller extends Principal.Class<Caller>("Caller")({
	userId: Schema.String,
	organizationId: Schema.String,
}) {}

class Bot extends Resource.Class<Bot>()("Bot", {
	actions: ["read", "update", "delete"],
	fields: {
		id: Schema.String,
		organizationId: Schema.String,
		ownerUserId: Schema.NullOr(Schema.String),
	},
	path: (f) => ["org", f.organizationId, "user", f.ownerUserId, "bot", f.id],
}) {}

const OpenBot = Domain.make({ principal: Caller, resources: [Bot] })

const member = Policy.define(OpenBot)(function* (_) {
	yield* _.allow(["read", "update", "delete"], "*", {
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
})

const token = Policy.define(OpenBot)(function* (_) {
	yield* _.allow("read", "*")
})

const platform = Policy.define(OpenBot)(function* (_) {
	yield* _.deny("delete", "*", {
		when: ($) => $.under("org", "frozen"),
		reason: "The platform stopped all changes to this organization",
	})
})

const forSession = member.pipe(Policy.ceiling(platform))
const forToken = Policy.all([member, token]).pipe(Policy.ceiling(platform))

const alice = Caller.make({ userId: "alice", organizationId: "acme" })
const own = Bot.make({ id: "b1", organizationId: "acme", ownerUserId: "alice" })

// The residual condition is the list filter. Change it into SQL with fold.
// The values go into the query as bound parameters, not into the SQL text. A
// value from a principal may have a quote in it, and in the SQL text it could
// change the query.
//
// In this library a test is true or false. In SQL a test with NULL is
// unknown, and NOT unknown is unknown too. So each test is made true or false
// with COALESCE, and `ne` and `in` say what to do with NULL.
interface Query {
	readonly sql: string
	readonly params: ReadonlyArray<Condition.Scalar>
}

const operators = {
	eq: "=",
	ne: "<>",
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">=",
} as const

const join = (parts: ReadonlyArray<Query>, glue: string): Query => ({
	sql: `(${parts.map((part) => part.sql).join(glue)})`,
	params: parts.flatMap((part) => part.params),
})

const toSql = Condition.fold<Query>({
	true: () => ({ sql: "TRUE", params: [] }),
	false: () => ({ sql: "FALSE", params: [] }),
	compare: (op, field, value) =>
		value === null
			? // Only `eq` and `ne` are true for a null value.
				op === "eq" || op === "ne"
				? { sql: `${field} IS ${op === "eq" ? "" : "NOT "}NULL`, params: [] }
				: { sql: "FALSE", params: [] }
			: op === "ne"
				? { sql: `(${field} IS NULL OR ${field} <> ?)`, params: [value] }
				: {
						sql: `COALESCE(${field} ${operators[op]} ?, FALSE)`,
						params: [value],
					},
	in: (field, values) => {
		const known = values.filter((value) => value !== null)
		const parts: ReadonlyArray<Query> = [
			...(known.length > 0
				? [
						{
							sql: `COALESCE(${field} IN (${known.map(() => "?").join(", ")}), FALSE)`,
							params: known,
						},
					]
				: []),
			...(known.length < values.length
				? [{ sql: `${field} IS NULL`, params: [] }]
				: []),
		]
		return parts.length === 0
			? { sql: "FALSE", params: [] }
			: join(parts, " OR ")
	},
	exists: (field) => ({ sql: `${field} IS NOT NULL`, params: [] }),
	and: (parts) => join(parts, " AND "),
	or: (parts) => join(parts, " OR "),
	not: (part) => ({ sql: `NOT ${part.sql}`, params: part.params }),
})

const program = Effect.gen(function* () {
	const decide = (
		policy: Policy.Policy<typeof OpenBot>,
		action: "read" | "update",
	) =>
		Policy.decideSync(policy, { principal: alice, action, resource: own })._tag

	return {
		sessionUpdate: decide(forSession, "update"),
		tokenRead: decide(forToken, "read"),
		tokenUpdate: decide(forToken, "update"),
		readableBots: yield* toSql(
			Policy.residual(forSession, {
				principal: alice,
				action: "read",
				kind: "Bot",
			}),
		),
		changeableBots: yield* toSql(
			Policy.residual(forSession, {
				principal: alice,
				action: "update",
				kind: "Bot",
			}),
		),
		// The list of one organization: the scope and the policy together.
		readableInAcme: yield* toSql(
			Policy.residual(forSession, {
				principal: alice,
				action: "read",
				kind: "Bot",
				within: ($) => $.under("org", "acme"),
			}),
		),
		// Every new Bot of Alice may be made: "All".
		createOwn: Policy.coverage(forSession, {
			principal: alice,
			action: "update",
			kind: "Bot",
			within: ($) => $.under("org", "acme", "user", "alice"),
		})._tag,
		// Alice may delete some Bots of the organization, so the page shows a
		// delete button: "Some".
		deleteInAcme: Policy.coverage(forSession, {
			principal: alice,
			action: "delete",
			kind: "Bot",
			within: ($) => $.under("org", "acme"),
		})._tag,
	}
})

console.log(Effect.runSync(program))
