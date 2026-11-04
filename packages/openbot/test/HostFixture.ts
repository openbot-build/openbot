import { NodeCrypto, NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Effect, Layer, Redacted, String as Str } from "effect"
import { HttpRouter } from "effect/http"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer.layer needs a function that makes a Node HTTP server.
import { createServer } from "node:http"
import * as DatabasePostgres from "../src/app/DatabasePostgres.ts"
import * as Host from "../src/app/Host.ts"
import * as OpenBot from "../src/app/OpenBot.ts"
import * as HostTools from "../src/tools-contract/chats/HostTools.ts"
import * as PostgresTest from "./PostgresTest.ts"

/** The settings of a test server on a new database. */
export const configure = Effect.map(PostgresTest.start, (database) => ({
	databaseUrl: Redacted.make(database.url),
	secretKeys: Redacted.make("test:" + Str.repeat(32)("11")),
	clusterSecret: Redacted.make(
		"test-cluster-secret-with-at-least-32-characters",
	),
	host: "127.0.0.1",
	port: 0,
}))

export type Settings = Effect.Success<typeof configure>

/** Makes the tables of a new database. The migration has its own pool. */
export const migrate = (options: Settings) =>
	DatabasePostgres.migrate.pipe(
		Effect.provide(
			DatabasePostgres.layer(options).pipe(
				Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
			),
		),
	)

/** A Node.js HTTP server on a free port. */
export const serverOf = (options: Settings) =>
	NodeHttpServer.layer(() => createServer(), {
		host: options.host,
		port: options.port,
	})

/** Gives an assembly the services from outside, the shared services and the crypto services. */
export const outside =
	(options: Settings) =>
	<A, E, R>(app: Layer.Layer<A, E, R>) =>
		app.pipe(
			Layer.provide(Layer.merge(OpenBot.layerOutside, HostTools.none)),
			Layer.provideMerge(OpenBot.layerShared(options)),
			Layer.provideMerge(NodeCrypto.layer),
		)

/**
 * The plugin host on these settings, served by its own HTTP server. Give it
 * `BrowserHost.layerPlatform`.
 */
export const host = (
	options: Settings & Pick<Host.Options, "entries" | "plugins" | "development">,
) =>
	outside(options)(
		HttpRouter.serve(Host.layer(options), {
			disableLogger: true,
			disableListenLog: true,
		}),
	).pipe(Layer.provideMerge(serverOf(options)))
