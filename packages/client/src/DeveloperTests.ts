import type { Execution } from "@openbot-build/domain"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

/** Keep the returned command to retry a check after a lost reply. */
export const run = Effect.fn("DeveloperTests.run")(function* (
	id: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.developer.runTest({
				params: { id },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})

/** Prepare a test sign-in. Read its link from the test after the execution ends. */
export const authorize = Effect.fn("DeveloperTests.authorize")(function* (
	id: string,
	input: { readonly issuer?: string; readonly scopes: ReadonlyArray<string> },
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.developer.authorizeTest({
				params: { id },
				payload: { ...input, commandKey: key },
			}),
		commandKey,
	)
})

/** Exchange the received code through a saved command. */
export const completeAuthorization = Effect.fn(
	"DeveloperTests.completeAuthorization",
)(function* (
	id: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.developer.completeTestAuthorization({
				params: { id },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})

/** Keep this command to retry the same cleanup request. */
export const cancel = Effect.fn("DeveloperTests.cancel")(function* (
	id: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.developer.cancelTest({
				params: { id },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})

/** Keep this command to retry the same cleanup request. */
export const cleanup = Effect.fn("DeveloperTests.cleanup")(function* (
	id: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.developer.cleanupTest({
				params: { id },
				payload: { commandKey: key },
			}),
		commandKey,
	)
})

/** Keep this command to retry the same cleanup request. */
export const remove = Effect.fn("DeveloperTests.remove")(function* (
	id: string,
	commandKey?: Execution.CommandKey,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(key) =>
			api.developer.deleteTest({ params: { id }, query: { commandKey: key } }),
		commandKey,
	)
})
