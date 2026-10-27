import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/api"
import { Policy } from "@nmnmcc/ability"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Record as Rec,
	Redacted,
	Schema,
} from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

const policyMigration = "20261024100433_ability_policies"

const rolePolicies = [
	{
		effect: "allow",
		permissionGroups: [
			"chats.read",
			"bots.read",
			"bots.delegate",
			"members.read",
		],
		resources: ["openbot.org.{org}"],
	},
	{
		effect: "allow",
		permissionGroups: ["bots.write"],
		resources: ["openbot.org.{org}.bot"],
	},
	{
		effect: "allow",
		permissionGroups: ["triggers.write"],
		resources: ["openbot.org.{org}.user.{self}.trigger"],
	},
	{
		effect: "deny",
		permissionGroups: ["bots.delegate"],
		resources: ["openbot.org.{org}.bot.bot%2Esecret"],
	},
	{
		effect: "allow",
		permissionGroups: ["channels.use"],
		resources: ["openbot.org.{org}.channel.ch_1"],
	},
	{
		effect: "allow",
		permissionGroups: ["tokens.read"],
		resources: ["openbot.org.{org}.user.{self}"],
	},
	{
		effect: "allow",
		permissionGroups: ["platform.read"],
		resources: ["openbot.platform"],
	},
	{
		effect: "allow",
		permissionGroups: ["files.read"],
		resources: ["openbot.org.org_b"],
	},
]
const tokenPolicies = [
	{
		effect: "allow",
		permissionGroups: ["chats.read"],
		resources: ["openbot.org.{org}.user.{self}.chat"],
	},
]
const ceiling = [
	{
		effect: "deny",
		permissionGroups: ["bots.delegate"],
		resources: ["openbot.org.{org}.user.{self}.bot"],
	},
]

/** JSON text, as the database keeps it. */
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const insertOldData = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient
	const insert = (table: string, rows: ReadonlyArray<object>) =>
		Effect.forEach(
			rows,
			(row) => sql`insert into ${sql(table)} ${sql.insert(row as never)}`,
		)
	yield* insert("openbot_organizations", [
		{ id: "org_a", name: "Org A", status: "active", created_at: 1 },
	])
	yield* insert("openbot_auth_user", [
		{ id: "user_a", name: "A", email: "a@example.com" },
	])
	yield* insert("openbot_roles", [
		{
			organization_id: "org_a",
			id: "role_1",
			name: "Helper",
			description: "Many kinds of keys.",
			policies: yield* encodeJson(rolePolicies),
			created_at: 1,
			updated_at: 1,
		},
	])
	yield* insert("openbot_members", [
		{
			organization_id: "org_a",
			user_id: "user_a",
			email: "a@example.com",
			name: "A",
			status: "active",
			roles: '["role_1"]',
			policies: "[]",
			joined_at: 1,
		},
	])
	yield* insert("openbot_tokens", [
		{
			id: "tok_1",
			organization_id: "org_a",
			user_id: "user_a",
			name: "Token",
			prefix: "ob_1",
			hash: "hash_1",
			policies: yield* encodeJson(tokenPolicies),
			created_at: 1,
		},
	])
	yield* insert("openbot_settings", [
		{
			scope_kind: "platform",
			scope_id: "platform",
			document: yield* encodeJson({ policyCeiling: ceiling }),
			version: 1,
			updated_at: 1,
		},
	])
})

/** The stored policies after the migration. All tests read the same rows. */
class Migrated extends Context.Service<
	Migrated,
	{
		readonly role: string
		readonly member: string
		readonly token: string
		readonly platform: string
	}
>()("@openbot-build/openbot/test/PolicyMigration.test/Migrated") {}

/** Runs the migrations before the policy migration, adds old rows, then runs the rest. */
const migrated = Layer.effect(
	Migrated,
	Effect.gen(function* () {
		const before = yield* MigrationTest.migrationsWhere(
			(name) => name < policyMigration,
		)
		const db = yield* Db.make
		yield* migrate(db, { migrationsFolder: before })
		yield* insertOldData
		yield* migrate(db, { migrationsFolder: yield* MigrationTest.folder })
		yield* DatabasePostgres.check
		const sql = yield* PgClient.PgClient
		const policyOf = (table: string) =>
			Effect.flatMap(
				sql<{ readonly policy: string }>`select policy from ${sql(table)}`,
				(rows) => Effect.fromOption(Arr.head(rows)),
			)
		const platform = yield* Effect.flatMap(
			sql<{
				readonly document: string
			}>`select document from openbot_settings where scope_kind = 'platform'`,
			(rows) => Effect.fromOption(Arr.head(rows)),
		)
		return {
			role: (yield* policyOf("openbot_roles")).policy,
			member: (yield* policyOf("openbot_members")).policy,
			token: (yield* policyOf("openbot_tokens")).policy,
			platform: platform.document,
		}
	}),
).pipe(
	Layer.provide(
		Layer.unwrap(
			Effect.map(PostgresTest.start, (database) =>
				DatabasePostgres.layer({ databaseUrl: Redacted.make(database.url) }),
			),
		),
	),
	Layer.provide(NodeServices.layer),
)

const decodePolicy = Schema.decodeEffect(
	Schema.fromJsonString(Authorization.PolicySchema),
)
const decodeDocument = Schema.decodeEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
)
const decodeCeiling = Schema.decodeUnknownEffect(Authorization.CeilingSchema)

const alice = {
	kind: "member" as const,
	userId: "user_a",
	organizationId: "org_a",
}
const bot = (ownerUserId: string | null, id = "bot_1") =>
	Authorization.Bot.make({ organizationId: "org_a", ownerUserId, id })

layer(migrated, { excludeTestServices: true, timeout: "120 seconds" })(
	"Policies become ability policies",
	(it) => {
		const decide = (
			policy: Authorization.Policy,
			target: Policy.Target<Authorization.OpenBot>,
		) => Policy.decideSync(policy, { ...target, principal: alice })._tag

		it.effect("a role keeps what each key covered", () =>
			Effect.gen(function* () {
				const role = yield* decodePolicy((yield* Migrated).role)
				const chatOfB = Authorization.Chat.make({
					organizationId: "org_a",
					ownerUserId: "user_b",
					id: "chat_1",
				})
				// `openbot.org.{org}` covers every resource of the organization.
				assert.strictEqual(
					decide(role, { action: "read", resource: chatOfB }),
					"Allow",
				)
				assert.strictEqual(
					decide(role, {
						action: "read",
						resource: Authorization.Member.make({ organizationId: "org_a" }),
					}),
					"Allow",
				)
				// `openbot.org.{org}.bot` covers only the shared Bots.
				assert.strictEqual(
					decide(role, { action: "write", resource: bot(null) }),
					"Allow",
				)
				assert.strictEqual(
					decide(role, { action: "write", resource: bot("user_a") }),
					"NotApplicable",
				)
				// A dot in an ID was `%2E`, and a deny rule still wins.
				assert.strictEqual(
					decide(role, {
						action: "delegate",
						resource: bot(null, "bot.secret"),
					}),
					"Deny",
				)
				assert.strictEqual(
					decide(role, { action: "delegate", resource: bot(null) }),
					"Allow",
				)
				// `{self}` is the user of the principal.
				const trigger = (ownerUserId: string) =>
					Authorization.Trigger.make({
						organizationId: "org_a",
						ownerUserId,
						id: "trg_1",
					})
				assert.strictEqual(
					decide(role, { action: "write", resource: trigger("user_a") }),
					"Allow",
				)
				assert.strictEqual(
					decide(role, { action: "write", resource: trigger("user_b") }),
					"NotApplicable",
				)
				const channel = (id: string) =>
					Authorization.Channel.make({ organizationId: "org_a", id })
				assert.strictEqual(
					decide(role, { action: "use", resource: channel("ch_1") }),
					"Allow",
				)
				assert.strictEqual(
					decide(role, { action: "use", resource: channel("ch_2") }),
					"NotApplicable",
				)
				// Tokens lived at the key of the user.
				const token = (ownerUserId: string) =>
					Authorization.Token.make({ organizationId: "org_a", ownerUserId })
				assert.strictEqual(
					decide(role, { action: "read", resource: token("user_a") }),
					"Allow",
				)
				assert.strictEqual(
					decide(role, { action: "read", resource: token("user_b") }),
					"NotApplicable",
				)
				assert.strictEqual(
					decide(role, { action: "read", resource: Authorization.platform }),
					"Allow",
				)
				// A literal organization stays. The loader still keeps every member
				// policy inside the organization of the caller.
				const fileOfB = Authorization.File.make({
					organizationId: "org_b",
					ownerUserId: "user_b",
					id: "file_1",
				})
				assert.strictEqual(
					decide(role, { action: "read", resource: fileOfB }),
					"Allow",
				)
			}),
		)

		it.effect(
			"an empty member policy, a token and the ceiling change too",
			() =>
				Effect.gen(function* () {
					const rows = yield* Migrated
					const member = yield* decodePolicy(rows.member)
					assert.strictEqual(member.node._tag, "Rules")
					assert.strictEqual(
						member.node._tag === "Rules" ? member.node.rules.length : -1,
						0,
					)
					const token = yield* decodePolicy(rows.token)
					const chat = (ownerUserId: string) =>
						Authorization.Chat.make({
							organizationId: "org_a",
							ownerUserId,
							id: "chat_1",
						})
					assert.strictEqual(
						decide(token, { action: "read", resource: chat("user_a") }),
						"Allow",
					)
					assert.strictEqual(
						decide(token, { action: "read", resource: chat("user_b") }),
						"NotApplicable",
					)
					const document = yield* decodeDocument(rows.platform)
					assert.isFalse(Rec.has(document, "policyCeiling"))
					const cap = yield* decodeCeiling(document["ceiling"])
					assert.strictEqual(
						decide(cap, { action: "delegate", resource: bot("user_a") }),
						"Deny",
					)
					assert.strictEqual(
						decide(cap, { action: "delegate", resource: bot(null) }),
						"NotApplicable",
					)
				}),
		)
	},
)
