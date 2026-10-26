import { assert, layer } from "@effect/vitest"
import { AppExecution, AppIndexApi } from "@openbot-build/api"
import { Array as Arr, Effect, Ref, Schema, String as Str } from "effect"
import * as Assistance from "../src/plugins/apps/Assistance.ts"
import { PublicIndex } from "../src/apps/Index.ts"
import { Connections } from "../src/apps/Connections.ts"
import * as BrowserHost from "./BrowserHost.ts"

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"App assistance shows public candidates and the account's access needs without sending private context or granting access",
		() =>
			Effect.gen(function* () {
				const host = yield* BrowserHost.start({
					publicOrigin: "https://openbot.fixture.test",
				})
				const alice = yield* host.login("assistance-alice")
				yield* host.run(
					Effect.gen(function* () {
						const index = yield* PublicIndex
						const connections = yield* Connections
						const queries = yield* Ref.make<ReadonlyArray<AppIndexApi.Query>>(
							[],
						)
						const tracked = PublicIndex.of({
							...index,
							search: (query) =>
								Ref.update(queries, Arr.append(query)).pipe(
									Effect.andThen(index.search(query)),
								),
						})
						const entries = Assistance.entries({
							identity: alice.identity,
							index: tracked,
							connections,
							occupied: [
								Assistance.names.search,
								Assistance.names.search + "_1",
							],
						})
						assert.strictEqual((yield* Ref.get(queries)).length, 0)
						assert.strictEqual(
							entries[0]?.tool.name,
							Assistance.names.search + "_2",
						)
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
						assert.strictEqual(candidates.page.apps.length, 0)
						assert.deepStrictEqual(yield* Ref.get(queries), [
							{ query: "document" },
						])
						const invalid = yield* search.handle(
							{ query: Str.repeat(201)("x") },
							context,
						)
						assert.strictEqual(invalid._tag, "AppAssistanceFailed")
						assert.strictEqual((yield* Ref.get(queries)).length, 1)
						const access = yield* entries[2]!.handle({}, context)
						assert.deepStrictEqual(access, {
							_tag: "AppAccess",
							connections: [],
						})
						// An App that is not in the Index is not an Index that is down.
						assert.deepStrictEqual(
							yield* entries[1]!.handle(
								{ cardUrl: "https://apps.fixture.test/missing/card.json" },
								context,
							),
							{
								_tag: "AppAssistanceFailed",
								reason: "IndexNotFound",
								message: "This App is not in the selected public Index.",
							},
						)
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
												{
													source: "fixture",
													message: "The source is offline.",
												},
											],
										}),
									),
							}),
						})
						const failed = yield* unavailable[0]!.handle(
							{ query: "document" },
							context,
						)
						assert.strictEqual(failed._tag, "AppAssistanceFailed")
						assert.deepStrictEqual(
							yield* entries[2]!.handle({}, context),
							access,
						)
					}),
				)
			}),
	)
})
