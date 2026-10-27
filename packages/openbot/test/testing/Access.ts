import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, Option, Redacted, String as Str } from "effect"
import { HttpServer } from "effect/http"
import * as DatabasePostgres from "../../src/database/DatabasePostgres.ts"
import { Server } from "../../src/index.ts"
import * as Setup from "../../src/platform/Setup.ts"
import * as PostgresTest from "../PostgresTest.ts"

/** Start a real platform with no settings. Keep setup in the same server. */
export const startUnconfiguredPlatform = Effect.fn(
	"TestAccess.startUnconfiguredPlatform",
)(function* ({ publicOrigin }: { readonly publicOrigin: string }) {
	const database = yield* PostgresTest.start
	const options = {
		databaseUrl: Redacted.make(database.url),
		clusterSecret: Redacted.make(
			"test-cluster-secret-with-at-least-32-characters",
		),
		secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
	}
	// The migration has its own pool. It closes after the migration.
	yield* DatabasePostgres.migrate.pipe(
		Effect.provide(
			DatabasePostgres.layer(options).pipe(Layer.provide(NodeServices.layer)),
		),
	)
	const server = yield* Layer.build(
		Server.layerLive({ ...options, host: "127.0.0.1", port: 0 }),
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
		}).pipe(Effect.provideContext(server)),
	}
})
