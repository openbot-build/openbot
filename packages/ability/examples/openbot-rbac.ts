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
const toSql = Condition.fold<string>({
	true: () => "TRUE",
	false: () => "FALSE",
	compare: (op, field, value) =>
		value === null
			? `${field} IS ${op === "eq" ? "" : "NOT "}NULL`
			: `${field} ${op === "eq" ? "=" : "<>"} '${String(value)}'`,
	in: (field, values) =>
		`${field} IN (${values.map((v) => `'${String(v)}'`).join(", ")})`,
	exists: (field) => `${field} IS NOT NULL`,
	and: (parts) => `(${parts.join(" AND ")})`,
	or: (parts) => `(${parts.join(" OR ")})`,
	not: (part) => `NOT ${part}`,
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
	}
})

console.log(Effect.runSync(program))
