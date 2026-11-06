/**
 * Parts of the limit tests that a test and a server process both use: a
 * model that asks for a host tool and then answers, and a test plugin with a
 * Bot feature that a Turn waits for when it is gone.
 */
import { Plugin as GraftPlugin } from "@graftland/graft"
import { Array as Arr, Context, Effect, Option, Stream } from "effect"
import { LanguageModel, type Prompt, Response } from "effect/ai"
import { Plugin } from "@openbot-build/core"
import * as BotFeaturesModule from "@openbot-build/conversation-contract/chats/BotFeatures"
import { BotFeatures } from "@openbot-build/conversation-contract/chats/BotFeatures"

/** Each model step uses 2 tokens. */
const usage = {
	inputTokens: { total: 1, uncached: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 1, text: 1, reasoning: 0 },
}

const answer = Stream.make(
	Response.makePart("text-start", { id: "answer" }),
	Response.makePart("text-delta", { id: "answer", delta: "Done." }),
	Response.makePart("text-end", { id: "answer" }),
	Response.makePart("finish", { reason: "stop", usage }),
)

/** The number of tool messages after the last message of the person. */
export const toolResults = (prompt: Prompt.Prompt) => {
	const last = Option.getOrElse(
		Arr.findLastIndex(prompt.content, (message) => message.role === "user"),
		() => -1,
	)
	return Arr.filter(
		Arr.drop(prompt.content, last + 1),
		(message) =>
			message.role === "tool" &&
			Arr.some(message.content, (part) => part.type === "tool-result"),
	).length
}

/**
 * A model that asks for the host tool `GetValue` in its first `calls` steps
 * and answers in the step after them. `before` runs before each request,
 * with the number of tool results so far. When it gives false, the request
 * never ends.
 */
export const toolsThenAnswer = (
	calls: number,
	before: (results: number) => Effect.Effect<boolean>,
) =>
	LanguageModel.make({
		generateText: () =>
			Effect.succeed([Response.makePart("text", { text: '{"changes":[]}' })]),
		streamText: ({ prompt }) =>
			Stream.unwrap(
				Effect.map(
					before(toolResults(prompt)),
					(go): Stream.Stream<Response.StreamPartEncoded> =>
						!go
							? Stream.never
							: toolResults(prompt) >= calls
								? answer
								: Stream.make(
										Response.makePart("tool-call", {
											id: `limit-call-${prompt.content.length}`,
											name: "GetValue",
											params: { key: "limit" },
											providerExecuted: false,
										}),
										Response.makePart("finish", {
											reason: "tool-calls",
											usage,
										}),
									),
				),
			),
	})

/** The id of the test feature that waits, in the plugins file and in the pin. */
export const waitFeature = "@openbot-build/server-testing/wait-feature"

/**
 * A plugin of the test with a Bot feature that gives nothing. When it is gone,
 * a later phase of a Turn waits for it for at most 2 seconds.
 */
export const waitPlugin = {
	entry: { id: "wait-feature", name: waitFeature },
	plugins: {
		[waitFeature]: GraftPlugin.make({
			name: waitFeature,
			inject: [BotFeatures],
			apply: () =>
				Effect.flatMap(BotFeatures, (features) =>
					features.contribute({
						id: waitFeature,
						version: 1,
						order: 100,
						build: "normal",
						review: true,
						restores: [],
						missing: BotFeaturesModule.wait("2 seconds"),
						settings: Effect.succeed(null),
						prepare: () =>
							Effect.succeed(
								BotFeaturesModule.fromPlugin(
									waitFeature,
									Plugin.make({ id: Plugin.Id.make(waitFeature) })(() =>
										Effect.succeed({ tools: {}, handlers: Context.empty() }),
									),
								),
							),
					}),
				),
		}),
	},
}
