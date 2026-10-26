import { Discovery, Network } from "@openbot-build/protocol"
import { Array as Arr, Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"

export const DiscoverAppRequest = Schema.Struct({
	input: Schema.NonEmptyString,
})
export type DiscoverAppRequest = typeof DiscoverAppRequest.Type

export const AppDiscoveryResult = Schema.Union([
	Schema.TaggedStruct("Single", {
		candidate: Discovery.Candidate,
		issues: Schema.Array(Discovery.Issue),
	}),
	Schema.TaggedStruct("Multiple", {
		candidates: Schema.Array(Discovery.Candidate).check(Schema.isMinLength(2)),
		issues: Schema.Array(Discovery.Issue),
	}),
])
export type AppDiscoveryResult = typeof AppDiscoveryResult.Type

/**
 * Why discovery failed. It joins the reasons of the protocol errors. A
 * `Configuration` problem of the publisher shows as `Document`.
 */
export const AppDiscoveryFailureReason = Schema.Literals([
	"InvalidInput",
	"IncompatibleCard",
	...Arr.filter(
		Discovery.DiscoveryErrorReason.literals,
		(reason): reason is Exclude<typeof reason, "Configuration"> =>
			reason !== "Configuration",
	),
	...Network.NetworkErrorReason.literals,
])
export type AppDiscoveryFailureReason = typeof AppDiscoveryFailureReason.Type

export class AppDiscoveryFailed extends Schema.TaggedError<
	AppDiscoveryFailed,
	{ readonly brand: unique symbol }
>()("AppDiscoveryFailed", {
	reason: AppDiscoveryFailureReason,
	issues: Schema.Array(Discovery.Issue),
}) {}

export const AppsApi = HttpApiGroup.make("apps").add(
	HttpApiEndpoint.post("discoverApp", "/v1/apps/discover", {
		payload: DiscoverAppRequest,
		success: AppDiscoveryResult,
		error: [
			HttpApiError.BadRequestNoContent,
			AppDiscoveryFailed.pipe(HttpApiSchema.status(422)),
		],
	}).annotate(
		OpenApi.Description,
		"Finds Apps at a domain or HTTPS link. Returns OpenBot App Protocol candidates, configuration requirements and provenance (where each candidate came from). It does not add a connection, authorize an account or index a service.",
	),
)
