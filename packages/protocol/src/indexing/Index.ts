import { Context, Effect, Option, Schema } from "effect"
import * as Document from "../Document.ts"

export class IndexError extends Schema.TaggedError<
	IndexError,
	{ readonly brand: unique symbol }
>()("IndexError", {
	reason: Schema.Literals(["Invalid", "Unavailable"]),
	operation: Schema.String,
	cause: Schema.optional(Schema.Defect()),
}) {}

export class Evidence extends Schema.Opaque<
	Evidence,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		publisherUrl: Document.Link,
		catalogUrl: Document.Link,
		cardUrl: Document.Link,
		association: Schema.Literals(["CardOrigin", "Website", "CardLink"]),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Evidence)(value).pipe(
			Effect.mapError((cause) =>
				IndexError.make({
					reason: "Invalid",
					operation: "Evidence.decode",
					cause,
				}),
			),
		)
}

export class Entry extends Schema.Opaque<
	Entry,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		cardUrl: Document.Link,
		card: Document.ServerCard,
		evidence: Schema.NonEmptyArray(Evidence),
		checkedAt: Schema.Finite,
		validators: Schema.Struct({
			etag: Schema.optional(Schema.String),
			lastModified: Schema.optional(Schema.String),
		}),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Entry)(value).pipe(
			Effect.mapError((cause) =>
				IndexError.make({
					reason: "Invalid",
					operation: "Entry.decode",
					cause,
				}),
			),
		)
}

export class IndexStore extends Context.Service<
	IndexStore,
	{
		readonly get: (
			cardUrl: string,
		) => Effect.Effect<Option.Option<Entry>, IndexError>
		readonly upsert: (entry: Entry) => Effect.Effect<Entry, IndexError>
		readonly withdraw: (cardUrl: string) => Effect.Effect<void, IndexError>
	}
>()("@openbot-build/protocol/indexing/IndexStore") {}
