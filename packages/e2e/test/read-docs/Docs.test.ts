import { assert, layer } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	HashMap,
	HashSet,
	Option,
	Record as Rec,
	Schema,
	String as Str,
} from "effect"
import * as Docs from "./Site.ts"

const Operation = Schema.Struct({ operationId: Schema.optional(Schema.String) })

const OpenApi = Schema.fromJsonString(
	Schema.Struct({
		paths: Schema.Record(
			Schema.String,
			Schema.Record(Schema.String, Operation),
		),
	}),
)

const hasTag = (page: Docs.Page, tag: string) =>
	Arr.some(page.elements, (node) => node.tag === tag)

// The full crawl uses real HTTP and has a scope that closes the local server.
layer(Docs.layer, { excludeTestServices: true, timeout: "60 seconds" })(
	(it) => {
		it.effect("normal: read every home language and its docs entry", () =>
			Effect.gen(function* () {
				const { pages, get } = yield* Docs.Site
				for (const language of Docs.homeLanguages) {
					const route =
						language === "en" ? "/" : `/${Str.toLowerCase(language)}/`
					const page = yield* Effect.fromOption(Docs.pageAt(pages, route))
					const html = yield* Effect.fromOption(
						Arr.findFirst(page.elements, (node) => node.tag === "html"),
					)
					assert.strictEqual(html.attrs["lang"], language, route)
					assert.strictEqual(
						html.attrs["dir"],
						Arr.contains(["ar", "ur", "fa", "lah", "he"], language)
							? "rtl"
							: "ltr",
						route,
					)
					assert.strictEqual(
						Arr.filter(page.elements, (node) => node.tag === "h1").length,
						1,
						route,
					)
					assert.isTrue(
						Arr.some(
							page.elements,
							(node) => node.tag === "title" && node.text.length > 0,
						),
						route,
					)
					assert.deepStrictEqual(
						Arr.sort(
							Arr.map(
								Docs.alternates(page),
								(node) => node.attrs["hreflang"] ?? "",
							),
							Str.Order,
						),
						Arr.sort([...Docs.homeLanguages, "x-default"], Str.Order),
						route,
					)
					const docs =
						language === "de" || language === "zh-CN"
							? `${route}docs/`
							: "/docs/"
					assert.isTrue(
						Arr.some(
							page.references,
							(ref) => ref.tag === "a" && ref.target === docs,
						),
						route,
					)
					assert.strictEqual((yield* get(route)).status, 200, route)
				}
			}),
		)

		it.effect(
			"normal: read the manual, API contract, search files, and icon",
			() =>
				Effect.gen(function* () {
					const { pages, files, get } = yield* Docs.Site
					for (const { prefix, language } of Docs.manualLanguages) {
						const manuals = Arr.filter(HashMap.values(pages), (page) =>
							Str.startsWith(prefix + "/docs/")(page.route),
						)
						assert.isAbove(manuals.length, 0, language)
						for (const page of manuals) {
							const html = yield* Effect.fromOption(
								Arr.findFirst(page.elements, (node) => node.tag === "html"),
							)
							assert.strictEqual(html.attrs["lang"], language, page.route)
							assert.strictEqual(
								Arr.filter(page.elements, (node) => node.tag === "h1").length,
								1,
								page.route,
							)
							assert.isTrue(
								Arr.some(
									page.elements,
									(node) => node.tag === "title" && node.text.length > 0,
								),
								page.route,
							)
						}
						assert.strictEqual(
							(yield* get(prefix + "/docs/developers/testing/")).status,
							200,
						)
					}
					const icon = yield* get("/favicon.svg")
					assert.strictEqual(icon.status, 200)
					assert.include(icon.body, "<svg")
					assert.isTrue(Arr.some(files, (file) => Str.endsWith(".css")(file)))
					assert.isTrue(Arr.some(files, (file) => Str.endsWith(".woff2")(file)))
					assert.strictEqual((yield* get("/pagefind/pagefind.js")).status, 200)
					const index = yield* Schema.decodeEffect(
						Schema.fromJsonString(
							Schema.Struct({
								languages: Schema.Record(Schema.String, Schema.Unknown),
							}),
						),
					)((yield* get("/pagefind/pagefind-entry.json")).body)
					assert.deepStrictEqual(
						Arr.sort(Rec.keys(index.languages), Str.Order),
						["de", "en", "zh-cn"],
					)
					const contract = yield* Schema.decodeEffect(OpenApi)(
						(yield* get("/openapi.json")).body,
					)
					const operations = Arr.flatMap(
						Arr.flatMap(Rec.values(contract.paths), (item) => Rec.values(item)),
						(operation: typeof Operation.Type) =>
							Option.toArray(Option.fromUndefinedOr(operation.operationId)),
					)
					assert.isAbove(operations.length, 0)
					for (const operation of operations) {
						// Contract groups use dots. Their public docs links omit those dots.
						const slug = Str.toLowerCase(
							Arr.join(Str.split(operation, "."), ""),
						)
						assert.isTrue(
							HashMap.has(pages, `/docs/api/operations/${slug}/`),
							operation,
						)
					}
					yield* Effect.logInfo("Docs API contract", {
						operations: operations.length,
					})
				}),
		)

		it.effect(
			"edge: manual languages keep real choices and API pages keep English links",
			() =>
				Effect.gen(function* () {
					const { pages, get } = yield* Docs.Site
					for (const page of HashMap.values(pages)) {
						if (/^\/docs\/api(?:\/|$)/.test(page.route)) {
							assert.isFalse(hasTag(page, "starlight-lang-select"), page.route)
							assert.deepStrictEqual(
								Arr.sort(
									Arr.map(
										Docs.alternates(page),
										(node) => node.attrs["hreflang"] ?? "",
									),
									Str.Order,
								),
								["en", "x-default"],
								page.route,
							)
						} else if (/^(?:\/de|\/zh-cn)?\/docs\//.test(page.route)) {
							assert.isTrue(hasTag(page, "starlight-lang-select"), page.route)
							assert.deepStrictEqual(
								Arr.sort(
									Arr.map(
										Docs.alternates(page),
										(node) => node.attrs["hreflang"] ?? "",
									),
									Str.Order,
								),
								["de", "en", "x-default", "zh-CN"],
								page.route,
							)
						}
					}
					assert.strictEqual((yield* get("/docs/api")).status, 200)
					assert.strictEqual((yield* get("/de/docs/api/")).status, 404)
					assert.strictEqual((yield* get("/zh-cn/docs/api/")).status, 404)
					assert.strictEqual(
						(yield* get("/this-page-does-not-exist/")).status,
						404,
					)
					assert.strictEqual((yield* get("/404.html")).status, 200)
				}),
		)

		it.effect(
			"extreme: every built file, local link, and decoded anchor has a target",
			() =>
				Effect.gen(function* () {
					const { pages, files, references, get } = yield* Docs.Site
					const targets = HashSet.fromIterable([
						...HashMap.keys(pages),
						...files,
						...Arr.map(references, (ref) => ref.target),
					])
					const referencesByTarget = Arr.groupBy(
						references,
						(ref) => ref.target,
					)
					const results = HashMap.fromIterable(
						yield* Effect.forEach(
							targets,
							(target) =>
								Effect.gen(function* () {
									const response = yield* get(target)
									const uses = referencesByTarget[target] ?? []
									assert.strictEqual(
										response.status,
										Docs.isErrorMetadata(target, uses) ? 404 : 200,
										target,
									)
									assert.isAbove(response.bytes, 0, target)
									return [target, response.status] as const
								}),
							{ concurrency: 12 },
						),
					)
					const anchors = Arr.filter(
						references,
						(ref) => ref.tag === "a" && ref.fragment !== "",
					)
					assert.isAbove(anchors.length, 0)
					assert.isTrue(
						Arr.some(anchors, (ref) => /[^\x00-\x7f]/.test(ref.fragment)),
					)
					for (const ref of anchors) {
						if (!Option.contains(HashMap.get(results, ref.target), 200))
							continue
						const target = Docs.pageAt(pages, ref.target)
						if (Option.isSome(target))
							assert.isTrue(
								HashSet.has(target.value.ids, ref.fragment),
								`${ref.source} -> ${ref.target}#${ref.fragment}`,
							)
					}
					yield* Effect.logInfo("Docs crawl", {
						pages: HashMap.size(pages),
						files: files.length,
						requests: HashSet.size(targets),
						references: references.length,
						anchors: anchors.length,
					})
				}),
			{ timeout: 120_000 },
		)
	},
)
