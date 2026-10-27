import { type Execution } from "@openbot-build/domain"
import { type ChannelsApi } from "@openbot-build/api"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

type Input<A> = Omit<A, "commandKey"> & {
	readonly commandKey?: Execution.CommandKey
}
/** Prepare one configuration. Transport retries keep its command key. */
export const create = Effect.fn("Channels.create")(function* (
	input: Input<ChannelsApi.CreateChannelRequest>,
): Effect.fn.Return<
	Command<ChannelsApi.Channel, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.channels.createChannel({ payload: { ...input, commandKey } }),
		input.commandKey,
	)
})
export const update = Effect.fn("Channels.update")(function* (
	channelId: ChannelsApi.ChannelId,
	input: Input<ChannelsApi.UpdateChannelRequest>,
): Effect.fn.Return<
	Command<ChannelsApi.Channel, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.channels.updateChannel({
				params: { channelId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})
/** A lost reply returns the same secret. It never rotates a second time. */
export const rotateSecret = Effect.fn("Channels.rotateSecret")(function* (
	channelId: ChannelsApi.ChannelId,
	input: {
		readonly expectedVersion: number
		readonly commandKey?: Execution.CommandKey
	},
): Effect.fn.Return<
	Command<ChannelsApi.ChannelSecret, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.channels.setChannelSecret({
				params: { channelId },
				payload: { expectedVersion: input.expectedVersion, commandKey },
			}),
		input.commandKey,
	)
})

/** Delete after active Channel work has released its resources. */
export const remove = Effect.fn("Channels.remove")(function* (
	channelId: ChannelsApi.ChannelId,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.channels.deleteChannel({
				params: { channelId },
				payload: { commandKey },
			}),
		commandKey,
	)
})
