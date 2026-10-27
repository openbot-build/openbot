import { Schema } from "effect"
import * as Legacy from "./LegacyApps.ts"

/** Saved history has a fixed codec. It does not follow changes to HTTP inputs. */
export const AppHistory = Schema.TaggedStruct("AppCall", {
	version: Schema.Literal(1),
	invocation: Legacy.Invocation,
})
export const CodeHistory = Schema.TaggedStruct("CodeRun", {
	version: Schema.Literal(1),
	run: Legacy.Run,
})
export const AuthorizationHistory = Schema.TaggedStruct("AppAuthorization", {
	version: Schema.Literal(1),
	state: Schema.Struct({
		...Legacy.AuthorizationRow.fields,
		expires_at: Schema.Finite,
		scopes: Schema.Array(Schema.String),
	}),
	flow: Schema.NullOr(Legacy.Flow),
})
export const DeveloperFlowHistory = Schema.TaggedStruct(
	"DeveloperAuthorization",
	{
		version: Schema.Literal(1),
		namespace: Schema.String,
		testId: Schema.String,
		state: Legacy.TestAuthorization,
		flow: Schema.NullOr(Legacy.Flow),
		callback: Schema.NullOr(Schema.String),
	},
)
export const DeveloperTestHistory = Schema.TaggedStruct("DeveloperTest", {
	version: Schema.Literal(1),
	namespace: Schema.String,
	test: Legacy.Test,
	privateState: Schema.NullOr(Legacy.PrivateTest),
})
export const History = Schema.Union([
	AppHistory,
	CodeHistory,
	AuthorizationHistory,
	DeveloperFlowHistory,
	DeveloperTestHistory,
])
