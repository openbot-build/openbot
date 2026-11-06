import { IndexStore } from "@openbot-build/protocol"
import { AppIndex } from "@openbot-build/domain"
import { Schema } from "effect"

/** An App description joins the protocol entry with product index facts. */
export const App = Schema.Struct({
	entry: IndexStore.Entry,
	sources: Schema.Array(AppIndex.Source),
	matches: Schema.Array(AppIndex.Match),
	check: Schema.optionalKey(AppIndex.Check),
	restriction: Schema.optionalKey(AppIndex.Restriction),
})
export type App = typeof App.Type

export const Page = Schema.Struct({
	apps: Schema.Array(App),
	nextCursor: Schema.NullOr(Schema.String),
	issues: Schema.Array(AppIndex.SourceIssue),
})
export type Page = typeof Page.Type
