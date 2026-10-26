import { Document, Index } from "@openbot-build/protocol"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Limit } from "./Page.ts"

export const Source = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	url: Schema.String,
	simulated: Schema.Boolean,
})
export type Source = typeof Source.Type

export const SourceIssue = Schema.Struct({
	source: Schema.NonEmptyString,
	message: Schema.String,
})
export type SourceIssue = typeof SourceIssue.Type

export const Check = Schema.TaggedUnion({
	Pending: {},
	Indexed: { attemptedAt: Schema.Finite },
	Excluded: { attemptedAt: Schema.Finite, reason: Schema.String },
	Withdrawn: { attemptedAt: Schema.Finite, reason: Schema.String },
	Unconfirmed: { attemptedAt: Schema.Finite, reason: Schema.String },
	Failed: { attemptedAt: Schema.Finite, reason: Schema.String },
})
export type Check = typeof Check.Type
export const Restriction = Schema.Struct({
	cardUrl: Document.Link,
	reason: Schema.NonEmptyString,
	appealUrl: Document.Link,
})
export type Restriction = typeof Restriction.Type

export const App = Schema.Struct({
	entry: Index.Entry,
	sources: Schema.Array(Source),
	matches: Schema.Array(Schema.Literals(["name", "description", "publisher"])),
	check: Schema.optionalKey(Check),
	restriction: Schema.optionalKey(Restriction),
})
export type App = typeof App.Type

export const Page = Schema.Struct({
	apps: Schema.Array(App),
	nextCursor: Schema.NullOr(Schema.String),
	issues: Schema.Array(SourceIssue),
})
export type Page = typeof Page.Type

export const Query = Schema.Struct({
	query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
	source: Schema.optionalKey(Schema.NonEmptyString),
	cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
	limit: Schema.optionalKey(Limit(50)),
})
export type Query = typeof Query.Type

export class IndexInputInvalid extends Schema.TaggedError<
	IndexInputInvalid,
	{ readonly brand: unique symbol }
>()("IndexInputInvalid", { message: Schema.String }) {}
export class IndexUnavailable extends Schema.TaggedError<
	IndexUnavailable,
	{ readonly brand: unique symbol }
>()("IndexUnavailable", { issues: Schema.Array(SourceIssue) }) {}
export class IndexNotFound extends Schema.TaggedError<
	IndexNotFound,
	{ readonly brand: unique symbol }
>()("IndexNotFound", { message: Schema.String }) {}
export class IndexRestricted extends Schema.TaggedError<
	IndexRestricted,
	{ readonly brand: unique symbol }
>()("IndexRestricted", { restriction: Restriction }) {}

const errors = [
	IndexRestricted.pipe(HttpApiSchema.status(403)),
	IndexInputInvalid.pipe(HttpApiSchema.status(400)),
	IndexNotFound.pipe(HttpApiSchema.status(404)),
	IndexUnavailable.pipe(HttpApiSchema.status(503)),
]

/** Only public descriptions. Account connection state uses protected endpoints. */
export const AppIndexApi = HttpApiGroup.make("appIndex").add(
	HttpApiEndpoint.get("listSources", "/v1/app-index/sources", {
		success: Schema.Array(Source),
	}),
	HttpApiEndpoint.get("searchApps", "/v1/app-index/apps", {
		query: Query.fields,
		success: Page,
		error: errors,
	}),
	HttpApiEndpoint.get("getApp", "/v1/app-index/app", {
		query: {
			cardUrl: Document.Link,
			source: Schema.optionalKey(Schema.NonEmptyString),
		},
		success: App,
		error: errors,
	}),
)
