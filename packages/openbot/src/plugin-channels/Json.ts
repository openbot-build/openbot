import { Option, Predicate, Schema } from "effect"

/**
 * Small readers for the JSON of platforms. Each platform sends many event shapes, and a
 * Channel only reads a few fields of each, so these are lighter than a full schema.
 */
const decodeJson = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Unknown),
)

/** The JSON value of the text, or `undefined` when the text is not JSON. */
export const parse = (value: string): unknown =>
	Option.getOrUndefined(decodeJson(value))

export const field = (value: unknown, key: string): unknown =>
	Predicate.isObject(value)
		? (value as Record<string, unknown>)[key]
		: undefined

export const text = (value: unknown, key: string) => {
	const found = field(value, key)
	return Predicate.isString(found) ? found : undefined
}

/** A number or a string, as text. Platforms send IDs both ways. */
export const id = (value: unknown, key: string) => {
	const found = field(value, key)
	return Predicate.isNumber(found) || Predicate.isString(found)
		? String(found)
		: undefined
}
