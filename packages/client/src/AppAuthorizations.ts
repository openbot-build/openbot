import type {
	AppAuthorizations,
	ConnectionId,
	Execution,
} from "@openbot-build/domain"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

export const complete = Effect.fn("AppAuthorizations.complete")(function* (
	flowId: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.appAuthorization.completeAppAuthorization({
				params: { flowId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})
export const revoke = Effect.fn("AppAuthorizations.revoke")(function* (
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
			api.appAuthorization.revokeAppAuthorization({
				params: { connectionId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})

export const refresh = Effect.fn("AppAuthorizations.refresh")(function* (
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
			api.connections.refreshConnectionAuthorization({
				params: { connectionId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})

export const begin = Effect.fn("AppAuthorizations.begin")(function* (
	connectionId: ConnectionId,
	input: AppAuthorizations.Begin,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.appAuthorization.beginAppAuthorization({
				params: { connectionId },
				payload: { ...input, commandKey: key },
			}),
		commandKey,
	)
})

export const remove = Effect.fn("AppAuthorizations.remove")(function* (
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
			api.connections.deleteConnection({
				params: { connectionId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})

export const reset = Effect.fn("AppAuthorizations.reset")(function* (
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) => api.appExperience.reset({ payload: { commandKey: key } }),
		commandKey,
	)
})
