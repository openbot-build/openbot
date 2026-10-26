import { CatalogDiscovery, Discovery } from "@openbot-build/protocol"
import * as OutboundPolicy from "../network/OutboundPolicy.ts"
import { AppDiscoveryFailed, type AppDiscoveryResult } from "@openbot-build/api"
import {
	Array as Arr,
	Effect,
	Layer,
	Match,
	Option,
	pipe,
	type Schema,
} from "effect"

const invalidInput = (input: string): AppDiscoveryFailed =>
	AppDiscoveryFailed.make({
		reason: "InvalidInput",
		issues: [
			{
				url: input,
				reason:
					"Expected a domain or an absolute HTTPS link without credentials",
			},
		],
	})

/** Gives a discovery failure for `input` the public error that says what failed. */
export const failure = (
	input: string,
	error: Discovery.Error,
): AppDiscoveryFailed =>
	Match.value(error).pipe(
		Match.tagsExhaustive({
			InvalidLink: () => invalidInput(input),
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
	// Both failures mean that the caller's link is not valid.
	yield* CatalogDiscovery.inputLink(input).pipe(
		Effect.catchTag(["InvalidLink", "SchemaError"], () =>
			Effect.fail(invalidInput(input)),
		),
	)
	const discovery = yield* Discovery.Discovery
	return yield* discovery
		.resolve(input)
		.pipe(Effect.mapError((error) => failure(input, error)))
})

/**
 * The configuration fields to fix after `configureEndpoint` fails. A link that is not
 * valid after the values go in names no one field, so all fields of the endpoint come back.
 */
export const configurationKeys = (
	error: Discovery.DiscoveryError | Schema.SchemaError,
	candidate: Discovery.Candidate,
	index: number,
): ReadonlyArray<string> =>
	Match.value(error).pipe(
		Match.tagsExhaustive({
			// A missing field that is also a link variable gives the same path two times.
			DiscoveryError: ({ issues }) =>
				Arr.dedupe(
					Arr.flatMap(issues, (issue) =>
						issue.fieldPath === undefined ? [] : [issue.fieldPath],
					),
				),
			SchemaError: () =>
				pipe(
					Arr.findFirst(
						candidate.endpoints,
						(endpoint) => endpoint.index === index,
					),
					Option.match({
						onNone: () => [],
						onSome: (endpoint) =>
							Arr.map(endpoint.requirements, (requirement) => requirement.key),
					}),
				),
		}),
	)

/** Discovery is anonymous. OpenBot credentials are never sent as publisher headers. */
export const layerPublic: Layer.Layer<Discovery.Discovery> =
	CatalogDiscovery.layer().pipe(
		Layer.provide(CatalogDiscovery.layerRules),
		Layer.provide(OutboundPolicy.layerPublicNetwork),
	)
