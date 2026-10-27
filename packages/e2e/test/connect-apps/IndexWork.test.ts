import { assert, layer } from "@effect/vitest"
import { AppIndexApi as Api } from "@openbot-build/api"
import {
	Array as Arr,
	Effect,
	Option,
	Schedule,
	Schema,
	String as Str,
} from "effect"
import { Discovery, Store } from "@openbot-build/protocol"
import { HttpClient } from "effect/http"
import {
	AppFixture as Fixture,
	AppIndex,
	BrowserHost,
	Caller,
	Wait,
} from "@openbot-build/openbot/testing"

const publicOrigin = "https://openbot.fixture.test"

/** The public Index did not come to the number of Apps that the test waits for. */
class IndexNotReady extends Schema.TaggedError<
	IndexNotReady,
	{ readonly brand: unique symbol }
>()("IndexNotReady", { count: Schema.Int }) {
	override get message() {
		return "Public Index did not reach the expected state: " + this.count
	}
}

const Created = Schema.Struct({ id: Schema.String })
const SavedConnection = Schema.Struct({
	id: Schema.String,
	cardUrl: Schema.String,
})
/** An answer that names what went wrong. */
const Tagged = Schema.Struct({ _tag: Schema.String })

/** Reads the public App list until it has `count` Apps. It gives the list as JSON text. */
const waitFor = (address: string, count: number) =>
	Effect.gen(function* () {
		const response = yield* HttpClient.get(address + "/v1/app-index/apps")
		const page = yield* Caller.json(Api.Page)(response)
		return { apps: page.apps.length, body: yield* response.text }
	}).pipe(
		Effect.repeat({
			until: (current) => current.apps === count,
			schedule: Schedule.spaced("20 millis"),
			times: 59,
		}),
		Effect.filterOrFail(
			(current) => current.apps === count,
			() => IndexNotReady.make({ count }),
		),
		Effect.map((current) => current.body),
	)

layer(BrowserHost.layerPlatform, { excludeTestServices: true })((it) => {
	it.effect(
		"public checks update, retry and withdraw through saved executions",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start()
				const website = yield* Fixture.start()
				const host = yield* BrowserHost.start({
					publicOrigin,
					indexPublicNetwork: publisher.publicNetwork({
						origins: [website.origin],
						cas: [website.ca],
					}),
					indexWork: { intervalMs: 500, retryMs: 100 },
				})
				const cardUrl = publisher.origin + "/card?edition=team"
				const request = AppIndex.requestCheck(host, cardUrl)
				const first = yield* request
				const wait = (generation: string) =>
					Wait.until(
						"saved Index result",
						AppIndex.checkJob(host, cardUrl, generation).pipe(
							Effect.map(Option.filter((job) => job.status === "Completed")),
						),
					)
				assert.strictEqual(
					(yield* wait(first.job.generation)).check?._tag,
					"Indexed",
				)
				const get = AppIndex.readPublicEntry(host, cardUrl)
				const original = yield* get
				yield* publisher.setDescription("Updated project documents")
				const updated = yield* Wait.untilTrue(
					"periodic update",
					get,
					(entry) =>
						entry.entry.card.description === "Updated project documents",
				)
				assert.ok(updated.entry.checkedAt > original.entry.checkedAt)
				yield* publisher.setPublication("unavailable")
				yield* Wait.untilTrue(
					"temporary failure",
					get,
					(entry) => entry.check?._tag === "Unconfirmed",
				)
				assert.strictEqual(
					(yield* get).entry.card.description,
					"Updated project documents",
				)
				const failures = yield* AppIndex.failureRecords(
					host,
					first.execution.id,
				)
				assert.isNotEmpty(failures)
				assert.isTrue(
					Arr.some(
						failures,
						(failure) =>
							Str.includes("IndexingError")(failure.details) &&
							Str.includes("Card is not anonymously available")(
								failure.details,
							),
					),
				)
				assert.isTrue(
					Arr.every(
						failures,
						(failure) => !Str.includes("IndexingError")(failure.sealed),
					),
				)
				yield* publisher.setPublication("withdrawn")
				yield* Wait.untilTrue(
					"withdrawal",
					AppIndex.readStoredEntry(host, cardUrl),
					Option.isNone,
				)
				for (const state of ["noindex", "robots-denied"] as const) {
					yield* publisher.setPublication("published")
					assert.strictEqual(
						(yield* wait((yield* request).job.generation)).check?._tag,
						"Indexed",
					)
					yield* publisher.setPublication(state)
					const removed = (yield* wait((yield* request).job.generation)).check
					assert.ok(
						removed?._tag === "Withdrawn" || removed?._tag === "Excluded",
					)
					assert.deepStrictEqual(
						(yield* AppIndex.searchPublicEntries(host, {})).apps,
						[],
					)
					if (state === "noindex")
						assert.ok(
							Option.isNone(yield* AppIndex.readStoredEntry(host, cardUrl)),
						)
				}
				yield* publisher.setPublication("published")
				yield* publisher.setWebsite(website.origin + "/website")
				yield* publisher.setDeclarations([])
				yield* website.setDeclarations([cardUrl])
				yield* wait((yield* request).job.generation)
				assert.strictEqual(
					(yield* get).entry.evidence[0]?.association,
					"Website",
				)
				const calls = yield* AppIndex.executionCalls(host, first.execution)
				assert.ok(calls.length > 1)
				assert.ok(Arr.every(calls, (call) => call.retry === "read_only"))
			}),
		{ timeout: 90_000 },
	)

	it.effect(
		"standard clients see independently indexed Apps, and withdrawal keeps private connections",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start()
				const host = yield* BrowserHost.start({
					publicOrigin,
					discovery: publisher.discovery,
					appProbe: publisher.probe,
					indexPublicNetwork: publisher.publicNetwork(),
					indexWork: { retryMs: 20 },
				})
				const address = yield* host.address
				const call = Caller.withCookie({ address, publicOrigin })
				const alice = yield* host.login("index-alice")
				const draft = yield* Effect.flatMap(
					call(alice.session, "/v1/connection-drafts", "POST", {
						input: publisher.origin + "/card?edition=team",
					}),
					Caller.json(Created),
				)
				const connection = yield* Effect.flatMap(
					call(alice.session, "/v1/connections", "POST", {
						draftId: draft.id,
						revision: 0,
						cardUrl: publisher.origin + "/card?edition=team",
						remoteIndex: 0,
						name: "Index documents",
						values: {
							"header:X-Account": "Work",
							"header:X-Secret": "private-secret",
						},
						confirmed: true,
					}),
					Caller.json(SavedConnection, 201),
				)
				const page = yield* waitFor(address, 1)
				assert.strictEqual(Str.includes("private-secret")(page), false)
				const bob = yield* host.login("index-bob")
				assert.deepStrictEqual(
					yield* Effect.flatMap(
						call(bob.session, "/v1/connections"),
						Caller.json(Schema.Unknown),
					),
					[],
				)
				yield* publisher.setPublication("noindex")
				yield* AppIndex.requestCheck(host, connection.cardUrl)
				yield* waitFor(address, 0)
				assert.strictEqual(
					(yield* call(alice.session, "/v1/connections/" + connection.id))
						.status,
					200,
				)
			}),
	)

	it.effect(
		"public restrictions show appeals and block existing App clients and new confirmations",
		() =>
			Effect.gen(function* () {
				const publisher = yield* Fixture.start()
				const cardUrl = publisher.origin + "/card?edition=team"
				const restriction = {
					cardUrl,
					reason: "The service breaks the host's public publication rules.",
					appealUrl: "https://openbot.fixture.test/appeals",
				}
				const host = yield* BrowserHost.start({
					publicOrigin,
					discovery: publisher.discovery,
					appProbe: publisher.probe,
					indexPublicNetwork: publisher.publicNetwork(),
					indexWork: { retryMs: 20 },
					appRestrictions: [restriction],
				})

				const address = yield* host.address
				const call = Caller.withCookie({ address, publicOrigin })
				const user = yield* host.login("restricted-user")
				const owner = AppIndex.connectionOwner(user.identity)
				const discovery = yield* Discovery.Discovery.use((discovery) =>
					discovery.resolve(cardUrl),
				).pipe(Effect.provide(publisher.discovery))
				assert.strictEqual(discovery._tag, "Single")
				if (discovery._tag !== "Single")
					return yield* Effect.die("Expected one fixture App")
				yield* AppIndex.saveExistingConnection(host, {
					owner,
					name: "Existing restricted App",
					app: Store.AppRecord.make({
						cardUrl,
						card: discovery.candidate.card,
						sources: discovery.candidate.sources,
					}),
					connectionId: "restricted",
					endpoint: publisher.origin + "/mcp",
				})
				const response = yield* Effect.flatMap(
					HttpClient.get(
						address + "/v1/app-index/app?" + new URLSearchParams({ cardUrl }),
					),
					Caller.json(Schema.Struct({ restriction: Schema.Unknown }), 403),
				)
				assert.deepStrictEqual(response.restriction, restriction)
				const denied = yield* AppIndex.restrictedConnectionFailure(
					host,
					owner,
					"restricted",
				)
				assert.strictEqual(denied._tag, "PermissionDenied")
				const confirmation = yield* Effect.flatMap(
					call(user.session, "/v1/connections", "POST", {
						draftId: "new",
						revision: 0,
						cardUrl,
						remoteIndex: 0,
						name: "Blocked",
						values: {},
						confirmed: true,
					}),
					Caller.json(Tagged, 403),
				)
				assert.strictEqual(confirmation._tag, "AppRestricted")
				const connections = yield* Effect.flatMap(
					call(user.session, "/v1/connections"),
					Caller.json(
						Schema.Array(
							Schema.Struct({
								availability: Schema.Struct({ _tag: Schema.String }),
							}),
						),
					),
				)
				assert.strictEqual(connections[0]?.availability._tag, "Restricted")
				assert.strictEqual(
					Arr.some(
						yield* publisher.requests,
						(request) => request.path === "/mcp",
					),
					false,
				)
			}),
	)
})
