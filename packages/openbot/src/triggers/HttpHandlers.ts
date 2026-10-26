import {
	type Caller,
	Identity,
	OpenBotApi,
	type OrganizationApi,
	TriggersApi,
} from "@openbot-build/api"
import { Array as Arr, Effect, Option, type Schema, Struct } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Bots } from "../bots/Bots.ts"
import * as DefaultBot from "../bots/DefaultBot.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { triggerKey } from "../audit/Resources.ts"
import * as Platform from "../settings/Platform.ts"
import * as Failures from "../app/Failures.ts"
import { Settings } from "../settings/Settings.ts"
import * as Fire from "./Fire.ts"
import { Triggers } from "./Triggers.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "triggers", (handlers) =>
	Effect.gen(function* () {
		const triggers = yield* Triggers
		const bots = yield* Bots
		const audit = yield* AuditLog
		const settings = yield* Settings
		const defaultBot = yield* DefaultBot.make
		const record = (
			caller: Caller,
			action: OrganizationApi.AuditAction,
			trigger: TriggersApi.Trigger,
			details: Schema.JsonObject,
		) =>
			audit
				.record({
					organizationId: caller.organizationId,
					action,
					actor: caller,
					resource: triggerKey({
						...trigger,
						organizationId: caller.organizationId,
					}),
					details,
				})
				.pipe(
					Failures.replace(
						"OpenBot could not write the audit entry of a trigger.",
						() => TriggersApi.TriggerStorageUnavailable.make({}),
					),
				)
		/** The tasks of a trigger work for the caller, so the caller must be able to give work to its Bot. */
		const botFor = (caller: Caller, bot: string | undefined) =>
			(bot === undefined
				? defaultBot.resolve(caller)
				: bots.access(caller, bot, "delegate")
			).pipe(
				Effect.catchTags({
					BotNotFound: (error) =>
						Effect.fail(
							TriggersApi.TriggerInvalid.make({
								message: `There is no Bot ${error.bot}.`,
							}),
						),
					BotConflict: () =>
						Effect.fail(TriggersApi.TriggerStorageUnavailable.make({})),
					BotInvalid: (error) =>
						Effect.fail(
							TriggersApi.TriggerInvalid.make({ message: error.message }),
						),
					BotStorageUnavailable: () =>
						Effect.fail(TriggersApi.TriggerStorageUnavailable.make({})),
				}),
			)
		return handlers
			.handle("listTriggers", () =>
				Effect.flatMap(Identity, (caller) => triggers.list(caller)),
			)
			.handle("createTrigger", ({ payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const bot = yield* botFor(caller, payload.bot)
					const trigger = yield* triggers.create(caller, {
						bot: bot.id,
						prompt: payload.prompt,
						...(payload.schedule === undefined
							? {}
							: { schedule: payload.schedule }),
						...(payload.shared === undefined ? {} : { shared: payload.shared }),
						...(payload.enabled === undefined
							? {}
							: { enabled: payload.enabled }),
					})
					yield* record(caller, "trigger.created", trigger, {
						bot: trigger.bot,
						schedule: trigger.schedule !== null,
					})
					return trigger
				}),
			)
			.handle("getTrigger", ({ params }) =>
				Effect.flatMap(Identity, (caller) =>
					triggers.get(caller, params.triggerId),
				),
			)
			.handle("updateTrigger", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const current = yield* triggers.get(caller, params.triggerId, "write")
					// The caller becomes the actor, so it must be able to give work to the Bot.
					yield* botFor(caller, payload.bot ?? current.bot)
					const trigger = yield* triggers.update(
						caller,
						params.triggerId,
						payload,
					)
					yield* record(caller, "trigger.updated", trigger, {
						changes: Arr.filter(
							Struct.keys(payload),
							(key) => key !== "expected",
						),
					})
					return trigger
				}),
			)
			.handle("deleteTrigger", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const trigger = yield* triggers.remove(caller, params.triggerId)
					yield* record(caller, "trigger.deleted", trigger, {})
				}),
			)
			.handle("setTriggerWebhook", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const current = yield* triggers.get(caller, params.triggerId, "write")
					yield* botFor(caller, current.bot)
					// Read the origin first, so a failure does not hide a new secret.
					const publicOrigin = yield* Platform.publicOriginOr(settings, () =>
						TriggersApi.TriggerStorageUnavailable.make({}),
					)
					const { trigger, secret } = yield* triggers.setWebhook(
						caller,
						params.triggerId,
					)
					yield* record(caller, "trigger.hook_changed", trigger, {
						webhook: true,
					})
					return {
						url: publicOrigin + "/v1/hooks/triggers/" + trigger.id,
						secret,
					}
				}),
			)
			.handle("removeTriggerWebhook", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const trigger = yield* triggers.removeWebhook(
						caller,
						params.triggerId,
					)
					yield* record(caller, "trigger.hook_changed", trigger, {
						webhook: false,
					})
				}),
			)
	}),
)

/** Webhooks: the secret is the only credential. The task works for the actor of the trigger. */
export const layerHooks = HttpApiBuilder.group(
	OpenBotApi,
	"triggerHooks",
	(handlers) =>
		Effect.gen(function* () {
			const triggers = yield* Triggers
			const fire = yield* Fire.make
			return handlers.handle("fireTrigger", ({ params, headers, payload }) =>
				Effect.gen(function* () {
					const denied = TriggersApi.TriggerHookDenied.make({})
					const match = /^Bearer\s+(\S+)$/i.exec(headers.authorization)
					if (match === null) return yield* denied
					const found = yield* triggers.verifyHook(params.triggerId, match[1]!)
					if (Option.isNone(found)) return yield* denied
					const delegation = yield* fire({
						...found.value,
						data: payload,
					}).pipe(
						// The actor can no longer give work to the Bot, or the task could
						// not be saved. The caller of the webhook learns only that it failed.
						Failures.replace("A webhook could not fire its trigger.", () =>
							TriggersApi.TriggerStorageUnavailable.make({}),
						),
						Effect.annotateLogs({
							trigger: found.value.trigger.id,
							organization: found.value.organizationId,
						}),
					)
					return { delegation }
				}),
			)
		}),
)
