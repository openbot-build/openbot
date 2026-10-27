import { AppIndex } from "@openbot-build/domain"
import { SettingsUnavailable } from "./SettingsErrors.ts"
import { Document, Index } from "@openbot-build/protocol"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Limit } from "./Page.ts"

export const Source = AppIndex.Source
export type Source = typeof Source.Type

export const SourceIssue = AppIndex.SourceIssue
export type SourceIssue = typeof SourceIssue.Type

export const Check = AppIndex.Check
export type Check = AppIndex.Check
export const Restriction = Schema.Struct({
	...AppIndex.Restriction.fields,
	cardUrl: Document.Link,
	reason: Schema.NonEmptyString,
	appealUrl: Document.Link,
})
export type Restriction = typeof Restriction.Type

export const App = Schema.Struct({
	entry: Index.Entry,
	sources: Schema.Array(Source),
	matches: Schema.Array(AppIndex.Match),
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
	...AppIndex.Query.fields,
	limit: Schema.optionalKey(Limit(50)),
})
export type Query = typeof Query.Type

export const IndexInputInvalid = AppIndex.IndexInputInvalid
export type IndexInputInvalid = AppIndex.IndexInputInvalid
export const IndexUnavailable = AppIndex.IndexUnavailable
export type IndexUnavailable = AppIndex.IndexUnavailable
export const IndexNotFound = AppIndex.IndexNotFound
export type IndexNotFound = AppIndex.IndexNotFound
export const IndexRestricted = AppIndex.IndexRestricted
export type IndexRestricted = AppIndex.IndexRestricted

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
		error: SettingsUnavailable.pipe(HttpApiSchema.status(503)),
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
