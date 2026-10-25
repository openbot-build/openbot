import type { FilesApi } from "@openbot-build/api"
import { Effect, Option, Predicate, Stream } from "effect"
import { AiError, type LanguageModel, Prompt } from "effect/ai"
import type { Files } from "./Files.ts"
import { fileIdOf } from "./Refs.ts"
import { type Methods, methodsOf, withMethods } from "../models/ModelMethods.ts"

/** Puts the bytes of each named file in the prompt. A file that is gone becomes a short text. */
const resolve = (
	load: Files["Service"]["load"],
	prompt: Prompt.Prompt,
): Effect.Effect<Prompt.Prompt, FilesApi.FilesUnavailable> =>
	Effect.map(
		Effect.forEach(prompt.content, (message) =>
			Predicate.isString(message.content)
				? Effect.succeed(message)
				: Effect.map(
						Effect.forEach(message.content, (part) => {
							if (part.type !== "file" || !(part.data instanceof URL))
								return Effect.succeed(part)
							const id = fileIdOf(part.data)
							if (id === undefined) return Effect.succeed(part)
							return Effect.map(load(id), (content) =>
								Option.match(content, {
									onNone: () =>
										Prompt.makePart("text", {
											text: `[The file ${part.fileName ?? id} was deleted.]`,
										}),
									onSome: (content) => ({ ...part, data: content.bytes }),
								}),
							)
						}),
						(content) => ({ ...message, content }) as Prompt.Message,
					),
		),
		Prompt.fromMessages,
	)

/** Whether a prompt names a file, so most calls skip the work. */
const namesFile = (prompt: Prompt.Prompt) =>
	prompt.content.some(
		(message) =>
			!Predicate.isString(message.content) &&
			message.content.some(
				(part) =>
					part.type === "file" &&
					part.data instanceof URL &&
					fileIdOf(part.data) !== undefined,
			),
	)

/**
 * A model that loads the files of a prompt from storage just before each call.
 * The Chat keeps only the address of each file.
 */
export const withFiles = (
	model: LanguageModel.LanguageModel,
	load: Files["Service"]["load"],
): LanguageModel.LanguageModel => {
	const plain = methodsOf(model)
	const prepare = (method: string, options: unknown) => {
		const raw = (options as { readonly prompt: Prompt.RawInput }).prompt
		const prompt = Prompt.make(raw)
		if (!namesFile(prompt)) return Effect.succeed(options)
		return resolve(load, prompt).pipe(
			Effect.map((prompt) => ({ ...(options as object), prompt })),
			Effect.mapError(() =>
				AiError.make({
					module: "OpenBot",
					method,
					reason: AiError.UnknownError.make({
						description: "OpenBot could not read a file from storage.",
					}),
				}),
			),
		)
	}
	const methods: Methods = {
		generateText: (options) =>
			Effect.flatMap(prepare("generateText", options), plain.generateText),
		generateObject: (options) =>
			Effect.flatMap(prepare("generateObject", options), plain.generateObject),
		streamText: (options) =>
			Stream.unwrap(
				Effect.map(prepare("streamText", options), plain.streamText),
			),
	}
	return withMethods(model, methods)
}
