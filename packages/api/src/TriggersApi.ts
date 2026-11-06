import { BotId } from "@openbot-build/domain/BotId"
import { DelegationId } from "@openbot-build/domain/DelegationId"
import { SecretOutput } from "@openbot-build/domain/Secret"
import { TriggerId } from "@openbot-build/domain/TriggerId"
import { Trigger } from "@openbot-build/domain/Triggers"
import { Schedule } from "@openbot-build/domain/Triggers"
import { TriggerNotFound } from "@openbot-build/domain/Triggers"
import { TriggerConflict } from "@openbot-build/domain/Triggers"
import { TriggerInvalid } from "@openbot-build/domain/Triggers"
import { TriggerStorageUnavailable } from "@openbot-build/domain/Triggers"
import { TriggerHookDenied } from "@openbot-build/domain/Triggers"
import { Change as UpdateTriggerRequest } from "@openbot-build/domain/Triggers"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { BotAuth } from "./AuthApi.ts"
import {
	Authorize,
	AuthorizationErrors,
	GroupRequired,
} from "./Authorization.ts"

import { Execution } from "@openbot-build/domain"
import { errors as executionErrors } from "./ExecutionsApi.ts"
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
			"Changes a trigger. The caller becomes its actor, so the new tasks work for the caller.",
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
