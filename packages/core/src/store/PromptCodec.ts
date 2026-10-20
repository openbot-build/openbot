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

const encodePrompt = (prompt: Prompt.Prompt) =>
	Schema.encodeEffect(Prompt.Prompt)(prompt).pipe(
		Effect.map((encoded) => ({
			...encoded,
			content: encoded.content.map((message) =>
				Predicate.isString(message.content)
					? message
					: {
							...message,
							content: message.content.map((part) =>
								Match.value(part).pipe(
									Match.when({ type: "file" }, (part) => ({
										...part,
										data: Predicate.isString(part.data)
											? { _tag: "String" as const, value: part.data }
											: part.data instanceof URL
												? { _tag: "Url" as const, value: part.data.href }
												: {
														_tag: "Bytes" as const,
														value: Array.from(part.data),
													},
									})),
									Match.orElse((part) => part),
								),
							),
						},
			),
		})),
		Effect.flatMap((value) =>
			Schema.decodeUnknownEffect(Schema.Json)(omitOptional(value)),
		),
	)

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
