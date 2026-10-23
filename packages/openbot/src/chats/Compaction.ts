import { Config, ContextCompaction } from "@openbot-build/core"
import { Effect } from "effect"
import { Tool } from "effect/ai"

/** About four characters of JSON make one token. It is a guess, not a count. */
const charactersPerToken = 4

/** The parameters of a tool. A tool whose schema cannot be made counts without it. */
const schemaOf = (tool: Tool.Any): unknown => {
	try {
		return Tool.getJsonSchema(tool)
	} catch {
		return null
	}
}

/**
 * A guess of the input tokens of one model step: the context window, the instructions
 * and the tools. OpenBot uses it to see when the context of a Chat gets near the
 * window of its model.
 */
export const estimate = (request: ContextCompaction.Request): number => {
	const window = request.window
	const tools = Object.values(request.toolkit.tools).map((tool) => [
		tool.name,
		tool.description,
		schemaOf(tool),
	])
	const text =
		JSON.stringify(
			window._tag === "Native" ? [window.items, window.prompt] : window.prompt,
		) +
		JSON.stringify(request.instructions) +
		JSON.stringify(tools)
	return Math.ceil(text.length / charactersPerToken)
}

/**
 * The compaction of every Chat. It counts with the guess above. A Chat that gets near
 * the window of its model gets a summary, written by the model of the Chat, so this
 * service never compacts in the way of one provider.
 */
export const service = ContextCompaction.ContextCompaction.of({
	count: (request) => Effect.succeed(estimate(request)),
	compact: () =>
		Effect.fail(
			new ContextCompaction.ContextCompactionError({
				reason: "unsupported",
				message: "OpenBot compacts the context of a Chat with a summary.",
			}),
		),
})

/** A model compacts with a summary, unless its configuration says otherwise. */
export const withSummary = (model: Config.Model): Config.Model =>
	model.compaction !== undefined
		? model
		: Config.Model.make({
				...model,
				compaction: Config.Compaction.NonNative({}),
			})
