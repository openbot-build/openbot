import assert from "node:assert/strict"
import { test } from "node:test"
import { AppExecution, AppIndexApi } from "@openbot-build/api"
import { Effect, Schema } from "effect"
import * as Assistance from "../src/apps/Assistance.ts"
import { PublicIndex } from "../src/apps/Index.ts"
import { Connections } from "../src/apps/Connections.ts"
import * as BrowserHost from "./BrowserHost.ts"

test("App assistance shows public candidates and the account's access needs without sending private context or granting access", async () => {
	const host = await BrowserHost.start({
		publicOrigin: "https://openbot.fixture.test",
	})
	try {
		const alice = await host.login("assistance-alice")
		await host.runtime.runPromise(
			Effect.gen(function* () {
				const index = yield* PublicIndex
				const connections = yield* Connections
				let queries: ReadonlyArray<AppIndexApi.Query> = []
				const tracked = PublicIndex.of({
					...index,
					search: (query) =>
						Effect.suspend(() => {
							queries = [...queries, query]
							return index.search(query)
						}),
				})
				const entries = Assistance.entries({
					identity: alice.identity,
					index: tracked,
					connections,
					occupied: [Assistance.names.search, Assistance.names.search + "_1"],
				})
				assert.equal(queries.length, 0)
				assert.equal(entries[0]?.tool.name, Assistance.names.search + "_2")
				const context = { preliminary: () => Effect.void }
				const search = entries[0]!
				const result = yield* search.handle(
					{
						query: "document",
						privateHistory:
							"A private document that must never reach discovery",
					},
					context,
				)
				const candidates = yield* Schema.decodeUnknownEffect(
					AppExecution.Assistance.cases.AppCandidates,
				)(result)
				assert.equal(candidates.page.apps.length, 0)
				assert.deepEqual(queries, [{ query: "document" }])
				const invalid = yield* search.handle(
					{ query: "x".repeat(201) },
					context,
				)
				assert.equal(invalid._tag, "AppAssistanceFailed")
				assert.equal(queries.length, 1)
				const access = yield* entries[2]!.handle({}, context)
				assert.deepEqual(access, {
					_tag: "AppAccess",
					connections: [],
				})
				const unavailable = Assistance.entries({
					identity: alice.identity,
					connections,
					occupied: [],
					index: PublicIndex.of({
						...index,
						search: () =>
							Effect.fail(
								AppIndexApi.IndexUnavailable.make({
									issues: [
										{ source: "fixture", message: "The source is offline." },
									],
								}),
							),
					}),
				})
				const failed = yield* unavailable[0]!.handle(
					{ query: "document" },
					context,
				)
				assert.equal(failed._tag, "AppAssistanceFailed")
				assert.deepEqual(yield* entries[2]!.handle({}, context), access)
			}),
		)
	} finally {
		await host.close()
	}
})
