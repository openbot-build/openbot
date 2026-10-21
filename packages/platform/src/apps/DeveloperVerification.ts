import { Context, Effect, Option, Schema } from "effect"

/** Extra proof locations accepted during a controlled migration. New challenges remain native. */
export interface Settings {
	readonly metadataKeys?: ReadonlyArray<string> | undefined
	readonly dnsLabels?: ReadonlyArray<string> | undefined
}
export const Options = Context.Reference<Settings>(
	"@openbot-build/platform/apps/DeveloperVerification/Options",
	{ defaultValue: (): Settings => ({}) },
)
const Marker = Schema.Struct({
	version: Schema.Literal(1),
	tokens: Schema.Array(Schema.String),
})
const Card = Schema.fromJsonString(
	Schema.Struct({
		_meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
	}),
)
/** Only exact stored challenge tokens confer control; an accepted location adds no authority itself. */
export const hasToken = ({
	text,
	token,
	settings = {},
}: {
	readonly text: string
	readonly token: string
	readonly settings?: Settings
}) =>
	Schema.decodeEffect(Card)(text).pipe(
		Effect.map((card) =>
			["openbot/developer-verification", ...(settings.metadataKeys ?? [])].some(
				(key) =>
					Option.match(Schema.decodeUnknownOption(Marker)(card._meta?.[key]), {
						onNone: () => false,
						onSome: (marker) => marker.tokens.includes(token),
					}),
			),
		),
	)
