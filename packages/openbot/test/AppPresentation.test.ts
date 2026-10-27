import { assert, it } from "@effect/vitest"
import { AppIndexApi } from "@openbot-build/api"
import { Document } from "@openbot-build/protocol"
import { Effect, Option, Record as Rec, Schema } from "effect"

it.effect(
	"the public Index page keeps publisher icons and examples through its JSON contract",
	() =>
		Effect.gen(function* () {
			const presentation = yield* Document.Presentation.decode({
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
			})
			const page = yield* Schema.decodeEffect(AppIndexApi.Page)({
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
			const recovered = yield* Schema.decodeEffect(codec)(
				yield* Schema.encodeEffect(codec)(page),
			)
			const app = recovered.apps[0]
			assert.ok(app)
			assert.strictEqual(
				app.entry.card.icons?.[0]?.src,
				"https://calendar.example/icon.png",
			)
			assert.deepStrictEqual(
				Option.getOrThrow(Document.presentationFromCard(app.entry.card)),
				presentation,
			)
			assert.strictEqual(Rec.has<string, unknown>(app, "connection"), false)
		}),
)
