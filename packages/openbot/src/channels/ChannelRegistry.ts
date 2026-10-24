import type { ChannelsApi } from "@openbot-build/api"
import {
	Context,
	Effect,
	Exit,
	HashMap,
	Layer,
	Scope,
	SynchronizedRef,
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
		readonly get: (
			organizationId: string,
			channel: { readonly id: string; readonly version: number },
		) => Effect.Effect<
			Channel,
			ChannelsApi.ChannelsUnavailable | ChannelsApi.ChannelNotFound
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
	const platform = Http.fromClient(client)
	const build = (
		id: string,
		credentials: Credentials,
	): Effect.Effect<Channel, never, Scope.Scope> => {
		switch (credentials.kind) {
			case "slack":
				return Effect.succeed(SlackChannel.make(credentials, platform))
			case "lark":
				return LarkChannel.make(credentials, platform)
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
	// One integration for each Channel version. A change of the Channel builds a new one,
	// and closes the scope of the old one. All scopes close when the registry stops.
	const registryScope = yield* Effect.scope
	const cache = yield* SynchronizedRef.make(
		HashMap.empty<
			string,
			{
				readonly version: number
				readonly channel: Channel
				readonly scope: Scope.Closeable
			}
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
					const scope = yield* Scope.fork(registryScope)
					const channel = yield* build(target.id, credentials).pipe(
						Scope.provide(scope),
					)
					if (found._tag === "Some")
						yield* Scope.close(found.value.scope, Exit.void)
					return [
						channel,
						HashMap.set(current, target.id, {
							version: target.version,
							channel,
							scope,
						}),
					] as const
				}),
			),
	})
})
export const layer = Layer.effect(ChannelRegistry, make)
