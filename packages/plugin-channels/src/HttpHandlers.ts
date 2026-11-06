import {
	ChannelsUnavailable,
	ChannelNotFound,
	ChannelIdentityNotFound,
	ChannelHookDenied,
	type Channel,
} from "@openbot-build/domain/Channels"
import type { AuditAction } from "@openbot-build/domain/Organizations"
import { type Caller, Identity } from "@openbot-build/domain/Identity"
import { ChannelRemoval } from "./ChannelRemoval.ts"
import { ChannelConfig } from "./ChannelConfig.ts"
import * as HttpErrors from "@openbot-build/server-execution/HttpErrors"
import { ChannelsApi, OpenBotApi } from "@openbot-build/api"
import { Array as Arr, Clock, Effect, Option, type Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "@openbot-build/server-kernel/Failures"
import { AuditLog } from "@openbot-build/identity-contract/audit/AuditLog"
import { organizationKey, segment } from "@openbot-build/domain/AuditResources"
import { Channels } from "@openbot-build/conversation-contract/channels/Channels"
import { ChannelQueue } from "./ChannelQueue.ts"
import { ChannelRegistry } from "./ChannelRegistry.ts"
import * as Platform from "@openbot-build/server-kernel/Platform"
import { Settings } from "@openbot-build/server-kernel/Settings"

const channelKey = (organizationId: string, id: string) =>
	organizationKey(organizationId) + ".channel." + segment(id)

/** The API view of a stored Channel, with the address that its platform calls. */
const view = (publicOrigin: string, channel: Channel): ChannelsApi.Channel => ({
	...channel,
	webhookUrl: `${publicOrigin}/v1/hooks/channels/${channel.id}`,
})

export const layer = HttpApiBuilder.group(OpenBotApi, "channels", (handlers) =>
	Effect.gen(function* () {
		const channels = yield* Channels
		const config = yield* ChannelConfig
		const removal = yield* ChannelRemoval
		const safe = yield* HttpErrors.make
		const audit = yield* AuditLog
		const settings = yield* Settings
		/** The webhook addresses use the public origin of the platform now. */
		const publicOrigin = Platform.publicOriginOr(settings, () =>
			ChannelsUnavailable.make({}),
		)
		const record = (
			caller: Caller,
			action: AuditAction,
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
						() => ChannelsUnavailable.make({}),
					),
				)
		const found = (caller: Caller, id: string) =>
			channels.get(caller.organizationId, id).pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.fail(ChannelNotFound.make({ id })),
						onSome: Effect.succeed,
					}),
				),
			)
		return handlers
			.handle("listChannels", () =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const origin = yield* publicOrigin
					const list = yield* channels.list(caller)
					return Arr.map(list, (channel) => view(origin, channel))
				}),
			)
			.handle("createChannel", ({ payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					return view(
						yield* publicOrigin,
						yield* config.create(caller, payload.commandKey, payload),
					)
				}).pipe(safe),
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
					return view(
						yield* publicOrigin,
						yield* config.update(
							caller,
							payload.commandKey,
							params.channelId,
							payload,
						),
					)
				}).pipe(safe),
			)
			.handle("deleteChannel", ({ params, payload }) =>
				Effect.flatMap(Identity, (caller) =>
					removal.request(caller, params.channelId, payload.commandKey),
				).pipe(safe),
			)
			.handle("setChannelSecret", ({ params, payload }) =>
				Effect.gen(function* () {
					const caller = yield* Identity
					const result = yield* config.rotate(
						caller,
						payload.commandKey,
						params.channelId,
						payload.expectedVersion,
					)
					return {
						secret: result.secret,
						channel: view(yield* publicOrigin, result.channel),
					}
				}).pipe(safe),
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
					if (!removed) return yield* ChannelIdentityNotFound.make({})
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
									() => ChannelsUnavailable.make({}),
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
						if (!removed) return yield* ChannelIdentityNotFound.make({})
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
									() => ChannelsUnavailable.make({}),
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
							return yield* ChannelHookDenied.make({})
						const { organizationId, channel: stored } = found.value
						// A Channel that went away since `find` is denied, like one that is not there.
						const channel = yield* registry
							.get(organizationId, stored.id)
							.pipe(
								Effect.catchTag("ChannelNotFound", () =>
									Effect.fail(ChannelHookDenied.make({})),
								),
							)
						const body = yield* request.text.pipe(
							Failures.replace(
								"OpenBot could not read the body of a Channel webhook",
								() => ChannelHookDenied.make({}),
							),
						)
						const received = yield* channel
							.receive({
								headers: request.headers,
								body,
								now: yield* Clock.currentTimeMillis,
							})
							.pipe(
								Failures.replaceTag(
									"ChannelDenied",
									"A Channel webhook was denied",
									() => ChannelHookDenied.make({}),
								),
							)
						yield* queue.receive(organizationId, stored.id, received.events)
						return HttpServerResponse.jsonUnsafe(received.reply ?? {})
					}),
				).pipe(Effect.annotateLogs({ channel: params.channelId })),
			)
		}),
)
