import { randomBytes } from "node:crypto"
import {
	type BotsApi,
	type Caller,
	ChannelsApi,
	Identity,
	OpenBotApi,
	type OrganizationApi,
} from "@openbot-build/api"
import { Clock, Effect, Option, type Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Bots } from "../bots/Bots.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import type { Services as AuthorizationServices } from "../authorization/Authorize.ts"
import { organizationKey, segment } from "../authorization/Policy.ts"
import {
	Channels,
	type Credentials,
	fromInput,
	type StoredChannel,
} from "./Channels.ts"
import { ChannelQueue } from "./ChannelQueue.ts"
import { ChannelRegistry } from "./ChannelRegistry.ts"

const unavailable = () => ChannelsApi.ChannelsUnavailable.make({})
const invalid = (message: string) =>
	ChannelsApi.ChannelInvalid.make({ message })

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

export const layer = (publicOrigin: string) =>
	HttpApiBuilder.group(OpenBotApi, "channels", (handlers) =>
		Effect.gen(function* () {
			const channels = yield* Channels
			const registry = yield* ChannelRegistry
			const bots = yield* Bots
			const audit = yield* AuditLog
			const services = yield* Effect.context<AuthorizationServices>()
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
					.pipe(Effect.mapError(unavailable))
			const found = (caller: Caller, id: string) =>
				channels.get(caller.organizationId, id).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () =>
								Effect.fail(ChannelsApi.ChannelNotFound.make({ id })),
							onSome: Effect.succeed,
						}),
					),
				)
			/**
			 * The Chats of a Channel work for the caller, who becomes its actor. So the caller
			 * must be able to give work to the Bot, and the Bot must belong to the organization.
			 */
			const checkBot = (caller: Caller, id: BotsApi.BotId) =>
				bots.access(caller, id, "bots.delegate").pipe(
					Effect.provideContext(services),
					Effect.catchTags({
						BotNotFound: () => Effect.fail(invalid(`There is no Bot ${id}.`)),
						BotConflict: () => Effect.fail(unavailable()),
						BotInvalid: () => Effect.fail(unavailable()),
						BotStorageUnavailable: () => Effect.fail(unavailable()),
					}),
					Effect.flatMap((bot) =>
						bot.owner._tag === "Organization"
							? Effect.void
							: Effect.fail(
									invalid(
										"The Bot of a Channel must be a shared Bot of the organization.",
									),
								),
					),
				)
			/** Tells the platform the webhook, for platforms that take it by API. */
			const register = (id: string, credentials: Credentials) =>
				registry.build(id, credentials).pipe(
					Effect.flatMap((channel) =>
						channel.register(`${publicOrigin}/v1/hooks/channels/${id}`),
					),
					Effect.scoped,
					Effect.mapError((failure) =>
						invalid(
							`The platform did not take the webhook: ${failure.message}`,
						),
					),
				)
			return handlers
				.handle("listChannels", () =>
					Effect.flatMap(Identity, (caller) =>
						channels
							.list(caller.organizationId)
							.pipe(
								Effect.map((list) =>
									list.map((channel) => view(publicOrigin, channel)),
								),
							),
					),
				)
				.handle("createChannel", ({ payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						yield* checkBot(caller, payload.bot)
						const credentials = fromInput(payload.credentials)
						const channel = yield* channels.create({
							organizationId: caller.organizationId,
							actor: caller.userId,
							name: payload.name,
							bot: payload.bot,
							credentials,
							linkPath: payload.linkPath ?? null,
							enabled: payload.enabled ?? true,
						})
						// A platform that refuses the webhook leaves no Channel behind.
						yield* register(channel.id, credentials).pipe(
							Effect.tapError(() =>
								channels.remove(caller.organizationId, channel.id),
							),
						)
						yield* record(
							caller,
							"channel.created",
							channelKey(caller.organizationId, channel.id),
							{ kind: channel.kind, bot: channel.bot },
						)
						return view(publicOrigin, channel)
					}),
				)
				.handle("getChannel", ({ params }) =>
					Effect.flatMap(Identity, (caller) =>
						found(caller, params.channelId).pipe(
							Effect.map((channel) => view(publicOrigin, channel)),
						),
					),
				)
				.handle("updateChannel", ({ params, payload }) =>
					Effect.gen(function* () {
						const caller = yield* Identity
						const current = yield* found(caller, params.channelId)
						if (
							payload.credentials !== undefined &&
							payload.credentials.kind !== current.kind
						)
							return yield* invalid("The kind of a Channel cannot change.")
						yield* checkBot(caller, payload.bot ?? current.bot)
						const credentials =
							payload.credentials === undefined
								? undefined
								: fromInput(
										payload.credentials,
										yield* channels.credentials(
											caller.organizationId,
											current.id,
										),
									)
						if (credentials !== undefined)
							yield* register(current.id, credentials)
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
								changes: Object.keys(payload).filter(
									(key) => key !== "expectedVersion",
								),
							},
						)
						return view(publicOrigin, channel)
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
							return yield* invalid(
								"Only a custom Channel has a signing secret.",
							)
						const secret = "ocs_" + randomBytes(32).toString("base64url")
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
						return { secret }
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
							.pipe(Effect.mapError(unavailable))
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
							.pipe(Effect.mapError(unavailable))
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
			const denied = () => ChannelsApi.ChannelHookDenied.make({})
			return handlers.handleRaw("receiveChannelEvent", ({ params }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest
					const found = yield* channels.find(params.channelId)
					if (Option.isNone(found) || !found.value.channel.enabled)
						return yield* denied()
					const { organizationId, channel: stored } = found.value
					const channel = yield* registry
						.get(organizationId, stored)
						.pipe(Effect.mapError(unavailable))
					const body = yield* request.text.pipe(Effect.mapError(denied))
					const received = yield* channel
						.receive({
							headers: request.headers,
							body,
							now: yield* Clock.currentTimeMillis,
						})
						.pipe(
							Effect.tapError((failure) =>
								Effect.logInfo("A Channel webhook was denied", failure.reason),
							),
							Effect.mapError(denied),
						)
					yield* queue.receive(organizationId, stored.id, received.events)
					return HttpServerResponse.jsonUnsafe(received.reply ?? {})
				}),
			)
		}),
)
