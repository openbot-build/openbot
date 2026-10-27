import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Settings as SettingsApi } from "@openbot-build/api"
import {
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	String as Str,
} from "effect"
import { DomainControl } from "../src/apps/DomainControl.ts"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import { Settings } from "../src/settings/Settings.ts"
import { Sso } from "../src/sso/Sso.ts"
import * as SsoPostgres from "../src/sso/SsoPostgres.ts"
import * as PostgresTest from "./PostgresTest.ts"

const organizationId = "org_sso_notice"
const domain = "example.com"

/** No instance can learn that a setting changed. */
const noNotice = Layer.mock(Settings, {
	notify: () => Effect.fail(SettingsApi.SettingsUnavailable.make({})),
})

// The database is real, so the test uses real time.
it.live(
	"an SSO change stays saved and keeps its secret when the change notice fails",
	() =>
		Effect.gen(function* () {
			const database = yield* PostgresTest.start
			const databaseLayer = DatabasePostgres.layer({
				databaseUrl: Redacted.make(database.url),
			})
			yield* DatabasePostgres.migrate.pipe(Effect.provide(databaseLayer))
			const records = yield* Ref.make<ReadonlyArray<string>>([])
			const services = yield* Layer.build(
				SsoPostgres.layer.pipe(
					Layer.provide(noNotice),
					Layer.provide(
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
					Layer.provide(
						Layer.succeed(DomainControl, { tokens: () => Ref.get(records) }),
					),
					Layer.provideMerge(databaseLayer),
				),
			)
			const sso = Context.get(services, Sso)
			const sql = Context.get(services, PgClient.PgClient)
			yield* sql`INSERT INTO openbot_organizations (id, name, status, created_at) VALUES (${organizationId}, 'Notice', 'active', 0)`

			const added = yield* sso.addDomain(organizationId, domain)
			yield* Ref.set(records, [added.recordValue])
			const verified = yield* sso.verifyDomain(organizationId, domain)
			assert.ok(verified.verifiedAt !== null)

			const created = yield* sso.createConnection(organizationId, {
				name: "Company",
				issuer: "https://sso.example.com",
				clientId: "openbot",
				clientSecret: Redacted.make("sso-secret-0123456789"),
				domains: [domain],
				enforce: false,
			})
			assert.strictEqual(created.clientSecretHint, "…6789")
			assert.deepStrictEqual(
				Option.map(yield* sso.openSecret(created), Redacted.value),
				Option.some("sso-secret-0123456789"),
			)

			const updated = yield* sso.updateConnection(organizationId, created.id, {
				expectedVersion: created.version,
				clientSecret: Redacted.make("sso-secret-9876543210"),
			})
			assert.strictEqual(updated.version, created.version + 1)
			assert.strictEqual(updated.clientSecretHint, "…3210")
			assert.deepStrictEqual(
				Option.map(yield* sso.openSecret(updated), Redacted.value),
				Option.some("sso-secret-9876543210"),
			)

			yield* sso.deleteConnection(organizationId, created.id)
			yield* sso.removeDomain(organizationId, domain)
			assert.deepStrictEqual(yield* sso.listConnections(organizationId), [])
			assert.deepStrictEqual(yield* sso.listDomains(organizationId), [])
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	{ timeout: 60000 },
)
