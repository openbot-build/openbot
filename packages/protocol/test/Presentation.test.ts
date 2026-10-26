import { assert, it } from "@effect/vitest"
import {
	Array as Arr,
	Effect,
	Layer,
	Match,
	Option,
	Record as Rec,
	Schema,
	Stream,
} from "effect"
import { HttpRouter } from "effect/http"
import {
	CatalogDiscovery,
	Discovery,
	Document,
	Index,
	McpPublisher,
	Publisher,
	Network,
} from "@openbot-build/protocol"

const origin = "https://notes.example"
const example = {
	id: "meeting-notes",
	title: "Turn meeting notes into clear next steps",
	prompt:
		"Organize these meeting notes into decisions and next steps for me to review.",
	description:
		"An illustrative note with decisions and owners, ready for review.",
	preview: {
		src: origin + "/assets/meeting.webp",
		alt: "Example meeting note with decisions and assigned next steps",
		width: 1200,
		height: 800,
		mimeType: "image/webp",
	},
}
const presentation = { version: "1", examples: [example] }
const card = {
	$schema: Document.cardSchemaUrl,
	name: "example.notes/notes",
	title: "Notes",
	version: "1.0.0",
	description: "Organize notes and next steps",
	icons: [
		Document.Icon.make({
			src: origin + "/assets/icon.png",
			mimeType: "image/png",
			sizes: ["128x128"],
		}),
	],
	remotes: [
		{
			type: "streamable-http",
			url: origin + "/mcp",
			supportedProtocolVersions: [Document.protocolVersion],
		},
	],
	_meta: {
		[Document.presentationKey]: presentation,
		"example.notes/other": { preserved: true },
	},
}
const publication = {
	card,
	cardUrl: origin + "/mcp/server-card",
	catalogUrl: origin + "/.well-known/ai-catalog.json",
	mcpUrl: origin + "/mcp",
}

it.effect(
	"published presentation survives discovery and public Index serialization without reading images or running work",
	() =>
		Effect.gen(function* () {
			const decodedPublication = yield* Schema.decodeUnknownEffect(
				Publisher.Publication,
			)(publication)
			const publisher = HttpRouter.toWebHandler(
				McpPublisher.layer({
					publication: decodedPublication,
					register: Effect.void,
				}),
				{ disableLogger: true },
			)
			yield* Effect.addFinalizer(() =>
				Effect.promise(() => publisher.dispose()),
			)
			let reads: ReadonlyArray<string> = []
			// The web handler of the publisher runs in memory and gives every
			// failure as a response, so a rejected Promise is a defect.
			const read = (url: string) =>
				Effect.gen(function* () {
					reads = Arr.append(reads, url)
					const response = yield* Effect.promise(() =>
						publisher.handler(new Request(url)),
					)
					return {
						url,
						status: response.status,
						headers: Rec.fromEntries(response.headers),
						text: yield* Effect.promise(() => response.text()),
					}
				})
			const network = Layer.succeed(Network.Network, {
				identity: { scope: "public", owner: "anonymous" },
				readDocument: (input) => read(input.url),
				execute: (request) =>
					read(request.url).pipe(
						Effect.map((response) => ({
							...response,
							body: Stream.succeed(new TextEncoder().encode(response.text)),
						})),
					),
			})
			const result = yield* Discovery.resolve(publication.catalogUrl).pipe(
				Effect.provide(
					CatalogDiscovery.layer().pipe(
						Layer.provide(network),
						Layer.provideMerge(CatalogDiscovery.layerRules),
					),
				),
			)
			const candidate = Match.value(result).pipe(
				Match.tag("Single", (value) => value.candidate),
				Match.orElse(() => assert.fail("Expected one candidate")),
			)
			assert.deepStrictEqual(candidate.card.icons, card.icons)
			assert.deepStrictEqual(candidate.card._meta, card._meta)
			const decoded = Option.getOrThrow(
				Document.presentationFromCard(candidate.card),
			)
			assert.strictEqual(decoded.examples[0].prompt, example.prompt)
			const entry = yield* Index.Entry.decode({
				cardUrl: candidate.cardUrl,
				card: candidate.card,
				evidence: [
					{
						publisherUrl: origin,
						catalogUrl: publication.catalogUrl,
						cardUrl: candidate.cardUrl,
						association: "CardOrigin",
					},
				],
				checkedAt: 1,
				validators: {},
			})
			const codec = Schema.fromJsonString(Index.Entry)
			assert.deepStrictEqual(
				yield* Schema.decodeEffect(codec)(
					yield* Schema.encodeEffect(codec)(entry),
				),
				entry,
			)
			assert.deepStrictEqual(reads, [
				publication.catalogUrl,
				publication.cardUrl,
			])
			const current = {
				...candidate,
				card: {
					...candidate.card,
					icons: [Document.Icon.make({ src: origin + "/assets/new.png" })],
					_meta: {
						...candidate.card._meta,
						[Document.presentationKey]: {
							...presentation,
							examples: [{ ...example, title: "Updated illustration" }],
						},
					},
				},
			}
			assert.strictEqual(
				CatalogDiscovery.compare({ previous: candidate, current })._tag,
				"DescriptionUpdated",
			)
		}),
)

it.effect(
	"publisher validation rejects malformed examples, but hosts keep Cards that are otherwise valid",
	() =>
		Effect.gen(function* () {
			for (const invalid of [
				{ version: "2", examples: [example] },
				{ version: "1", examples: [] },
				{ version: "1", examples: [example, example] },
				{ version: "1", examples: [{ ...example, prompt: "" }] },
				{
					version: "1",
					examples: [
						{
							...example,
							preview: { ...example.preview, src: "javascript:alert(1)" },
						},
					],
				},
				{
					version: "1",
					examples: [
						{
							...example,
							preview: {
								...example.preview,
								src: "https://token:secret@notes.example/preview.png",
							},
						},
					],
				},
				{
					version: "1",
					examples: [
						{ ...example, preview: { ...example.preview, alt: "", width: 0 } },
					],
				},
			]) {
				const raw = {
					...card,
					_meta: { ...card._meta, [Document.presentationKey]: invalid },
				}
				const decoded = yield* Document.ServerCard.decode(raw)
				assert.ok(Option.isNone(Document.presentationFromCard(decoded)))
				assert.deepStrictEqual(decoded._meta, raw._meta)
				assert.strictEqual(
					(yield* Document.compatibleRemotes(decoded)).length,
					1,
				)
				const error = yield* Effect.flip(
					McpPublisher.validate({ ...publication, card: raw }),
				)
				assert.match(String(error), /InvalidDocument/)
			}
			const { _meta: omitted, ...legacy } = card
			assert.ok(omitted)
			const old = yield* Document.ServerCard.decode(legacy)
			assert.ok(Option.isNone(Document.presentationFromCard(old)))
			yield* McpPublisher.validate({ ...publication, card: legacy })
			const textOnly = yield* Document.Presentation.decode({
				version: "1",
				examples: [
					{
						id: "read",
						title: "Read notes",
						prompt: "Find the notes for this meeting.",
					},
				],
			})
			assert.strictEqual(textOnly.examples[0].preview, undefined)
		}),
)
