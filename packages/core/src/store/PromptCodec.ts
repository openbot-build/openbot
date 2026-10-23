import {
	Match,
	Effect,
	Schema,
	SchemaTransformation,
	Predicate,
	Array as ArrayUtils,
} from "effect"
import { Prompt } from "effect/ai"

const FileData = Schema.TaggedUnion({
	String: { value: Schema.String },
	Bytes: { value: Schema.Array(Schema.Int) },
	Url: { value: Schema.String },
})

/** Optional schema properties are left out at the JSON boundary. Array positions stay the same. */
export const omitOptional = (value: unknown): unknown => {
	if (ArrayUtils.isArray(value)) return value.map(omitOptional)
	if (
		Predicate.isObjectOrArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	)
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, field]) => field !== undefined)
				.map(([key, field]) => [key, omitOptional(field)]),
		)
	return value
}

/**
 * Since effect 4.0.6, the Prompt schema encodes bytes as `{ _tag: "Uint8Array", base64 }`
 * and URLs as `{ _tag: "URL", href }`. The stored format stays `String`, `Bytes` or `Url`.
 */
const encodeFileData = (
	data: Prompt.FilePartEncoded["data"],
): Effect.Effect<typeof FileData.Type, Schema.SchemaError> =>
	Predicate.isString(data)
		? Effect.succeed({ _tag: "String", value: data })
		: data instanceof URL
			? Effect.succeed({ _tag: "Url", value: data.href })
			: data instanceof Uint8Array
				? Effect.succeed({ _tag: "Bytes", value: Array.from(data) })
				: data._tag === "URL"
					? Effect.succeed({ _tag: "Url", value: data.href })
					: Schema.decodeEffect(Schema.Uint8ArrayFromBase64)(data.base64).pipe(
							Effect.map((bytes) => ({
								_tag: "Bytes",
								value: Array.from(bytes),
							})),
						)

const encodePrompt = (prompt: Prompt.Prompt) =>
	Effect.gen(function* () {
		const encoded = yield* Schema.encodeEffect(Prompt.Prompt)(prompt)
		const content = yield* Effect.forEach(encoded.content, (message) =>
			Effect.gen(function* () {
				if (Predicate.isString(message.content)) return message
				const parts: ReadonlyArray<(typeof message.content)[number]> =
					message.content
				return {
					...message,
					content: yield* Effect.forEach(parts, (part) =>
						Effect.gen(function* () {
							if (part.type !== "file") return part
							return { ...part, data: yield* encodeFileData(part.data) }
						}),
					),
				}
			}),
		)
		return yield* Schema.decodeUnknownEffect(Schema.Json)(
			omitOptional({ ...encoded, content }),
		)
	})

/** Media data has explicit tags, so a URL and a base64 string can always be told apart. */
export const PromptJson = Schema.Json.pipe(
	Schema.decodeTo(
		Schema.toType(Prompt.Prompt),
		SchemaTransformation.transformEffect({
			decode: (json) =>
				Effect.gen(function* () {
					const object = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ content: Schema.Array(Schema.JsonObject) }),
					)(json)
					const content = yield* Effect.forEach(object.content, (message) =>
						Effect.gen(function* () {
							if (Predicate.isString(message["content"])) return message
							const parts = yield* Schema.decodeUnknownEffect(
								Schema.Array(Schema.JsonObject),
							)(message["content"])
							return {
								...message,
								content: yield* Effect.forEach(parts, (part) =>
									Match.value(part["type"]).pipe(
										Match.when("file", () =>
											Effect.gen(function* () {
												const data = yield* Schema.decodeUnknownEffect(
													FileData,
												)(part["data"])
												return {
													...part,
													data: Match.value(data).pipe(
														Match.tag("String", (data) => data.value),
														Match.tag("Url", (data) => new URL(data.value)),
														Match.orElse((data) => Uint8Array.from(data.value)),
													),
												}
											}),
										),
										Match.orElse(() => Effect.succeed(part)),
									),
								),
							}
						}),
					)
					return yield* Schema.decodeUnknownEffect(Prompt.Prompt)({ content })
				}).pipe(Effect.mapError((error) => error.issue)),
			encode: (prompt) =>
				encodePrompt(prompt).pipe(Effect.mapError((error) => error.issue)),
		}),
	),
)
