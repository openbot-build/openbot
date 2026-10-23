import {
	Array as EffectArray,
	ManagedRuntime,
	Effect,
	Layer,
	Stream,
	Match,
} from "effect"
import assert from "node:assert/strict"
import {
	CatalogDiscovery,
	Discovery,
	Document,
	Network,
} from "@openbot-build/protocol"
import { test } from "node:test"

// These tests build Discovery instances at the edge of their runtime.

const card = (url: string): Document.ServerCard => ({
	$schema: Document.cardSchemaUrl,
	name: "example.test/same-name",
	version: "1.0.0",
	description: "Example",
	remotes: [
		{
			type: "streamable-http",
			url,
			supportedProtocolVersions: [Document.protocolVersion],
		},
	],
	_meta: { "example.test/extra": { kept: true } },
})
const json = (
	url: string,
	value: unknown,
	headers: Record<string, string> = {},
): Network.DocumentResponse => ({
	url,
	status: 200,
	text: JSON.stringify(value),
	headers: {
		"content-type": "application/json",
		"cache-control": "no-cache",
		...headers,
	},
})
const network = (options: {
	readonly owner?: string
	readonly get: (input: {
		readonly url: string
		readonly headers?: Readonly<Record<string, string>>
	}) => Network.DocumentResponse
}) =>
	Layer.succeed(Network.Network, {
		identity: {
			scope: options.owner === undefined ? "public" : "user",
			owner: options.owner ?? "anonymous",
		},
		readDocument: (input) => Effect.sync(() => options.get(input)),
		execute: (request) =>
			Effect.sync(() => {
				const response = options.get({
					url: request.url,
					headers: request.headers,
				})
				return {
					url: response.url,
					status: response.status,
					headers: response.headers,
					body: Stream.succeed(new TextEncoder().encode(response.text)),
				}
			}),
	})

test("Domain and QR Link keep exact URLs, and a static base or Link resolves without scripts or fallback", async () => {
	let reads: ReadonlyArray<string> = []
	const net = network({
		get: ({ url }) => {
			reads = EffectArray.append(reads, url)
			if (url === "https://pub.example/apps/calendar?edition=team")
				return {
					url,
					status: 200,
					headers: {
						"content-type": "text/html",
					},
					text: '<head><base href="/catalogs/"><link rel="alternate ai-catalog" href="calendar.json"></head><script>globalThis.executed = true</script>',
				}
			if (
				url === "https://pub.example/catalogs/calendar.json" ||
				url === "https://pub.example/.well-known/ai-catalog.json"
			)
				return json(
					url,
					Document.catalogFor({
						cardUrl: "https://cards.example/a?edition=team",
						identifier: "opaque",
					}),
				)
			if (url === "https://cards.example/a?edition=team")
				return json(url, card("https://api.example/mcp"))
			return {
				url,
				status: 200,
				headers: { "content-type": "text/html" },
				text: '<script>document.head.innerHTML = "catalog"</script>',
			}
		},
	})
	const layers = CatalogDiscovery.layer().pipe(Layer.provide(net))
	const input = "https://pub.example/apps/calendar?edition=team"
	await using runtime1 = ManagedRuntime.make(
		layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	const result = await runtime1.runPromise(Discovery.resolve(input))
	assert.equal(result._tag, "Single")
	const candidate = Match.value(result).pipe(
		Match.tag("Single", ({ candidate }) => {
			assert.equal(candidate.sources[0]?.originalInput, input)
			return candidate
		}),
		Match.orElse(() => {
			throw new Error("Expected a single candidate")
		}),
	)
	assert.equal(candidate.cardUrl, "https://cards.example/a?edition=team")
	assert.deepEqual(
		candidate.sources.map((s) => s.role),
		["input", "page", "catalog", "card", "endpoint"],
	)
	assert.equal(candidate.sources.at(-1)?.url, "https://api.example/mcp")
	assert.equal(reads.filter((u) => u === candidate.cardUrl).length, 1)
	await using runtime2 = ManagedRuntime.make(
		layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	assert.deepEqual(await runtime2.runPromise(Discovery.resolve(input)), result)
	await using runtime3 = ManagedRuntime.make(
		layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	await runtime3.runPromise(Discovery.resolve("pub.example"))
	assert.ok(reads.includes("https://pub.example/.well-known/ai-catalog.json"))
	assert.equal(
		await Effect.runPromise(CatalogDiscovery.inputLink("pub.example:8443")),
		"https://pub.example:8443/.well-known/ai-catalog.json",
	)
	const before = reads.length
	await using runtime4 = ManagedRuntime.make(
		layers.pipe(Layer.provideMerge([CatalogDiscovery.layerRules])),
	)
	await assert.rejects(
		runtime4.runPromise(
			Discovery.resolve("https://pub.example/no-declaration"),
		),
		(e: unknown) =>
			e instanceof Discovery.DiscoveryError && e.reason === "NoDeclaration",
	)
	assert.equal(reads.length, before + 1)
	assert.deepEqual(
		CatalogDiscovery.catalogLinks({
			responseUrl: input,
			link: '<../one.json>; rel="ai-catalog"; title="one,two", </two.json>; rel="alternate ai-catalog"',
			html: '<link rel="ai-catalog" href="ignored.json">',
		}),
		["https://pub.example/one.json", "https://pub.example/two.json"],
	)
})

test("Catalog candidates keep separate Card identities and the reasons for unusable entries", async () => {
	const net = network({
		get: ({ url }) =>
			url.endsWith("catalog")
				? json(url, {
						specVersion: "1.0",
						entries: [
							{
								identifier: "same",
								type: Document.cardMediaType,
								url: "https://cards.example/a?q=1",
							},
							{
								identifier: "same",
								type: Document.cardMediaType,
								url: "https://cards.example/a?q=2",
							},
							{
								identifier: "inline",
								type: Document.cardMediaType,
								data: card("https://api.example/mcp"),
							},
							{
								identifier: "other",
								type: "application/a2a-agent-card+json",
								url: "https://irrelevant.example/bot",
							},
							{
								identifier: "incompatible",
								type: Document.cardMediaType,
								url: "https://cards.example/incompatible",
							},
						],
					})
				: json(
						url,
						url.endsWith("incompatible")
							? {
									...card("https://api.example/mcp"),
									remotes: [],
								}
							: card("https://api.example/mcp"),
					),
	})
	await using runtime5 = ManagedRuntime.make(
		CatalogDiscovery.layer().pipe(
			Layer.provide(net),
			Layer.provideMerge([CatalogDiscovery.layerRules]),
		),
	)
	const result = await runtime5.runPromise(
		Discovery.resolve("https://pub.example/catalog"),
	)
	assert.equal(result._tag, "Multiple")
	const candidates = Match.value(result).pipe(
		Match.tag("Multiple", ({ candidates }) => candidates),
		Match.orElse(() => {
			throw new Error("Expected multiple candidates")
		}),
	)
	assert.equal(candidates.length, 2)
	assert.notEqual(candidates[0].cardUrl, candidates[1].cardUrl)
	assert.deepEqual(candidates[0].card._meta, {
		"example.test/extra": { kept: true },
	})
	assert.equal(result.issues.length, 2)
	assert.ok(result.issues.some((i) => i.reason.includes("stable Card URL")))
	const noServices = network({
		get: ({ url }) => json(url, { specVersion: "1.0", entries: [] }),
	})
	await using runtime6 = ManagedRuntime.make(
		CatalogDiscovery.layer().pipe(
			Layer.provide(noServices),
			Layer.provideMerge([CatalogDiscovery.layerRules]),
		),
	)
	await assert.rejects(
		runtime6.runPromise(Discovery.resolve("https://pub.example/catalog")),
		(e: unknown) =>
			e instanceof Discovery.DiscoveryError && e.reason === "NoUsableServices",
	)
})

test("Endpoint choice and variables stay explicit, and candidates do not contain private configuration", async () => {
	const configuredCard = {
		...card("https://api.example/{tenant}/mcp"),
		remotes: [
			{
				type: "streamable-http",
				url: "https://api.example/{tenant}/mcp",
				supportedProtocolVersions: [Document.protocolVersion],
				variables: {
					tenant: {
						isRequired: true,
						choices: ["team-a", "team-b"],
					},
				},
				headers: [
					{
						name: "x-api-key",
						isRequired: true,
						isSecret: true,
					},
				],
			},
		],
	}
	const net = network({ get: ({ url }) => json(url, configuredCard) })
	await using runtime7 = ManagedRuntime.make(
		CatalogDiscovery.layer().pipe(
			Layer.provide(net),
			Layer.provideMerge([CatalogDiscovery.layerRules]),
		),
	)
	const result = await runtime7.runPromise(
		Discovery.resolve("https://cards.example/config"),
	)
	const candidate = Match.value(result).pipe(
		Match.tag("Single", ({ candidate }) => candidate),
		Match.orElse(() => {
			throw new Error("Expected a candidate")
		}),
	)
	assert.equal(candidate.endpoints[0]?.requirements.length, 2)
	await assert.rejects(
		Effect.runPromise(
			CatalogDiscovery.configureEndpoint({
				candidate,
				index: 0,
				values: {},
			}),
		),
		/DiscoveryError/,
	)
	const config = await Effect.runPromise(
		CatalogDiscovery.configureEndpoint({
			candidate,
			index: 0,
			values: {
				"variable:tenant": "team-a",
				"header:x-api-key": "private-secret",
			},
		}),
	)
	assert.equal(config.url, "https://api.example/team-a/mcp")
	assert.equal(config.headers["x-api-key"], "private-secret")
	assert.ok(!JSON.stringify(candidate).includes("private-secret"))
	await assert.rejects(
		Effect.runPromise(
			CatalogDiscovery.configureEndpoint({
				candidate,
				index: 0,
				values: {
					"variable:tenant": "other",
					"header:x-api-key": "private-secret",
				},
			}),
		),
		/DiscoveryError/,
	)
})

test("Validated 304 reuses its body, caches stay inside each owner and network instance, and refresh finds endpoint updates", async () => {
	let seen: ReadonlyArray<Readonly<Record<string, string>> | undefined> = []
	let modified = false
	const alice = network({
		owner: "alice",
		get: ({ url, headers }) => {
			seen = EffectArray.append(seen, headers)
			if (headers?.["if-none-match"] === '"v1"' && !modified)
				return {
					url,
					status: 304,
					headers: { etag: '"v1"' },
					text: "",
				}
			return json(
				url,
				card(
					modified ? "https://changed.example/mcp" : "https://api.example/mcp",
				),
				{
					etag: modified ? '"v2"' : '"v1"',
					"cache-control": "private, no-cache",
				},
			)
		},
	})
	const program = Effect.gen(function* () {
		const discover = yield* Discovery.Discovery
		const first = yield* discover.resolve("https://cards.example/a")
		const second = yield* discover.resolve("https://cards.example/a")
		assert.deepEqual(first, second)
		yield* Effect.sync(() => (modified = true))
		return yield* discover.refreshCard("https://cards.example/a")
	})
	await using runtime = ManagedRuntime.make(
		CatalogDiscovery.layer({
			headersByOrigin: {
				"https://cards.example": {
					authorization: "Bearer alice",
				},
			},
		}).pipe(
			Layer.provide(alice),
			Layer.provideMerge([CatalogDiscovery.layerRules]),
		),
	)
	const changed = await runtime.runPromise(program)
	assert.equal(changed.endpoints[0]?.remote.url, "https://changed.example/mcp")
	const previous = {
		...changed,
		endpoints: changed.endpoints.map((e) => ({
			...e,
			remote: { ...e.remote, url: "https://api.example/mcp" },
		})),
	}
	assert.equal(
		CatalogDiscovery.compare({ previous, current: changed })._tag,
		"NeedsRevalidation",
	)
	assert.equal(
		CatalogDiscovery.compare({
			previous: changed,
			current: {
				...changed,
				card: {
					...changed.card,
					description: "Updated description",
				},
			},
		})._tag,
		"DescriptionUpdated",
	)
	assert.equal(seen[1]?.["if-none-match"], '"v1"')
	let anonymousCalls = 0
	const anonymous = network({
		get: ({ url, headers }) => {
			anonymousCalls++
			assert.equal(headers?.["authorization"], undefined)
			assert.equal(headers?.["if-none-match"], undefined)
			return { url, status: 403, headers: {}, text: "" }
		},
	})
	await using runtime8 = ManagedRuntime.make(
		CatalogDiscovery.layer().pipe(
			Layer.provide(anonymous),
			Layer.provideMerge([CatalogDiscovery.layerRules]),
		),
	)
	await assert.rejects(
		runtime8.runPromise(Discovery.resolve("https://cards.example/a")),
		/DiscoveryError/,
	)
	assert.equal(anonymousCalls, 1)
})

test("connection hints ignore variable key order and descriptions but keep choices", () => {
	const remote: Document.Remote = {
		type: "streamable-http",
		url: "https://api.example/mcp",
		variables: {
			account: { default: "one", choices: ["one", "two"] },
			mode: { default: "read" },
		},
	}
	const previous: Discovery.Candidate = {
		cardUrl: "https://cards.example/a",
		card: card(remote.url),
		endpoints: [{ index: 0, remote, requirements: [] }],
		sources: [],
	}
	const reordered = {
		...remote,
		variables: {
			mode: { default: "read", description: "New display text" },
			account: { choices: ["one", "two"], default: "one" },
		},
	}
	assert.equal(
		CatalogDiscovery.compare({
			previous,
			current: {
				...previous,
				endpoints: [{ index: 0, remote: reordered, requirements: [] }],
			},
		})._tag,
		"DescriptionUpdated",
	)
	for (const account of [
		{ default: "two", choices: ["one", "two"] },
		{ default: "one", choices: ["two", "one"] },
	]) {
		assert.equal(
			CatalogDiscovery.compare({
				previous,
				current: {
					...previous,
					endpoints: [
						{
							index: 0,
							remote: {
								...reordered,
								variables: { ...reordered.variables, account },
							},
							requirements: [],
						},
					],
				},
			})._tag,
			"NeedsRevalidation",
		)
	}
})
