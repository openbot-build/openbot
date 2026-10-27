import { SecretOutput } from "./Secret.ts"
import { DelegationId } from "./DelegationsApi.ts"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { BotId } from "./BotsApi.ts"
import { BotAuth } from "./AuthApi.ts"
import {
	Authorize,
	AuthorizationErrors,
	GroupRequired,
} from "./Authorization.ts"

export { TriggerId } from "./TriggerId.ts"
import { TriggerId } from "./TriggerId.ts"

import { Execution } from "@openbot-build/domain"
import { errors as executionErrors } from "./ExecutionsApi.ts"
import { Triggers as Domain } from "@openbot-build/domain"
export const {
	Trigger,
	TriggerOwner,
	Schedule,
	TriggerNotFound,
	TriggerConflict,
	TriggerInvalid,
	TriggerStorageUnavailable,
	TriggerHookDenied,
} = Domain
export type Trigger = Domain.Trigger
export type TriggerOwner = Domain.TriggerOwner
export type Schedule = Domain.Schedule
export type TriggerNotFound = Domain.TriggerNotFound
export type TriggerConflict = Domain.TriggerConflict
export type TriggerInvalid = Domain.TriggerInvalid
export type TriggerStorageUnavailable = Domain.TriggerStorageUnavailable
export type TriggerHookDenied = Domain.TriggerHookDenied
const Prompt = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(20000),
)
export const CreateTriggerRequest = Schema.Struct({
	/** Without it, the default Bot of the caller does the work. */
	bot: Schema.optionalKey(BotId),
	prompt: Prompt,
	schedule: Schema.optionalKey(Schedule),
	/** Shared triggers belong to the organization. Other triggers belong to the caller. */
	shared: Schema.optionalKey(Schema.Boolean),
	enabled: Schema.optionalKey(Schema.Boolean),
})
export type CreateTriggerRequest = typeof CreateTriggerRequest.Type

export const UpdateTriggerRequest = Domain.Change
export type UpdateTriggerRequest = Domain.Change

/** The secret of a webhook. OpenBot shows it only once. */
export const WebhookSecret = Schema.Struct({
	url: Schema.String,
	secret: SecretOutput,
})
export type WebhookSecret = typeof WebhookSecret.Type

/** The handlers check permissions on triggers themselves, so these errors are listed here too. */
export const TriggerErrors = [
	...AuthorizationErrors,
	TriggerNotFound.pipe(HttpApiSchema.status(404)),
	TriggerConflict.pipe(HttpApiSchema.status(409)),
	TriggerInvalid.pipe(HttpApiSchema.status(400)),
	TriggerStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const triggerParams = { triggerId: TriggerId }

export class TriggersApi extends HttpApiGroup.make("triggers")
	.add(
		HttpApiEndpoint.get("listTriggers", "/v1/triggers", {
			success: Schema.Array(Trigger),
			error: TriggerErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the triggers that the caller can read: their own and the shared ones.",
		),
		HttpApiEndpoint.post("createTrigger", "/v1/triggers", {
			payload: CreateTriggerRequest,
			success: Trigger.pipe(HttpApiSchema.status(201)),
			error: TriggerErrors,
		}),
		HttpApiEndpoint.get("getTrigger", "/v1/triggers/:triggerId", {
			params: triggerParams,
			success: Trigger,
			error: TriggerErrors,
		}),
		HttpApiEndpoint.patch("updateTrigger", "/v1/triggers/:triggerId", {
			params: triggerParams,
			payload: UpdateTriggerRequest,
			success: Trigger,
			error: TriggerErrors,
		}).annotate(
			OpenApi.Description,
			"Changes a trigger and clears needsAuthorization. The caller becomes its actor, so the new tasks work for the caller.",
		),
		HttpApiEndpoint.delete("deleteTrigger", "/v1/triggers/:triggerId", {
			params: triggerParams,
			success: HttpApiSchema.NoContent,
			error: TriggerErrors,
		}),
		HttpApiEndpoint.put(
			"setTriggerWebhook",
			"/v1/triggers/:triggerId/webhook",
			{
				params: triggerParams,
				success: WebhookSecret,
				error: TriggerErrors,
			},
		).annotate(
			OpenApi.Description,
			"Makes a new webhook secret. The old secret stops working. The caller becomes the actor of the trigger.",
		),
		HttpApiEndpoint.delete(
			"removeTriggerWebhook",
			"/v1/triggers/:triggerId/webhook",
			{
				params: triggerParams,
				success: HttpApiSchema.NoContent,
				error: TriggerErrors,
			},
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// The resource key of a trigger depends on its owner, which the path does not show.
	// So the handlers check the triggers permissions themselves.
	.annotate(GroupRequired, { read: [], write: [] })
	.middleware(Authorize)
	.middleware(BotAuth) {}

/** Fires a trigger from another system. The secret of the webhook is the only credential. */
export class TriggerHooksApi extends HttpApiGroup.make("triggerHooks").add(
	HttpApiEndpoint.post("fireTrigger", "/v1/hooks/triggers/:triggerId", {
		params: triggerParams,
		headers: {
			authorization: Schema.String,
			"idempotency-key": Execution.CommandKey,
		},
		payload: Schema.Json,
		success: Schema.Struct({
			...Execution.Receipt.fields,
			delegation: DelegationId,
		}).pipe(HttpApiSchema.status(202)),
		error: [
			...executionErrors,
			TriggerInvalid.pipe(HttpApiSchema.status(409)),
			TriggerHookDenied.pipe(HttpApiSchema.status(401)),
			TriggerStorageUnavailable.pipe(HttpApiSchema.status(503)),
		],
	}).annotate(
		OpenApi.Description,
		"Gives the task of the trigger to its Bot. Send `Authorization: Bearer <webhook secret>`. The JSON body goes to the Bot as data, not as instructions. The task works for the actor of the trigger.",
	),
) {}
