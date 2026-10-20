import { Effect, Schema } from "effect"
import * as Document from "../Document.ts"

export class Publication extends Schema.Opaque<Publication>()(
	Schema.Struct({
		card: Document.ServerCard,
		cardUrl: Schema.String,
		catalogUrl: Schema.String,
		mcpUrl: Schema.String,
		catalog: Schema.optional(Document.Catalog),
		allowedOrigins: Schema.optional(Schema.Array(Schema.String)),
		cacheControl: Schema.optional(Schema.String),
		etag: Schema.optional(Schema.String),
		lastModified: Schema.optional(Schema.String),
		noindex: Schema.optional(Schema.Boolean),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Publication)(value).pipe(
			Effect.mapError(
				(error) =>
					new Document.InvalidDocument({
						kind: "Publication",
						issue: error.message,
					}),
			),
		)
}

export class UiResource extends Schema.Opaque<UiResource>()(
	Schema.Struct({
		uri: Schema.String.check(Schema.isPattern(/^ui:\/\/[^\s]+$/)),
		name: Schema.NonEmptyString,
		html: Schema.NonEmptyString,
		meta: Schema.optional(Schema.JsonObject),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(UiResource)(value).pipe(
			Effect.mapError(
				(error) =>
					new Document.InvalidDocument({
						kind: "Publication",
						issue: error.message,
					}),
			),
		)
}
