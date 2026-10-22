import type { ChannelsApi } from "@openbot-build/api"
import { Context, Effect, HashMap, Layer, SynchronizedRef } from "effect"
import { HttpClient } from "effect/http"
import { AppNetwork } from "../apps/AppHost.ts"
import type { Channel } from "./Channel.ts"
import { Channels, type Credentials } from "./Channels.ts"
import * as CustomChannel from "./custom/CustomChannel.ts"
import * as Http from "./Http.ts"
import * as LarkChannel from "./lark/LarkChannel.ts"
import * as SlackChannel from "./slack/SlackChannel.ts"
import * as TelegramChannel from "./telegram/TelegramChannel.ts"

/** The integration of each stored Channel, built from its secrets. */
export class ChannelRegistry extends Context.Service<
	ChannelRegistry,
	{
		readonly get: (
			organizationId: string,
			channel: { readonly id: string; readonly version: number },
		) => Effect.Effect<
			Channel,
			ChannelsApi.ChannelsUnavailable | ChannelsApi.ChannelNotFound
		>
		/** Builds an integration from secrets that are not stored yet, such as on create. */
		readonly build: (
			id: string,
			credentials: Credentials,
		) => Effect.Effect<Channel>
	}
>()("@openbot-build/openbot/channels/ChannelRegistry") {}

export const make = Effect.gen(function* () {
	const channels = yield* Channels
	const client = yield* HttpClient.HttpClient
	const network = yield* AppNetwork
	const platform = Http.fromClient(client)
	const build = (
		id: string,
		credentials: Credentials,
	): Effect.Effect<Channel> => {
		switch (credentials.kind) {
			case "slack":
				return Effect.succeed(SlackChannel.make(credentials, platform))
			case "lark":
				return LarkChannel.make(credentials, platform)
			case "telegram":
				return Effect.succeed(TelegramChannel.make(credentials, platform))
			case "custom":
				return Effect.succeed(
					CustomChannel.make(
						credentials,
						// The endpoint is the only place that the Channel may call.
						Http.fromNetwork(
							network.layer("channel:" + id, [
								new URL(credentials.endpoint).origin,
							]),
						),
					),
				)
		}
	}
	// One integration for each Channel version. A change of the Channel builds a new one.
	const cache = yield* SynchronizedRef.make(
		HashMap.empty<
			string,
			{ readonly version: number; readonly channel: Channel }
		>(),
	)
	return ChannelRegistry.of({
		build,
		get: (organizationId, target) =>
			SynchronizedRef.modifyEffect(cache, (current) =>
				Effect.gen(function* () {
					const found = HashMap.get(current, target.id)
					if (found._tag === "Some" && found.value.version === target.version)
						return [found.value.channel, current] as const
					const credentials = yield* channels.credentials(
						organizationId,
						target.id,
					)
					const channel = yield* build(target.id, credentials)
					return [
						channel,
						HashMap.set(current, target.id, {
							version: target.version,
							channel,
						}),
					] as const
				}),
			),
	})
})
export const layer = Layer.effect(ChannelRegistry, make)
