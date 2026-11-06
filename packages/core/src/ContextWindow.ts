import { Context, Schema } from "effect"
import { dual } from "effect/Function"
import { Prompt } from "effect/ai"
import * as Model from "./Model.ts"
import * as Provider from "./Provider.ts"

/** A native window is an ordered, opaque provider response, then new messages. */
export const Window = Schema.TaggedUnion({
	Prompt: { prompt: Prompt.Prompt },
	Native: {
		provider: Provider.Id,
		model: Model.Id,
		items: Schema.Array(Schema.Json),
		prompt: Prompt.Prompt,
	},
})
export type Window = typeof Window.Type

export const fromPrompt = (prompt: Prompt.RawInput): Window =>
	Window.make({ _tag: "Prompt", prompt: Prompt.make(prompt) })

export const append: {
	(input: Prompt.RawInput): (window: Window) => Window
	(window: Window, input: Prompt.RawInput): Window
} = dual(2, (window: Window, input: Prompt.RawInput): Window => ({
	...window,
	prompt: Prompt.concat(window.prompt, input),
}))

/**
 * Provided at the model boundary. Providers read opaque input without
 * interpreting it. A call that gets no window, such as a helper model call, reads
 * an empty prompt window, so it sends no native items.
 */
export const CurrentWindow = Context.Reference<Window>(
	"@openbot-build/core/ContextWindow/CurrentWindow",
	{ defaultValue: () => fromPrompt([]) },
)
