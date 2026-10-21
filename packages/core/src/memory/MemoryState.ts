import { HashMap, Match } from "effect"
import { Prompt } from "effect/ai"
import type * as Item from "./Item.ts"
import type * as Memory from "./Memory.ts"
import * as ContextWindow from "../context/ContextWindow.ts"

export const initial = <P>(plugins: P): Memory.Value<P> => ({
	...plugins,
	memory: {
		history: [],
		context: ContextWindow.fromPrompt(Prompt.empty),
		closed: true,
	},
})
export const fullHistory = <P>(value: Memory.Value<P>): Prompt.Prompt =>
	value.memory.history.reduce(
		(prompt, entry) => Prompt.concat(prompt, entry.content),
		Prompt.empty,
	)

/** Client tool calls in the history that have no tool result yet, by call ID. */
export const unansweredCalls = (
	history: ReadonlyArray<Item.Record>,
): HashMap.HashMap<string, Prompt.ToolCallPart> =>
	history
		.flatMap((entry) => entry.content.content)
		.reduce(
			(calls, message) =>
				Match.value(message).pipe(
					Match.when({ role: "assistant" }, (message) =>
						message.content.reduce(
							(calls, part) =>
								part.type === "tool-call" && !part.providerExecuted
									? HashMap.set(calls, part.id, part)
									: calls,
							calls,
						),
					),
					Match.when({ role: "tool" }, (message) =>
						message.content.reduce(
							(calls, part) =>
								part.type === "tool-result"
									? HashMap.remove(calls, part.id)
									: calls,
							calls,
						),
					),
					Match.orElse(() => calls),
				),
			HashMap.empty<string, Prompt.ToolCallPart>(),
		)

/** In coherent history, no client tool call is still waiting for a result. */
export const coherent = <P>(value: Memory.Value<P>): boolean =>
	value.memory.closed && HashMap.isEmpty(unansweredCalls(value.memory.history))
