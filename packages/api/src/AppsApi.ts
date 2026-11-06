import { Result as AppDiscoveryResult } from "@openbot-build/protocol/Discovery"
import { Failed as AppDiscoveryFailed } from "@openbot-build/domain/AppDiscovery"
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
