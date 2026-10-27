import {
	ChatNotFound,
	ChatConflict,
	ChatStorageUnavailable,
} from "@openbot-build/domain"
import { Effect } from "effect"
import * as Failures from "../errors/Failures.ts"
import type { InputCommands } from "./InputCommands.ts"
import type * as ChatCommands from "./ChatCommands.ts"
import type * as ChatQueries from "./ChatQueries.ts"
import type * as ToolQueries from "./ToolQueries.ts"

type QueryError = Effect.Error<
	| ReturnType<Effect.Success<typeof ToolQueries.make>["list" | "read"]>
	| ReturnType<InputCommands["Service"]["message"]>
	| ReturnType<Effect.Success<typeof ChatQueries.make>["get" | "models"]>
	| ReturnType<
			Effect.Success<typeof ChatCommands.make>[
				"update" | "todos" | "direct" | "createLive"]
	  >
>
type MappedError = Extract<
	QueryError,
	{
		readonly _tag:
			| "ChatNotFound"
			| "ChatConflict"
			| "ChatStoreError"
			| "ModelConfigurationError"
			| "BotStorageUnavailable"
	}
>
type DomainError = ChatNotFound | ChatConflict | ChatStorageUnavailable
function domainError<E extends QueryError>(
	error: E,
): Exclude<E, MappedError> | DomainError
function domainError(
	error: QueryError,
): Exclude<QueryError, MappedError> | DomainError {
	switch (error._tag) {
		case "ChatNotFound":
			return ChatNotFound.make({ chat: error.chat })
		case "ChatConflict":
			return ChatConflict.make({ message: error.message })
		case "ChatStoreError":
			return error.reason === "reference-conflict"
				? ChatConflict.make({ message: error.message })
				: ChatStorageUnavailable.make({})
		case "ModelConfigurationError":
		case "BotStorageUnavailable":
			return ChatStorageUnavailable.make({})
		default:
			return error
	}
}

/** Give application failures while keeping private details for the outside boundary. */
export const map = <A, E extends QueryError, R>(work: Effect.Effect<A, E, R>) =>
	work.pipe(
		Failures.map(
			"OpenBot could not read or write saved Chat data.",
			(error: E) => domainError(error),
		),
	)
