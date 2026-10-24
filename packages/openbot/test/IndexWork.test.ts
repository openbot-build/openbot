// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { AppIndexApi as Api, AuthApi } from "@openbot-build/api"
import {
	CatalogDiscovery,
	Discovery,
	PublicIndexing,
	RobotsPolicy,
	Client,
} from "@openbot-build/protocol"
import {
	Effect,
	HashMap,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Schema,
	Scope,
	Exit,
} from "effect"
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
import { AppHost } from "../src/apps/AppHost.ts"
import * as StoredConnections from "../src/apps/StoredConnections.ts"
import { ownerKey } from "../src/apps/StoredConnections.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as Db from "../src/database/Database.ts"

it.live(
	"stored public verification updates and withdraws with a test clock and recovers interrupted claims",
	() =>
		Effect.gen(function* () {
			// Each resource closes when the test ends, in the reverse order.
			const database = yield* Effect.acquireRelease(
				Effect.promise(() => Postgres.start()),
				(database) => Effect.promise(() => database.close()),
			)
			const website = yield* Effect.acquireRelease(
				Effect.promise(() => Fixture.start()),
				(website) => Effect.promise(() => website.close()),
			)
			const publisher = yield* Effect.acquireRelease(
				Effect.promise(() => Fixture.start()),
				(publisher) => Effect.promise(() => publisher.close()),
			)
			const indexStorage = IndexStorage.layer
			const indexing = PublicIndexing.layer.pipe(
				Layer.provide(CatalogDiscovery.layerRules),
				Layer.provide(RobotsPolicy.layer),
				Layer.provide(
					publisher.publicNetwork({
						origins: [website.origin],
						cas: [website.ca],
					}),
				),
				Layer.provide(indexStorage),
			)
			const layers = Layer.merge(
				PublicIndex.layer({ publicOrigin: "https://openbot.test" }),
				Work.layer().pipe(Layer.provide(indexing)),
			).pipe(
				Layer.provideMerge(indexStorage),
				Layer.provide(
					Governance.layer.pipe(
						Layer.provide(OrganizationFixture.layerDefaultSettings),
					),
				),
				Layer.provideMerge(
					Database.layer({ databaseUrl: Redacted.make(database.url) }),
				),
				Layer.provideMerge(TestClock.layer()),
				Layer.provide(NodeServices.layer),
			)
			const cardUrl = publisher.origin + "/card?edition=team"
			yield* Effect.gen(function* () {
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
				publisher.setDescription("Updated project documents")
				yield* TestClock.adjust("1 hour")
				yield* work.runOne()
				const updated = yield* index.get(cardUrl)
				assert.strictEqual(
					updated.entry.card.description,
					"Updated project documents",
				)
				assert.ok(updated.entry.checkedAt > first.entry.checkedAt)
				publisher.setPublication("unavailable")
				yield* TestClock.adjust("1 hour")
				yield* work.runOne()
				const unconfirmed = yield* index.get(cardUrl)
				assert.strictEqual(unconfirmed.check?._tag, "Unconfirmed")
				assert.strictEqual(unconfirmed.entry.checkedAt, updated.entry.checkedAt)
				publisher.setPublication("withdrawn")
				assert.strictEqual(yield* work.runOne(), false)
				yield* TestClock.adjust("1 minute")
				yield* work.runOne()
				assert.deepStrictEqual((yield* index.search({})).apps, [])
				assert.strictEqual(Option.isNone(yield* repository.get(cardUrl)), true)
				assert.strictEqual(
					Option.getOrThrow(
						HashMap.get(yield* IndexStorage.checks(db, "public"), cardUrl),
					)._tag,
					"Withdrawn",
				)
				publisher.setPublication("published")
				yield* enqueue
				yield* work.runOne()
				publisher.setPublication("noindex")
				yield* enqueue
				yield* work.runOne()
				assert.deepStrictEqual((yield* index.search({})).apps, [])
				publisher.setPublication("published")
				yield* enqueue
				yield* work.runOne()
				publisher.setPublication("robots-denied")
				yield* enqueue
				yield* work.runOne()
				assert.deepStrictEqual((yield* index.search({})).apps, [])
				publisher.setPublication("published")
				publisher.setWebsite(website.origin + "/website")
				publisher.setDeclarations([])
				website.setDeclarations([cardUrl])
				yield* enqueue
				yield* work.runOne()
				assert.strictEqual(
					(yield* index.get(cardUrl)).entry.evidence[0]?.association,
					"Website",
				)
				yield* enqueue
				// A worker takes the job and then stops before it finishes.
				yield* db
					.update(appIndexJobs)
					.set({ claim: "interrupted", leaseUntil: Number.MAX_SAFE_INTEGER })
					.where(eq(appIndexJobs.cardUrl, cardUrl))
				assert.strictEqual(yield* work.runOne(), false)
			}).pipe(Effect.provide(layers))
			// Providing the layers again builds new services, like a new process.
			yield* Effect.gen(function* () {
				// The worker of the new process releases the claims of the old process.
				yield* (yield* Db.make)
					.update(appIndexJobs)
					.set({ claim: null, leaseUntil: 0 })
					.where(eq(appIndexJobs.namespace, "public"))
				assert.strictEqual(yield* (yield* IndexWork).runOne(), true)
				assert.strictEqual(
					(yield* (yield* PublicIndex.PublicIndex).search({})).apps.length,
					1,
				)
				const workerScope = yield* Scope.make()
				yield* Layer.buildWithScope(Work.layerWorker(), workerScope)
				yield* Scope.close(workerScope, Exit.void)
				const count = publisher.requests().length
				yield* TestClock.adjust("2 hours")
				assert.strictEqual(publisher.requests().length, count)
			}).pipe(Effect.provide(layers))
		}),
)

it("standard clients see independently indexed Apps, and withdrawal keeps private connections", async () => {
	const publisher = await Fixture.start()
	const host = await BrowserHost.start({
		publicOrigin: "https://openbot.fixture.test",
		discovery: publisher.discovery,
		appProbe: publisher.probe,
		indexPublicNetwork: publisher.publicNetwork(),
		indexWork: { retryMs: 20 },
	})
	try {
		const alice = await host.login("index-alice")
		const headers = {
			cookie:
				AuthApi.SessionCookie +
				"=" +
				encodeURIComponent(Redacted.value(alice.session)),
			origin: "https://openbot.fixture.test",
			"content-type": "application/json",
		}
		const prepared = await fetch(host.address + "/v1/connection-drafts", {
			method: "POST",
			headers,
			body: JSON.stringify({ input: publisher.origin + "/card?edition=team" }),
		})
		const draft = await prepared.json()
		const saved = await fetch(host.address + "/v1/connections", {
			method: "POST",
			headers,
			body: JSON.stringify({
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
		})
		assert.strictEqual(saved.status, 201)
		const connection = await saved.json()
		const waitFor = async (count: number) => {
			for (let attempt = 0; attempt < 60; attempt++) {
				const response = await fetch(host.address + "/v1/app-index/apps")
				const page = Schema.decodeUnknownSync(Api.Page)(await response.json())
				if (page.apps.length === count) return page
				await new Promise((resolve) => setTimeout(resolve, 20))
			}
			throw new Error("Public Index did not reach the expected state")
		}
		const page = await waitFor(1)
		assert.strictEqual(JSON.stringify(page).includes("private-secret"), false)
		const bob = await host.login("index-bob")
		assert.deepStrictEqual(
			await (
				await fetch(host.address + "/v1/connections", {
					headers: {
						cookie:
							AuthApi.SessionCookie +
							"=" +
							encodeURIComponent(Redacted.value(bob.session)),
					},
				})
			).json(),
			[],
		)
		publisher.setPublication("noindex")
		await host.runtime.runPromise(
			Effect.gen(function* () {
				yield* Work.enqueue(
					yield* Db.make,
					yield* IndexNamespace,
					connection.cardUrl,
					[],
				)
			}),
		)
		await waitFor(0)
		assert.strictEqual(
			(
				await fetch(host.address + "/v1/connections/" + connection.id, {
					headers,
				})
			).status,
			200,
		)
	} finally {
		await host.close()
		await publisher.close()
	}
})

it("public restrictions show appeals and block existing App clients and new confirmations", async () => {
	const publisher = await Fixture.start()
	const cardUrl = publisher.origin + "/card?edition=team"
	const restriction = {
		cardUrl,
		reason: "The service breaks the host's public publication rules.",
		appealUrl: "https://openbot.fixture.test/appeals",
	}
	const host = await BrowserHost.start({
		publicOrigin: "https://openbot.fixture.test",
		discovery: publisher.discovery,
		appProbe: publisher.probe,
		indexPublicNetwork: publisher.publicNetwork(),
		indexWork: { retryMs: 20 },
		appRestrictions: [restriction],
	})
	const storage = ManagedRuntime.make(
		Layer.merge(
			Secrets.layer(Redacted.make("test:" + "11".repeat(32))),
			Database.layer({ databaseUrl: Redacted.make(host.databaseUrl) }),
		).pipe(Layer.provide(NodeServices.layer)),
	)
	try {
		const user = await host.login("restricted-user")
		const owner = ownerKey(user.identity)
		const discovery = await Effect.runPromise(
			Discovery.Discovery.use((discovery) => discovery.resolve(cardUrl)).pipe(
				Effect.provide(publisher.discovery),
			),
		)
		assert.strictEqual(discovery._tag, "Single")
		if (discovery._tag !== "Single") throw new Error("Expected one fixture App")
		await storage.runPromise(
			Effect.gen(function* () {
				return yield* StoredConnections.save(
					yield* Db.make,
					yield* Secrets.Secrets,
					"public",
					owner,
					{
						name: "Existing restricted App",
						app: {
							cardUrl,
							card: discovery.candidate.card,
							sources: discovery.candidate.sources,
						},
						connection: {
							owner,
							connectionId: "restricted",
							cardUrl,
							endpoint: publisher.origin + "/mcp",
							remoteIndex: 0,
							configuration: Redacted.make({}),
							headers: Redacted.make({}),
							state: "Enabled",
							authorization: { _tag: "Unprotected" },
						},
					},
				)
			}),
		)
		await host.runtime.runPromise(
			Effect.flatMap(IndexWork, (work) => work.runOne()),
		)
		const response = await fetch(
			host.address + "/v1/app-index/app?" + new URLSearchParams({ cardUrl }),
		)
		assert.strictEqual(response.status, 403)
		assert.deepStrictEqual((await response.json()).restriction, restriction)
		const denied = await host.runtime.runPromise(
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
		const headers = {
			cookie:
				AuthApi.SessionCookie +
				"=" +
				encodeURIComponent(Redacted.value(user.session)),
			origin: "https://openbot.fixture.test",
			"content-type": "application/json",
		}
		const confirmation = await fetch(host.address + "/v1/connections", {
			method: "POST",
			headers,
			body: JSON.stringify({
				draftId: "new",
				revision: 0,
				cardUrl,
				remoteIndex: 0,
				name: "Blocked",
				values: {},
				confirmed: true,
			}),
		})
		assert.strictEqual(confirmation.status, 403)
		assert.strictEqual((await confirmation.json())._tag, "AppRestricted")
		assert.strictEqual(
			(
				await (
					await fetch(host.address + "/v1/connections", { headers })
				).json()
			)[0].availability._tag,
			"Restricted",
		)
		assert.strictEqual(
			publisher.requests().some((request) => request.path === "/mcp"),
			false,
		)
	} finally {
		await storage.dispose()
		await host.close()
		await publisher.close()
	}
})
