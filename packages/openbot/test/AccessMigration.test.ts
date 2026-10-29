import { assert, it } from "@effect/vitest"
import { PgClient } from "@effect/sql-pg"
import { NodeServices } from "@effect/platform-node"
import { Array as Arr, Effect, Layer, Redacted } from "effect"
import { migrate } from "drizzle-orm/effect-postgres/migrator"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Db from "../src/database/Database.ts"
import * as Access from "@openbot-build/domain/Access"
import * as MigrationTest from "./MigrationTest.ts"
import * as PostgresTest from "./PostgresTest.ts"

const database = Layer.unwrap(
	Effect.map(PostgresTest.start, (db) =>
		DatabasePostgres.layer({ databaseUrl: Redacted.make(db.url) }),
	),
).pipe(Layer.provideMerge(NodeServices.layer))
it.layer(database, { excludeTestServices: true })((it) => {
	it.effect(
		"an old database keeps users and manual roles, closes new account sources, and can migrate twice",
		() =>
			Effect.gen(function* () {
				const before = yield* MigrationTest.migrationsWhere(
					(name) => name < "20261029103213_account_access",
				)
				const db = yield* Db.make
				const sql = yield* PgClient.PgClient
				yield* migrate(db, { migrationsFolder: before })
				yield* sql`insert into openbot_auth_user (id,name,email,email_verified,created_at,updated_at) values ('old-user','Old user','old@example.com',true,now(),now())`
				yield* sql`insert into openbot_auth_account (id,user_id,provider_id,account_id,created_at,updated_at) values ('old-identity','old-user','oidc','old-subject',now(),now())`
				yield* sql`insert into openbot_platform_admins (email,user_id,added_at) values ('old@example.com','old-user',0)`
				yield* sql`insert into openbot_organizations (id,name,status,created_at) values ('old-org','Old organization','active',0)`
				yield* sql`insert into openbot_members (organization_id,user_id,roles,policy,status,joined_at) values ('old-org','old-user','["member"]','{}','active',0)`
				yield* sql`insert into openbot_settings (scope_kind,scope_id,document,version,updated_at) values ('platform','', '{"organizationCreation":"anyone","identityProvider":{"issuer":"https://id.example.com"}}',1,0)`
				const folder = yield* MigrationTest.folder
				yield* migrate(db, { migrationsFolder: folder })
				yield* migrate(db, { migrationsFolder: folder })
				const states =
					yield* sql`select status from openbot_account_states where user_id='old-user'`
				assert.deepStrictEqual(states, [{ status: "active" }])
				const roles =
					yield* sql`select roles,status from openbot_members where user_id='old-user'`
				assert.deepStrictEqual(roles, [
					{ roles: '["member"]', status: "active" },
				])
				assert.deepStrictEqual(
					yield* sql`select * from openbot_mapped_roles`,
					[],
				)
				const settings = yield* sql<{
					registration: typeof Access.defaults
					creation: string
					issuer: string
				}>`select document::jsonb->'registration' as registration,document::jsonb->>'organizationCreation' as creation,document::jsonb->'identityProvider'->>'issuer' as issuer from openbot_settings where scope_kind='platform'`
				assert.deepStrictEqual(settings[0]?.registration, Access.defaults)
				assert.strictEqual(settings[0]?.creation, "platform_admins")
				assert.strictEqual(settings[0]?.issuer, "https://id.example.com")
				const admins = yield* sql<{
					provider: string
				}>`select provider_id as provider from openbot_platform_admins`
				assert.deepStrictEqual(
					Arr.map(admins, (a) => a.provider),
					["oidc"],
				)
			}),
	)
})
