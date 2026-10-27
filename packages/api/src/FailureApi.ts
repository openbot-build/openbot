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

/** Saves faults before the HTTP encoder handles them. */
export class FailureBoundary extends HttpApiMiddleware.Service<FailureBoundary>()(
	"@openbot-build/api/FailureBoundary",
	{ error: RequestFailed.pipe(HttpApiSchema.status(503)) },
) {}
