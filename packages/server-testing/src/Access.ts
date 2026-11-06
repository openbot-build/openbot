import * as TestDatabase from "@openbot-build/server-database/Testing"
import { PgClient } from "@effect/sql-pg"
import * as Migrations from "@openbot-build/server-database/Migrations"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Redacted, String as Str } from "effect"
import { HttpServer } from "effect/http"
import { Host } from "@openbot-build/openbot"
import * as PlatformAdminsPostgres from "@openbot-build/plugin-platform/PlatformAdminsPostgres"
import * as Setup from "@openbot-build/plugin-platform/Setup"

/** Start a real platform with no settings. Keep setup in the same server. */
export const startUnconfiguredPlatform = Effect.fn(
	"TestAccess.startUnconfiguredPlatform",
)(function* ({ publicOrigin }: { readonly publicOrigin: string }) {
	const database = yield* TestDatabase.start
	const options = {
		databaseUrl: Redacted.make(database.url),
		clusterSecret: Redacted.make(
			"test-cluster-secret-with-at-least-32-characters",
		),
		secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
	}
	// The migration has its own pool. It closes after the migration.
	yield* Migrations.migrate.pipe(
		Effect.provide(
			PgClient.layer({ url: options.databaseUrl }).pipe(
				Layer.provide(NodeServices.layer),
			),
		),
	)
	const server = yield* Layer.build(
		Host.layer({ ...options, host: "127.0.0.1", port: 0 }),
	)
	return {
		address: HttpServer.formatAddress(
			Context.get(server, HttpServer.HttpServer).address,
		),
		setup: Setup.run({
			publicOrigin,
			identityProvider: Option.none(),
			adminEmails: ["root@example.com"],
			force: false,
			authSecret: Option.none(),
			fileStorage: Option.none(),
		}).pipe(
			Effect.provide(PlatformAdminsPostgres.layer),
			Effect.provideContext(server),
		),
	}
})
