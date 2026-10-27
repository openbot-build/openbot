import {
	Array as Arr,
	HashSet,
	Context,
	DateTime,
	Effect,
	flow,
	Layer,
	pipe,
	Result,
	Schema,
	Predicate,
	Record as Rec,
	String as Str,
} from "effect"
import * as Client from "../connections/Client.ts"
import * as PublisherProtection from "./PublisherProtection.ts"

import { McpProtocol, McpSchema, McpServer } from "effect/ai"
import {
	Headers,
	HttpRouter,
	HttpServerResponse,
	type HttpServerRequest,
} from "effect/http"
import * as Ui from "../apps/Ui.ts"
import * as Document from "../Document.ts"
import * as Protection from "./Protection.ts"
import { Publication, UiResource } from "./Publisher.ts"

/**
 * A Publication after `validate`. It always has a Catalog.
 * The declaration file needs this name to keep the brand of Publication.
 */
interface Valid extends Publication {
	readonly catalog: Document.Catalog
}

export const validate = Effect.fn("Publisher.validate")(function* (
	input: unknown,
) {
	const config = yield* Publication.decode(input)
	if (
		config.card._meta !== undefined &&
		Rec.has(config.card._meta, Document.presentationKey)
	) {
		yield* Document.Presentation.decode(
			config.card._meta[Document.presentationKey],
		)
	}
	const cardUrl = yield* Schema.decodeEffect(Document.Link)(config.cardUrl)
	const catalogUrl = yield* Schema.decodeEffect(Document.Link)(
		config.catalogUrl,
	)
	const mcpUrl = yield* Schema.decodeEffect(Document.Link)(config.mcpUrl)
	const remotes = yield* Document.compatibleRemotes(config.card)
	if (!Arr.some(remotes, (r) => r.url === mcpUrl)) {
		return yield* Document.IncompatibleCard.make({
			reason: "Publication MCP URL must match a compatible Card remote",
		})
	}
	if (
		new URL(cardUrl).origin !== new URL(catalogUrl).origin ||
		new URL(cardUrl).origin !== new URL(mcpUrl).origin
	) {
		return yield* Document.InvalidDocument.make({
			kind: "Publication",
			issue:
				"One Publisher serves one public origin. Mount a separate Publisher for each other origin",
		})
	}
	const paths = Arr.map(
		[cardUrl, catalogUrl, mcpUrl],
		(s) => new URL(s).pathname,
	)
	if (HashSet.size(HashSet.fromIterable(paths)) !== 3) {
		return yield* Document.InvalidDocument.make({
			kind: "Publication",
			issue: "Card, Catalog and MCP routes must have distinct paths",
		})
	}
	for (const origin of config.allowedOrigins ?? []) {
		const url = yield* Schema.decodeEffect(Document.Link)(origin)
		if (new URL(url).origin !== origin) {
			return yield* Document.InvalidDocument.make({
				kind: "Publication",
				issue: "allowedOrigins entries must be exact HTTPS origins",
			})
		}
	}
	const catalog =
		config.catalog ??
		Document.catalogFor({ cardUrl, identifier: config.card.name })
	if (
		!Arr.some(
			catalog.entries,
			(e) => e.type === Document.cardMediaType && e.url === cardUrl,
		)
	) {
		return yield* Document.InvalidDocument.make({
			kind: "Publication",
			issue: "Published Catalog must reference the stable Card URL",
		})
	}
	const valid: Valid = { ...config, cardUrl, catalogUrl, mcpUrl, catalog }
	return valid
})

/** The path of an HTTP URL always starts with `/`. */
const routePath = (url: string): `/${string}` =>
	`/${pipe(new URL(url).pathname, Str.slice(1))}`

const serve = <E, R>(
	config: Valid,
	register: Effect.Effect<void, E, R | McpServer.McpServer>,
) => {
	const mcp = McpServer.layerHttp({
		name: config.card.name,
		version: config.card.version,
		description: config.card.description,
		websiteUrl: config.card.websiteUrl,
		path: routePath(config.mcpUrl),
		protocols: [McpProtocol.v2026_07_28],
		allowedOrigins: config.allowedOrigins,
	})
	const docs = HttpRouter.use((router) =>
		Effect.gen(function* () {
			yield* router.add("GET", routePath(config.cardUrl), (request) =>
				Effect.succeed(
					documentResponse({
						request,
						url: config.cardUrl,
						value: config.card,
						mediaType: Document.cardMediaType,
						config,
					}),
				),
			)
			yield* router.add("GET", routePath(config.catalogUrl), (request) =>
				Effect.succeed(
					documentResponse({
						request,
						url: config.catalogUrl,
						value: config.catalog,
						mediaType: Document.catalogMediaType,
						config,
					}),
				),
			)
		}),
	)
	return Layer.merge(
		docs,
		Layer.effectDiscard(register).pipe(Layer.provideMerge(mcp)),
	)
}

/** Register native Effect tools, resources and prompts in the publisher Scope. */
export const layer = <E, R>(options: {
	readonly publication: typeof Publication.Encoded
	readonly register: Effect.Effect<void, E, R | McpServer.McpServer>
}) =>
	Layer.unwrap(
		Effect.map(validate(options.publication), (config) =>
			serve(config, options.register),
		),
	)

/** A protected route cannot be built without TokenVerifier and AccessPolicy. */
export const layerProtected = <E, R>(options: {
	readonly publication: typeof Publication.Encoded
	readonly protection: Omit<Protection.Options, "resource" | "allowedOrigins">
	readonly register: Effect.Effect<void, E, R | McpServer.McpServer>
}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const publication = yield* validate(options.publication)
			const protection = yield* PublisherProtection.validate({
				...options.protection,
				resource: publication.mcpUrl,
				...Rec.filter(
					{ allowedOrigins: publication.allowedOrigins },
					Predicate.isNotUndefined,
				),
			})
			if (
				Arr.some(
					[publication.cardUrl, publication.catalogUrl],
					(url) =>
						new URL(url).pathname === new URL(protection.metadataUrl).pathname,
				)
			)
				return yield* Document.InvalidDocument.make({
					kind: "Publication",
					issue: "PRM (Protected Resource Metadata) must use its own route",
				})
			return Layer.merge(
				serve(publication, options.register).pipe(
					Layer.provide(PublisherProtection.middleware(protection).layer),
				),
				PublisherProtection.layerMetadata(protection),
			)
		}),
	)

/** If-None-Match uses weak comparison, so it ignores the `W/` of a weak entity tag. */
const withoutWeakPrefix = Str.replace(/^W\//, "")

/** RFC 9110 says to ignore an If-Modified-Since value that is not a valid HTTP date. */
const notModifiedSince = (since: string, lastModified: string) =>
	Result.match(
		Result.all([
			Headers.parseHttpDate(since),
			Headers.parseHttpDate(lastModified),
		]),
		{
			onFailure: () => false,
			onSuccess: ([since, lastModified]) =>
				DateTime.isGreaterThanOrEqualTo(since, lastModified),
		},
	)

const documentResponse = (options: {
	readonly request: HttpServerRequest.HttpServerRequest
	readonly url: string
	readonly value: Document.ServerCard | Document.Catalog
	readonly mediaType: string
	readonly config: Publication
}) => {
	const { request, config } = options
	if (
		new URL(request.originalUrl, options.url).search !==
		new URL(options.url).search
	) {
		return HttpServerResponse.empty({ status: 404 })
	}
	const headers = {
		"content-type": options.mediaType,
		"cache-control": config.cacheControl ?? "no-cache",
		...Rec.filter(
			{
				etag: config.etag,
				"last-modified": config.lastModified,
				"x-robots-tag":
					config.noindex === true &&
					options.mediaType === Document.cardMediaType
						? "noindex"
						: undefined,
			},
			Predicate.isNotUndefined,
		),
	}
	const inm = request.headers["if-none-match"]
	const etag = config.etag
	const etagMatch =
		inm !== undefined &&
		etag !== undefined &&
		(Str.trim(inm) === "*" ||
			Arr.some(
				Str.split(inm, ","),
				(t) => withoutWeakPrefix(Str.trim(t)) === withoutWeakPrefix(etag),
			))
	const since = request.headers["if-modified-since"]
	if (
		etagMatch ||
		(inm === undefined &&
			since !== undefined &&
			config.lastModified !== undefined &&
			notModifiedSince(since, config.lastModified))
	) {
		return HttpServerResponse.empty({ status: 304, headers })
	}
	return HttpServerResponse.jsonUnsafe(options.value, { headers })
}

export const catalogLinkHeader = (catalogUrl: string) =>
	Schema.decodeEffect(Document.Link)(catalogUrl).pipe(
		Effect.map(
			(url) =>
				`<${url}>; rel="ai-catalog"; type="${Document.catalogMediaType}"`,
		),
	)

const escapeAttribute = flow(
	Str.replaceAll("&", "&amp;"),
	Str.replaceAll('"', "&quot;"),
	Str.replaceAll("<", "&lt;"),
)

export const catalogLinkHtml = (catalogUrl: string) =>
	Schema.decodeEffect(Document.Link)(catalogUrl).pipe(
		Effect.map(
			(url) =>
				`<link rel="ai-catalog" type="${Document.catalogMediaType}" href="${escapeAttribute(url)}">`,
		),
	)

export const registerUi = Effect.fn("Publisher.registerUi")(function* (
	input: typeof UiResource.Encoded,
) {
	const resource = yield* UiResource.decode(input)
	const server = yield* McpServer.McpServer
	yield* server.addResource({
		resource: McpSchema.Resource.make({
			uri: resource.uri,
			name: resource.name,
			mimeType: Document.uiMediaType,
		}),
		annotations: Context.empty(),
		handle: Effect.succeed(
			McpSchema.ReadResourceResult.make({
				contents: [
					McpSchema.TextResourceContents.make({
						uri: resource.uri,
						mimeType: Document.uiMediaType,
						text: resource.html,
						_meta: resource.meta,
					}),
				],
			}),
		),
	})
})

/** This is the native tool metadata shape. Annotate Tool.Meta with this value. */
export const uiToolMeta = (options: {
	readonly resourceUri: string
	readonly visibility?: ReadonlyArray<Client.ToolVisibility>
}) =>
	Schema.decodeEffect(
		Schema.Struct({
			ui: Schema.Struct({
				resourceUri: Ui.Uri,
				visibility: Schema.optional(Schema.Array(Client.ToolVisibility)),
			}),
		}),
	)({ ui: options })
