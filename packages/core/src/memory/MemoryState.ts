import { HashSet, Match } from "effect"
import { Prompt } from "effect/ai"
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

/** In coherent history, no client tool call is still waiting for a result. */
export const coherent = <P>(value: Memory.Value<P>): boolean => {
	if (!value.memory.closed) return false
	let pending = HashSet.empty<string>()
	for (const entry of value.memory.history)
		for (const message of entry.content.content)
			Match.value(message).pipe(
				Match.when({ role: "assistant" }, (message) => {
					for (const part of message.content)
						Match.value(part).pipe(
							Match.when({ type: "tool-call" }, (part) => {
								if (!part.providerExecuted)
									pending = HashSet.add(pending, part.id)
							}),
							Match.orElse(() => {}),
						)
				}),
				Match.when({ role: "tool" }, (message) => {
					for (const part of message.content)
						Match.value(part).pipe(
							Match.when({ type: "tool-result" }, (part) => {
								pending = HashSet.remove(pending, part.id)
							}),
							Match.orElse(() => {}),
						)
				}),
				Match.orElse(() => {}),
			)
	return HashSet.size(pending) === 0
}
