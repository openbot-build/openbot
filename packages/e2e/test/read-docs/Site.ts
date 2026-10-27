// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer needs the native server factory.
import { createServer } from "node:http"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	HashMap,
	HashSet,
	Layer,
	Option,
	Path,
	Record as Rec,
	String as Str,
} from "effect"
import {
	FetchHttpClient,
	HttpClient,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import { NetAddress } from "effect/net"
import { parse, type DefaultTreeAdapterTypes } from "parse5"

interface Element {
	readonly tag: string
	readonly attrs: Readonly<Record<string, string>>
	readonly text: string
}

interface Reference {
	readonly source: string
	readonly tag: string
	readonly attribute: string
	readonly target: string
	readonly fragment: string
}

export interface Page {
	readonly route: string
	readonly ids: HashSet.HashSet<string>
	readonly elements: ReadonlyArray<Element>
	readonly references: ReadonlyArray<Reference>
}

const textContent = (node: DefaultTreeAdapterTypes.Node): string =>
	"value" in node
		? node.value
		: "childNodes" in node
			? Arr.join(Arr.map(node.childNodes, textContent), "")
			: ""

const elements = (
	node: DefaultTreeAdapterTypes.Node,
): ReadonlyArray<Element> => [
	...("tagName" in node
		? [
				{
					tag: node.tagName,
					attrs: Rec.fromEntries(
						Arr.map(node.attrs, (attr) => [attr.name, attr.value]),
					),
					text: node.tagName === "title" ? textContent(node) : "",
				},
			]
		: []),
	...("childNodes" in node ? Arr.flatMap(node.childNodes, elements) : []),
	...("content" in node ? elements(node.content) : []),
]

const routeForFile = (file: string): string =>
	Str.endsWith("index.html")(file) ? "/" + Str.slice(0, -10)(file) : "/" + file

const rawReferences = (element: Element) => [
	...Arr.flatMap(["href", "src", "poster", "action"], (attribute) =>
		Option.toArray(
			Option.map(Rec.get(element.attrs, attribute), (value) => ({
				attribute,
				value,
			})),
		),
	),
	...Option.match(Rec.get(element.attrs, "srcset"), {
		onNone: () => [],
		onSome: (value) =>
			Str.startsWith("data:")(value)
				? []
				: Arr.flatMap(Str.split(value, ","), (source) =>
						Option.toArray(
							Option.map(
								Arr.head(Str.split(Str.trim(source), /\s+/)),
								(value) => ({ attribute: "srcset", value }),
							),
						),
					),
	}),
	...(element.tag === "option" &&
	Str.startsWith("/")(element.attrs["value"] ?? "")
		? [{ attribute: "value", value: element.attrs["value"] ?? "" }]
		: []),
]

const readPage = (route: string, content: string, origin: string): Page => {
	const nodes = elements(parse(content))
	return {
		route,
		elements: nodes,
		ids: HashSet.fromIterable(
			Arr.flatMap(nodes, (node) => [
				...Option.toArray(Rec.get(node.attrs, "id")),
				...(node.tag === "a"
					? Option.toArray(Rec.get(node.attrs, "name"))
					: []),
			]),
		),
		references: Arr.flatMap(nodes, (node) =>
			Arr.flatMap(rawReferences(node), (ref) => {
				const url = new URL(ref.value, origin + route)
				if (url.origin !== origin) return []
				return [
					{
						source: route,
						tag: node.tag,
						attribute: ref.attribute,
						target: url.pathname,
						fragment: decodeURIComponent(Str.slice(1)(url.hash)),
					},
				]
			}),
		),
	}
}

export class Site extends Context.Service<
	Site,
	{
		readonly pages: HashMap.HashMap<string, Page>
		readonly files: ReadonlyArray<string>
		readonly references: ReadonlyArray<Reference>
		readonly get: (route: string) => Effect.Effect<
			{
				readonly status: number
				readonly bytes: number
				readonly body: string
			},
			import("effect/http/HttpClientError").HttpClientError
		>
	}
>()("@openbot-build/e2e/test/read-docs/Site") {}

export const layer = Layer.effect(
	Site,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const client = yield* HttpClient.HttpClient
		const manifest = yield* path.fromFileUrl(
			new URL(import.meta.resolve("@openbot-build/docs/package.json")),
		)
		const dist = path.join(path.dirname(manifest), "dist")
		// The build is a prerequisite. A missing output must fail, never skip this test.
		const entries = yield* fs.readDirectory(dist, { recursive: true })
		const files = yield* Effect.filter(
			entries,
			(entry) =>
				fs
					.stat(path.join(dist, entry))
					.pipe(Effect.map((stat) => stat.type === "File")),
			{ concurrency: 16 },
		)
		const home = elements(
			parse(yield* fs.readFileString(path.join(dist, "index.html"))),
		)
		const canonical = yield* Effect.fromOption(
			Arr.findFirst(
				home,
				(node) => node.tag === "link" && node.attrs["rel"] === "canonical",
			),
		)
		const origin = new URL(canonical.attrs["href"] ?? "").origin
		const pages = HashMap.fromIterable(
			yield* Effect.forEach(
				Arr.filter(files, (file) => Str.endsWith(".html")(file)),
				(file) =>
					Effect.gen(function* () {
						const route = routeForFile(file)
						return [
							route,
							readPage(
								route,
								yield* fs.readFileString(path.join(dist, file)),
								origin,
							),
						] as const
					}),
				{ concurrency: 4 },
			),
		)
		const routes = HashMap.fromIterable(
			Arr.flatMap(files, (file) => [
				["/" + file, file] as const,
				[routeForFile(file), file] as const,
			]),
		)
		const server = yield* NodeHttpServer.make(createServer, {
			host: "127.0.0.1",
			port: 0,
		})
		yield* server.serve(
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest
				const route = new URL(request.url, "http://localhost").pathname
				const file = HashMap.get(routes, route)
				if (Option.isSome(file)) {
					return HttpServerResponse.uint8Array(
						yield* fs.readFile(path.join(dist, file.value)),
					)
				}
				if (!Str.endsWith("/")(route) && HashMap.has(routes, route + "/")) {
					return HttpServerResponse.redirect(route + "/", { status: 301 })
				}
				return HttpServerResponse.text("Page not found", { status: 404 })
			}),
		)
		const base = yield* Effect.fromResult(NetAddress.formatUrl(server.address))
		const get = Effect.fn("read-docs.get")(function* (route: string) {
			const response = yield* client.get(base + route)
			const body = yield* response.text
			return {
				status: response.status,
				bytes: new TextEncoder().encode(body).length,
				body,
			}
		})
		return {
			pages,
			files: Arr.map(files, (file) => "/" + file),
			references: Arr.flatMap(
				Arr.fromIterable(HashMap.values(pages)),
				(page) => page.references,
			),
			get,
		}
	}),
).pipe(Layer.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)))

export const pageAt = (pages: HashMap.HashMap<string, Page>, route: string) =>
	HashMap.get(pages, routeForFile(Str.slice(1)(route))).pipe(
		Option.orElse(() => HashMap.get(pages, route + "/")),
	)

export const alternates = (page: Page) =>
	Arr.filter(
		page.elements,
		(node) =>
			node.tag === "link" &&
			node.attrs["rel"] === "alternate" &&
			"hreflang" in node.attrs,
	)

export const homeLanguages = [
	"en",
	"zh-CN",
	"es",
	"ar",
	"hi",
	"pt",
	"fr",
	"id",
	"ru",
	"ja",
	"de",
	"ko",
	"it",
	"tr",
	"vi",
	"th",
	"bn",
	"ur",
	"ms",
	"tl",
	"fa",
	"mr",
	"jv",
	"pcm",
	"te",
	"ta",
	"pl",
	"lah",
	"uk",
	"ha",
	"gu",
	"sw",
	"kn",
	"uz",
	"he",
]

export const manualLanguages = [
	{ prefix: "", language: "en" },
	{ prefix: "/de", language: "de" },
	{ prefix: "/zh-cn", language: "zh-CN" },
]

/** Error-page metadata points to error routes, not to content pages. */
export const isErrorMetadata = (
	target: string,
	uses: ReadonlyArray<Reference>,
) =>
	Arr.contains(["/404/", "/de/404/", "/zh-cn/404/"], target) &&
	uses.length > 0 &&
	Arr.every(
		uses,
		(ref) =>
			ref.source === "/404.html" &&
			(ref.tag === "link" || ref.tag === "option"),
	)
