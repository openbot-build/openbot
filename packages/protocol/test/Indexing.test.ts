import {
	Array as EffectArray,
	HashMap,
	ManagedRuntime,
	Effect,
	Layer,
	Option,
	Redacted,
	Match,
	Predicate,
} from "effect"
import assert from "node:assert/strict"
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
import { test } from "node:test"

import { TestClock } from "effect/testing"

// These tests build public-only services at the edge of the runtime.

const cardAt = (cardUrl: string, websiteUrl?: string): Document.ServerCard => ({
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
				entries: links.map((link) => ({
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
				requests = EffectArray.append(requests, options)
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
			Layer.mergeAll(
				network,
				MemoryIndex.layer,
				MemoryStore.layer,
				TestClock.layer(),
			),
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
test("anonymous publisher evidence, stable identities and conditional updates do not depend on private connections", async () => {
	const fixture = site()
	await using runtime1 = ManagedRuntime.make(
		fixture.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	await runtime1.runPromise(
		Effect.gen(function* () {
			const apps = yield* Store.AppStore
			yield* apps.save({
				app: {
					cardUrl: fixture.cardUrl,
					card: cardAt(fixture.cardUrl),
					sources: [],
				},
				connection: {
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
				},
			})
			const input = { cardUrl: fixture.cardUrl }
			const first = yield* Indexing.sync(input)
			assert.equal(first._tag, "Indexed")
			return yield* Match.value(first).pipe(
				Match.tag("Indexed", (first) =>
					Effect.gen(function* () {
						assert.equal(first.entry.cardUrl, fixture.cardUrl)
						assert.equal(first.entry.evidence[0]?.association, "CardOrigin")
						assert.equal(
							JSON.stringify(first).includes("private-secret"),
							false,
						)
						assert.equal(
							JSON.stringify(first).includes("private-tenant"),
							false,
						)
						assert.equal((yield* Indexing.sync(input))._tag, "Indexed")
						assert.ok(
							fixture.requests.some(
								(request) => request.validators?.etag === '"card-1"',
							),
						)
						assert.ok(
							fixture.requests.every(
								(request) =>
									!Object.hasOwn(request, "headers") &&
									request.followRedirects === false,
							),
						)
						fixture.responses = HashMap.remove(
							fixture.responses,
							"https://publisher.example/.well-known/ai-catalog.json",
						)
						assert.equal((yield* Indexing.sync(input))._tag, "Unconfirmed")
						assert.equal(
							(yield* (yield* Index.IndexStore).get(fixture.cardUrl))._tag,
							"Some",
						)
						fixture.catalog(
							"https://publisher.example/.well-known/ai-catalog.json",
							[],
						)
						const catalog = Option.getOrUndefined(
							HashMap.get(
								fixture.responses,
								"https://publisher.example/.well-known/ai-catalog.json",
							),
						)
						if (catalog === undefined) throw new Error("Missing Catalog")
						fixture.responses = HashMap.set(fixture.responses, catalog.url, {
							...catalog,
							headers: {
								...catalog.headers,
								etag: '"catalog-2"',
							},
						})
						const withdrawn = yield* Indexing.sync(input)
						assert.equal(withdrawn._tag, "Withdrawn")
						const index = yield* Index.IndexStore
						assert.equal(Option.isNone(yield* index.get(fixture.cardUrl)), true)
						assert.equal(
							(yield* apps.get({
								owner: "alice",
								connectionId: "notes",
							})).state,
							"Enabled",
						)
						assert.equal(
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
		}),
	)
})
test("cross-host Card association succeeds, but a third-party repost gives no publisher evidence", async () => {
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
	await using runtime2 = ManagedRuntime.make(
		fixture.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	await runtime2.runPromise(
		Effect.gen(function* () {
			const indexed = yield* Indexing.sync({
				cardUrl: fixture.cardUrl,
			})
			assert.equal(indexed._tag, "Indexed")
			Match.value(indexed).pipe(
				Match.tag("Indexed", (indexed) => {
					assert.deepEqual(indexed.entry.evidence[0], {
						publisherUrl: "https://publisher.example/product",
						catalogUrl: "https://publisher.example/catalog?product=notes",
						cardUrl: fixture.cardUrl,
						association: "Website",
					})
				}),
				Match.orElse(() => undefined),
			)
			fixture.document(
				fixture.cardUrl,
				cardAt(fixture.cardUrl),
				Document.cardMediaType,
				{ etag: '"card-2"' },
			)
			assert.equal(
				(yield* Indexing.sync({
					cardUrl: fixture.cardUrl,
				}))._tag,
				"Withdrawn",
			)
		}),
	)
	const repost = site("https://hosting.example/card")
	repost.responses = HashMap.remove(
		repost.responses,
		"https://hosting.example/.well-known/ai-catalog.json",
	)
	repost.catalog("https://third-party.example/catalog")
	await using runtime3 = ManagedRuntime.make(
		repost.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	await runtime3.runPromise(
		Effect.gen(function* () {
			const result = yield* Indexing.sync({
				cardUrl: repost.cardUrl,
				sources: [
					{
						role: "catalog",
						url: "https://third-party.example/catalog",
					},
				],
			})
			assert.equal(result._tag, "Excluded")
			assert.ok(
				repost.requests.every(
					(request) => !request.url.includes("third-party"),
				),
			)
		}),
	)
})
test("noindex withdraws the entry, and authorization, robots and storage failures never report indexing success", async () => {
	const fixture = site()
	await using runtime4 = ManagedRuntime.make(
		fixture.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	await runtime4.runPromise(
		Effect.gen(function* () {
			assert.equal(
				(yield* Indexing.sync({
					cardUrl: fixture.cardUrl,
				}))._tag,
				"Indexed",
			)
			fixture.document(
				fixture.cardUrl,
				cardAt(fixture.cardUrl),
				Document.cardMediaType,
				{ "x-robots-tag": "NOINDEX", etag: '"card-2"' },
			)
			assert.equal(
				(yield* Indexing.sync({
					cardUrl: fixture.cardUrl,
				}))._tag,
				"Withdrawn",
			)
			fixture.document(fixture.cardUrl, "Login required", "text/plain", {}, 401)
			assert.equal(
				(yield* Indexing.sync({
					cardUrl: fixture.cardUrl,
				}))._tag,
				"Unconfirmed",
			)
			fixture.document(
				"https://publisher.example/robots.txt",
				"User-agent: *\nDisallow: /",
				"text/plain",
			)
			const count = fixture.requests.filter(
				(request) => request.url === fixture.cardUrl,
			).length
			assert.equal(
				(yield* Indexing.sync({
					cardUrl: fixture.cardUrl,
				}))._tag,
				"Excluded",
			)
			assert.equal(
				fixture.requests.filter((request) => request.url === fixture.cardUrl)
					.length,
				count,
			)
			fixture.document(
				"https://publisher.example/robots.txt",
				"Unavailable",
				"text/plain",
				{},
				503,
			)
			assert.equal(
				(yield* Indexing.sync({
					cardUrl: fixture.cardUrl,
				}))._tag,
				"Unconfirmed",
			)
			assert.equal(
				fixture.requests.filter((request) => request.url === fixture.cardUrl)
					.length,
				count,
			)
		}),
	)
	const valid = site()
	const broken = Layer.succeed(Index.IndexStore, {
		get: () => Effect.succeedNone,
		withdraw: () => Effect.void,
		upsert: () =>
			Effect.fail(
				new Index.IndexError({
					reason: "Unavailable",
					operation: "upsert",
				}),
			),
	})
	await using runtime5 = ManagedRuntime.make(
		PublicIndexing.layer.pipe(
			Layer.provide(RobotsPolicy.layer),
			Layer.provide(Layer.mergeAll(valid.network, broken)),
			Layer.provideMerge([CatalogDiscovery.layerRules]),
		),
	)
	const result = await runtime5.runPromise(
		Effect.result(Indexing.sync({ cardUrl: valid.cardUrl })),
	)
	assert.equal(result._tag, "Failure")
})
test("robots combines matching bots, encoded paths, wildcards, longest match and allow ties", async () => {
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
		await using runtime6 = ManagedRuntime.make(
			fixture.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
		)
		const result = await runtime6.runPromise(
			Indexing.sync({ cardUrl: fixture.cardUrl }),
		)
		assert.equal(result._tag, expected, path + " " + text)
	}
})
test("robots redirects apply to the original authority, and blocked redirect targets of documents are never fetched", async () => {
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
	await using runtime7 = ManagedRuntime.make(
		fixture.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	let result = await runtime7.runPromise(
		Indexing.sync({ cardUrl: fixture.cardUrl }),
	)
	assert.equal(result._tag, "Excluded")
	assert.ok(
		fixture.requests.every((request) => request.url !== fixture.cardUrl),
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
	await using runtime8 = ManagedRuntime.make(
		fixture.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	result = await runtime8.runPromise(
		Indexing.sync({ cardUrl: fixture.cardUrl }),
	)
	assert.equal(result._tag, "Excluded")
	assert.ok(
		fixture.requests.every(
			(request) => request.url !== "https://publisher.example/private",
		),
	)
})

test("robots cache expires within 24 hours, and no-store responses are never reused through conditional requests", async () => {
	const fixture = site()
	fixture.document(
		"https://publisher.example/robots.txt",
		"User-agent: *\nAllow: /",
		"text/plain",
		{ "cache-control": "max-age=172800", etag: '"robots-1"' },
	)
	await using runtime9 = ManagedRuntime.make(
		fixture.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	await runtime9.runPromise(
		Effect.gen(function* () {
			assert.equal(
				(yield* Indexing.sync({
					cardUrl: fixture.cardUrl,
				}))._tag,
				"Indexed",
			)
			const first = fixture.requests.filter((request) =>
				request.url.endsWith("/robots.txt"),
			).length
			assert.equal(
				(yield* Indexing.sync({
					cardUrl: fixture.cardUrl,
				}))._tag,
				"Indexed",
			)
			assert.equal(
				fixture.requests.filter((request) =>
					request.url.endsWith("/robots.txt"),
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
			assert.equal(
				(yield* Indexing.sync({
					cardUrl: fixture.cardUrl,
				}))._tag,
				"Excluded",
			)
			assert.ok(
				fixture.requests.some(
					(request) => request.validators?.etag === '"robots-1"',
				),
			)
		}),
	)
	const uncached = site()
	uncached.document(
		uncached.cardUrl,
		cardAt(uncached.cardUrl),
		Document.cardMediaType,
		{ "cache-control": "no-store", etag: '"private-cache"' },
	)
	await using runtime10 = ManagedRuntime.make(
		uncached.layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	await runtime10.runPromise(
		Effect.gen(function* () {
			yield* Indexing.sync({ cardUrl: uncached.cardUrl })
			yield* Indexing.sync({ cardUrl: uncached.cardUrl })
			assert.ok(
				uncached.requests
					.filter((request) => request.url === uncached.cardUrl)
					.every((request) => request.validators === undefined),
			)
		}),
	)
})

test("publication inspection checks live eligibility without an Index writer", async () => {
	const fixture = site()
	await using runtime = ManagedRuntime.make(
		PublicIndexing.layerInspection.pipe(
			Layer.provide(fixture.network),
			Layer.provide(RobotsPolicy.layer),
			Layer.provide(CatalogDiscovery.layerRules),
		),
	)
	const input = await Effect.runPromise(
		Indexing.Input.decode({ cardUrl: fixture.cardUrl }),
	)
	const eligible = await runtime.runPromise(Indexing.inspect(input))
	assert.equal(eligible._tag, "Eligible")
	if (eligible._tag === "Eligible")
		assert.equal(eligible.entry.cardUrl, fixture.cardUrl)
	fixture.document(
		fixture.cardUrl,
		cardAt(fixture.cardUrl),
		Document.cardMediaType,
		{ "x-robots-tag": "noindex" },
	)
	const excluded = await runtime.runPromise(Indexing.inspect(input))
	assert.equal(excluded._tag, "Excluded")
	if (excluded._tag === "Excluded") assert.equal(excluded.reason, "NoIndex")
	fixture.document(fixture.cardUrl, "Unavailable", "text/plain", {}, 503)
	const unconfirmed = await runtime.runPromise(Indexing.inspect(input))
	assert.equal(unconfirmed._tag, "Unconfirmed")
})
