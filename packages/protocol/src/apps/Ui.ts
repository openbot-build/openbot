import { Context, Effect, Schema } from "effect"
import {
	type Tool,
	type ReadResourceResult,
	type ClientCapabilities,
} from "@modelcontextprotocol/client"
import * as Document from "../Document.ts"

export class UiError extends Schema.TaggedError<
	UiError,
	{ readonly brand: unique symbol }
>()("UiError", {
	reason: Schema.Literals([
		"Declaration",
		"Resource",
		"Initialization",
		"Closed",
		"Protocol",
	]),
	issue: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export const Uri = Schema.String.check(Schema.isPattern(/^ui:\/\/[^\s]+$/))

export const decodeError =
	(reason: UiError["reason"]) => (error: Schema.SchemaError) =>
		UiError.make({ reason, issue: error.message })

export class Resource extends Schema.Opaque<
	Resource,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		uri: Uri,
		mimeType: Schema.Literal(Document.uiMediaType),
		html: Schema.NonEmptyString,
		prefersBorder: Schema.optional(Schema.Boolean),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Resource)(value).pipe(
			Effect.mapError(decodeError("Resource")),
		)
}

export const clientCapabilities: ClientCapabilities = {
	extensions: {
		"io.modelcontextprotocol/ui": {
			mimeTypes: [Document.uiMediaType],
		},
	},
}

export class Ui extends Context.Service<
	Ui,
	{
		readonly toolResourceUri: (tool: Tool) => Effect.Effect<string, UiError>
		readonly readResource: (
			uri: string,
			result: ReadResourceResult,
		) => Effect.Effect<Resource, UiError>
	}
>()("@openbot-build/protocol/apps/Ui") {}
