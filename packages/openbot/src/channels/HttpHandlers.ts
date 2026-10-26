import { Redacted } from "effect"
import {
	type BotsApi,
	type Caller,
	ChannelsApi,
	Identity,
	OpenBotApi,
	type OrganizationApi,
} from "@openbot-build/api"
import {
	Array as Arr,
	Clock,
	Crypto,
	Effect,
	Option,
	Record as Rec,
	type Schema,
} from "effect"
import { Base64Url } from "effect/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Background from "../app/Background.ts"
import * as Failures from "../app/Failures.ts"
import { Bots } from "../bots/Bots.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { organizationKey, segment } from "../audit/Resources.ts"
import {
	Channels,
	type Credentials,
	fromInput,
	type StoredChannel,
} from "./Channels.ts"
import { ChannelQueue } from "./ChannelQueue.ts"
import { ChannelRegistry } from "./ChannelRegistry.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"

const channelKey = (organizationId: string, id: string) =>
	organizationKey(organizationId) + ".channel." + segment(id)

/** The API view of a stored Channel, with the address that its platform calls. */
const view = (
	publicOrigin: string,
	channel: StoredChannel,
): ChannelsApi.Channel => ({
	...channel,
	webhookUrl: `${publicOrigin}/v1/hooks/channels/${channel.id}`,
})

export const layer = HttpApiBuilder.group(OpenBotApi, "channels", (handlers) =>
	Effect.gen(function* () {
		const channels = yield* Channels
		const registry = yield* ChannelRegistry
		const bots = yield* Bots
		const audit = yield* AuditLog
		const crypto = yield* Crypto.Crypto
		const settings = yield* Settings
		/** The webhook addresses use the public origin of the platform now. */
		const publicOrigin = Platform.publicOriginOr(settings, () =>
			ChannelsApi.ChannelsUnavailable.make({}),
		)
		const record = (
			caller: Caller,
			action: OrganizationApi.AuditAction,
			resource: string,
			details: Schema.JsonObject,
		) =>
			audit
				.record({
					organizationId: caller.organizationId,
					action,
					actor: caller,
					resource,
					details,
				})
				.pipe(
					Failures.replace(
						"OpenBot could not write the audit entry of a Channel.",
						() => ChannelsApi.ChannelsUnavailable.make({}),
					),
				)
		const found = (caller: Caller, id: string) =>
			channels.get(caller.organizationId, id).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.fail(ChannelsApi.ChannelNotFound.make({ id })),
						onSome: Effect.succeed,
					}),
				),
			)
		/**
		 * The Chats of a Channel work for the caller, who becomes its actor. So the caller
		 * must be able to give work to the Bot, and the Bot must belong to the organization.
		 */
		const checkBot = (caller: Caller, id: BotsApi.BotId) =>
			bots.access(caller, id, "delegate").pipe(
				Effect.catchTags({
					BotNotFound: () =>
						Effect.fail(
							ChannelsApi.ChannelInvalid.make({
								message: `There is no Bot ${id}.`,
							}),
						),
					BotConflict: () =>
						Effect.fail(ChannelsApi.ChannelsUnavailable.make({})),
					BotInvalid: () =>
						Effect.fail(ChannelsApi.ChannelsUnavailable.make({})),
					BotStorageUnavailable: () =>
						Effect.fail(ChannelsApi.ChannelsUnavailable.make({})),
				}),
				Effect.flatMap((bot) =>
					bot.owner._tag === "Organization"
						? Effect.void
						: Effect.fail(
								ChannelsApi.ChannelInvalid.make({
									message:
										"The Bot of a Channel must be a shared Bot of the organization.",
								}),
							),
				),
			)
		/**
		 * Tells the platform the webhook, for platforms that take it by API. A platform
		 * that refuses the webhook gives `ChannelInvalid`. A platform that is down or
		 * busy gives `ChannelsUnavailable`, because the input may be right.
		 */
		const register = (origin: string, id: string, credentials: Credentials) =>
			registry.build(id, credentials).pipe(
				Effect.flatMap((channel) =>
					channel.register(`${origin}/v1/hooks/channels/${id}`),
				),
				Effect.scoped,
				Effect.catchIf(
					(failure) => !failure.retry,
					(failure) =>
						Effect.fail(
							ChannelsApi.ChannelInvalid.make({
								message: `The platform did not take the webhook: ${failure.message}`,
							}),
						),
				),
				Failures.replaceTag(
					"ChannelDeliveryFailed",
					"The platform could not take the webhook now.",
					() => ChannelsApi.ChannelsUnavailable.make({}),
				),
			)
		return handlers
			.handle("listChannels", () =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const origin = yield* publicOrigin
					const list = yield* channels.list(caller.organizationId)
					return Arr.map(list, (channel) => view(origin, channel))
				}),
			)
			.handle("createChannel", ({ payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const origin = yield* publicOrigin
					yield* checkBot(caller, payload.bot)
					const credentials = yield* fromInput(crypto, payload.credentials)
					const channel = yield* channels.create({
						organizationId: caller.organizationId,
						actor: caller.userId,
						name: payload.name,
						bot: payload.bot,
						credentials,
						linkPath: payload.linkPath ?? null,
						enabled: payload.enabled ?? true,
					})
					// A platform that refuses the webhook, or a request that stops, leaves no
					// Channel behind.
					yield* register(origin, channel.id, credentials).pipe(
						Effect.onError(() =>
							channels
								.remove(caller.organizationId, channel.id)
								.pipe(
									Background.logFailure(
										"OpenBot could not remove a Channel that the platform did not take.",
									),
								),
						),
					)
					yield* record(
						caller,
						"channel.created",
						channelKey(caller.organizationId, channel.id),
						{ kind: channel.kind, bot: channel.bot },
					)
					return view(origin, channel)
				}),
			)
			.handle("getChannel", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const origin = yield* publicOrigin
					return view(origin, yield* found(caller, params.channelId))
				}),
			)
			.handle("updateChannel", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const origin = yield* publicOrigin
					const current = yield* found(caller, params.channelId)
					if (
						payload.credentials !== undefined &&
						payload.credentials.kind !== current.kind
					)
						return yield* ChannelsApi.ChannelInvalid.make({
							message: "The kind of a Channel cannot change.",
						})
					yield* checkBot(caller, payload.bot ?? current.bot)
					const credentials =
						payload.credentials === undefined
							? undefined
							: yield* fromInput(
									crypto,
									payload.credentials,
									yield* channels.credentials(
										caller.organizationId,
										current.id,
									),
								)
					if (credentials !== undefined)
						yield* register(origin, current.id, credentials)
					const channel = yield* channels.update(
						caller.organizationId,
						current.id,
						payload.expectedVersion,
						{
							actor: caller.userId,
							...(payload.name === undefined ? {} : { name: payload.name }),
							...(payload.bot === undefined ? {} : { bot: payload.bot }),
							...(credentials === undefined ? {} : { credentials }),
							...(payload.linkPath === undefined
								? {}
								: { linkPath: payload.linkPath }),
							...(payload.enabled === undefined
								? {}
								: { enabled: payload.enabled }),
						},
					)
					yield* record(
						caller,
						"channel.updated",
						channelKey(caller.organizationId, channel.id),
						{
							changes: Arr.filter(
								Rec.keys<string, unknown>(payload),
								(key) => key !== "expectedVersion",
							),
						},
					)
					return view(origin, channel)
				}),
			)
			.handle("deleteChannel", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					if (
						!(yield* channels.remove(caller.organizationId, params.channelId))
					)
						return yield* ChannelsApi.ChannelNotFound.make({
							id: params.channelId,
						})
					yield* record(
						caller,
						"channel.deleted",
						channelKey(caller.organizationId, params.channelId),
						{},
					)
				}),
			)
			.handle("setChannelSecret", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const current = yield* found(caller, params.channelId)
					const credentials = yield* channels.credentials(
						caller.organizationId,
						current.id,
					)
					if (credentials.kind !== "custom")
						return yield* ChannelsApi.ChannelInvalid.make({
							message: "Only a custom Channel has a signing secret.",
						})
					const secret =
						"ocs_" +
						Base64Url.encode(
							// A platform without secure random numbers cannot keep secrets, so a failure here is a defect.
							yield* crypto.randomBytes(32).pipe(Effect.orDie),
						)
					yield* channels.update(
						caller.organizationId,
						current.id,
						current.version,
						{ actor: caller.userId, credentials: { ...credentials, secret } },
					)
					yield* record(
						caller,
						"channel.secret_changed",
						channelKey(caller.organizationId, current.id),
						{},
					)
					return { secret: Redacted.make(secret) }
				}),
			)
			.handle("listChannelIdentities", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					yield* found(caller, params.channelId)
					return yield* channels.identities(
						caller.organizationId,
						params.channelId,
					)
				}),
			)
			.handle("deleteChannelIdentity", ({ params }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const removed = yield* channels.unlink({
						organizationId: caller.organizationId,
						channelId: params.channelId,
						externalUserId: params.externalUserId,
					})
					if (!removed)
						return yield* ChannelsApi.ChannelIdentityNotFound.make({})
					yield* record(
						caller,
						"channel_identity.unlinked",
						channelKey(caller.organizationId, params.channelId),
						{ externalUserId: params.externalUserId },
					)
				}),
			)
	}),
)

export const layerLinks = HttpApiBuilder.group(
	OpenBotApi,
	"channelLinks",
	(handlers) =>
		Effect.gen(function* () {
			const channels = yield* Channels
			const audit = yield* AuditLog
			return handlers
				.handle("getChannelLink", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						channels.readLink(caller.organizationId, params.code),
					),
				)
				.handle("acceptChannelLink", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const identity = yield* channels.acceptLink(
							caller.organizationId,
							params.code,
							caller.userId,
						)
						yield* audit
							.record({
								organizationId: caller.organizationId,
								action: "channel_identity.linked",
								actor: caller,
								resource: channelKey(caller.organizationId, identity.channel),
								details: { externalUserId: identity.externalUserId },
							})
							.pipe(
								Failures.replace(
									"OpenBot could not write the audit entry of a Channel identity.",
									() => ChannelsApi.ChannelsUnavailable.make({}),
								),
							)
						return identity
					}),
				)
				.handle("listMyChannelIdentities", () =>
					Effect.flatMap(Identity, (caller) =>
						channels.identitiesOf(caller.organizationId, caller.userId),
					),
				)
				.handle("deleteMyChannelIdentity", ({ params }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const removed = yield* channels.unlink({
							organizationId: caller.organizationId,
							channelId: params.channelId,
							externalUserId: params.externalUserId,
							userId: caller.userId,
						})
						if (!removed)
							return yield* ChannelsApi.ChannelIdentityNotFound.make({})
						yield* audit
							.record({
								organizationId: caller.organizationId,
								action: "channel_identity.unlinked",
								actor: caller,
								resource: channelKey(caller.organizationId, params.channelId),
								details: { externalUserId: params.externalUserId },
							})
							.pipe(
								Failures.replace(
									"OpenBot could not write the audit entry of a Channel identity.",
									() => ChannelsApi.ChannelsUnavailable.make({}),
								),
							)
					}),
				)
		}),
)

/**
 * Takes the events of platforms. The signature is checked on the exact bytes of the body,
 * so the handler reads the raw request. The work happens later, so the platform gets
 * its answer in time.
 */
export const layerHooks = HttpApiBuilder.group(
	OpenBotApi,
	"channelHooks",
	(handlers) =>
		Effect.gen(function* () {
			const channels = yield* Channels
			const registry = yield* ChannelRegistry
			const queue = yield* ChannelQueue
			return handlers.handleRaw("receiveChannelEvent", ({ params }) =>
				// The integration of the Channel stays open until the event is read.
				Effect.scoped(
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest
						const found = yield* channels.find(params.channelId)
						if (Option.isNone(found) || !found.value.channel.enabled)
							return yield* ChannelsApi.ChannelHookDenied.make({})
						const { organizationId, channel: stored } = found.value
						// A Channel that went away since `find` is denied, like one that is not there.
						const channel = yield* registry
							.get(organizationId, stored)
							.pipe(
								Effect.catchTag("ChannelNotFound", () =>
									Effect.fail(ChannelsApi.ChannelHookDenied.make({})),
								),
							)
						const body = yield* request.text.pipe(
							Effect.catch((error) =>
								Effect.logInfo(
									"OpenBot could not read the body of a Channel webhook",
									error,
								).pipe(
									Effect.andThen(
										Effect.fail(ChannelsApi.ChannelHookDenied.make({})),
									),
								),
							),
						)
						const received = yield* channel
							.receive({
								headers: request.headers,
								body,
								now: yield* Clock.currentTimeMillis,
							})
							.pipe(
								Effect.catchTag("ChannelDenied", (failure) =>
									Effect.logInfo(
										"A Channel webhook was denied",
										failure.reason,
									).pipe(
										Effect.andThen(
											Effect.fail(ChannelsApi.ChannelHookDenied.make({})),
										),
									),
								),
							)
						yield* queue.receive(organizationId, stored.id, received.events)
						return HttpServerResponse.jsonUnsafe(received.reply ?? {})
					}),
				).pipe(Effect.annotateLogs({ channel: params.channelId })),
			)
		}),
)
