import assert from "node:assert/strict"
import { test } from "node:test"
import {
	AppExecution,
	AppIndexApi,
	AppExperienceApi,
	ConnectionsApi,
} from "@openbot-build/platform-api"
import { Document, Index } from "@openbot-build/protocol"
import { Effect, Schema } from "effect"
import * as Assistance from "../src/apps/Assistance.ts"
import { PublicIndex } from "../src/apps/Index.ts"
import { Connections } from "../src/apps/Connections.ts"
import * as BrowserHost from "./BrowserHost.ts"

test("App assistance shows public candidates and the account's access needs without sending private context or granting access", async () => {
	const host = await BrowserHost.start({
		publicOrigin: "https://platform.fixture.test",
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
					occupied: ["openbot_search_apps", "openbot_search_apps_1"],
				})
				assert.equal(queries.length, 0)
				assert.equal(entries[0]?.tool.name, "openbot_search_apps_2")
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

test("owned tool output identities encode without relaxing public Card contracts", () => {
	const manual = "urn:openbot:manual:827409f8-bc90-4bca-a30e-df5bd4f6e893"
	for (const cardUrl of ["https://publisher.example/card", manual]) {
		const source: AppExecution.Source = {
			connectionId: "owned-connection",
			connectionName: "Work documents",
			cardUrl,
			appName: "Documents",
			remoteIndex: 0,
			revision: 0,
			kind: "tool",
			name: "read_document",
		}
		const results: ReadonlyArray<AppExecution.ToolResult> = [
			{
				_tag: "Completed",
				source,
				result: { content: [{ type: "text", text: "Document result" }] },
			},
			{
				_tag: "InputRequired",
				source,
				request: { inputRequests: [{ id: "consent", mode: "form" }] },
			},
			{
				_tag: "Failed",
				source,
				reason: "Schema",
				message: "The provider returned invalid output.",
			},
			{
				_tag: "AppAccess",
				connections: [
					{
						id: source.connectionId,
						name: source.connectionName,
						cardUrl,
						revision: 0,
						enabled: true,
						availability: { _tag: "Unverified" },
					},
				],
			},
		]
		for (const result of results) {
			const encoded = Schema.encodeSync(AppExecution.ToolResult)(result)
			assert.deepEqual(
				Schema.decodeSync(AppExecution.ToolResult)(encoded),
				result,
			)
		}
	}
	for (const invalid of [
		"urn:example:private",
		"urn:openbot:manual:" + "-".repeat(36),
		"urn:openbot:manual:not-a-uuid",
		"http://publisher.example/card",
		"https://user:secret@publisher.example/card",
	]) {
		assert.throws(() =>
			Schema.decodeSync(AppExecution.Source.fields.cardUrl)(invalid),
		)
		assert.throws(() =>
			Schema.decodeSync(AppExecution.AccessConnection.fields.cardUrl)(invalid),
		)
	}
	for (const publicIdentity of [
		Document.Link,
		Index.Entry.fields.cardUrl,
		ConnectionsApi.ConnectionRequest.fields.cardUrl,
		AppExperienceApi.Entry.fields.cardUrl,
	]) {
		assert.throws(() => Schema.decodeSync(publicIdentity)(manual))
		assert.equal(
			Schema.decodeSync(publicIdentity)("https://publisher.example/card"),
			"https://publisher.example/card",
		)
	}
})
