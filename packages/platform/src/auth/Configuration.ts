import { Option, Schema } from "effect"
import { DevelopmentConfiguration, OidcConfiguration } from "./Model.js"

export const ResolvedConfiguration = Schema.Union([
	OidcConfiguration.pipe(
		Schema.extendTo(
			{ redirectUri: Schema.String },
			{
				redirectUri: (config) =>
					Option.some(config.publicOrigin + "/auth/callback"),
			},
		),
	),
	DevelopmentConfiguration,
])
export type ResolvedConfiguration = typeof ResolvedConfiguration.Type
