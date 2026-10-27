import type { Schema } from "effect"

/**
 * The value as plain JSON, for a tool result. The round trip drops `undefined` fields
 * and turns other values, such as dates, into their JSON form.
 */
export const toolJson = (value: unknown): Schema.Json =>
	JSON.parse(JSON.stringify(value)) as Schema.Json
