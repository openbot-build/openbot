import {
	Array as Arr,
	Predicate,
	Record as Rec,
	String as Str,
	pipe,
	type JsonSchema,
} from "effect"
import type { Named } from "./CodeRuns.ts"

/** Writes a TypeScript type for a JSON Schema. Deep or unknown parts become `unknown`. */
const typeOf = (schema: unknown, depth: number): string => {
	if (!Predicate.isObject(schema) || depth > 4) return "unknown"
	if ("const" in schema) return JSON.stringify(schema["const"])
	const choices = schema["enum"]
	if (Arr.isArray(choices))
		return pipe(
			choices,
			Arr.map((entry) => JSON.stringify(entry)),
			Arr.join(" | "),
		)
	const union = schema["anyOf"] ?? schema["oneOf"]
	if (Arr.isArray(union))
		return pipe(
			union,
			Arr.map((entry) => typeOf(entry, depth + 1)),
			Arr.join(" | "),
		)
	const type = schema["type"]
	if (Arr.isArray(type))
		return pipe(
			type,
			Arr.map((entry) => typeOf({ ...schema, type: entry }, depth)),
			Arr.join(" | "),
		)
	switch (type) {
		case "string":
			return "string"
		case "number":
		case "integer":
			return "number"
		case "boolean":
			return "boolean"
		case "null":
			return "null"
		case "array":
			return "Array<" + typeOf(schema["items"], depth + 1) + ">"
		case "object":
		case undefined: {
			const properties = schema["properties"]
			if (!Predicate.isObject(properties))
				return type === undefined ? "unknown" : "Record<string, unknown>"
			const listed = schema["required"]
			const required = Arr.isArray(listed) ? listed : []
			const fields = Arr.map(Rec.toEntries(properties), ([key, field]) => {
				const description =
					Predicate.hasProperty(field, "description") &&
					Predicate.isString(field.description)
						? "/** " +
							pipe(
								field.description,
								Str.replaceAll("*/", "* /"),
								Str.slice(0, 200),
							) +
							" */ "
						: ""
				return (
					description +
					JSON.stringify(key) +
					(Arr.contains(required, key) ? ": " : "?: ") +
					typeOf(field, depth + 1)
				)
			})
			return "{ " + Arr.join(fields, "; ") + " }"
		}
		default:
			return "unknown"
	}
}

const header = `/** The result of an App tool, as the App sent it. */
type ToolResult = { content: Array<{ type: string; text?: string; [key: string]: unknown }>; structuredContent?: unknown; isError?: boolean }
/** The result of a resource read or a prompt, as the App sent it. */
type ReadResult = Record<string, unknown>
/**
 * Errors: a call that a decider did not allow throws an Error with name "AppCallDenied".
 * A call that failed throws "AppCallFailed". An App that needs more input throws "AppInputRequired".
 * Each error has \`details.operationId\`.
 */`

/** The group of an alias, such as `calendar` for `calendar.list_events`. */
const groupOf = (alias: string) => Arr.headNonEmpty(Str.split(alias, "."))

/** The TypeScript declarations of the bindings that match the filter. */
export const declarations = (
	named: ReadonlyArray<Named>,
	filter: (entry: Named) => boolean,
): string => {
	const chosen = Arr.filter(named, filter)
	// Group names never look like numbers (`slug` puts "_" before a leading digit),
	// so the record keeps the order of first appearance.
	const members = pipe(
		Arr.groupBy(chosen, ({ alias }) => groupOf(alias)),
		Rec.toEntries,
		Arr.map(([group, entries]) => {
			const functions = Arr.map(entries, ({ alias, binding }) => {
				const description = pipe(
					binding.source.appName +
						" / " +
						binding.source.connectionName +
						" / " +
						binding.source.name +
						". " +
						binding.description,
					Str.replaceAll("*/", "* /"),
					Str.slice(0, 1000),
				)
				return (
					"\t\t/** " +
					description +
					" */\n\t\t" +
					pipe(alias, Str.slice(group.length + 1)) +
					"(args: " +
					typeOf(binding.schema satisfies JsonSchema.JsonSchema, 0) +
					"): Promise<" +
					(binding.source.kind === "tool" ? "ToolResult" : "ReadResult") +
					">"
				)
			})
			return "\t" + group + ": {\n" + Arr.join(functions, "\n") + "\n\t}"
		}),
	)
	return Arr.join(
		[
			header,
			"declare const apps: {\n" +
				Arr.join(
					Arr.append(
						members,
						'\t/** Calls a binding by its full name, such as "calendar.list_events". */\n\tcall(binding: string, args: Record<string, unknown>): Promise<unknown>',
					),
					"\n",
				) +
				"\n}",
		],
		"\n\n",
	)
}
