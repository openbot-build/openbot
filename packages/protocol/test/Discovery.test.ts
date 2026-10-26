import {
	Array as Arr,
	Effect,
	Fiber,
	Layer,
	Match,
	Schema,
	Stream,
	String as Str,
} from "effect"
import {
	CatalogDiscovery,
	Discovery,
	Document,
	Network,
} from "@openbot-build/protocol"
import { assert, it } from "@effect/vitest"
import { TestClock } from "effect/testing"

// These tests build Discovery instances with Effect.provide.

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const card = (url: string): Document.ServerCard =>
	Document.ServerCard.make({
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
					reads = Arr.append(reads, url)
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
				Match.orElse(() => assert.fail("Expected a single candidate")),
			)
			assert.strictEqual(
				candidate.cardUrl,
				"https://cards.example/a?edition=team",
			)
			assert.deepStrictEqual(
				Arr.map(candidate.sources, (s) => s.role),
				["input", "page", "catalog", "card", "endpoint"],
			)
			assert.strictEqual(
				candidate.sources.at(-1)?.url,
				"https://api.example/mcp",
			)
			assert.strictEqual(
				Arr.filter(reads, (u) => u === candidate.cardUrl).length,
				1,
			)
			assert.deepStrictEqual(
				yield* Discovery.resolve(input).pipe(Effect.provide(discovery)),
				result,
			)
			yield* Discovery.resolve("pub.example").pipe(Effect.provide(discovery))
			assert.ok(
				Arr.contains(reads, "https://pub.example/.well-known/ai-catalog.json"),
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
			assert.ok(noDeclaration._tag === "DiscoveryError")
			assert.strictEqual(noDeclaration.reason, "NoDeclaration")
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
					Str.endsWith("catalog")(url)
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
								Str.endsWith("incompatible")(url)
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
				Match.orElse(() => assert.fail("Expected multiple candidates")),
			)
			assert.strictEqual(candidates.length, 2)
			assert.notStrictEqual(candidates[0].cardUrl, candidates[1].cardUrl)
			assert.deepStrictEqual(candidates[0].card._meta, {
				"example.test/extra": { kept: true },
			})
			assert.strictEqual(result.issues.length, 2)
			assert.ok(
				Arr.some(result.issues, (i) =>
					Str.includes("stable Card URL")(i.reason),
				),
			)
			assert.ok(
				Arr.some(
					result.issues,
					(i) =>
						i.url === "https://cards.example/incompatible" &&
						Str.includes("No HTTPS Streamable HTTP endpoint")(i.reason),
				),
			)
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
			assert.ok(error._tag === "DiscoveryError")
			assert.strictEqual(error.reason, "NoUsableServices")
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
				Match.orElse(() => assert.fail("Expected a candidate")),
			)
			assert.strictEqual(candidate.endpoints[0]?.requirements.length, 2)
			const missing = yield* Effect.flip(
				CatalogDiscovery.configureEndpoint({
					candidate,
					index: 0,
					values: {},
				}),
			)
			assert.ok(missing._tag === "DiscoveryError")
			assert.strictEqual(missing.reason, "Configuration")
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
			assert.ok(!Str.includes("private-secret")(yield* encodeJson(candidate)))
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
			assert.ok(wrongChoice._tag === "DiscoveryError")
			assert.strictEqual(wrongChoice.reason, "Configuration")
			assert.deepStrictEqual(
				Arr.map(wrongChoice.issues, (issue) => issue.fieldPath),
				["variable:tenant"],
			)
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
					seen = Arr.append(seen, headers)
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
				endpoints: Arr.map(changed.endpoints, (e) => ({
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
			assert.ok(denied._tag === "DiscoveryError")
			assert.strictEqual(denied.reason, "Http")
			assert.strictEqual(denied.issues[0]?.reason, "HTTP 403")
			assert.strictEqual(anonymousCalls, 1)
		}),
)

it.effect(
	"connection hints ignore variable key order and descriptions but keep choices",
	() =>
		Effect.sync(() => {
			const remote = Document.Remote.make({
				type: "streamable-http",
				url: "https://api.example/mcp",
				variables: {
					account: { default: "one", choices: ["one", "two"] },
					mode: { default: "read" },
				},
			})
			const previous = Discovery.Candidate.make({
				cardUrl: "https://cards.example/a",
				card: card(remote.url),
				endpoints: [{ index: 0, remote, requirements: [] }],
				sources: [],
			})
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
						endpoints: [
							Discovery.Endpoint.make({
								index: 0,
								remote: reordered,
								requirements: [],
							}),
						],
					},
				})._tag,
				"DescriptionUpdated",
			)
			for (const account of [
				{ default: "two", choices: ["one", "two"] },
				{ default: "one", choices: ["two", "one"] },
				{
					default: "one",
					choices: ["one", "two"],
					format: "string" as const,
					isSecret: true,
				},
			]) {
				assert.strictEqual(
					CatalogDiscovery.compare({
						previous,
						current: {
							...previous,
							endpoints: [
								Discovery.Endpoint.make({
									index: 0,
									remote: {
										...reordered,
										variables: { ...reordered.variables, account },
									},
									requirements: [],
								}),
							],
						},
					})._tag,
					"NeedsRevalidation",
				)
			}
		}),
)

it.effect(
	"Discovery stops at its link and document limits, and a stalled host fails with Timeout",
	() =>
		Effect.gen(function* () {
			const catalogUrl = "https://pub.example/catalog"
			const net = network({
				get: ({ url }) =>
					url === catalogUrl
						? json(url, {
								specVersion: "1.0",
								entries: Arr.makeBy(70, (index) => ({
									identifier: `card-${index}`,
									type: Document.cardMediaType,
									url: `https://cards.example/${index}`,
								})),
							})
						: json(url, card("https://api.example/mcp")),
			})
			const result = yield* Discovery.resolve(catalogUrl).pipe(
				Effect.provide(
					CatalogDiscovery.layer().pipe(
						Layer.provide(net),
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
			)
			const candidates = Match.value(result).pipe(
				Match.tag("Multiple", ({ candidates }) => candidates),
				Match.orElse(() => assert.fail("Expected multiple candidates")),
			)
			// The Catalog is the first of the 64 documents, so 63 Cards are left.
			assert.strictEqual(candidates.length, 63)
			assert.ok(
				Arr.some(
					result.issues,
					(i) =>
						i.url === catalogUrl && Str.includes("skipped 6 links")(i.reason),
				),
			)
			assert.ok(
				Arr.some(
					result.issues,
					(i) =>
						i.url === "https://cards.example/63" &&
						Str.includes("at most 64 documents")(i.reason),
				),
			)
			const stalled = Layer.succeed(Network.Network, {
				identity: { scope: "public", owner: "anonymous" },
				readDocument: () => Effect.never,
				execute: () => Effect.never,
			})
			const fiber = yield* Discovery.resolve(catalogUrl).pipe(
				Effect.provide(
					CatalogDiscovery.layer().pipe(
						Layer.provide(stalled),
						Layer.provideMerge([CatalogDiscovery.layerRules]),
					),
				),
				Effect.flip,
				Effect.forkChild,
			)
			yield* TestClock.adjust("60 seconds")
			const failure = yield* Fiber.join(fiber)
			assert.ok(
				Schema.is(Network.NetworkError)(failure) &&
					failure.reason === "Timeout",
			)
		}),
)
