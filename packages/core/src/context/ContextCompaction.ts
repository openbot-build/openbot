import { Context, Schema, type Effect } from "effect"
import { type LanguageModel, type Prompt, type Toolkit } from "effect/ai"
import type * as Config from "../models/Config.ts"
import type * as ContextWindow from "./ContextWindow.ts"

export interface Request {
	readonly selection: Config.Selection
	readonly window: ContextWindow.Window
	readonly instructions: Prompt.Prompt
	readonly toolkit: Toolkit.Any
	readonly toolChoice?: LanguageModel.ProviderOptions["toolChoice"]
}

export interface NonNativeRequest {
	readonly prompt: Prompt.Prompt
	readonly targetTokens: number
	readonly keepRecentMessages?: number
}

export type NonNativeCompact = (
	input: NonNativeRequest,
) => Effect.Effect<
	ContextWindow.Window,
	ContextCompactionError,
	LanguageModel.LanguageModel
>

export class ContextCompactionError extends Schema.TaggedError<ContextCompactionError>()(
	"ContextCompactionError",
	{
		reason: Schema.Literals([
			"unsupported",
			"request-failed",
			"input-too-large",
			"target-not-reached",
			"invalid-target",
			"head-conflict",
		]),
		message: Schema.String,
	},
) {}

export class ContextCompaction extends Context.Service<
	ContextCompaction,
	{
		readonly count: (
			request: Request,
		) => Effect.Effect<number, ContextCompactionError>
		readonly compact: (
			request: Request,
		) => Effect.Effect<ContextWindow.Window, ContextCompactionError>
	}
>()("@openbot-build/core/context/ContextCompaction") {}
