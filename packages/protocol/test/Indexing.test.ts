import {
	Array as Arr,
	HashMap,
	Effect,
	Fiber,
	Layer,
	Option,
	pipe,
	Redacted,
	Match,
	Predicate,
	Schema,
	String as Str,
} from "effect"
import {
	CatalogDiscovery,
	RobotsPolicy,
	PublicIndexing,
	MemoryIndex,
	MemoryStore,
	Index,
	Document,
	Indexing,
	Network,
	Store,
} from "@openbot-build/protocol"
import { assert, it } from "@effect/vitest"

import { TestClock } from "effect/testing"

// These tests build public-only services with Effect.provide. The TestClock
// of it.effect is the clock of these services.

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const cardAt = (cardUrl: string, websiteUrl?: string): Document.ServerCard =>
	Document.ServerCard.make({
		$schema: Document.cardSchemaUrl,
		name: "example.test/notes",
		version: "1.0.0",
		description: "Public description",
		...(websiteUrl === undefined ? {} : { websiteUrl }),
		remotes: [
			{
				type: "streamable-http",
				url: new URL("/mcp", cardUrl).href,
				supportedProtocolVersions: [Document.protocolVersion],
			},
		],
	})
const site = (
	cardUrl = "https://publisher.example/card",
	websiteUrl?: string,
) => {
	let responses = HashMap.empty<string, Network.DocumentResponse>()
	let requests: ReadonlyArray<
		Parameters<Network.PublicNetwork["Service"]["readDocument"]>[0]
	> = []
	const document = (
		url: string,
		value: unknown,
		type: string,
		headers: Readonly<Record<string, string>> = {},
		status = 200,
	) => {
		responses = HashMap.set(responses, url, {
			url,
			status,
			text: Predicate.isString(value) ? value : JSON.stringify(value),
			headers: {
				"content-type": type,
				"cache-control": "max-age=0",
				...headers,
			},
		})
	}
	const catalog = (url: string, links = [cardUrl]) =>
		document(
			url,
			{
				specVersion: "1.0",
				entries: Arr.map(links, (link) => ({
					identifier: "not-an-identity",
					type: Document.cardMediaType,
					url: link,
				})),
			},
			Document.catalogMediaType,
			{ etag: '"catalog-1"' },
		)
	document(cardUrl, cardAt(cardUrl, websiteUrl), Document.cardMediaType, {
		etag: '"card-1"',
	})
	catalog(new URL("/.well-known/ai-catalog.json", cardUrl).href)
	const network = Layer.succeed(Network.PublicNetwork, {
		readDocument: (options) =>
			Effect.sync(() => {
				requests = Arr.append(requests, options)
				const response = Option.getOrUndefined(
					HashMap.get(responses, options.url),
				) ?? {
					url: options.url,
					status: 404,
					text: "",
					headers: {
						"cache-control": "no-cache",
					},
				}
				return options.validators?.etag !== undefined &&
					options.validators.etag === response.headers["etag"]
					? { ...response, status: 304, text: "" }
					: response
			}),
	})
	const layers = PublicIndexing.layer.pipe(
		Layer.provide(RobotsPolicy.layer),
		Layer.provideMerge(
			Layer.mergeAll(network, MemoryIndex.layer, MemoryStore.layer),
		),
	)
	return {
		cardUrl,
		get responses() {
			return responses
		},
		set responses(value: typeof responses) {
			responses = value
		},
		get requests() {
			return requests
		},
		document,
		catalog,
		network,
		layers,
	}
}
// Each provide builds fresh services, as a fresh runtime did before.
const provideSite = (fixture: ReturnType<typeof site>) =>
	Effect.provide(
		fixture.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
it.effect(
	"anonymous publisher evidence, stable identities and conditional updates do not depend on private connections",
	() =>
		Effect.gen(function* () {
			const fixture = site()
			yield* Effect.gen(function* () {
				const apps = yield* Store.AppStore
				yield* apps.save({
					app: Store.AppRecord.make({
						cardUrl: fixture.cardUrl,
						card: cardAt(fixture.cardUrl),
						sources: [],
					}),
					connection: Store.UserConnection.make({
						owner: "alice",
						connectionId: "notes",
						cardUrl: fixture.cardUrl,
						endpoint: "https://publisher.example/mcp",
						remoteIndex: 0,
						state: "Enabled",
						authorization: { _tag: "Unprotected" },
						configuration: Redacted.make({
							tenant: "private-tenant",
						}),
						headers: Redacted.make({
							"x-private": "private-secret",
						}),
					}),
				})
				const input = Indexing.Input.make({ cardUrl: fixture.cardUrl })
				const first = yield* Indexing.sync(input)
				assert.strictEqual(first._tag, "Indexed")
				return yield* Match.value(first).pipe(
					Match.tag("Indexed", (first) =>
						Effect.gen(function* () {
							assert.strictEqual(first.entry.cardUrl, fixture.cardUrl)
							assert.strictEqual(
								first.entry.evidence[0]?.association,
								"CardOrigin",
							)
							const text = yield* encodeJson(first)
							assert.strictEqual(Str.includes("private-secret")(text), false)
							assert.strictEqual(Str.includes("private-tenant")(text), false)
							assert.strictEqual((yield* Indexing.sync(input))._tag, "Indexed")
							assert.ok(
								Arr.some(
									fixture.requests,
									(request) => request.validators?.etag === '"card-1"',
								),
							)
							assert.ok(
								Arr.every(
									fixture.requests,
									(request) =>
										!Predicate.hasProperty(request, "headers") &&
										request.followRedirects === false,
								),
							)
							fixture.responses = HashMap.remove(
								fixture.responses,
								"https://publisher.example/.well-known/ai-catalog.json",
							)
							assert.strictEqual(
								(yield* Indexing.sync(input))._tag,
								"Unconfirmed",
							)
							assert.strictEqual(
								(yield* (yield* Index.IndexStore).get(fixture.cardUrl))._tag,
								"Some",
							)
							fixture.catalog(
								"https://publisher.example/.well-known/ai-catalog.json",
								[],
							)
							const catalog = HashMap.get(
								fixture.responses,
								"https://publisher.example/.well-known/ai-catalog.json",
							).pipe(Option.getOrElse(() => assert.fail("Missing Catalog")))
							fixture.responses = HashMap.set(fixture.responses, catalog.url, {
								...catalog,
								headers: {
									...catalog.headers,
									etag: '"catalog-2"',
								},
							})
							const withdrawn = yield* Indexing.sync(input)
							assert.strictEqual(withdrawn._tag, "Withdrawn")
							const index = yield* Index.IndexStore
							assert.strictEqual(
								Option.isNone(yield* index.get(fixture.cardUrl)),
								true,
							)
							assert.strictEqual(
								(yield* apps.get({
									owner: "alice",
									connectionId: "notes",
								})).state,
								"Enabled",
							)
							assert.strictEqual(
								(yield* Effect.result(
									Indexing.Input.decode({
										cardUrl: fixture.cardUrl,
										owner: "alice",
										credentialRef: "private",
									}),
								))._tag,
								"Failure",
							)
						}),
					),
					Match.orElse(() => Effect.void),
				)
			}).pipe(provideSite(fixture))
		}),
)
it.effect(
	"cross-host Card association succeeds, but a third-party repost gives no publisher evidence",
	() =>
		Effect.gen(function* () {
			const fixture = site(
				"https://hosting.example/card",
				"https://publisher.example/product",
			)
			fixture.responses = HashMap.remove(
				fixture.responses,
				"https://hosting.example/.well-known/ai-catalog.json",
			)
			fixture.document(
				"https://publisher.example/product",
				'<!doctype html><head><link rel="ai-catalog" href="/catalog?product=notes"></head>',
				"text/html",
			)
			fixture.catalog("https://publisher.example/catalog?product=notes")
			yield* Effect.gen(function* () {
				const indexed = yield* Indexing.sync(
					Indexing.Input.make({ cardUrl: fixture.cardUrl }),
				)
				assert.strictEqual(indexed._tag, "Indexed")
				Match.value(indexed).pipe(
					Match.tag("Indexed", (indexed) => {
						assert.deepStrictEqual(
							indexed.entry.evidence[0],
							Index.Evidence.make({
								publisherUrl: "https://publisher.example/product",
								catalogUrl: "https://publisher.example/catalog?product=notes",
								cardUrl: fixture.cardUrl,
								association: "Website",
							}),
						)
					}),
					Match.orElse(() => undefined),
				)
				fixture.document(
					fixture.cardUrl,
					cardAt(fixture.cardUrl),
					Document.cardMediaType,
					{ etag: '"card-2"' },
				)
				assert.strictEqual(
					(yield* Indexing.sync(
						Indexing.Input.make({ cardUrl: fixture.cardUrl }),
					))._tag,
					"Withdrawn",
				)
			}).pipe(provideSite(fixture))
			const repost = site("https://hosting.example/card")
			repost.responses = HashMap.remove(
				repost.responses,
				"https://hosting.example/.well-known/ai-catalog.json",
			)
			repost.catalog("https://third-party.example/catalog")
			yield* Effect.gen(function* () {
				const result = yield* Indexing.sync(
					Indexing.Input.make({
						cardUrl: repost.cardUrl,
						sources: [
							{
								role: "catalog",
								url: "https://third-party.example/catalog",
							},
						],
					}),
				)
				assert.strictEqual(result._tag, "Excluded")
				assert.ok(
					Arr.every(
						repost.requests,
						(request) => !Str.includes("third-party")(request.url),
					),
				)
			}).pipe(provideSite(repost))
		}),
)
it.effect(
	"noindex withdraws the entry, and authorization, robots and storage failures never report indexing success",
	() =>
		Effect.gen(function* () {
			const fixture = site()
			yield* Effect.gen(function* () {
				assert.strictEqual(
					(yield* Indexing.sync(
						Indexing.Input.make({ cardUrl: fixture.cardUrl }),
					))._tag,
					"Indexed",
				)
				fixture.document(
					fixture.cardUrl,
					cardAt(fixture.cardUrl),
					Document.cardMediaType,
					{ "x-robots-tag": "NOINDEX", etag: '"card-2"' },
				)
				assert.strictEqual(
					(yield* Indexing.sync(
						Indexing.Input.make({ cardUrl: fixture.cardUrl }),
					))._tag,
					"Withdrawn",
				)
				fixture.document(
					fixture.cardUrl,
					"Login required",
					"text/plain",
					{},
					401,
				)
				assert.strictEqual(
					(yield* Indexing.sync(
						Indexing.Input.make({ cardUrl: fixture.cardUrl }),
					))._tag,
					"Unconfirmed",
				)
				fixture.document(
					"https://publisher.example/robots.txt",
					"User-agent: *\nDisallow: /",
					"text/plain",
				)
				const count = Arr.filter(
					fixture.requests,
					(request) => request.url === fixture.cardUrl,
				).length
				assert.strictEqual(
					(yield* Indexing.sync(
						Indexing.Input.make({ cardUrl: fixture.cardUrl }),
					))._tag,
					"Excluded",
				)
				assert.strictEqual(
					Arr.filter(
						fixture.requests,
						(request) => request.url === fixture.cardUrl,
					).length,
					count,
				)
				fixture.document(
					"https://publisher.example/robots.txt",
					"Unavailable",
					"text/plain",
					{},
					503,
				)
				assert.strictEqual(
					(yield* Indexing.sync(
						Indexing.Input.make({ cardUrl: fixture.cardUrl }),
					))._tag,
					"Unconfirmed",
				)
				assert.strictEqual(
					Arr.filter(
						fixture.requests,
						(request) => request.url === fixture.cardUrl,
					).length,
					count,
				)
			}).pipe(provideSite(fixture))
			const valid = site()
			const broken = Layer.succeed(Index.IndexStore, {
				get: () => Effect.succeedNone,
				withdraw: () => Effect.void,
				upsert: () =>
					Effect.fail(
						Index.IndexError.make({
							reason: "Unavailable",
							operation: "upsert",
						}),
					),
			})
			const result = yield* Effect.result(
				Indexing.sync(Indexing.Input.make({ cardUrl: valid.cardUrl })),
			).pipe(
				Effect.provide(
					PublicIndexing.layer.pipe(
						Layer.provide(RobotsPolicy.layer),
						Layer.provide(Layer.mergeAll(valid.network, broken)),
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
			)
			assert.strictEqual(result._tag, "Failure")
		}),
)
it.effect(
	"robots combines matching bots, encoded paths, wildcards, longest match and allow ties",
	() =>
		Effect.gen(function* () {
			for (const [path, text, expected] of [
				[
					"/card",
					"User-agent: *\nDisallow: /\nUser-agent: OpenBot\nAllow: /card",
					"Indexed",
				],
				[
					"/card",
					"User-agent: OPENBOT\nDisallow: /card\nUser-agent: OpenBot\nAllow: /card",
					"Indexed",
				],
				["/foo/bar", "User-agent: *\nDisallow: /foo/%62ar", "Excluded"],
				["/foo/%2Fbar", "User-agent: *\nDisallow: /foo//bar", "Indexed"],
				["/\uFF35\uFF33", "User-agent: *\nDisallow: /\uFF35\uFF33", "Excluded"],
				[
					"/card?type=private",
					"User-agent: *\nDisallow: /card*private$",
					"Excluded",
				],
				[
					"/card?type=private-more",
					"User-agent: *\nDisallow: /card*private$",
					"Indexed",
				],
				[
					"/card",
					"User-agent: *\nDisallow: /\nAllow: /card\nSitemap: https://publisher.example/sitemap\nDisallow: /card",
					"Indexed",
				],
				["/a%2A.html", "User-agent: *\nDisallow: /a%2A.html", "Excluded"],
				["/a*.html", "User-agent: *\nDisallow: /a%2A.html", "Excluded"],
				["/animation.gif", "User-agent: *\nDisallow: *.gif$", "Excluded"],
			] as const) {
				const fixture = site("https://publisher.example" + path)
				fixture.document(
					"https://publisher.example/robots.txt",
					text + "\nAllow: /.well-known/",
					"text/plain",
				)
				const result = yield* Indexing.sync(
					Indexing.Input.make({ cardUrl: fixture.cardUrl }),
				).pipe(provideSite(fixture))
				assert.strictEqual(result._tag, expected, path + " " + text)
			}
		}),
)
it.effect(
	"robots redirects apply to the original authority, and blocked redirect targets of documents are never fetched",
	() =>
		Effect.gen(function* () {
			const fixture = site()
			fixture.document(
				"https://publisher.example/robots.txt",
				"",
				"text/plain",
				{ location: "https://rules.example/rules" },
				302,
			)
			fixture.document(
				"https://rules.example/rules",
				"User-agent: *\nDisallow: /card",
				"text/plain",
			)
			let result = yield* Indexing.sync(
				Indexing.Input.make({ cardUrl: fixture.cardUrl }),
			).pipe(provideSite(fixture))
			assert.strictEqual(result._tag, "Excluded")
			assert.ok(
				Arr.every(
					fixture.requests,
					(request) => request.url !== fixture.cardUrl,
				),
			)
			fixture.document(
				"https://rules.example/rules",
				"User-agent: *\nDisallow: /private",
				"text/plain",
			)
			fixture.document(
				fixture.cardUrl,
				"",
				"text/plain",
				{ location: "/private" },
				302,
			)
			result = yield* Indexing.sync(
				Indexing.Input.make({ cardUrl: fixture.cardUrl }),
			).pipe(provideSite(fixture))
			assert.strictEqual(result._tag, "Excluded")
			assert.ok(
				Arr.every(
					fixture.requests,
					(request) => request.url !== "https://publisher.example/private",
				),
			)
		}),
)

it.effect(
	"robots cache expires within 24 hours, and no-store responses are never reused through conditional requests",
	() =>
		Effect.gen(function* () {
			const fixture = site()
			fixture.document(
				"https://publisher.example/robots.txt",
				"User-agent: *\nAllow: /",
				"text/plain",
				{ "cache-control": "max-age=172800", etag: '"robots-1"' },
			)
			yield* Effect.gen(function* () {
				assert.strictEqual(
					(yield* Indexing.sync(
						Indexing.Input.make({ cardUrl: fixture.cardUrl }),
					))._tag,
					"Indexed",
				)
				const first = Arr.filter(fixture.requests, (request) =>
					Str.endsWith("/robots.txt")(request.url),
				).length
				assert.strictEqual(
					(yield* Indexing.sync(
						Indexing.Input.make({ cardUrl: fixture.cardUrl }),
					))._tag,
					"Indexed",
				)
				assert.strictEqual(
					Arr.filter(fixture.requests, (request) =>
						Str.endsWith("/robots.txt")(request.url),
					).length,
					first,
				)
				fixture.document(
					"https://publisher.example/robots.txt",
					"User-agent: *\nDisallow: /card",
					"text/plain",
					{
						etag: '"robots-2"',
						"cache-control": "max-age=172800",
					},
				)
				yield* TestClock.adjust("24 hours")
				assert.strictEqual(
					(yield* Indexing.sync(
						Indexing.Input.make({ cardUrl: fixture.cardUrl }),
					))._tag,
					"Excluded",
				)
				assert.ok(
					Arr.some(
						fixture.requests,
						(request) => request.validators?.etag === '"robots-1"',
					),
				)
			}).pipe(provideSite(fixture))
			const uncached = site()
			uncached.document(
				uncached.cardUrl,
				cardAt(uncached.cardUrl),
				Document.cardMediaType,
				{ "cache-control": "no-store", etag: '"private-cache"' },
			)
			yield* Effect.gen(function* () {
				yield* Indexing.sync(Indexing.Input.make({ cardUrl: uncached.cardUrl }))
				yield* Indexing.sync(Indexing.Input.make({ cardUrl: uncached.cardUrl }))
				assert.ok(
					pipe(
						uncached.requests,
						Arr.filter((request) => request.url === uncached.cardUrl),
						Arr.every((request) => request.validators === undefined),
					),
				)
			}).pipe(provideSite(uncached))
		}),
)

it.effect(
	"publication inspection checks live eligibility without an Index writer",
	() =>
		Effect.gen(function* () {
			const fixture = site()
			// One built Layer serves all three checks, as one runtime did before.
			const services = yield* Layer.build(
				PublicIndexing.layerInspection.pipe(
					Layer.provide(fixture.network),
					Layer.provide(RobotsPolicy.layer),
					Layer.provide(CatalogDiscovery.layerRules),
				),
			)
			const input = yield* Indexing.Input.decode({ cardUrl: fixture.cardUrl })
			const eligible = yield* Indexing.inspect(input).pipe(
				Effect.provideContext(services),
			)
			assert.strictEqual(eligible._tag, "Eligible")
			if (eligible._tag === "Eligible")
				assert.strictEqual(eligible.entry.cardUrl, fixture.cardUrl)
			fixture.document(
				fixture.cardUrl,
				cardAt(fixture.cardUrl),
				Document.cardMediaType,
				{ "x-robots-tag": "noindex" },
			)
			const excluded = yield* Indexing.inspect(input).pipe(
				Effect.provideContext(services),
			)
			assert.strictEqual(excluded._tag, "Excluded")
			if (excluded._tag === "Excluded")
				assert.strictEqual(excluded.reason, "NoIndex")
			fixture.document(fixture.cardUrl, "Unavailable", "text/plain", {}, 503)
			const unconfirmed = yield* Indexing.inspect(input).pipe(
				Effect.provideContext(services),
			)
			assert.strictEqual(unconfirmed._tag, "Unconfirmed")
		}),
)

it.effect(
	"an Unconfirmed result gives a safe issue, and a stalled publisher stops at the deadline",
	() =>
		Effect.gen(function* () {
			const fixture = site()
			fixture.document(
				fixture.cardUrl,
				{ ...cardAt(fixture.cardUrl), remotes: [] },
				Document.cardMediaType,
			)
			const incompatible = yield* Indexing.sync(
				Indexing.Input.make({ cardUrl: fixture.cardUrl }),
			).pipe(provideSite(fixture))
			assert.ok(incompatible._tag === "Unconfirmed")
			assert.strictEqual(incompatible.reason, "InvalidDocument")
			assert.strictEqual(
				incompatible.issue,
				"The public App Card has no supported connection.",
			)
			const stalled = Layer.succeed(Network.PublicNetwork, {
				readDocument: () => Effect.never,
			})
			const fiber = yield* Indexing.sync(
				Indexing.Input.make({ cardUrl: fixture.cardUrl }),
			).pipe(
				Effect.provide(
					PublicIndexing.layer.pipe(
						Layer.provide(RobotsPolicy.layer),
						Layer.provideMerge(
							Layer.mergeAll(stalled, MemoryIndex.layer, MemoryStore.layer),
						),
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
				Effect.forkChild,
			)
			yield* TestClock.adjust("60 seconds")
			const timedOut = yield* Fiber.join(fiber)
			assert.ok(timedOut._tag === "Unconfirmed")
			assert.strictEqual(timedOut.reason, "Timeout")
		}),
)
