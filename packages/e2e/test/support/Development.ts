import { NodeServices } from "@effect/platform-node"
import { Config, Item, Model, Provider } from "@openbot-build/core"
import { DatabasePostgres } from "@openbot-build/openbot"
import { DevelopmentLogin, Messages } from "@openbot-build/openbot/testing"
import {
	Context,
	Effect,
	Layer,
	Record as Rec,
	Redacted,
	Schedule,
	Schema,
} from "effect"
import { FetchHttpClient, HttpServer } from "effect/http"

export const browser = DevelopmentLogin.browser
export const signIn: typeof DevelopmentLogin.signIn = DevelopmentLogin.signIn
export const bot: typeof Messages.bot = Messages.bot
export const { message, model, settled, send: sendMessage } = Messages
export const developmentProvider = Provider.Id.make("development")
export const defaultModel = Config.Selection.make({
	provider: developmentProvider,
	model: Model.Id.make("mock-text"),
})

export const settings = (databaseUrl: string) => ({
	host: "127.0.0.1",
	port: 0,
	databaseUrl: Redacted.make(databaseUrl),
	clusterSecret: Redacted.make(
		"test-cluster-secret-with-at-least-32-characters",
	),
	secretKeys: Redacted.make(
		"test:" +
			"1111111111111111111111111111111111111111111111111111111111111111",
	),
	auth: {
		mode: "development" as const,
		publicOrigin: "https://localhost:8443",
		secret: Redacted.make("DevelopmentAssemblySecretMustRemainStable123456"),
	},
})
/** Files, programs and an HTTP client for the tests. */
export const platform = Layer.merge(NodeServices.layer, FetchHttpClient.layer)
/** A page of the Items of a Chat, as the API gives it. */
export const ItemPage = Schema.Struct({
	items: Schema.Array(Item.Record),
	next: Schema.NullOr(Item.Seq),
})
/** Gives a value as JSON text. */
export const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
/** Runs the migrations with a database pool of their own, which closes at the end. */
export const migrate = (options: ReturnType<typeof settings>) =>
	DatabasePostgres.migrate.pipe(
		Effect.provide(DatabasePostgres.layer(options)),
		// A failed setup must stop the test before it starts its server.
		Effect.orDie,
	)
/** Starts a server in the current scope, and gives its services and its address. */
export const launch = <ROut, E, R>(
	server: Layer.Layer<ROut | HttpServer.HttpServer, E, R>,
) =>
	Effect.map(Layer.build(server), (services) => ({
		services,
		address: HttpServer.formatAddress(
			Context.get(services, HttpServer.HttpServer).address,
		),
	}))
/**
 * Runs a read again, 25 milliseconds apart, until `done` holds for its value.
 * It tries again at most 200 times, and then gives the last value.
 */
export const poll = <A, E, R>(
	read: Effect.Effect<A, E, R>,
	done: (value: A) => boolean,
) =>
	Effect.repeat(read, {
		until: done,
		times: 200,
		schedule: Schedule.spaced("25 millis"),
	})
/** A fetch that sends each request with a Cookie, from an origin. */
export const fetchWith = (cookie: string, origin: string) =>
	Layer.effect(
		FetchHttpClient.Fetch,
		Effect.gen(function* () {
			const fetch = yield* FetchHttpClient.Fetch
			return (input, init) =>
				fetch(input, {
					...init,
					headers: {
						...Rec.fromEntries(new Headers(init?.headers)),
						cookie,
						origin,
					},
				})
		}),
	)
