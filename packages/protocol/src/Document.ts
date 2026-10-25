import { Effect, HashSet, Schema, SchemaTransformation } from "effect"

export const protocolVersion = "2026-07-28"
export const appsVersion = "2026-01-26"
export const cardMediaType = "application/mcp-server-card+json"
export const catalogMediaType = "application/ai-catalog+json"
export const uiMediaType = "text/html;profile=mcp-app"
export const cardSchemaUrl =
	"https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json"

export class InvalidLink extends Schema.TaggedError<InvalidLink>()(
	"InvalidLink",
	{
		reason: Schema.String,
	},
) {}
export class InvalidDocument extends Schema.TaggedError<InvalidDocument>()(
	"InvalidDocument",
	{
		kind: Schema.Literals(["Card", "Catalog", "Publication"]),
		issue: Schema.String,
	},
) {}
const invalid =
	(kind: InvalidDocument["kind"]) => (error: Schema.SchemaError) =>
		InvalidDocument.make({ kind, issue: error.message })

export class IncompatibleCard extends Schema.TaggedError<IncompatibleCard>()(
	"IncompatibleCard",
	{
		reason: Schema.String,
	},
) {}

/** The canonical identity keeps the path and query, including the query order. */
export const Link = Schema.URLFromString.check(
	Schema.makeFilter(
		(url) =>
			(url.protocol === "https:" &&
				url.username === "" &&
				url.password === "") ||
			"Expected an absolute HTTPS URL without credentials",
	),
).pipe(
	Schema.decodeTo(Schema.flip(Schema.URLFromString)),
	Schema.decode(
		SchemaTransformation.transform({
			decode: (href) => href.replace(/#.*$/s, ""),
			encode: (href) => href.replace(/#.*$/s, ""),
		}),
	),
)

const Uri = Schema.String.check(Schema.makeFilter((s) => URL.canParse(s)))
const Extensions = Schema.Record(Schema.String, Schema.Unknown)
/** Public presentation is optional. It never describes authority to run actions. */
export const presentationKey = "openbot/presentation"

export class Icon extends Schema.Opaque<Icon>()(
	Schema.StructWithRest(
		Schema.Struct({
			src: Uri,
			mimeType: Schema.optional(Schema.String),
			sizes: Schema.optional(Schema.Array(Schema.String)),
			theme: Schema.optional(Schema.Literals(["light", "dark"])),
		}),
		[Extensions],
	),
) {}

export class PreviewImage extends Schema.Opaque<PreviewImage>()(
	Schema.Struct({
		src: Link,
		alt: Schema.NonEmptyString.check(Schema.isMaxLength(500)),
		width: Schema.Int.check(
			Schema.isGreaterThan(0),
			Schema.isLessThanOrEqualTo(8192),
		),
		height: Schema.Int.check(
			Schema.isGreaterThan(0),
			Schema.isLessThanOrEqualTo(8192),
		),
		mimeType: Schema.optional(
			Schema.Literals([
				"image/png",
				"image/jpeg",
				"image/webp",
				"image/avif",
				"image/svg+xml",
			]),
		),
	}),
) {}

export class UsageExample extends Schema.Opaque<UsageExample>()(
	Schema.Struct({
		id: Schema.NonEmptyString.check(
			Schema.isMaxLength(100),
			Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
		),
		title: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
		prompt: Schema.NonEmptyString.check(Schema.isMaxLength(2000)),
		description: Schema.optional(
			Schema.NonEmptyString.check(Schema.isMaxLength(500)),
		),
		preview: Schema.optional(PreviewImage),
	}),
) {}

export class Presentation extends Schema.Opaque<Presentation>()(
	Schema.Struct({
		version: Schema.Literal("1"),
		examples: Schema.NonEmptyArray(UsageExample).check(Schema.isMaxLength(12)),
	}).check(
		Schema.makeFilter(
			(value) =>
				HashSet.size(
					HashSet.fromIterable(value.examples.map((example) => example.id)),
				) === value.examples.length || "Example identifiers must be unique",
		),
	),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Presentation)(value).pipe(
			Effect.mapError((error) =>
				InvalidDocument.make({
					kind: "Card",
					issue: "Invalid App presentation: " + error.message,
				}),
			),
		)
}

const InputFields = {
	description: Schema.optional(Schema.String),
	isRequired: Schema.optional(Schema.Boolean),
	isSecret: Schema.optional(Schema.Boolean),
	format: Schema.optional(
		Schema.Literals(["string", "number", "boolean", "filepath"]),
	),
	default: Schema.optional(Schema.String),
	placeholder: Schema.optional(Schema.String),
	value: Schema.optional(Schema.String),
	choices: Schema.optional(Schema.Array(Schema.String)),
}
export class Input extends Schema.Opaque<Input>()(
	Schema.StructWithRest(Schema.Struct(InputFields), [Extensions]),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Input)(value).pipe(
			Effect.mapError(invalid("Card")),
		)
}
export class HeaderInput extends Schema.Opaque<HeaderInput>()(
	Schema.StructWithRest(
		Schema.Struct({
			...InputFields,
			name: Schema.String.check(
				Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
			),
			variables: Schema.optional(Schema.Record(Schema.String, Input)),
		}),
		[Extensions],
	),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(HeaderInput)(value).pipe(
			Effect.mapError(invalid("Card")),
		)
}
export class Remote extends Schema.Opaque<Remote>()(
	Schema.StructWithRest(
		Schema.Struct({
			type: Schema.Literals(["streamable-http", "sse"]),
			url: Schema.String.check(
				Schema.isPattern(
					/^(https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/,
				),
			),
			headers: Schema.optional(Schema.Array(HeaderInput)),
			variables: Schema.optional(Schema.Record(Schema.String, Input)),
			supportedProtocolVersions: Schema.optional(Schema.Array(Schema.String)),
		}),
		[Extensions],
	),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Remote)(value).pipe(
			Effect.mapError(invalid("Card")),
		)
}
export class ServerCard extends Schema.Opaque<ServerCard>()(
	Schema.StructWithRest(
		Schema.Struct({
			$schema: Schema.Literal(cardSchemaUrl),
			name: Schema.String.check(
				Schema.isPattern(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/),
				Schema.isMinLength(3),
				Schema.isMaxLength(200),
			),
			version: Schema.NonEmptyString.check(
				Schema.isMaxLength(255),
				Schema.makeFilter((s) => !/[\s^~*<>=|]|(^|\.)x($|\.)/i.test(s)),
			),
			description: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
			title: Schema.optional(
				Schema.NonEmptyString.check(Schema.isMaxLength(100)),
			),
			websiteUrl: Schema.optional(Uri),
			repository: Schema.optional(
				Schema.StructWithRest(
					Schema.Struct({
						url: Uri,
						source: Schema.String,
						subfolder: Schema.optional(
							Schema.String.check(
								Schema.makeFilter(
									(s) => !s.startsWith("/") && !s.split("/").includes(".."),
								),
							),
						),
						id: Schema.optional(Schema.String),
					}),
					[Extensions],
				),
			),
			icons: Schema.optional(Schema.Array(Icon)),
			remotes: Schema.optional(Schema.Array(Remote)),
			_meta: Schema.optional(Extensions),
		}),
		[Extensions],
	),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(ServerCard)(value).pipe(
			Effect.mapError(invalid("Card")),
		)
}

/** Ignore newer or malformed display metadata so it does not break connection discovery. */
export const presentationFromCard = (card: ServerCard) =>
	Schema.decodeUnknownOption(Presentation)(card._meta?.[presentationKey])

export class CatalogEntry extends Schema.Opaque<CatalogEntry>()(
	Schema.StructWithRest(
		Schema.Struct({
			identifier: Schema.NonEmptyString,
			type: Schema.NonEmptyString,
			url: Schema.optional(Uri),
			data: Schema.optional(Schema.Unknown),
			displayName: Schema.optional(Schema.String),
			description: Schema.optional(Schema.String),
			version: Schema.optional(Schema.String),
			tags: Schema.optional(Schema.Array(Schema.String)),
			updatedAt: Schema.optional(Schema.String),
			publisher: Schema.optional(Extensions),
			trustManifest: Schema.optional(Extensions),
			extensions: Schema.optional(Extensions),
		}),
		[Extensions],
	).check(
		Schema.makeFilter(
			(e) => Object.hasOwn(e, "url") !== Object.hasOwn(e, "data"),
		),
	),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(CatalogEntry)(value).pipe(
			Effect.mapError(invalid("Catalog")),
		)
}
export class Catalog extends Schema.Opaque<Catalog>()(
	Schema.StructWithRest(
		Schema.Struct({
			specVersion: Schema.Literal("1.0"),
			entries: Schema.Array(CatalogEntry),
			host: Schema.optional(
				Schema.StructWithRest(
					Schema.Struct({
						displayName: Schema.String,
						identifier: Schema.optional(Schema.String),
						documentationUrl: Schema.optional(Uri),
						logoUrl: Schema.optional(Uri),
					}),
					[Extensions],
				),
			),
			extensions: Schema.optional(Extensions),
			signature: Schema.optional(Schema.String),
		}),
		[Extensions],
	),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Catalog)(value).pipe(
			Effect.mapError(invalid("Catalog")),
		)
}

/** Template endpoints stay candidates until the user gives their configuration. */
export const compatibleRemotes = (
	card: ServerCard,
): Effect.Effect<ReadonlyArray<Remote>, IncompatibleCard> => {
	const remotes = (card.remotes ?? []).filter(
		(r) =>
			r.type === "streamable-http" &&
			r.supportedProtocolVersions?.includes(protocolVersion) === true &&
			(r.url.startsWith("https://") || r.url.startsWith("{")),
	)
	return remotes.length > 0
		? Effect.succeed(remotes)
		: Effect.fail(
				IncompatibleCard.make({
					reason:
						"No HTTPS Streamable HTTP endpoint supports " + protocolVersion,
				}),
			)
}

export const catalogFor = (options: {
	readonly cardUrl: string
	readonly identifier: string
}): Catalog =>
	Catalog.make({
		specVersion: "1.0",
		entries: [
			{
				identifier: options.identifier,
				type: cardMediaType,
				url: options.cardUrl,
			},
		],
	})
