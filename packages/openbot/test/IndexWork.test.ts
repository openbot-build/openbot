import { assert, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { AppIndexApi as Api } from "@openbot-build/api"
import {
	CatalogDiscovery,
	Discovery,
	Indexing,
	PublicIndexing,
	RobotsPolicy,
	Client,
	Store,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Duration,
	Effect,
	HashMap,
	Layer,
	Option,
	Redacted,
	Ref,
	Schedule,
	Schema,
	String as Str,
} from "effect"
import { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import * as PublicIndex from "../src/apps/Index.ts"
import { Index } from "@openbot-build/protocol"
import { eq } from "drizzle-orm"
import * as IndexStorage from "../src/apps/IndexStore.ts"
import { IndexNamespace } from "../src/apps/IndexNamespace.ts"
import { appIndexJobs } from "../src/database/Schema.ts"
import { IndexWork } from "../src/apps/IndexWork.ts"
import * as Work from "../src/apps/IndexWork.ts"
import * as Governance from "../src/apps/Governance.ts"
import * as OrganizationFixture from "./OrganizationFixture.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Fixture from "./AppFixture.ts"
import * as Postgres from "./PostgresTest.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as Caller from "./Caller.ts"
import { AppHost } from "../src/apps/AppHost.ts"
import * as StoredConnections from "../src/apps/StoredConnections.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Db from "../src/database/Database.ts"

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
		"stored public verification updates and withdraws with a test clock and recovers interrupted claims",
		() =>
			Effect.gen(function* () {
				// Each resource closes when the test ends, in the reverse order.
				const database = yield* Postgres.start
				const website = yield* Fixture.start()
				const publisher = yield* Fixture.start()
				const replaceClaim = yield* Ref.make(false)
				const indexStorage = IndexStorage.layer
				const indexing = PublicIndexing.layerInspection.pipe(
					Layer.provide(CatalogDiscovery.layerRules),
					Layer.provide(RobotsPolicy.layer),
					Layer.provide(
						publisher.publicNetwork({
							origins: [website.origin],
							cas: [website.ca],
						}),
					),
				)
				const checked = Layer.effect(
					Indexing.PublicationInspection,
					Effect.gen(function* () {
						const inspection = yield* Indexing.PublicationInspection
						const db = yield* Db.make
						return Indexing.PublicationInspection.of({
							inspect: (input, previous) =>
								inspection.inspect(input, previous).pipe(
									Effect.tap(() =>
										Effect.gen(function* () {
											if (yield* Ref.get(replaceClaim))
												yield* db
													.update(appIndexJobs)
													.set({ claim: "new-worker" })
													.where(eq(appIndexJobs.cardUrl, input.cardUrl))
													.pipe(Effect.orDie)
										}),
									),
								),
						})
					}),
				).pipe(Layer.provide(indexing))

				const layers = Layer.merge(
					PublicIndex.layer({}),
					Work.layer().pipe(Layer.provide(checked)),
				).pipe(
					Layer.provideMerge(indexStorage),
					Layer.provide(Governance.layer),
					Layer.provide(
						OrganizationFixture.layerSettings({
							publicOrigin: "https://openbot.test",
						}),
					),
					Layer.provideMerge(
						Database.layer({ databaseUrl: Redacted.make(database.url) }),
					),
					Layer.provideMerge(TestClock.layer()),
					Layer.provideMerge(NodeServices.layer),
				)
				const cardUrl = publisher.origin + "/card?edition=team"
				const leaseUntil = yield* Effect.gen(function* () {
					yield* Database.migrate
					const db = yield* Db.make
					const enqueue = Work.enqueue(db, "public", cardUrl, [])
					const work = yield* IndexWork
					const index = yield* PublicIndex.PublicIndex
					const repository = yield* Index.IndexStore
					yield* enqueue
					assert.ok(yield* work.runOne())
					const first = (yield* index.search({})).apps[0]
					assert.ok(first)
					assert.strictEqual(first.entry.cardUrl, cardUrl)
					assert.strictEqual(first.check?._tag, "Indexed")
					assert.strictEqual(yield* work.runOne(), false)
					// A worker that lost its claim must not change the public entry.
					yield* publisher.setDescription("Old worker result")
					yield* enqueue
					yield* Ref.set(replaceClaim, true)
					yield* work.runOne()
					assert.strictEqual(
						(yield* index.get(cardUrl)).entry.card.description,
						first.entry.card.description,
					)
					const held = (yield* db
						.select()
						.from(appIndexJobs)
						.where(eq(appIndexJobs.cardUrl, cardUrl)))[0]
					assert.strictEqual(held?.claim, "new-worker")
					yield* Ref.set(replaceClaim, false)
					yield* db
						.update(appIndexJobs)
						.set({ claim: null, leaseUntil: 0 })
						.where(eq(appIndexJobs.cardUrl, cardUrl))

					yield* publisher.setDescription("Updated project documents")
					yield* TestClock.adjust("1 hour")
					yield* work.runOne()
					const updated = yield* index.get(cardUrl)
					assert.strictEqual(
						updated.entry.card.description,
						"Updated project documents",
					)
					assert.ok(updated.entry.checkedAt > first.entry.checkedAt)
					yield* publisher.setPublication("unavailable")
					yield* TestClock.adjust("1 hour")
					yield* work.runOne()
					const unconfirmed = yield* index.get(cardUrl)
					assert.strictEqual(unconfirmed.check?._tag, "Unconfirmed")
					assert.strictEqual(
						unconfirmed.entry.checkedAt,
						updated.entry.checkedAt,
					)
					yield* publisher.setPublication("withdrawn")
					assert.strictEqual(yield* work.runOne(), false)
					yield* TestClock.adjust("1 minute")
					yield* work.runOne()
					assert.deepStrictEqual((yield* index.search({})).apps, [])
					assert.strictEqual(
						Option.isNone(yield* repository.get(cardUrl)),
						true,
					)
					assert.strictEqual(
						Option.getOrThrow(
							HashMap.get(yield* IndexStorage.checks(db, "public"), cardUrl),
						)._tag,
						"Withdrawn",
					)
					yield* publisher.setPublication("published")
					yield* enqueue
					yield* work.runOne()
					yield* publisher.setPublication("noindex")
					yield* enqueue
					yield* work.runOne()
					assert.deepStrictEqual((yield* index.search({})).apps, [])
					yield* publisher.setPublication("published")
					yield* enqueue
					yield* work.runOne()
					yield* publisher.setPublication("robots-denied")
					yield* enqueue
					yield* work.runOne()
					assert.deepStrictEqual((yield* index.search({})).apps, [])
					yield* publisher.setPublication("published")
					yield* publisher.setWebsite(website.origin + "/website")
					yield* publisher.setDeclarations([])
					yield* website.setDeclarations([cardUrl])
					yield* enqueue
					yield* work.runOne()
					assert.strictEqual(
						(yield* index.get(cardUrl)).entry.evidence[0]?.association,
						"Website",
					)
					yield* enqueue
					// A worker takes the job and then stops before it finishes.
					const leaseUntil = (yield* Clock.currentTimeMillis) + 300000
					yield* db
						.update(appIndexJobs)
						.set({ claim: "interrupted", leaseUntil })
						.where(eq(appIndexJobs.cardUrl, cardUrl))
					assert.strictEqual(yield* work.runOne(), false)
					return leaseUntil
				}).pipe(Effect.provide(layers))
				// Providing the layers again builds new services, like a new process.
				yield* Effect.gen(function* () {
					// The claim of the old process comes back when its lease ends.
					// The new test clock starts again at its own start time.
					yield* TestClock.adjust(
						Duration.millis(leaseUntil - (yield* Clock.currentTimeMillis)),
					)
					assert.strictEqual(yield* (yield* IndexWork).runOne(), true)
					assert.strictEqual(
						(yield* (yield* PublicIndex.PublicIndex).search({})).apps.length,
						1,
					)
					yield* Effect.scoped(Layer.build(Work.layerWorker()))
					const count = (yield* publisher.requests).length
					yield* TestClock.adjust("2 hours")
					assert.strictEqual((yield* publisher.requests).length, count)
				}).pipe(Effect.provide(layers))
			}),
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
				yield* host.run(
					Effect.gen(function* () {
						yield* Work.enqueue(
							yield* Db.make,
							yield* IndexNamespace,
							connection.cardUrl,
							[],
						)
					}),
				)
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
				const storage = Layer.merge(
					Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					Database.layer({ databaseUrl: Redacted.make(host.databaseUrl) }),
				)
				const address = yield* host.address
				const call = Caller.withCookie({ address, publicOrigin })
				const user = yield* host.login("restricted-user")
				const owner = ownerKey(user.identity)
				const discovery = yield* Discovery.Discovery.use((discovery) =>
					discovery.resolve(cardUrl),
				).pipe(Effect.provide(publisher.discovery))
				assert.strictEqual(discovery._tag, "Single")
				if (discovery._tag !== "Single")
					return yield* Effect.die("Expected one fixture App")
				yield* Effect.gen(function* () {
					return yield* StoredConnections.save(
						yield* Db.make,
						yield* Secrets.Secrets,
						"public",
						owner,
						{
							name: "Existing restricted App",
							app: Store.AppRecord.make({
								cardUrl,
								card: discovery.candidate.card,
								sources: discovery.candidate.sources,
							}),
							connection: Store.UserConnection.make({
								owner,
								connectionId: "restricted",
								cardUrl,
								endpoint: publisher.origin + "/mcp",
								remoteIndex: 0,
								configuration: Redacted.make({}),
								headers: Redacted.make({}),
								state: "Enabled",
								authorization: { _tag: "Unprotected" },
							}),
						},
					)
				}).pipe(Effect.provide(storage))
				yield* host.run(Effect.flatMap(IndexWork, (work) => work.runOne()))
				const response = yield* Effect.flatMap(
					HttpClient.get(
						address + "/v1/app-index/app?" + new URLSearchParams({ cardUrl }),
					),
					Caller.json(Schema.Struct({ restriction: Schema.Unknown }), 403),
				)
				assert.deepStrictEqual(response.restriction, restriction)
				const denied = yield* host.run(
					Effect.scoped(
						Effect.gen(function* () {
							const app = (yield* AppHost).bind(
								owner,
								Client.InvocationPolicy.of({ check: () => Effect.void }),
							)
							return yield* Effect.flip(
								app.open({
									key: { owner, connectionId: "restricted" },
									clientInfo: { name: "Policy fixture", version: "1.0.0" },
								}),
							)
						}),
					),
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
