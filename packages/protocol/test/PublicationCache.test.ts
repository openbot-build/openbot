import { McpPublisher, Document, Publisher } from "@openbot-build/protocol"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpEffect, HttpRouter } from "effect/http"

const origin = "https://service.example"
const publication = Publisher.Publication.make({
	card: Document.ServerCard.make({
		$schema: Document.cardSchemaUrl,
		name: "example.test/notes",
		version: "1.0.0",
		description: "Create notes",
		remotes: [
			{
				type: "streamable-http" as const,
				url: origin + "/mcp",
				supportedProtocolVersions: [Document.protocolVersion],
			},
		],
	}),
	cardUrl: origin + "/mcp/server-card",
	catalogUrl: origin + "/.well-known/ai-catalog.json",
	mcpUrl: origin + "/mcp",
	etag: '"notes-v1"',
	lastModified: "Fri, 09 Oct 2026 00:00:00 GMT",
})

it.effect(
	"A Publication takes only a quoted entity tag and an HTTP date for its cache headers",
	() =>
		Effect.gen(function* () {
			for (const change of [
				{ etag: "notes-v1" },
				{ etag: '"notes\nv1"' },
				{ lastModified: "2026-10-09" },
				{ lastModified: "next Friday" },
			]) {
				const error = yield* Effect.flip(
					McpPublisher.validate({ ...publication, ...change }),
				)
				assert.strictEqual(error._tag, "InvalidDocument")
			}
			for (const lastModified of [
				"Fri, 09 Oct 2026 00:00:00 GMT",
				"Friday, 09-Oct-26 00:00:00 GMT",
				"Fri Oct  9 00:00:00 2026",
			]) {
				const valid = yield* McpPublisher.validate({
					...publication,
					etag: 'W/"notes-v1"',
					lastModified,
				})
				assert.strictEqual(valid.lastModified, lastModified)
			}
		}),
)

it.effect(
	"The Card answers 304 only for an If-Modified-Since date that is valid and not older",
	() =>
		Effect.gen(function* () {
			const publisher = HttpEffect.toWebHandler(
				yield* HttpRouter.toHttpEffect(
					McpPublisher.layer({ publication, register: Effect.void }),
				),
			)
			const status = (since: string) =>
				Effect.promise(() =>
					publisher(
						new Request(publication.cardUrl, {
							headers: { "if-modified-since": since },
						}),
					),
				).pipe(Effect.map((response) => response.status))
			assert.strictEqual(yield* status("Fri, 09 Oct 2026 00:00:00 GMT"), 304)
			assert.strictEqual(yield* status("Sat Oct 10 00:00:00 2026"), 304)
			assert.strictEqual(yield* status("Thu, 08 Oct 2026 23:59:59 GMT"), 200)
			// RFC 9110 says to ignore a value that is not an HTTP date.
			assert.strictEqual(yield* status("2026-10-10"), 200)
			assert.strictEqual(yield* status("not a date"), 200)
		}),
)
