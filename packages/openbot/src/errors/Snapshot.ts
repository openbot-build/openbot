import { Array as Arr, Cause, Option, Redacted, Schema } from "effect"

/** Private diagnostic data. It is sealed before it enters storage or a log. */
const value = (
	input: unknown,
	parents: ReadonlyArray<object> = [],
): Schema.Json => {
	if (input === null || typeof input === "string" || typeof input === "boolean")
		return input
	if (typeof input === "number")
		return Number.isFinite(input) ? input : String(input)
	if (typeof input !== "object")
		return { type: typeof input, value: String(input) }
	if (Redacted.isRedacted(input)) {
		// A storage error hides its Cause from logs. The sealed record must keep it.
		// Other redacted values, such as provider keys, remain hidden here too.
		const inner = Redacted.value(input)
		return Cause.isCause(inner)
			? value(inner, [...parents, input])
			: "<redacted>"
	}
	const reference = Arr.findFirstIndex(parents, (parent) => parent === input)
	if (Option.isSome(reference)) return { reference: reference.value }
	const next = [...parents, input]
	if (Cause.isCause(input))
		return {
			type: "Cause",
			stack: Cause.pretty(input),
			reasons: Arr.map(input.reasons, (reason) => ({
				kind: reason._tag,
				value: value(
					reason._tag === "Fail"
						? reason.error
						: reason._tag === "Die"
							? reason.defect
							: reason.fiberId,
					next,
				),
				annotations: value(reason.annotations, next),
			})),
		}
	if (input instanceof Map)
		return {
			type: "Map",
			entries: Arr.map(Arr.fromIterable(input), ([key, entry]) => [
				value(key, next),
				value(entry, next),
			]),
		}
	if (input instanceof Set)
		return {
			type: "Set",
			entries: Arr.map(Arr.fromIterable(input), (entry) => value(entry, next)),
		}
	if (Arr.isArray(input)) return Arr.map(input, (entry) => value(entry, next))
	// Own descriptors keep cause and driver fields without calling custom getters.
	// Node gives Error.stack its own accessor, so read that field below.
	const fields = Arr.map(Reflect.ownKeys(input), (key): Schema.Json => {
		const descriptor = Reflect.getOwnPropertyDescriptor(input, key)
		return [
			String(key),
			descriptor !== undefined && "value" in descriptor
				? value(descriptor.value, next)
				: { type: "accessor" },
		]
	})
	return input instanceof Error
		? { type: input.name, stack: input.stack ?? null, fields }
		: { type: "Object", fields }
}

/** Keep each failure, defect, interrupt, stack and annotation, including driver details. */
export const snapshot = (cause: Cause.Cause<unknown>): Schema.Json => ({
	format: 1,
	// Effect renders its lazy call stacks here. The fields below keep driver details.
	stack: Cause.pretty(cause),
	reasons: Arr.map(cause.reasons, (reason) => ({
		kind: reason._tag,
		value: value(
			reason._tag === "Fail"
				? reason.error
				: reason._tag === "Die"
					? reason.defect
					: reason.fiberId,
		),
		annotations: value(reason.annotations),
	})),
})
export const codec = Schema.fromJsonString(Schema.Json)
