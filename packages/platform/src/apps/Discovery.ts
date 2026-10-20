import { CatalogDiscovery, Discovery } from "@openbot-build/protocol"
import * as NodeHttpServer from "@openbot-build/protocol/NodeHttpServer"
import {
	AppDiscoveryFailed,
	type AppDiscoveryResult,
} from "@openbot-build/platform-api"
import { Effect, Layer, Match } from "effect"

const failure = (input: string, error: Discovery.Error): AppDiscoveryFailed =>
	Match.value(error).pipe(
		Match.tagsExhaustive({
			InvalidLink: () =>
				AppDiscoveryFailed.make({
					reason: "InvalidInput",
					issues: [
						{
							url: input,
							reason:
								"Expected a domain or an absolute HTTPS link without credentials",
						},
					],
				}),
			SchemaError: () =>
				AppDiscoveryFailed.make({
					reason: "Document",
					issues: [
						{ url: input, reason: "Invalid discovery document or link" },
					],
				}),
			InvalidDocument: ({ issue }) =>
				AppDiscoveryFailed.make({
					reason: "Document",
					issues: [{ url: input, reason: issue }],
				}),
			IncompatibleCard: ({ reason }) =>
				AppDiscoveryFailed.make({
					reason: "IncompatibleCard",
					issues: [{ url: input, reason }],
				}),
			NetworkError: ({ reason, message }) =>
				AppDiscoveryFailed.make({
					reason,
					issues: [{ url: input, reason: message }],
				}),
			DiscoveryError: ({ reason, issues }) =>
				AppDiscoveryFailed.make({
					reason: Match.value(reason).pipe(
						Match.when("Configuration", () => "Document" as const),
						Match.orElse((reason) => reason),
					),
					issues,
				}),
		}),
	)

export const discover: (
	input: string,
) => Effect.Effect<
	AppDiscoveryResult,
	AppDiscoveryFailed,
	Discovery.Discovery
> = Effect.fn("Apps.discover")(function* (input) {
	// Check the caller's link apart from decoding the publisher document.
	yield* CatalogDiscovery.inputLink(input).pipe(
		Effect.mapError(() =>
			AppDiscoveryFailed.make({
				reason: "InvalidInput",
				issues: [
					{
						url: input,
						reason:
							"Expected a domain or an absolute HTTPS link without credentials",
					},
				],
			}),
		),
	)
	const discovery = yield* Discovery.Discovery
	return yield* discovery
		.resolve(input)
		.pipe(Effect.mapError((error) => failure(input, error)))
})

/** Discovery is anonymous. Platform credentials are never sent as publisher headers. */
export const layerPublic: Layer.Layer<Discovery.Discovery> =
	CatalogDiscovery.layer().pipe(
		Layer.provide(CatalogDiscovery.layerRules),
		Layer.provide(NodeHttpServer.layerPublicNetwork()),
	)
