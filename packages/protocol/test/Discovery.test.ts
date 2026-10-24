// Tests are entry points, so they provide their own Layers.
// @effect-diagnostics strictEffectProvide:off
import { Array as EffectArray, Effect, Layer, Stream, Match } from "effect"
import {
	CatalogDiscovery,
	Discovery,
	Document,
	Network,
} from "@openbot-build/protocol"
import { assert, it } from "@effect/vitest"

// These tests build Discovery instances with Effect.provide.

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

it.effect(
	"Domain and QR Link keep exact URLs, and a static base or Link resolves without scripts or fallback",
	() =>
		Effect.gen(function* () {
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
			// Each provide builds a fresh Layer, as a fresh runtime did before.
			const discovery = layers.pipe(
				Layer.provideMerge([CatalogDiscovery.layerRules]),
			)
			const result = yield* Discovery.resolve(input).pipe(
				Effect.provide(discovery),
			)
			assert.strictEqual(result._tag, "Single")
			const candidate = Match.value(result).pipe(
				Match.tag("Single", ({ candidate }) => {
					assert.strictEqual(candidate.sources[0]?.originalInput, input)
					return candidate
				}),
				Match.orElse(() => {
					throw new Error("Expected a single candidate")
				}),
			)
			assert.strictEqual(
				candidate.cardUrl,
				"https://cards.example/a?edition=team",
			)
			assert.deepStrictEqual(
				candidate.sources.map((s) => s.role),
				["input", "page", "catalog", "card", "endpoint"],
			)
			assert.strictEqual(
				candidate.sources.at(-1)?.url,
				"https://api.example/mcp",
			)
			assert.strictEqual(reads.filter((u) => u === candidate.cardUrl).length, 1)
			assert.deepStrictEqual(
				yield* Discovery.resolve(input).pipe(Effect.provide(discovery)),
				result,
			)
			yield* Discovery.resolve("pub.example").pipe(Effect.provide(discovery))
			assert.ok(
				reads.includes("https://pub.example/.well-known/ai-catalog.json"),
			)
			assert.strictEqual(
				yield* CatalogDiscovery.inputLink("pub.example:8443"),
				"https://pub.example:8443/.well-known/ai-catalog.json",
			)
			const before = reads.length
			const noDeclaration = yield* Effect.flip(
				Discovery.resolve("https://pub.example/no-declaration").pipe(
					Effect.provide(discovery),
				),
			)
			assert.ok(
				noDeclaration instanceof Discovery.DiscoveryError &&
					noDeclaration.reason === "NoDeclaration",
			)
			assert.strictEqual(reads.length, before + 1)
			assert.deepStrictEqual(
				CatalogDiscovery.catalogLinks({
					responseUrl: input,
					link: '<../one.json>; rel="ai-catalog"; title="one,two", </two.json>; rel="alternate ai-catalog"',
					html: '<link rel="ai-catalog" href="ignored.json">',
				}),
				["https://pub.example/one.json", "https://pub.example/two.json"],
			)
		}),
)

it.effect(
	"Catalog candidates keep separate Card identities and the reasons for unusable entries",
	() =>
		Effect.gen(function* () {
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
			const result = yield* Discovery.resolve(
				"https://pub.example/catalog",
			).pipe(
				Effect.provide(
					CatalogDiscovery.layer().pipe(
						Layer.provide(net),
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
			)
			assert.strictEqual(result._tag, "Multiple")
			const candidates = Match.value(result).pipe(
				Match.tag("Multiple", ({ candidates }) => candidates),
				Match.orElse(() => {
					throw new Error("Expected multiple candidates")
				}),
			)
			assert.strictEqual(candidates.length, 2)
			assert.notStrictEqual(candidates[0].cardUrl, candidates[1].cardUrl)
			assert.deepStrictEqual(candidates[0].card._meta, {
				"example.test/extra": { kept: true },
			})
			assert.strictEqual(result.issues.length, 2)
			assert.ok(result.issues.some((i) => i.reason.includes("stable Card URL")))
			const noServices = network({
				get: ({ url }) => json(url, { specVersion: "1.0", entries: [] }),
			})
			const error = yield* Effect.flip(
				Discovery.resolve("https://pub.example/catalog").pipe(
					Effect.provide(
						CatalogDiscovery.layer().pipe(
							Layer.provide(noServices),
							Layer.provideMerge([CatalogDiscovery.layerRules]),
						),
					),
				),
			)
			assert.ok(
				error instanceof Discovery.DiscoveryError &&
					error.reason === "NoUsableServices",
			)
		}),
)

it.effect(
	"Endpoint choice and variables stay explicit, and candidates do not contain private configuration",
	() =>
		Effect.gen(function* () {
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
			const result = yield* Discovery.resolve(
				"https://cards.example/config",
			).pipe(
				Effect.provide(
					CatalogDiscovery.layer().pipe(
						Layer.provide(net),
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
			)
			const candidate = Match.value(result).pipe(
				Match.tag("Single", ({ candidate }) => candidate),
				Match.orElse(() => {
					throw new Error("Expected a candidate")
				}),
			)
			assert.strictEqual(candidate.endpoints[0]?.requirements.length, 2)
			const missing = yield* Effect.flip(
				CatalogDiscovery.configureEndpoint({
					candidate,
					index: 0,
					values: {},
				}),
			)
			assert.match(String(missing), /DiscoveryError/)
			const config = yield* CatalogDiscovery.configureEndpoint({
				candidate,
				index: 0,
				values: {
					"variable:tenant": "team-a",
					"header:x-api-key": "private-secret",
				},
			})
			assert.strictEqual(config.url, "https://api.example/team-a/mcp")
			assert.strictEqual(config.headers["x-api-key"], "private-secret")
			assert.ok(!JSON.stringify(candidate).includes("private-secret"))
			const wrongChoice = yield* Effect.flip(
				CatalogDiscovery.configureEndpoint({
					candidate,
					index: 0,
					values: {
						"variable:tenant": "other",
						"header:x-api-key": "private-secret",
					},
				}),
			)
			assert.match(String(wrongChoice), /DiscoveryError/)
		}),
)

it.effect(
	"Validated 304 reuses its body, caches stay inside each owner and network instance, and refresh finds endpoint updates",
	() =>
		Effect.gen(function* () {
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
							modified
								? "https://changed.example/mcp"
								: "https://api.example/mcp",
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
				assert.deepStrictEqual(first, second)
				yield* Effect.sync(() => (modified = true))
				return yield* discover.refreshCard("https://cards.example/a")
			})
			const changed = yield* program.pipe(
				Effect.provide(
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
				),
			)
			assert.strictEqual(
				changed.endpoints[0]?.remote.url,
				"https://changed.example/mcp",
			)
			const previous = {
				...changed,
				endpoints: changed.endpoints.map((e) => ({
					...e,
					remote: { ...e.remote, url: "https://api.example/mcp" },
				})),
			}
			assert.strictEqual(
				CatalogDiscovery.compare({ previous, current: changed })._tag,
				"NeedsRevalidation",
			)
			assert.strictEqual(
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
			assert.strictEqual(seen[1]?.["if-none-match"], '"v1"')
			let anonymousCalls = 0
			const anonymous = network({
				get: ({ url, headers }) => {
					anonymousCalls++
					assert.strictEqual(headers?.["authorization"], undefined)
					assert.strictEqual(headers?.["if-none-match"], undefined)
					return { url, status: 403, headers: {}, text: "" }
				},
			})
			const denied = yield* Effect.flip(
				Discovery.resolve("https://cards.example/a").pipe(
					Effect.provide(
						CatalogDiscovery.layer().pipe(
							Layer.provide(anonymous),
							Layer.provideMerge([CatalogDiscovery.layerRules]),
						),
					),
				),
			)
			assert.match(String(denied), /DiscoveryError/)
			assert.strictEqual(anonymousCalls, 1)
		}),
)

it("connection hints ignore variable key order and descriptions but keep choices", () => {
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
	assert.strictEqual(
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
		assert.strictEqual(
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
