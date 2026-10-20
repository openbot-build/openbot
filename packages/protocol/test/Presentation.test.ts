import assert from "node:assert/strict"
import { test } from "node:test"
import {
	Array as Arr,
	Effect,
	Layer,
	ManagedRuntime,
	Match,
	Option,
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
		{
			src: origin + "/assets/icon.png",
			mimeType: "image/png",
			sizes: ["128x128"],
		},
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

test("published presentation survives discovery and public Index serialization without reading images or running work", async () => {
	const publisher = HttpRouter.toWebHandler(
		McpPublisher.layer({
			publication: Schema.decodeUnknownSync(Publisher.Publication)(publication),
			register: Effect.void,
		}),
		{ disableLogger: true },
	)
	let reads: ReadonlyArray<string> = []
	const read = (url: string) =>
		Effect.tryPromise({
			try: async () => {
				reads = Arr.append(reads, url)
				const response = await publisher.handler(new Request(url))
				return {
					url,
					status: response.status,
					headers: Object.fromEntries(response.headers),
					text: await response.text(),
				}
			},
			catch: () =>
				new Network.NetworkError({
					reason: "Transport",
					message: "Publisher fixture request failed",
				}),
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
	await using runtime = ManagedRuntime.make(
		CatalogDiscovery.layer().pipe(
			Layer.provide(network),
			Layer.provideMerge(CatalogDiscovery.layerRules),
		),
	)
	try {
		const result = await runtime.runPromise(
			Discovery.resolve(publication.catalogUrl),
		)
		const candidate = Match.value(result).pipe(
			Match.tag("Single", (value) => value.candidate),
			Match.orElse(() => {
				throw new Error("Expected one candidate")
			}),
		)
		assert.deepEqual(candidate.card.icons, card.icons)
		assert.deepEqual(candidate.card._meta, card._meta)
		const decoded = Option.getOrThrow(
			Document.presentationFromCard(candidate.card),
		)
		assert.equal(decoded.examples[0].prompt, example.prompt)
		const entry = await Effect.runPromise(
			Index.Entry.decode({
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
			}),
		)
		const codec = Schema.fromJsonString(Index.Entry)
		assert.deepEqual(
			Schema.decodeSync(codec)(Schema.encodeSync(codec)(entry)),
			entry,
		)
		assert.deepEqual(reads, [publication.catalogUrl, publication.cardUrl])
		const current = {
			...candidate,
			card: {
				...candidate.card,
				icons: [{ src: origin + "/assets/new.png" }],
				_meta: {
					...candidate.card._meta,
					[Document.presentationKey]: {
						...presentation,
						examples: [{ ...example, title: "Updated illustration" }],
					},
				},
			},
		}
		assert.equal(
			CatalogDiscovery.compare({ previous: candidate, current })._tag,
			"DescriptionUpdated",
		)
	} finally {
		await publisher.dispose()
	}
})

test("publisher validation rejects malformed examples, but hosts keep Cards that are otherwise valid", async () => {
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
		const decoded = await Effect.runPromise(Document.ServerCard.decode(raw))
		assert.ok(Option.isNone(Document.presentationFromCard(decoded)))
		assert.deepEqual(decoded._meta, raw._meta)
		assert.equal(
			(await Effect.runPromise(Document.compatibleRemotes(decoded))).length,
			1,
		)
		await assert.rejects(
			Effect.runPromise(McpPublisher.validate({ ...publication, card: raw })),
			/InvalidDocument/,
		)
	}
	const { _meta: omitted, ...legacy } = card
	assert.ok(omitted)
	const old = await Effect.runPromise(Document.ServerCard.decode(legacy))
	assert.ok(Option.isNone(Document.presentationFromCard(old)))
	await Effect.runPromise(
		McpPublisher.validate({ ...publication, card: legacy }),
	)
	const textOnly = await Effect.runPromise(
		Document.Presentation.decode({
			version: "1",
			examples: [
				{
					id: "read",
					title: "Read notes",
					prompt: "Find the notes for this meeting.",
				},
			],
		}),
	)
	assert.equal(textOnly.examples[0].preview, undefined)
})
