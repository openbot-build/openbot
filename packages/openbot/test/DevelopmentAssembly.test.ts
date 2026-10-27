import { expectTypeOf, it } from "@effect/vitest"
import { Discovery } from "@openbot-build/protocol"
import { Server } from "@openbot-build/openbot"
import { Context, Effect, Layer, Redacted, Schema } from "effect"

const settings = (databaseUrl: string) => ({
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
it.effect(
	"discovery injection keeps construction failures and required services",
	() =>
		Effect.sync(() => {
			class DiscoveryConfiguration extends Context.Service<
				DiscoveryConfiguration,
				{ readonly enabled: boolean }
			>()(
				"@openbot-build/openbot/test/DevelopmentAssembly.test/DiscoveryConfiguration",
			) {}
			class DiscoveryStartupFailed extends Schema.TaggedError<
				DiscoveryStartupFailed,
				{ readonly brand: unique symbol }
			>()("DiscoveryStartupFailed", {}) {}
			const injected = Layer.effect(
				Discovery.Discovery,
				Effect.gen(function* () {
					yield* DiscoveryConfiguration
					return yield* DiscoveryStartupFailed.make({})
				}),
			)
			const server = Server.layerFixed(settings("postgresql://unused")).pipe(
				Layer.provide(injected),
			)
			expectTypeOf<DiscoveryConfiguration>().toExtend<
				Layer.Services<typeof server>
			>()
			expectTypeOf<DiscoveryStartupFailed>().toExtend<
				Layer.Error<typeof server>
			>()
		}),
)
