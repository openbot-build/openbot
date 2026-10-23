import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import {
	type Caller,
	Identity,
	OpenBotApi,
	type OrganizationApi,
	TriggersApi,
} from "@openbot-build/api"
import { Effect, Option, type Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Bots } from "../bots/Bots.ts"
import * as DefaultBot from "../bots/DefaultBot.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { triggerKey } from "../authorization/Policy.ts"
import { fire } from "./Fire.ts"
import { Triggers } from "./Triggers.ts"

const unavailable = () => TriggersApi.TriggerStorageUnavailable.make({})

export const layer = (publicOrigin: string) =>
	HttpApiBuilder.group(OpenBotApi, "triggers", (handlers) =>
		Effect.gen(function* () {
			const triggers = yield* Triggers
			const bots = yield* Bots
			const audit = yield* AuditLog
			const services = yield* Effect.context<
				AuthorizationServices | DefaultBot.Services
			>()
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
					.pipe(Effect.mapError(unavailable))
			/** The tasks of a trigger work for the caller, so the caller must be able to give work to its Bot. */
			const botFor = (caller: Caller, bot: string | undefined) =>
				(bot === undefined
					? DefaultBot.resolve(caller)
					: bots.access(caller, bot, "bots.delegate")
				).pipe(
					Effect.provideContext(services),
					Effect.catchTags({
						BotNotFound: (error) =>
							Effect.fail(
								TriggersApi.TriggerInvalid.make({
									message: `There is no Bot ${error.bot}.`,
								}),
							),
						BotConflict: () => Effect.fail(unavailable()),
						BotInvalid: (error) =>
							Effect.fail(
								TriggersApi.TriggerInvalid.make({ message: error.message }),
							),
						BotStorageUnavailable: () => Effect.fail(unavailable()),
					}),
				)
			return handlers
				.handle("listTriggers", () =>
					Effect.flatMap(Identity, (caller) =>
						triggers.list(caller).pipe(Effect.provideContext(services)),
					),
				)
				.handle("createTrigger", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const bot = yield* botFor(caller, payload.bot)
						const trigger = yield* triggers
							.create(caller, {
								bot: bot.id,
								prompt: payload.prompt,
								...(payload.schedule === undefined
									? {}
									: { schedule: payload.schedule }),
								...(payload.shared === undefined
									? {}
									: { shared: payload.shared }),
								...(payload.enabled === undefined
									? {}
									: { enabled: payload.enabled }),
							})
							.pipe(Effect.provideContext(services))
						yield* record(caller, "trigger.created", trigger, {
							bot: trigger.bot,
							schedule: trigger.schedule !== null,
						})
						return trigger
					}),
				)
				.handle("getTrigger", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						triggers
							.get(caller, params.triggerId)
							.pipe(Effect.provideContext(services)),
					),
				)
				.handle("updateTrigger", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const current = yield* triggers
							.get(caller, params.triggerId, "triggers.write")
							.pipe(Effect.provideContext(services))
						// The caller becomes the actor, so it must be able to give work to the Bot.
						yield* botFor(caller, payload.bot ?? current.bot)
						const trigger = yield* triggers
							.update(caller, params.triggerId, payload)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "trigger.updated", trigger, {
							changes: Object.keys(payload).filter((key) => key !== "expected"),
						})
						return trigger
					}),
				)
				.handle("deleteTrigger", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const trigger = yield* triggers
							.remove(caller, params.triggerId)
							.pipe(Effect.provideContext(services))
						yield* record(caller, "trigger.deleted", trigger, {})
					}),
				)
				.handle("setTriggerWebhook", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const current = yield* triggers
							.get(caller, params.triggerId, "triggers.write")
							.pipe(Effect.provideContext(services))
						yield* botFor(caller, current.bot)
						const { trigger, secret } = yield* triggers
							.setWebhook(caller, params.triggerId)
							.pipe(Effect.provideContext(services))
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
						const trigger = yield* triggers
							.removeWebhook(caller, params.triggerId)
							.pipe(Effect.provideContext(services))
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
			const context =
				yield* Effect.context<Effect.Services<ReturnType<typeof fire>>>()
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
						Effect.provideContext(context),
						// The actor can no longer give work to the Bot, or the task could
						// not be saved. The caller of the webhook learns only that it failed.
						Effect.catchCause((cause) =>
							Effect.logWarning(
								"A webhook could not fire its trigger",
								cause,
							).pipe(Effect.andThen(Effect.fail(unavailable()))),
						),
					)
					return { delegation }
				}),
			)
		}),
)
