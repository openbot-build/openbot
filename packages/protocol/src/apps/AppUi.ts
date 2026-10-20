import {
	type ReadResourceResult,
	type Tool,
} from "@modelcontextprotocol/client"
import { Effect, Schema, Layer, Predicate } from "effect"
import { Base64 } from "effect/encoding"
import * as Document from "../Document.ts"
import { Ui, UiError, Uri, decodeError, Resource } from "./Ui.ts"

export const toolResourceUri = Effect.fn("Ui.toolResourceUri")(function* (
	tool: Tool,
) {
	const value = yield* Schema.decodeUnknownEffect(
		Schema.Struct({ ui: Schema.Struct({ resourceUri: Uri }) }),
	)(tool._meta).pipe(Effect.mapError(decodeError("Declaration")))
	return value.ui.resourceUri
})

const Meta = Schema.Struct({
	ui: Schema.optional(
		Schema.Struct({
			prefersBorder: Schema.optional(Schema.Boolean),
		}),
	),
})

export const readResource = Effect.fn("Ui.readResource")(function* (
	uri: string,
	result: ReadResourceResult,
) {
	const matching = result.contents.filter((item) => item.uri === uri)
	const item = matching[0]
	if (
		matching.length !== 1 ||
		item === undefined ||
		item.mimeType !== Document.uiMediaType ||
		Predicate.hasProperty(item, "text") === Predicate.hasProperty(item, "blob")
	)
		return yield* new UiError({
			reason: "Resource",
			issue:
				"Expected one declared MCP Apps HTML resource with text or blob content",
		})
	const meta = yield* Schema.decodeEffect(Meta)(item._meta ?? {}).pipe(
		Effect.mapError(decodeError("Resource")),
	)
	const html = Predicate.hasProperty(item, "text")
		? item.text
		: yield* Effect.fromResult(Base64.decodeString(item.blob)).pipe(
				Effect.mapError(
					() =>
						new UiError({
							reason: "Resource",
							issue: "Invalid base64 UI resource",
						}),
				),
			)
	return yield* Resource.decode({
		uri,
		mimeType: item.mimeType,
		html,
		...meta.ui,
	})
})

export const layer = Layer.succeed(Ui, {
	toolResourceUri,
	readResource,
})
