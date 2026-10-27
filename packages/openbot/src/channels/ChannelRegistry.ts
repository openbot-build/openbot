import type { Channels as ChannelsApi } from "@openbot-build/domain"
import { Context, Crypto, Data, Effect, Layer, RcMap, Scope } from "effect"
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
		 * Borrows the current Channel connection. The integration works until
		 * the scope closes.
		 */
		readonly get: (
			organizationId: string,
			id: string,
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
	// Read credentials and their version together. A later update must not put new
	// credentials under an old cache key. Data gives these keys value equality.
	type Key = {
		readonly organizationId: string
		readonly id: string
		readonly version: number
		readonly credentials: Credentials
	}
	const integrations = yield* RcMap.make({
		lookup: (key: Key) => build(key.id, key.credentials),
		// Active scopes may share a connection. The last scope closes it at once.
		idleTimeToLive: 0,
	})
	return ChannelRegistry.of({
		build,
		get: (organizationId, id) =>
			Effect.gen(function* () {
				const current = yield* channels.credentials(organizationId, id)
				return yield* RcMap.get(
					integrations,
					new Data.Class({
						organizationId,
						id,
						version: current.version,
						credentials: new Data.Class<Credentials>(current.credentials),
					}),
				)
			}),
	})
})
export const layer = Layer.effect(ChannelRegistry, make)
