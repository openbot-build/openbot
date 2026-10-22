// This is a plain function. A pipeable form does not help here.
// @effect-diagnostics missingPipeableSignature:off
import type { JsonSchema } from "effect"
import type { Named } from "./CodeRuns.ts"

/** Writes a TypeScript type for a JSON Schema. Deep or unknown parts become `unknown`. */
const typeOf = (schema: unknown, depth: number): string => {
	if (typeof schema !== "object" || schema === null || depth > 4)
		return "unknown"
	const value = schema as Record<string, unknown>
	if ("const" in value) return JSON.stringify(value["const"])
	if (Array.isArray(value["enum"]))
		return value["enum"].map((entry) => JSON.stringify(entry)).join(" | ")
	const union = value["anyOf"] ?? value["oneOf"]
	if (Array.isArray(union))
		return union.map((entry) => typeOf(entry, depth + 1)).join(" | ")
	const type = value["type"]
	if (Array.isArray(type))
		return type
			.map((entry) => typeOf({ ...value, type: entry }, depth))
			.join(" | ")
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
			return "Array<" + typeOf(value["items"], depth + 1) + ">"
		case "object":
		case undefined: {
			const properties = value["properties"]
			if (typeof properties !== "object" || properties === null)
				return type === undefined ? "unknown" : "Record<string, unknown>"
			const required = Array.isArray(value["required"])
				? (value["required"] as ReadonlyArray<unknown>)
				: []
			const fields = Object.entries(properties).map(([key, field]) => {
				const description =
					typeof field === "object" &&
					field !== null &&
					typeof (field as Record<string, unknown>)["description"] === "string"
						? "/** " +
							String((field as Record<string, unknown>)["description"])
								.replaceAll("*/", "* /")
								.slice(0, 200) +
							" */ "
						: ""
				return (
					description +
					JSON.stringify(key) +
					(required.includes(key) ? ": " : "?: ") +
					typeOf(field, depth + 1)
				)
			})
			return "{ " + fields.join("; ") + " }"
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

/** The TypeScript declarations of the bindings that match the filter. */
export const declarations = (
	named: ReadonlyArray<Named>,
	filter: (entry: Named) => boolean,
): string => {
	const chosen = named.filter(filter)
	const groups = [...new Set(chosen.map(({ alias }) => alias.split(".")[0]!))]
	const members = groups.map((group) => {
		const functions = chosen
			.filter(({ alias }) => alias.split(".")[0] === group)
			.map(({ alias, binding }) => {
				const description = (
					binding.source.appName +
					" / " +
					binding.source.connectionName +
					" / " +
					binding.source.name +
					". " +
					binding.description
				)
					.replaceAll("*/", "* /")
					.slice(0, 1000)
				return (
					"\t\t/** " +
					description +
					" */\n\t\t" +
					alias.split(".")[1] +
					"(args: " +
					typeOf(binding.schema satisfies JsonSchema.JsonSchema, 0) +
					"): Promise<" +
					(binding.source.kind === "tool" ? "ToolResult" : "ReadResult") +
					">"
				)
			})
		return "\t" + group + ": {\n" + functions.join("\n") + "\n\t}"
	})
	return [
		header,
		"declare const apps: {\n" +
			[
				...members,
				'\t/** Calls a binding by its full name, such as "calendar.list_events". */\n\tcall(binding: string, args: Record<string, unknown>): Promise<unknown>',
			].join("\n") +
			"\n}",
	].join("\n\n")
}
