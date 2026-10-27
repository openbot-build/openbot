import type {
	AppConnections,
	ConnectionId,
	Execution,
} from "@openbot-build/domain"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

export const verify = Effect.fn("Connections.verify")(function* (
	connectionId: ConnectionId,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.connections.verifyConnection({
				params: { connectionId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})
export const update = Effect.fn("Connections.update")(function* (
	connectionId: ConnectionId,
	input: AppConnections.Update,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.connections.updateConnection({
				params: { connectionId },
				payload: { ...input, commandKey: key },
			}),
		commandKey,
	)
})
export const updateManual = Effect.fn("Connections.updateManual")(function* (
	connectionId: ConnectionId,
	input: AppConnections.ManualUpdate,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.connections.updateManualConnection({
				params: { connectionId },
				payload: { ...input, commandKey: key },
			}),
		commandKey,
	)
})
export const revalidate = Effect.fn("Connections.revalidate")(function* (
	connectionId: ConnectionId,
	input: AppConnections.Revalidation,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.connections.revalidateConnection({
				params: { connectionId },
				payload: { ...input, commandKey: key },
			}),
		commandKey,
	)
})
