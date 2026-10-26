import {
	Array as Arr,
	Effect,
	Option,
	Record as Rec,
	Schema,
	SchemaTransformation,
	pipe,
} from "effect"
import * as Chat from "../chat/Chat.ts"
import * as ChatState from "../chat/ChatState.ts"
import type * as ChatStore from "./ChatStore.ts"
import type * as Plugin from "../plugins/Plugin.ts"
import { omitOptional } from "./PromptCodec.ts"
export const schemaVersion = "chat/1" as const
const codec = <S extends Schema.Constraint>(schema: S) =>
	Schema.Json.pipe(
		Schema.decodeTo(
			Schema.toType(schema),
			SchemaTransformation.transformEffect({
				decode: (json) =>
					Schema.decodeEffect(schema)(json).pipe(
						Effect.mapError((e) => e.issue),
					),
				encode: (value) =>
					Schema.encodeEffect(schema)(value).pipe(
						Effect.flatMap((encoded) =>
							Schema.decodeUnknownEffect(Schema.Json)(omitOptional(encoded)),
						),
						Effect.mapError((e) => e.issue),
					),
			}),
		),
	)
/**
 * Builds the codecs of a store. Plugin data with `record` scope is kept on the
 * record of the Chat. Plugin data with `state` scope is kept with the conversation.
 */
export const define: ChatStore.DefinitionFactory["define"] = (input) =>
	Effect.sync(() => {
		const fields = (scope: Plugin.StateDeclaration["scope"]) =>
			Rec.fromEntries(
				pipe(
					Rec.toEntries<string, Plugin.StateDeclaration>(input.stores),
					Arr.filter(([, state]) => state.scope === scope),
					Arr.map(
						([key, state]) => [key, Schema.optionalKey(state.schema)] as const,
					),
				),
			)
		const stateSchema = ChatState.Value(fields("state")).check(
			Schema.makeFilter(
				(value) =>
					Arr.every(
						Rec.keys(value),
						(key) =>
							key !== "chat" &&
							!Option.exists(
								Rec.get<string, Plugin.StateDeclaration>(input.stores, key),
								(state) => state.scope !== "state",
							),
					) || "Record data cannot be stored in the state",
			),
		)
		const business = Schema.StructWithRest(Schema.Struct(fields("record")), [
			Schema.Record(Schema.String, Schema.Unknown),
		])
		// The fields come from Record.fromEntries at run time, so TypeScript only sees a
		// string record. The schemas match Plugins<S>, but the compiler cannot prove it.
		return {
			...input,
			schema: codec(stateSchema),
			recordSchema: codec(Schema.Struct({ ...Chat.Ref.fields, business })),
		} as unknown as ChatStore.Definition<
			typeof input.stores,
			typeof input.schemaVersion
		>
	})
