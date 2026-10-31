import { assert } from "@effect/vitest"
import { Network } from "@openbot-build/protocol"
import {
	Array as Arr,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Stream,
	String as Str,
} from "effect"
import { LanguageModel } from "effect/ai"

export const publicOrigin = "https://artifacts.example.com"
export const storageOrigin = "http://artifact-storage.test"
export const hoursUrl = "https://notes.example.com/hours"
export const scopeUrl = "https://notes.example.com/scope"
export const hoursText = "A work week has five days. Count each person's hours."
export const scopeText =
	"The plan covers one week. Each person has the same work days."

/** Check the daily sums and the two people's week totals in the delivered CSV. */
export const assertHours = (csv: string) => {
	const rows = Arr.map(Str.split(Str.trim(csv), "\n"), (line) =>
		Str.split(line, ","),
	)
	assert.deepStrictEqual(rows[0], [
		"day",
		"my_hours",
		"coworker_hours",
		"total_hours",
	])
	assert.strictEqual(rows.length, 7)
	const days = Arr.take(Arr.drop(rows, 1), 5)
	assert.deepStrictEqual(
		Arr.map(days, (row) => Number(row[3])),
		[6, 6, 6, 8, 8],
	)
	assert.ok(
		Arr.every(
			days,
			(row) => Number(row[1]) + Number(row[2]) === Number(row[3]),
		),
	)
	const totals = Arr.map([1, 2, 3], (column) =>
		Arr.reduce(days, 0, (sum, row) => sum + Number(row[column])),
	)
	assert.deepStrictEqual(totals, [20, 14, 34])
	assert.deepStrictEqual(Arr.map(Arr.drop(rows[6]!, 1), Number), totals)
}

/** A fixed public network lets the test change a page after capture. */
export const network = Effect.gen(function* () {
	const changed = yield* Ref.make(false)
	return {
		change: Ref.set(changed, true),
		layer: Layer.succeed(Network.PublicNetwork, {
			readDocument: ({ url }) =>
				Effect.map(Ref.get(changed), (change) => ({
					url: url + "?copy=1",
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
					text: `<html><head><title>Work notes</title><style>hidden</style></head><body><p>${change ? "This page changed." : url === hoursUrl ? hoursText : scopeText}</p><script>hidden</script></body></html>`,
				})),
		}),
	}
})

/** Real HTTP storage calls use fixed bytes held at the boundary. */
export const storage = Effect.gen(function* () {
	const objects = yield* Ref.make(
		HashMap.empty<string, Uint8Array<ArrayBuffer>>(),
	)
	return {
		count: Effect.map(Ref.get(objects), HashMap.size),
		fetch: Effect.fn("Artifacts.storage")(function* (request: Request) {
			const url = new URL(request.url)
			assert.ok(request.headers.has("authorization"))
			switch (request.method) {
				case "PUT": {
					const bytes = new Uint8Array(
						yield* Effect.promise(() => request.arrayBuffer()),
					)
					yield* Ref.update(objects, HashMap.set(url.pathname, bytes))
					return new Response(null, { status: 200 })
				}
				case "GET":
				case "HEAD": {
					const bytes = HashMap.get(yield* Ref.get(objects), url.pathname)
					if (Option.isNone(bytes)) return new Response(null, { status: 404 })
					return new Response(
						request.method === "HEAD" ? null : new Blob([bytes.value]),
						{
							headers: { "content-length": String(bytes.value.length) },
						},
					)
				}
				case "DELETE":
					yield* Ref.update(objects, HashMap.remove(url.pathname))
					return new Response(null, { status: 204 })
			}
			return new Response(null, { status: 405 })
		}),
	}
})

/** This model makes one plain assistant message for each user input. */
export const model = LanguageModel.make({
	generateText: () => Effect.succeed([]),
	streamText: () =>
		Stream.fromIterable(
			Arr.make(
				{ type: "text-start", id: "answer" } as const,
				{
					type: "text-delta",
					id: "answer",
					delta: "The work plan is ready.",
				} as const,
				{ type: "text-end", id: "answer" } as const,
				{
					type: "finish",
					reason: "stop",
					response: undefined,
					usage: {
						inputTokens: { total: 5, uncached: 5, cacheRead: 0, cacheWrite: 0 },
						outputTokens: { total: 5, text: 5, reasoning: 0 },
					},
				} as const,
			),
		),
})
