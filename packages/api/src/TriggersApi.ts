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

/** A member owns their own triggers. The organization owns shared triggers. */
export const TriggerOwner = Schema.TaggedUnion({
	Member: { userId: Schema.String },
	Organization: {},
})
export type TriggerOwner = typeof TriggerOwner.Type

/** When a trigger fires by itself. `cron` has five fields, such as `0 9 * * 1-5`. */
export const Schedule = Schema.Struct({
	cron: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	/** An IANA time zone, such as `Europe/Berlin`. Without it, the time zone is UTC. */
	timeZone: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
})
export type Schedule = typeof Schedule.Type

const Prompt = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(20000),
)

/**
 * A trigger gives one task with one prompt to one Bot, on a schedule or from a webhook.
 * It does nothing else. The Bot decides how to do the work. When the task ends, its
 * result goes to the Chat of the actor with the Bot.
 */
export const Trigger = Schema.Struct({
	id: TriggerId,
	owner: TriggerOwner,
	bot: BotId,
	prompt: Schema.String,
	schedule: Schema.NullOr(Schedule),
	/** True when the trigger has a webhook secret. */
	webhook: Schema.Boolean,
	/**
	 * The member that the tasks work for. It is the last member who changed
	 * the trigger or its webhook.
	 */
	actor: Schema.String,
	enabled: Schema.Boolean,
	/** The next time that the schedule fires. `null` without a schedule, or when disabled. */
	nextRunAt: Schema.NullOr(Schema.Finite),
	lastFiredAt: Schema.NullOr(Schema.Finite),
	revision: Schema.Natural,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Trigger = typeof Trigger.Type

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

export const UpdateTriggerRequest = Schema.Struct({
	expected: Schema.Natural,
	bot: Schema.optionalKey(BotId),
	prompt: Schema.optionalKey(Prompt),
	/** `null` removes the schedule. */
	schedule: Schema.optionalKey(Schema.NullOr(Schedule)),
	enabled: Schema.optionalKey(Schema.Boolean),
})
export type UpdateTriggerRequest = typeof UpdateTriggerRequest.Type

/** The secret of a webhook. OpenBot shows it only once. */
export const WebhookSecret = Schema.Struct({
	url: Schema.String,
	secret: SecretOutput,
})
export type WebhookSecret = typeof WebhookSecret.Type

export class TriggerNotFound extends Schema.TaggedError<
	TriggerNotFound,
	{ readonly brand: unique symbol }
>()("TriggerNotFound", { id: Schema.String }) {}
export class TriggerConflict extends Schema.TaggedError<
	TriggerConflict,
	{ readonly brand: unique symbol }
>()("TriggerConflict", { message: Schema.String }) {}
export class TriggerInvalid extends Schema.TaggedError<
	TriggerInvalid,
	{ readonly brand: unique symbol }
>()("TriggerInvalid", { message: Schema.String }) {}
export class TriggerStorageUnavailable extends Schema.TaggedError<
	TriggerStorageUnavailable,
	{ readonly brand: unique symbol }
>()("TriggerStorageUnavailable", {}) {}
/** The webhook secret is wrong, the trigger has no webhook, or it is disabled. */
export class TriggerHookDenied extends Schema.TaggedError<
	TriggerHookDenied,
	{ readonly brand: unique symbol }
>()("TriggerHookDenied", {}) {}

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
		headers: { authorization: Schema.String },
		payload: Schema.Json,
		success: Schema.Struct({ delegation: DelegationId }).pipe(
			HttpApiSchema.status(202),
		),
		error: [
			TriggerInvalid.pipe(HttpApiSchema.status(409)),
			TriggerHookDenied.pipe(HttpApiSchema.status(401)),
			TriggerStorageUnavailable.pipe(HttpApiSchema.status(503)),
		],
	}).annotate(
		OpenApi.Description,
		"Gives the task of the trigger to its Bot. Send `Authorization: Bearer <webhook secret>`. The JSON body goes to the Bot as data, not as instructions. The task works for the actor of the trigger.",
	),
) {}
