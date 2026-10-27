import type { Computers as Domain, Execution } from "@openbot-build/domain"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

export const create = Effect.fn("Computers.create")(function* (
	input: Domain.CreateComputerRequest,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.computers.createComputer({ payload: { ...input, commandKey: key } }),
		commandKey,
	)
})

export const pause = Effect.fn("Computers.pause")(function* (
	computerId: Domain.ComputerId,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.computers.pauseComputer({
				params: { computerId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})

export const resume = Effect.fn("Computers.resume")(function* (
	computerId: Domain.ComputerId,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.computers.resumeComputer({
				params: { computerId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})

export const remove = Effect.fn("Computers.remove")(function* (
	computerId: Domain.ComputerId,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.computers.deleteComputer({
				params: { computerId },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})
