import { Network } from "@openbot-build/protocol"
import { NodeCrypto } from "@effect/platform-node"
import { HttpClient } from "effect/http"
import { AppNetwork } from "../src/apps/AppHost.ts"
import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref } from "effect"
import * as ChannelRegistry from "../src/channels/ChannelRegistry.ts"
import { Channels } from "../src/channels/Channels.ts"
import * as BrowserHost from "./BrowserHost.ts"

const publicOrigin = "https://channel-config.example.com"
layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"Channel connections share a saved version and change with its credentials",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({ publicOrigin })
				yield* host.run(
					Effect.scoped(
						Effect.gen(function* () {
							const channels = yield* Channels
							const version = yield* Ref.make(0)
							const registry = yield* ChannelRegistry.make.pipe(
								Effect.provide(NodeCrypto.layer),
								Effect.provideService(
									HttpClient.HttpClient,
									HttpClient.make(() => Effect.die("No HTTP call is needed")),
								),
								Effect.provideService(AppNetwork, {
									layer: () =>
										Layer.effect(
											Network.Network,
											Effect.die("No custom Channel is needed"),
										),
								}),
								Effect.provideService(Channels, {
									...channels,
									credentials: () =>
										Ref.get(version).pipe(
											Effect.map((version) => ({
												version,
												credentials: {
													kind: "slack" as const,
													botToken: Redacted.make("token-" + version),
													signingSecret: Redacted.make("secret"),
												},
											})),
										),
								}),
							)
							const first = yield* registry.get("org", "channel")
							const same = yield* registry.get("org", "channel")
							assert.strictEqual(first, same)
							yield* Ref.set(version, 1)
							const second = yield* registry.get("org", "channel")
							assert.notStrictEqual(first, second)
							assert.strictEqual(second, yield* registry.get("org", "channel"))
						}),
					),
				)
			}),
		60000,
	)
})
