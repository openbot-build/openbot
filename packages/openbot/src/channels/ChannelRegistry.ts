import type { ChannelsApi } from "@openbot-build/api"
import {
	Cause,
	Context,
	Crypto,
	Duration,
	Effect,
	Layer,
	RcMap,
	Scope,
} from "effect"
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
		/**
		 * Borrows the integration of a stored Channel version. The integration works until
		 * the scope closes.
		 */
		readonly get: (
			organizationId: string,
			channel: { readonly id: string; readonly version: number },
		) => Effect.Effect<
			Channel,
			ChannelsApi.ChannelsUnavailable | ChannelsApi.ChannelNotFound,
			Scope.Scope
		>
		/**
		 * Builds an integration from secrets that are not stored yet, such as on create.
		 * The integration works until the scope closes.
		 */
		readonly build: (
			id: string,
			credentials: Credentials,
		) => Effect.Effect<Channel, never, Scope.Scope>
	}
>()("@openbot-build/openbot/channels/ChannelRegistry") {}

export const make = Effect.gen(function* () {
	const channels = yield* Channels
	const client = yield* HttpClient.HttpClient
	const network = yield* AppNetwork
	const crypto = yield* Crypto.Crypto
	const platform = Http.fromClient(client)
	const build = (
		id: string,
		credentials: Credentials,
	): Effect.Effect<Channel, never, Scope.Scope> => {
		switch (credentials.kind) {
			case "slack":
				return Effect.succeed(SlackChannel.make(credentials, platform))
			case "lark":
				return LarkChannel.make(credentials, platform).pipe(
					Effect.provideService(Crypto.Crypto, crypto),
				)
			case "telegram":
				return Effect.succeed(TelegramChannel.make(credentials, platform))
			case "custom":
				// The endpoint is the only place that the Channel may call. The network is
				// made once, so its connections stay open for the next message.
				return Effect.map(
					Layer.build(
						network.layer("channel:" + id, [
							new URL(credentials.endpoint).origin,
						]),
					),
					(context) =>
						CustomChannel.make(credentials, Http.fromNetwork(context)),
				)
		}
	}
	// One integration for each Channel version, shared by everyone who uses it. An
	// integration closes some time after its last user is done, so a change of the
	// Channel never closes an integration that is still in use, and the integration of
	// a deleted Channel goes away too. RcMap compares the keys by value.
	type Key = readonly [organizationId: string, id: string, version: number]
	const integrations: RcMap.RcMap<
		Key,
		Channel,
		ChannelsApi.ChannelsUnavailable | ChannelsApi.ChannelNotFound
	> = yield* RcMap.make({
		lookup: (key: Key) =>
			channels.credentials(key[0], key[1]).pipe(
				Effect.flatMap((credentials) => build(key[1], credentials)),
				// A failed build is not kept, so the next use builds again.
				Effect.onError((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.void
						: RcMap.invalidate(integrations, key),
				),
			),
		idleTimeToLive: Duration.minutes(10),
	})
	return ChannelRegistry.of({
		build,
		get: (organizationId, target) =>
			RcMap.get(integrations, [organizationId, target.id, target.version]),
	})
})
export const layer = Layer.effect(ChannelRegistry, make)
