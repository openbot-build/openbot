import { Execution } from "@openbot-build/domain"
import { Schema } from "effect"
import { HttpApiMiddleware, HttpApiSchema } from "effect/http-api"

/** A server fault has a safe category and a reference to its sealed cause. */
export class RequestFailed extends Schema.TaggedError<
	RequestFailed,
	{ readonly brand: unique symbol }
>()("RequestFailed", {
	category: Execution.Failure.fields.category,
	errorId: Execution.ErrorId,
}) {}

/**
 * The feature that owns this request is not loaded on the server now. An
 * operator turned it off, or it waits for a feature that it needs. Nothing
 * failed, so the server keeps no error record. Try the request again later.
 */
export class FeatureUnavailable extends Schema.TaggedError<
	FeatureUnavailable,
	{ readonly brand: unique symbol }
>()("FeatureUnavailable", {
	/** The name of the feature, such as `triggers`. */
	feature: Schema.String,
}) {}

/** The response header that names the feature of a `FeatureUnavailable` answer. */
export const featureHeader = "openbot-unavailable-feature"

/** Saves faults before the HTTP encoder handles them. */
export class FailureBoundary extends HttpApiMiddleware.Service<FailureBoundary>()(
	"@openbot-build/api/FailureApi/FailureBoundary",
	{
		error: [
			RequestFailed.pipe(HttpApiSchema.status(503)),
			FeatureUnavailable.pipe(HttpApiSchema.status(503)),
		],
	},
) {}
