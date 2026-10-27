import { Execution, Requests as RequestDomain } from "@openbot-build/domain"
import { errors as ExecutionErrors } from "./ExecutionsApi.ts"
import { CapabilityRequestId } from "./CapabilityRequestId.ts"
export { CapabilityRequestId } from "./CapabilityRequestId.ts"
import { BotAuth } from "./AuthApi.ts"
import { Authorize, GroupRequired, own } from "./Authorization.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { BotErrors } from "./BotsApi.ts"

// tsdown drops star exports from the built API namespace. List the names here.
export {
	RequestStatus,
	RequestNotFound,
	RequestConflict,
} from "@openbot-build/domain/Requests"
import {
	RequestStatus,
	RequestNotFound,
	RequestConflict,
} from "@openbot-build/domain/Requests"

export const CapabilityRequest = Schema.Struct({
	...RequestDomain.CapabilityRequest.fields,
	executionId: Execution.Id,
	executionStatus: Execution.Status,
})
export type CapabilityRequest = typeof CapabilityRequest.Type
export const ResolveRequest = RequestDomain.PersonDecision
export type ResolveRequest = typeof ResolveRequest.Type

export const RequestErrors = [
	...BotErrors,
	...ExecutionErrors,
	RequestNotFound.pipe(HttpApiSchema.status(404)),
	RequestConflict.pipe(HttpApiSchema.status(409)),
] as const

export class RequestsApi extends HttpApiGroup.make("requests")
	.add(
		HttpApiEndpoint.get("listRequests", "/v1/requests", {
			query: {
				status: Schema.optionalKey(RequestStatus),
			},
			success: Schema.Array(CapabilityRequest),
			error: RequestErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the requests that wait for the caller, or that the caller answered.",
		),
		HttpApiEndpoint.get("getRequest", "/v1/requests/:requestId", {
			params: { requestId: CapabilityRequestId },
			success: CapabilityRequest,
			error: RequestErrors,
		}),
		HttpApiEndpoint.post("resolveRequest", "/v1/requests/:requestId", {
			params: { requestId: CapabilityRequestId },
			payload: ResolveRequest,
			success: Execution.Receipt.pipe(HttpApiSchema.status(202)),
			error: RequestErrors,
		}).annotate(
			OpenApi.Description,
			"Saves one decision and returns its execution receipt. The workflow sends the result to the Chat.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	.annotate(GroupRequired, {
		read: [own("resolve", "Request")],
		write: [own("resolve", "Request")],
	})
	.middleware(Authorize)
	.middleware(BotAuth) {}
