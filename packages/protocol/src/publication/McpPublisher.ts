import {
	HashSet,
	Context,
	Effect,
	Layer,
	Schema,
	Predicate,
	Record as RecordUtils,
} from "effect"
import * as Client from "../connections/Client.ts"
import * as PublisherProtection from "./PublisherProtection.ts"

import { McpProtocol, McpSchema, McpServer } from "effect/ai"
import {
	HttpRouter,
	HttpServerResponse,
	type HttpServerRequest,
} from "effect/http"
import * as Document from "../Document.ts"
import * as Protection from "./Protection.ts"
import { Publication, UiResource } from "./Publisher.ts"

export const validate = Effect.fn("Publisher.validate")(function* (
	input: unknown,
) {
	const config = yield* Publication.decode(input)
	if (
		config.card._meta !== undefined &&
		Object.hasOwn(config.card._meta, Document.presentationKey)
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
	if (!remotes.some((r) => r.url === mcpUrl)) {
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
	const paths = [cardUrl, catalogUrl, mcpUrl].map((s) => new URL(s).pathname)
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
		!catalog.entries.some(
			(e) => e.type === Document.cardMediaType && e.url === cardUrl,
		)
	) {
		return yield* Document.InvalidDocument.make({
			kind: "Publication",
			issue: "Published Catalog must reference the stable Card URL",
		})
	}
	if (config.etag !== undefined && !/^(W\/)?"[^"\r\n]*"$/.test(config.etag)) {
		return yield* Document.InvalidDocument.make({
			kind: "Publication",
			issue: "ETag must be a quoted HTTP entity tag",
		})
	}
	if (
		config.lastModified !== undefined &&
		!Number.isFinite(Date.parse(config.lastModified))
	) {
		return yield* Document.InvalidDocument.make({
			kind: "Publication",
			issue: "Last-Modified must be an HTTP date",
		})
	}
	return { ...config, cardUrl, catalogUrl, mcpUrl, catalog }
})

/** Register native Effect tools, resources and prompts in the publisher Scope. */
export const layer = <E, R>(options: {
	readonly publication: Publication
	readonly register: Effect.Effect<void, E, R | McpServer.McpServer>
}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const config = yield* validate(options.publication)
			const mcp = McpServer.layerHttp({
				name: config.card.name,
				version: config.card.version,
				description: config.card.description,
				websiteUrl: config.card.websiteUrl,
				path: `/${new URL(config.mcpUrl).pathname.slice(1)}`,
				protocols: [McpProtocol.v2026_07_28],
				allowedOrigins: config.allowedOrigins,
			})
			const docs = HttpRouter.use((router) =>
				Effect.gen(function* () {
					yield* router.add(
						"GET",
						`/${new URL(config.cardUrl).pathname.slice(1)}`,
						(request) =>
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
					yield* router.add(
						"GET",
						`/${new URL(config.catalogUrl).pathname.slice(1)}`,
						(request) =>
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
				Layer.effectDiscard(options.register).pipe(Layer.provideMerge(mcp)),
			)
		}),
	)

/** A protected route cannot be built without TokenVerifier and AccessPolicy. */
export const layerProtected = <E, R>(options: {
	readonly publication: Publication
	readonly protection: Omit<Protection.Options, "resource" | "allowedOrigins">
	readonly register: Effect.Effect<void, E, R | McpServer.McpServer>
}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const publication = yield* validate(options.publication)
			const protection = yield* PublisherProtection.validate({
				...options.protection,
				resource: publication.mcpUrl,
				...RecordUtils.filter(
					{ allowedOrigins: publication.allowedOrigins },
					Predicate.isNotUndefined,
				),
			})
			if (
				[publication.cardUrl, publication.catalogUrl].some(
					(url) =>
						new URL(url).pathname === new URL(protection.metadataUrl).pathname,
				)
			)
				return yield* Document.InvalidDocument.make({
					kind: "Publication",
					issue: "PRM (Protected Resource Metadata) must use its own route",
				})
			return Layer.merge(
				layer({
					publication,
					register: options.register,
				}).pipe(
					Layer.provide(PublisherProtection.middleware(protection).layer),
				),
				PublisherProtection.layerMetadata(protection),
			)
		}),
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
	const headers: Record<string, string> = {
		"content-type": options.mediaType,
		"cache-control": config.cacheControl ?? "no-cache",
	}
	if (config.etag !== undefined) headers["etag"] = config.etag
	if (config.lastModified !== undefined)
		headers["last-modified"] = config.lastModified
	if (config.noindex === true && options.mediaType === Document.cardMediaType)
		headers["x-robots-tag"] = "noindex"
	const inm = request.headers["if-none-match"]
	const etag = config.etag
	const etagMatch =
		inm !== undefined &&
		etag !== undefined &&
		(inm.trim() === "*" ||
			inm
				.split(",")
				.some((t) => t.trim().replace(/^W\//, "") === etag.replace(/^W\//, "")))
	const since = request.headers["if-modified-since"]
	if (
		etagMatch ||
		(inm === undefined &&
			since !== undefined &&
			config.lastModified !== undefined &&
			Date.parse(since) >= Date.parse(config.lastModified))
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

export const catalogLinkHtml = (catalogUrl: string) =>
	Schema.decodeEffect(Document.Link)(catalogUrl).pipe(
		Effect.map(
			(url) =>
				`<link rel="ai-catalog" type="${Document.catalogMediaType}" href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}">`,
		),
	)

export const registerUi = Effect.fn("Publisher.registerUi")(function* (
	input: UiResource,
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
				resourceUri: Schema.String.check(Schema.isPattern(/^ui:\/\/[^\s]+$/)),
				visibility: Schema.optional(Schema.Array(Client.ToolVisibility)),
			}),
		}),
	)({ ui: options })
