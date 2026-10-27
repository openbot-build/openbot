import { AppDiscovery } from "@openbot-build/domain"
import { Discovery } from "@openbot-build/protocol"
import { Schema } from "effect"
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

export const AppDiscoveryResult = Discovery.Result
export type AppDiscoveryResult = Discovery.Result

/**
 * Why discovery failed. It joins the reasons of the protocol errors. A
 * `Configuration` problem of the publisher shows as `Document`.
 */
export const AppDiscoveryFailureReason = AppDiscovery.FailureReason
export type AppDiscoveryFailureReason = typeof AppDiscoveryFailureReason.Type

export const AppDiscoveryFailed = AppDiscovery.Failed
export type AppDiscoveryFailed = AppDiscovery.Failed

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
