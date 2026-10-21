import assert from "node:assert/strict"
import { test } from "node:test"
import { AppIndexApi } from "@openbot-build/api"
import { Document } from "@openbot-build/protocol"
import { Effect, Option, Schema } from "effect"

test("the public Index page keeps publisher icons and examples through its JSON contract", async () => {
	const presentation = await Effect.runPromise(
		Document.Presentation.decode({
			version: "1",
			examples: [
				{
					id: "prepare",
					title: "Prepare a meeting",
					prompt: "Find a free half hour and prepare a draft agenda.",
					preview: {
						src: "https://calendar.example/preview.png",
						alt: "Illustrative meeting and agenda",
						width: 800,
						height: 500,
					},
				},
			],
		}),
	)
	const page = Schema.decodeSync(AppIndexApi.Page)({
		apps: [
			{
				entry: {
					cardUrl: "https://calendar.example/card",
					card: {
						$schema: Document.cardSchemaUrl,
						name: "example.calendar/calendar",
						description: "Plan meetings",
						version: "1.0.0",
						icons: [
							{
								src: "https://calendar.example/icon.png",
								mimeType: "image/png",
							},
						],
						_meta: { [Document.presentationKey]: presentation },
					},
					evidence: [
						{
							publisherUrl: "https://calendar.example/",
							catalogUrl: "https://calendar.example/catalog",
							cardUrl: "https://calendar.example/card",
							association: "CardOrigin",
						},
					],
					checkedAt: 1,
					validators: {},
				},
				sources: [
					{
						id: "public",
						name: "Public Index",
						url: "https://host.example/index",
						simulated: false,
					},
				],
				matches: [],
			},
		],
		issues: [],
		nextCursor: null,
	})
	const codec = Schema.fromJsonString(AppIndexApi.Page)
	const recovered = Schema.decodeSync(codec)(Schema.encodeSync(codec)(page))
	const app = recovered.apps[0]
	assert.ok(app)
	assert.equal(
		app.entry.card.icons?.[0]?.src,
		"https://calendar.example/icon.png",
	)
	assert.deepEqual(
		Option.getOrThrow(Document.presentationFromCard(app.entry.card)),
		presentation,
	)
	assert.equal(Object.hasOwn(app, "connection"), false)
})
