import { Effect, Result, Schema } from "effect"
import { Headers } from "effect/http"
import * as Ui from "../apps/Ui.ts"
import * as Document from "../Document.ts"

export class Publication extends Schema.Opaque<
	Publication,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		card: Document.ServerCard,
		cardUrl: Schema.String,
		catalogUrl: Schema.String,
		mcpUrl: Schema.String,
		catalog: Schema.optional(Document.Catalog),
		allowedOrigins: Schema.optional(Schema.Array(Schema.String)),
		cacheControl: Schema.optional(Schema.String),
		etag: Schema.optional(
			Schema.String.check(
				Schema.isPattern(/^(W\/)?"[^"\r\n]*"$/, {
					message: "ETag must be a quoted HTTP entity tag",
				}),
			),
		),
		lastModified: Schema.optional(
			Schema.String.check(
				Schema.makeFilter(
					(value: string) =>
						Result.isSuccess(Headers.parseHttpDate(value)) ||
						"Last-Modified must be an HTTP date",
				),
			),
		),
		noindex: Schema.optional(Schema.Boolean),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Publication)(value).pipe(
			Effect.mapError((error) =>
				Document.InvalidDocument.make({
					kind: "Publication",
					issue: error.message,
				}),
			),
		)
}

export class UiResource extends Schema.Opaque<
	UiResource,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		uri: Ui.Uri,
		name: Schema.NonEmptyString,
		html: Schema.NonEmptyString,
		meta: Schema.optional(Schema.JsonObject),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(UiResource)(value).pipe(
			Effect.mapError((error) =>
				Document.InvalidDocument.make({
					kind: "Publication",
					issue: error.message,
				}),
			),
		)
}
