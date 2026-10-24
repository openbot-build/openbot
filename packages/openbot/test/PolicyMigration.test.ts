import { cp, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Authorization } from "@openbot-build/api"
import { Policy } from "@nmnmcc/ability"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as PostgresTest from "./PostgresTest.ts"

const migrations = fileURLToPath(new URL("../migrations", import.meta.url))
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
			policies: JSON.stringify(rolePolicies),
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
			policies: JSON.stringify(tokenPolicies),
			created_at: 1,
		},
	])
	yield* insert("openbot_settings", [
		{
			scope_kind: "platform",
			scope_id: "platform",
			document: JSON.stringify({ policyCeiling: ceiling }),
			version: 1,
			updated_at: 1,
		},
	])
})

const makeRuntime = (url: string) =>
	ManagedRuntime.make(
		DatabasePostgres.layer({ databaseUrl: Redacted.make(url) }).pipe(
			Layer.provide(NodeServices.layer),
		),
	)

const decodePolicy = (text: string) =>
	Schema.decodeSync(Schema.fromJsonString(Authorization.PolicySchema))(text)

const alice = {
	kind: "member" as const,
	userId: "user_a",
	organizationId: "org_a",
}
const bot = (ownerUserId: string | null, id = "bot_1") =>
	Authorization.Bot.make({ organizationId: "org_a", ownerUserId, id })

describe("Policies become ability policies", () => {
	let database: Awaited<ReturnType<typeof PostgresTest.start>> | undefined
	let before: string | undefined
	let runtime!: ReturnType<typeof makeRuntime>
	const rows: Record<string, string> = {}

	beforeAll(async () => {
		database = await PostgresTest.start()
		const folder = await mkdtemp(join(tmpdir(), "openbot-migrations-"))
		before = folder
		runtime = makeRuntime(database.url)
		for (const name of await readdir(migrations))
			if (name < policyMigration)
				await cp(join(migrations, name), join(folder, name), {
					recursive: true,
				})
		await runtime.runPromise(
			Effect.gen(function* () {
				const db = yield* Db.make
				yield* migrate(db, { migrationsFolder: folder })
				yield* insertOldData
				yield* migrate(db, { migrationsFolder: migrations })
				yield* DatabasePostgres.check
				const sql = yield* PgClient.PgClient
				for (const [name, table] of [
					["role", "openbot_roles"],
					["member", "openbot_members"],
					["token", "openbot_tokens"],
				] as const) {
					const [row] = yield* sql<{
						readonly policy: string
					}>`select policy from ${sql(table)}`
					rows[name] = row!.policy
				}
				const [platform] = yield* sql<{
					readonly document: string
				}>`select document from openbot_settings where scope_kind = 'platform'`
				rows["platform"] = platform!.document
			}),
		)
	}, 120_000)

	afterAll(async () => {
		await runtime?.dispose()
		if (before !== undefined) await rm(before, { recursive: true, force: true })
		await database?.close()
	})

	const decide = (
		policy: Authorization.Policy,
		action: string,
		resource: object,
	) =>
		Policy.decideSync(policy, {
			principal: alice,
			action,
			resource,
		} as never)._tag

	it("a role keeps what each key covered", () => {
		const role = decodePolicy(rows["role"]!)
		const chatOfB = Authorization.Chat.make({
			organizationId: "org_a",
			ownerUserId: "user_b",
			id: "chat_1",
		})
		// `openbot.org.{org}` covers every resource of the organization.
		assert.strictEqual(decide(role, "read", chatOfB), "Allow")
		assert.strictEqual(
			decide(
				role,
				"read",
				Authorization.Member.make({ organizationId: "org_a" }),
			),
			"Allow",
		)
		// `openbot.org.{org}.bot` covers only the shared Bots.
		assert.strictEqual(decide(role, "write", bot(null)), "Allow")
		assert.strictEqual(decide(role, "write", bot("user_a")), "NotApplicable")
		// A dot in an ID was `%2E`, and a deny rule still wins.
		assert.strictEqual(
			decide(role, "delegate", bot(null, "bot.secret")),
			"Deny",
		)
		assert.strictEqual(decide(role, "delegate", bot(null)), "Allow")
		// `{self}` is the user of the principal.
		const trigger = (ownerUserId: string) =>
			Authorization.Trigger.make({
				organizationId: "org_a",
				ownerUserId,
				id: "trg_1",
			})
		assert.strictEqual(decide(role, "write", trigger("user_a")), "Allow")
		assert.strictEqual(
			decide(role, "write", trigger("user_b")),
			"NotApplicable",
		)
		const channel = (id: string) =>
			Authorization.Channel.make({ organizationId: "org_a", id })
		assert.strictEqual(decide(role, "use", channel("ch_1")), "Allow")
		assert.strictEqual(decide(role, "use", channel("ch_2")), "NotApplicable")
		// Tokens lived at the key of the user.
		const token = (ownerUserId: string) =>
			Authorization.Token.make({ organizationId: "org_a", ownerUserId })
		assert.strictEqual(decide(role, "read", token("user_a")), "Allow")
		assert.strictEqual(decide(role, "read", token("user_b")), "NotApplicable")
		assert.strictEqual(decide(role, "read", Authorization.platform), "Allow")
		// A literal organization stays. The loader still keeps every member
		// policy inside the organization of the caller.
		const fileOfB = Authorization.File.make({
			organizationId: "org_b",
			ownerUserId: "user_b",
			id: "file_1",
		})
		assert.strictEqual(decide(role, "read", fileOfB), "Allow")
	})

	it("an empty member policy, a token and the ceiling change too", () => {
		const member = decodePolicy(rows["member"]!)
		assert.strictEqual(member.node._tag, "Rules")
		assert.strictEqual(
			member.node._tag === "Rules" ? member.node.rules.length : -1,
			0,
		)
		const token = decodePolicy(rows["token"]!)
		const chat = (ownerUserId: string) =>
			Authorization.Chat.make({
				organizationId: "org_a",
				ownerUserId,
				id: "chat_1",
			})
		assert.strictEqual(decide(token, "read", chat("user_a")), "Allow")
		assert.strictEqual(decide(token, "read", chat("user_b")), "NotApplicable")
		const document = JSON.parse(rows["platform"]!)
		assert.isFalse("policyCeiling" in document)
		const cap = Schema.decodeSync(Authorization.CeilingSchema)(document.ceiling)
		assert.strictEqual(decide(cap, "delegate", bot("user_a")), "Deny")
		assert.strictEqual(decide(cap, "delegate", bot(null)), "NotApplicable")
	})
})
