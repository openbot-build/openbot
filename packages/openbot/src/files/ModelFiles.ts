import type { FilesApi } from "@openbot-build/api"
import { Array as Arr, Effect, Option, Predicate, Stream } from "effect"
import { AiError, type LanguageModel, Prompt } from "effect/ai"
import type { Files } from "./Files.ts"
import { fileIdOf } from "./Refs.ts"
import {
	type Methods,
	methodsOf,
	type Options,
	withMethods,
} from "../models/ModelMethods.ts"

type Load = Files["Service"]["load"]

/** A file part that names a stored file, with the ID of that file. */
const fileOf = (
	part: Prompt.Part,
): Option.Option<{ readonly part: Prompt.FilePart; readonly id: string }> =>
	part.type === "file" && part.data instanceof URL
		? Option.map(fileIdOf(part.data), (id) => ({ part, id }))
		: Option.none()

/** Puts the bytes of a named file in the part. A file that is gone becomes a short text. */
const resolvePart =
	(load: Load) =>
	<P extends Prompt.Part>(
		part: P,
	): Effect.Effect<
		P | Prompt.TextPart | Prompt.FilePart,
		FilesApi.FilesUnavailable
	> =>
		Option.match(fileOf(part), {
			onNone: () => Effect.succeed(part),
			onSome: ({ part: file, id }) =>
				Effect.map(
					load(id),
					Option.match({
						onNone: () =>
							Prompt.makePart("text", {
								text: `[The file ${file.fileName ?? id} was deleted.]`,
							}),
						onSome: (content): Prompt.FilePart => ({
							...file,
							data: content.bytes,
						}),
					}),
				),
		})

/** Only user and assistant messages can hold file parts. */
const resolveMessage = (
	load: Load,
	message: Prompt.Message,
): Effect.Effect<Prompt.Message, FilesApi.FilesUnavailable> => {
	switch (message.role) {
		case "user":
			return Effect.map(
				Effect.forEach(message.content, resolvePart(load)),
				(content) => ({ ...message, content }),
			)
		case "assistant":
			return Effect.map(
				Effect.forEach(message.content, resolvePart(load)),
				(content) => ({ ...message, content }),
			)
		default:
			return Effect.succeed(message)
	}
}

/** Puts the bytes of each named file in the prompt. */
const resolve = (
	load: Load,
	prompt: Prompt.Prompt,
): Effect.Effect<Prompt.Prompt, FilesApi.FilesUnavailable> =>
	Effect.map(
		Effect.forEach(prompt.content, (message) => resolveMessage(load, message)),
		Prompt.fromMessages,
	)

/** Whether a prompt names a file, so most calls skip the work. */
const namesFile = (prompt: Prompt.Prompt) =>
	Arr.some(
		prompt.content,
		(message) =>
			!Predicate.isString(message.content) &&
			Arr.some<Prompt.Part>(message.content, (part) =>
				Option.isSome(fileOf(part)),
			),
	)

/**
 * A model that loads the files of a prompt from storage just before each call.
 * The Chat keeps only the address of each file.
 */
export const withFiles = (
	model: LanguageModel.LanguageModel,
	load: Load,
): LanguageModel.LanguageModel => {
	const plain = methodsOf(model)
	const prepare = (
		method: string,
		options: Options,
	): Effect.Effect<Options, AiError.AiError> => {
		const prompt = Prompt.make(options.prompt)
		if (!namesFile(prompt)) return Effect.succeed(options)
		return resolve(load, prompt).pipe(
			Effect.map((prompt) => ({ ...options, prompt })),
			// `FilesUnavailable` holds no details. `Files` logs the reason when it fails.
			Effect.catchTag("FilesUnavailable", () =>
				Effect.fail(
					AiError.make({
						module: "OpenBot",
						method,
						reason: AiError.UnknownError.make({
							description: "OpenBot could not read a file from storage.",
						}),
					}),
				),
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
