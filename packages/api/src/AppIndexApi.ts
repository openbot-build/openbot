import { SettingsUnavailable } from "@openbot-build/domain/SettingsErrors"
import { Source } from "@openbot-build/domain/AppIndex"
import { SourceIssue } from "@openbot-build/domain/AppIndex"
import { Check } from "@openbot-build/domain/AppIndex"
import { IndexInputInvalid } from "@openbot-build/domain/AppIndex"
import { IndexUnavailable } from "@openbot-build/domain/AppIndex"
import { IndexNotFound } from "@openbot-build/domain/AppIndex"
import { IndexRestricted } from "@openbot-build/domain/AppIndex"
import { IndexStore } from "@openbot-build/protocol"
import { AppIndex } from "@openbot-build/domain"
import { Document } from "@openbot-build/protocol"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import { Limit } from "./Page.ts"

export const Restriction = Schema.Struct({
	...AppIndex.Restriction.fields,
	cardUrl: Document.Link,
	reason: Schema.NonEmptyString,
	appealUrl: Document.Link,
})
export type Restriction = typeof Restriction.Type

export const App = Schema.Struct({
	entry: IndexStore.Entry,
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
