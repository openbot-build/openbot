import { Array as Arr, Effect, Option, Schema, SchemaIssue } from "effect"
import {
	AuthConfigurationError,
	type Configuration,
	DevelopmentConfiguration,
	NoProviderConfiguration,
	OidcConfiguration,
} from "./Model.ts"

export const ResolvedConfiguration = Schema.Union([
	OidcConfiguration.pipe(
		Schema.extendTo(
			{ redirectUri: Schema.String },
			{
				redirectUri: (config) =>
					Option.some(config.publicOrigin + "/auth/callback/oidc"),
			},
		),
	),
	DevelopmentConfiguration,
	NoProviderConfiguration,
])
export type ResolvedConfiguration = typeof ResolvedConfiguration.Type

/** Checks a sign-in configuration. A bad public origin has its own field, so the error can name it. */
export const resolve = (configuration: Configuration) =>
	Schema.decodeEffect(ResolvedConfiguration)(configuration).pipe(
		Effect.mapError((error) =>
			AuthConfigurationError.make({
				field: Arr.some(
					SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues,
					(issue) => issue.path?.[0] === "publicOrigin",
				)
					? "publicOrigin"
					: "configuration",
			}),
		),
	)
