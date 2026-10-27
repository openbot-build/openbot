import { Context, Effect, Schema } from "effect"
import * as Document from "../Document.ts"
import * as Network from "../network/Network.ts"

export class Source extends Schema.Opaque<
	Source,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		role: Schema.Literals([
			"input",
			"page",
			"catalog",
			"card",
			"endpoint",
			"manual",
		]),
		url: Schema.String,
		originalInput: Schema.optional(Schema.String),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Source)(value).pipe(
			Effect.mapError((error) =>
				DiscoveryError.make({
					reason: "Document",
					issues: [{ url: "", reason: error.message }],
				}),
			),
		)
}

export class ConfigurationRequirement extends Schema.Opaque<
	ConfigurationRequirement,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		key: Schema.String,
		description: Schema.optional(Schema.String),
		isSecret: Schema.Boolean,
		format: Schema.optional(Schema.String),
		choices: Schema.optional(Schema.Array(Schema.String)),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(ConfigurationRequirement)(value).pipe(
			Effect.mapError((error) =>
				DiscoveryError.make({
					reason: "Document",
					issues: [{ url: "", reason: error.message }],
				}),
			),
		)
}

export class Endpoint extends Schema.Opaque<
	Endpoint,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		index: Schema.Natural,
		remote: Document.Remote,
		requirements: Schema.Array(ConfigurationRequirement),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Endpoint)(value).pipe(
			Effect.mapError((error) =>
				DiscoveryError.make({
					reason: "Document",
					issues: [{ url: "", reason: error.message }],
				}),
			),
		)
}

export class Candidate extends Schema.Opaque<
	Candidate,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		cardUrl: Schema.String,
		card: Document.ServerCard,
		endpoints: Schema.Array(Endpoint),
		sources: Schema.Array(Source),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Candidate)(value).pipe(
			Effect.mapError((error) =>
				DiscoveryError.make({
					reason: "Document",
					issues: [{ url: "", reason: error.message }],
				}),
			),
		)
}

export class Issue extends Schema.Opaque<
	Issue,
	{ readonly brand: unique symbol }
>()(
	Schema.Struct({
		url: Schema.String,
		reason: Schema.String,
		fieldPath: Schema.optionalKey(Schema.String),
	}),
) {
	public static decode = (value: unknown) =>
		Schema.decodeUnknownEffect(Issue)(value).pipe(
			Effect.mapError((error) =>
				DiscoveryError.make({
					reason: "Document",
					issues: [{ url: "", reason: error.message }],
				}),
			),
		)
}

export type Update =
	| {
			readonly _tag: "DescriptionUpdated"
			readonly candidate: Candidate
	  }
	| {
			readonly _tag: "NeedsRevalidation"
			readonly candidate: Candidate
			readonly reason: "ConnectionDescriptionChanged"
	  }

/** A saved discovery result keeps the same candidate and issue types as discovery. */
export const Result = Schema.TaggedUnion({
	Single: { candidate: Candidate, issues: Schema.Array(Issue) },
	Multiple: {
		candidates: Schema.TupleWithRest(Schema.Tuple([Candidate, Candidate]), [
			Candidate,
		]),
		issues: Schema.Array(Issue),
	},
})
export type Result = typeof Result.Type

export const DiscoveryErrorReason = Schema.Literals([
	"NoDeclaration",
	"NoUsableServices",
	"Document",
	"Http",
	"Configuration",
])
export type DiscoveryErrorReason = typeof DiscoveryErrorReason.Type

export class DiscoveryError extends Schema.TaggedError<
	DiscoveryError,
	{ readonly brand: unique symbol }
>()("DiscoveryError", {
	reason: DiscoveryErrorReason,
	issues: Schema.Array(Issue),
}) {}

export type Error =
	| DiscoveryError
	| Document.InvalidLink
	| Schema.SchemaError
	| Document.InvalidDocument
	| Document.IncompatibleCard
	| Network.NetworkError

export class Discovery extends Context.Service<
	Discovery,
	{
		readonly resolve: (input: string) => Effect.Effect<Result, Error>
		readonly refreshCard: (cardUrl: string) => Effect.Effect<Candidate, Error>
		readonly refresh: (previous: Candidate) => Effect.Effect<Update, Error>
	}
>()("@openbot-build/protocol/discovery/Discovery") {}

export const resolve = (input: string) =>
	Discovery.use((service) => service.resolve(input))

export interface Options {
	/** Fixed for this Discovery instance. The target origin selects the headers. */
	readonly headersByOrigin?: Readonly<
		Record<string, Readonly<Record<string, string>>>
	>
}

export class Rules extends Context.Service<
	Rules,
	{
		readonly compare: (options: {
			readonly previous: Candidate
			readonly current: Candidate
		}) => Update
		readonly inputLink: (
			input: string,
		) => Effect.Effect<string, Document.InvalidLink | Schema.SchemaError>
		readonly configureEndpoint: (options: {
			readonly candidate: Candidate
			readonly index: number
			readonly values: Readonly<Record<string, string>>
		}) => Effect.Effect<
			{
				readonly url: typeof Document.Link.Type
				readonly headers: Readonly<Record<string, string>>
				readonly remoteIndex: number
			},
			DiscoveryError | Schema.SchemaError
		>
		readonly catalogLinks: (options: {
			readonly responseUrl: string
			readonly link?: string | undefined
			readonly html?: string | undefined
		}) => ReadonlyArray<string>
		readonly requirements: (
			remote: Document.Remote,
		) => ReadonlyArray<ConfigurationRequirement>
	}
>()("@openbot-build/protocol/discovery/Discovery/Rules") {}
