import { Context, Effect, Option, Schema } from "effect"
import * as Index from "./Index.ts"
import * as Discovery from "../discovery/Discovery.ts"
import * as Document from "../Document.ts"

export class IndexingError extends Schema.TaggedError<IndexingError>()(
	"IndexingError",
	{
		reason: Schema.Literals([
			"InvalidInput",
			"RobotsDenied",
			"RobotsUnavailable",
			"Unavailable",
			"InvalidDocument",
			"Redirect",
		]),
		url: Schema.String,
		issue: Schema.String,
	},
) {}

export class Input extends Schema.Opaque<Input>()(
	Schema.Struct({
		cardUrl: Document.Link,
		sources: Schema.optional(Schema.Array(Discovery.Source)),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Input)(value, {
			onExcessProperty: "error",
		}).pipe(
			Effect.mapError(() =>
				IndexingError.make({
					reason: "InvalidInput",
					url: "",
					issue: "Expected only a public Card URL and public source hints",
				}),
			),
		)
}

export const SyncResult = Schema.TaggedUnion({
	Indexed: { entry: Index.Entry },
	Excluded: {
		cardUrl: Document.Link,
		reason: Schema.String,
	},
	Withdrawn: {
		cardUrl: Document.Link,
		reason: Schema.String,
	},
	Unconfirmed: {
		cardUrl: Document.Link,
		reason: Schema.String,
		url: Schema.String,
		issue: Schema.String,
	},
})

export type SyncResult = typeof SyncResult.Type

export class Indexing extends Context.Service<
	Indexing,
	{
		readonly sync: (
			input: Input,
		) => Effect.Effect<SyncResult, Index.IndexError | IndexingError>
	}
>()("@openbot-build/protocol/indexing/Indexing") {}

export const sync = (input: Input) =>
	Indexing.use((indexing) => indexing.sync(input))

export const InspectionStage = Schema.Struct({
	name: Schema.Literals([
		"Input",
		"Discovery",
		"CardRead",
		"CardSchema",
		"Compatibility",
		"PublisherAssociation",
		"Eligibility",
	]),
	source: Schema.String,
	status: Schema.Literals(["Passed", "Failed", "Unconfirmed", "NotChecked"]),
	checkedAt: Schema.optionalKey(Schema.Finite),
	reason: Schema.optionalKey(Schema.String),
})
export type InspectionStage = typeof InspectionStage.Type
export const InspectionResult = Schema.TaggedUnion({
	Eligible: { entry: Index.Entry, stages: Schema.Array(InspectionStage) },
	Excluded: {
		stages: Schema.Array(InspectionStage),
		cardUrl: Document.Link,
		reason: Schema.String,
		withdraw: Schema.Boolean,
	},
	Unconfirmed: {
		stages: Schema.Array(InspectionStage),
		cardUrl: Document.Link,
		reason: Schema.String,
		url: Schema.String,
		issue: Schema.String,
	},
})
export type InspectionResult = typeof InspectionResult.Type

/** Reads public evidence. It never takes an Index writer or account credentials. */
export class PublicationInspection extends Context.Service<
	PublicationInspection,
	{
		readonly inspect: (
			input: Input,
			previous: Option.Option<Index.Entry>,
		) => Effect.Effect<InspectionResult, IndexingError>
	}
>()("@openbot-build/protocol/indexing/Indexing/PublicationInspection") {}

export const inspect = (input: Input) =>
	PublicationInspection.use((service) => service.inspect(input, Option.none()))
