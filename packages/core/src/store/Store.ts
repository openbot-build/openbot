import { Effect, Schema, SchemaTransformation } from "effect"
import { dual } from "effect/Function"
import * as Session from "../session/Session.ts"
import * as Timeline from "../timeline/Timeline.ts"
import * as SessionStore from "./SessionStore.ts"
import type * as Plugin from "../plugins/Plugin.ts"
import { omitOptional } from "./PromptCodec.ts"
import { error, invalid } from "./StoreErrors.ts"
export const schemaVersion = "timeline/1" as const
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
export const define: SessionStore.DefinitionFactory["define"] = (input) =>
	Effect.sync(() => {
		const fields = (scope: Plugin.StateDeclaration["scope"]) =>
			Object.fromEntries(
				Object.entries(input.stores)
					.filter(([, state]) => state.scope === scope)
					.map(([key, state]) => [key, Schema.optionalKey(state.schema)]),
			)
		const timelineSchema = Timeline.Value(fields("timeline")).check(
			Schema.makeFilter(
				(value) =>
					Object.keys(value).every(
						(key) =>
							key !== "session" &&
							(!(key in input.stores) ||
								input.stores[key]!.scope === "timeline"),
					) || "Session state cannot be stored in the Timeline",
			),
		)
		const business = Schema.StructWithRest(Schema.Struct(fields("session")), [
			Schema.Record(Schema.String, Schema.Unknown),
		])
		// The fields come from Object.fromEntries at run time, so TypeScript only sees a
		// string record. The schemas match Plugins<S>, but the compiler cannot prove it.
		return {
			...input,
			schema: codec(timelineSchema),
			sessionSchema: codec(Schema.Struct({ ...Session.Ref.fields, business })),
		} as unknown as SessionStore.Definition<
			typeof input.stores,
			typeof input.schemaVersion
		>
	})
export const project: {
	(
		version: Timeline.Version,
		raw: Schema.Json,
	): <S extends Plugin.Stores>(
		definition: SessionStore.Definition<S>,
	) => Effect.Effect<
		Timeline.State<SessionStore.Plugins<S>>,
		SessionStore.SessionStoreError,
		SessionStore.DecodingServices<S>
	>
	<S extends Plugin.Stores>(
		definition: SessionStore.Definition<S>,
		version: Timeline.Version,
		raw: Schema.Json,
	): Effect.Effect<
		Timeline.State<SessionStore.Plugins<S>>,
		SessionStore.SessionStoreError,
		SessionStore.DecodingServices<S>
	>
} = dual(
	3,
	<S extends Plugin.Stores>(
		definition: SessionStore.Definition<S>,
		version: Timeline.Version,
		raw: Schema.Json,
	) =>
		Effect.gen(function* () {
			if (version.schemaVersion !== definition.schemaVersion)
				return yield* error("unsupported-format", {
					message: "Unsupported Timeline format",
					version: version.id,
				})
			const value = yield* Schema.decodeEffect(definition.schema)(raw).pipe(
				Effect.mapError(invalid),
			)
			return {
				version: {
					id: version.id,
					schemaVersion: version.schemaVersion,
					parents: version.parents,
				},
				value,
			}
		}),
)
