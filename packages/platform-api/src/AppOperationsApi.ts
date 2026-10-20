import { Session } from "@openbot-build/core"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Invocation } from "./AppExecution.ts"
import { ExperienceErrors } from "./ExperienceErrors.ts"
import { SessionConflict } from "./SessionsApi.ts"

const errors = [
	...ExperienceErrors,
	SessionConflict.pipe(HttpApiSchema.status(409)),
]
export const AppOperationsApi = HttpApiGroup.make("appOperations").add(
	HttpApiEndpoint.get("get", "/v1/app-operations/:id", {
		params: { id: Schema.String },
		success: Invocation,
		error: errors,
	}),
	HttpApiEndpoint.get("list", "/v1/sessions/:sessionId/app-operations", {
		params: { sessionId: Session.Id },
		success: Schema.Array(Invocation),
		error: errors,
	}),
	HttpApiEndpoint.post("respond", "/v1/app-operations/:id/inputs", {
		params: { id: Schema.String },
		payload: Schema.Struct({
			round: Schema.Natural,
			responses: Schema.JsonObject,
		}),
		success: Invocation,
		error: errors,
	}),
)
