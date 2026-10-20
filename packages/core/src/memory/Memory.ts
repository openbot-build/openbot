import { Data, Schema } from "effect"
import * as Item from "./Item.ts"
import { VersionId } from "./MemoryIdentity.ts"
import * as ContextWindow from "../context/ContextWindow.ts"
import { PromptJson } from "../store/PromptCodec.ts"
export { VersionId } from "./MemoryIdentity.ts"

export const Parents = Schema.Union([
	Schema.Tuple([]),
	Schema.Tuple([VersionId]),
])
export type Parents = typeof Parents.Type
export const Version = Schema.Struct({
	id: VersionId,
	schemaVersion: Schema.String,
	parents: Parents,
})
export type Version = typeof Version.Type
export const CoreValue = Schema.Struct({
	history: Schema.Array(Item.Record),
	context: Schema.TaggedUnion({
		Prompt: { prompt: PromptJson },
		Native: { ...ContextWindow.Window.cases.Native.fields, prompt: PromptJson },
	}),
	closed: Schema.Boolean,
})
export type CoreValue = typeof CoreValue.Type
const opaque = Schema.declare(
	(_value: unknown): _value is unknown => true,
).annotate({ toCodecJson: () => undefined, toJsonSchema: () => ({}) })
export const Value = <Fields extends Schema.Struct.Fields>(
	namespaces: Fields,
) =>
	Schema.StructWithRest(Schema.Struct({ ...namespaces, memory: CoreValue }), [
		Schema.Record(Schema.String, opaque),
	])
export type Value<P = {}> = typeof CoreValue extends never
	? never
	: { readonly memory: CoreValue; readonly [key: string]: unknown } & P
export const State = <Fields extends Schema.Struct.Fields>(
	namespaces: Fields,
) => Schema.Struct({ version: Version, value: Value(namespaces) })
export interface State<P = {}> {
	readonly version: Version
	readonly value: Value<P>
}
export class VersionError extends Data.TaggedError("MemoryVersionError")<{
	readonly reason:
		| "version-missing"
		| "version-unreachable"
		| "head-conflict"
		| "invalid-boundary"
	readonly version: VersionId
	readonly message: string
}> {}
