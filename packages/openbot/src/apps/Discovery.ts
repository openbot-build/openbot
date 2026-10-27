import { CatalogDiscovery, Discovery } from "@openbot-build/protocol"
import * as OutboundPolicy from "../network/OutboundPolicy.ts"
import * as Failures from "../errors/Failures.ts"
import { AppDiscovery } from "@openbot-build/domain"

import {
	Array as Arr,
	Effect,
	Layer,
	Match,
	Option,
	pipe,
	type Schema,
} from "effect"

const invalidInput = (input: string): AppDiscovery.Failed =>
	AppDiscovery.Failed.make({
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
): AppDiscovery.Failed =>
	Match.value(error).pipe(
		Match.tagsExhaustive({
			InvalidLink: () => invalidInput(input),
			SchemaError: () =>
				AppDiscovery.Failed.make({
					reason: "Document",
					issues: [
						{ url: input, reason: "Invalid discovery document or link" },
					],
				}),
			InvalidDocument: ({ issue }) =>
				AppDiscovery.Failed.make({
					reason: "Document",
					issues: [{ url: input, reason: issue }],
				}),
			IncompatibleCard: ({ reason }) =>
				AppDiscovery.Failed.make({
					reason: "IncompatibleCard",
					issues: [{ url: input, reason }],
				}),
			NetworkError: ({ reason, message }) =>
				AppDiscovery.Failed.make({
					reason,
					issues: [{ url: input, reason: message }],
				}),
			DiscoveryError: ({ reason, issues }) =>
				AppDiscovery.Failed.make({
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
) => Effect.Effect<Discovery.Result, AppDiscovery.Failed, Discovery.Discovery> =
	Effect.fn("Apps.discover")(function* (input) {
		// Check the caller's link apart from decoding the publisher document.
		// Both failures mean that the caller's link is not valid.
		yield* CatalogDiscovery.inputLink(input).pipe(
			Failures.replace("The App discovery input is not valid", () =>
				invalidInput(input),
			),
		)
		const discovery = yield* Discovery.Discovery
		return yield* discovery
			.resolve(input)
			.pipe(
				Failures.map("The App publication could not be found", (error) =>
					failure(input, error),
				),
			)
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
