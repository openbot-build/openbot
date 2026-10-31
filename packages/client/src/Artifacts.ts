import type { Chat } from "@openbot-build/core"
import type { ArtifactsApi } from "@openbot-build/api"
import type { Execution } from "@openbot-build/domain"
import { Crypto, Effect, type PlatformError } from "effect"
import { Client, type ClientError } from "./Client.ts"
import { prepare, type Command } from "./Command.ts"

type WithKey<A extends { readonly commandKey: Execution.CommandKey }> = Omit<
	A,
	"commandKey"
> & { readonly commandKey?: Execution.CommandKey }

/** Make a publish command. Reuse send when a reply is lost. */
export const publish = Effect.fn("Artifacts.publish")(function* (
	chatId: Chat.Id,
	input: WithKey<ArtifactsApi.PublishArtifactRequest>,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.artifacts.publishArtifact({
				params: { chatId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})

/** A new version keeps the artifact ID. Old versions keep their bytes. */
export const publishVersion = Effect.fn("Artifacts.publishVersion")(function* (
	chatId: Chat.Id,
	artifactId: ArtifactsApi.ArtifactId,
	input: WithKey<ArtifactsApi.PublishVersionRequest>,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.artifacts.publishVersion({
				params: { chatId, artifactId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})

/** Save the material that a Chat can later cite. */
export const captureSource = Effect.fn("Artifacts.captureSource")(function* (
	chatId: Chat.Id,
	input: WithKey<ArtifactsApi.CaptureSourceRequest>,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.artifacts.captureSource({
				params: { chatId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})

/** Add saved source references to a saved message. */
export const cite = Effect.fn("Artifacts.cite")(function* (
	chatId: Chat.Id,
	input: WithKey<ArtifactsApi.RecordCitationsRequest>,
): Effect.fn.Return<
	Command<Execution.Receipt, ClientError>,
	PlatformError.PlatformError,
	Client | Crypto.Crypto
> {
	const { api } = yield* Client
	return yield* prepare(
		(commandKey) =>
			api.artifacts.recordCitations({
				params: { chatId },
				payload: { ...input, commandKey },
			}),
		input.commandKey,
	)
})
