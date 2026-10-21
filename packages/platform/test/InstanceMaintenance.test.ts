// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setTimeout } from "node:timers/promises"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Network } from "@openbot-build/protocol"
import { Effect, Fiber, Layer, ManagedRuntime, Redacted } from "effect"
import * as InstanceWork from "../src/execution/InstanceWork.ts"
import * as Fence from "../src/execution/ExecutionFence.ts"
import * as Barrier from "../src/auth/Barrier.ts"
import * as Stored from "../src/execution/StoredExecutions.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import { IndexWorkRepository } from "../src/apps/IndexWorkRepository.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as AppFixture from "./AppFixture.ts"
import * as Postgres from "./PostgresTest.ts"

const options = {
	origin: "http://maintenance-authority.test",
	token: Redacted.make("maintenance-test-only"),
	backend: "openbot" as const,
}
const latch = () => {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}
const waitFor = async (check: () => Promise<boolean>) => {
	for (let i = 0; i < 100; i++) {
		if (await check()) return
		await setTimeout(20)
	}
	assert.fail("Maintenance condition did not settle")
}
const authority = (t: TestContext, beforeAdmit = async () => {}) => {
	const actualFetch = globalThis.fetch
	let serial = 0
	return t.mock.method(
		globalThis,
		"fetch",
		async (input: URL | RequestInfo, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			if (url.origin !== options.origin) return actualFetch(input, init)
			if (url.pathname === "/internal/auth/admit") await beforeAdmit()
			if (url.pathname.endsWith("/assignment"))
				return Response.json({ assigned: true })
			if (url.pathname.endsWith("/release"))
				return Response.json({ released: true })
			return Response.json({
				allowed: true,
				epoch: 1,
				phase: "OPENBOT_ACTIVE",
				leaseId: String(++serial),
			})
		},
	)
}

test("paused instance allows admitted nested work to finish and retains counts through cancellation", async (t) => {
	const network = authority(t)
	const runtime = ManagedRuntime.make(
		Fence.layer(options).pipe(Layer.provideMerge(InstanceWork.layer)),
	)
	const entered = latch(),
		proceed = latch(),
		childEntered = latch(),
		childFinish = latch()
	try {
		const fiber = runtime.runFork(
			Effect.gen(function* () {
				const gate = yield* InstanceWork.InstanceWork
				const fence = yield* Fence.ExecutionFence
				return yield* gate.wrap(
					Effect.gen(function* () {
						yield* Effect.sync(entered.release)
						yield* Effect.promise(() => proceed.promise)
						return yield* gate.wrap(
							fence.admit(
								"nested-account",
								Effect.gen(function* () {
									yield* Effect.sync(childEntered.release)
									yield* Effect.promise(() => childFinish.promise)
									return "committed"
								}),
							),
						)
					}),
				)
			}),
		)
		await entered.promise
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* InstanceWork.InstanceWork).quiesce
				yield* (yield* Fence.ExecutionFence).quiesce
			}),
		)
		assert.equal(
			(await runtime.runPromise(Effect.flip(InstanceWork.wrap(Effect.void))))
				._tag,
			"InstancePaused",
		)
		proceed.release()
		await childEntered.promise
		assert.equal(
			await runtime
				.runPromise(
					Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.status),
				)
				.then((s) => s.activeTasks),
			2,
		)
		const interrupt = runtime.runPromise(Fiber.interrupt(fiber))
		await setTimeout(30)
		assert.equal(
			await runtime
				.runPromise(
					Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.status),
				)
				.then((s) => s.activeTasks),
			2,
		)
		childFinish.release()
		await interrupt
		assert.equal(
			await runtime
				.runPromise(
					Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.status),
				)
				.then((s) => s.activeTasks),
			0,
		)
	} finally {
		proceed.release()
		childFinish.release()
		await runtime.dispose()
		network.mock.restore()
	}
})

test(
	"release waits for real auth admission and public HTTPS indexing, then stays paused",
	{ timeout: 30000 },
	async (t) => {
		const authEntered = latch(),
			authFinish = latch(),
			indexEntered = latch(),
			indexFinish = latch()
		let holdAuth = false,
			holdIndex = false
		const network = authority(t, async () => {
			if (holdAuth) {
				authEntered.release()
				await authFinish.promise
			}
		})
		const publisher = await AppFixture.start()
		const publicNetwork = Layer.effect(
			Network.PublicNetwork,
			Effect.map(Network.PublicNetwork, (network) =>
				Network.PublicNetwork.of({
					readDocument: (input) =>
						Effect.promise(async () => {
							if (holdIndex) {
								indexEntered.release()
								await indexFinish.promise
							}
						}).pipe(Effect.andThen(network.readDocument(input))),
				}),
			),
		).pipe(Layer.provide(publisher.publicNetwork()))
		const host = await BrowserHost.start({
			publicOrigin: "https://maintenance.fixture.test",
			execution: options,
			indexPublicNetwork: publicNetwork,
			indexWork: { retryMs: 20 },
		})
		const control = async (action: string) => {
			const response = await fetch(
				host.address + "/internal/execution/" + action,
				{
					method: "POST",
					headers: { authorization: "Bearer maintenance-test-only" },
				},
			)
			assert.equal(response.status, 200, await response.clone().text())
			return response.json()
		}
		try {
			holdAuth = true
			const login = fetch(host.address + "/auth/login", { redirect: "manual" })
			await authEntered.promise
			const busyAuth = await control("quiesce")
			assert.equal(busyAuth.drained, false)
			assert.ok(
				busyAuth.instanceTasks > 0,
				"auth is counted before its durable lease response",
			)
			assert.equal(
				(await fetch(host.address + "/auth/login", { redirect: "manual" }))
					.status,
				503,
			)
			holdAuth = false
			authFinish.release()
			assert.equal((await login).status, 303)
			await waitFor(async () => (await control("status")).drained === true)
			await control("resume")
			holdIndex = true
			const cardUrl = publisher.origin + "/card?edition=team"
			await host.runtime.runPromise(
				Effect.flatMap(IndexWorkRepository, (jobs) =>
					jobs.enqueue(cardUrl, []),
				),
			)
			await indexEntered.promise
			const busyIndex = await control("quiesce")
			assert.equal(busyIndex.drained, false)
			assert.ok(busyIndex.instanceTasks > 0)
			assert.ok(
				busyIndex.persistedPending > 0,
				"the claimed public job remains durable",
			)
			holdIndex = false
			indexFinish.release()
			await waitFor(async () => (await control("status")).drained === true)
			const count = publisher.requests().length
			await host.runtime.runPromise(
				Effect.flatMap(IndexWorkRepository, (jobs) =>
					jobs.enqueue(cardUrl, []),
				),
			)
			await setTimeout(100)
			assert.equal(
				publisher.requests().length,
				count,
				"a paused worker cannot claim a fresh job",
			)
			assert.equal((await control("status")).drained, true)
			await control("resume")
			await waitFor(async () => publisher.requests().length > count)
		} finally {
			authFinish.release()
			indexFinish.release()
			await host.close()
			await publisher.close()
			network.mock.restore()
		}
	},
)

test("private auth revocation and retry remain counted until their actual storage effect finishes", async (t) => {
	const network = authority(t)
	const database = await Postgres.start()
	const runtime = ManagedRuntime.make(
		Barrier.layer(options).pipe(
			Layer.provideMerge(InstanceWork.layer),
			Layer.provideMerge(
				Database.layer({ databaseUrl: Redacted.make(database.url) }),
			),
			Layer.provide(NodeServices.layer),
		),
	)
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				yield* sql`CREATE TABLE maintenance_revocations (id integer PRIMARY KEY)`
			}),
		)
		for (const retry of [false, true]) {
			const entered = latch(),
				finish = latch()
			const operation = Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				yield* Effect.sync(entered.release)
				yield* Effect.promise(() => finish.promise)
				yield* sql`INSERT INTO maintenance_revocations (id) VALUES (${retry ? 2 : 1})`
			}).pipe(Effect.orDie)
			await runtime.runPromise(
				Effect.gen(function* () {
					const sqlContext = yield* Effect.context<PgClient.PgClient>()
					const barrier = yield* Barrier.Barrier
					yield* barrier.register({
						profile: {
							issuer: "https://issuer.test",
							clientId: "test",
							providerId: "oidc",
							publicOrigin: "https://client.test",
							redirectUri: "https://client.test/auth/callback/oidc",
							sessionCookie: "test",
							loginCookie: "test-login",
							basePath: "/auth",
							sdkVersion: "1.7.8",
						},
						secret: Redacted.make("test-secret"),
						readSession: () =>
							Effect.succeed({ accountId: "alice", setCookies: [] }),
						revokeSession: () =>
							operation.pipe(Effect.as([]), Effect.provide(sqlContext)),
						revocationStatus: () =>
							operation.pipe(Effect.as(true), Effect.provide(sqlContext)),
					})
				}),
			)
			const running = runtime.runPromise(
				Effect.flatMap(Barrier.Barrier, (barrier) =>
					retry
						? barrier.revocationStatus({
								accountId: "alice",
								credentialDigest: "test",
								retry: true,
							})
						: barrier
								.revokeSession({
									accountId: "alice",
									credentialDigest: "test",
									headers: new Headers(),
								})
								.pipe(Effect.as(true)),
				),
			)
			try {
				await entered.promise
				await runtime.runPromise(
					Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.quiesce),
				)
				assert.equal(
					await runtime
						.runPromise(
							Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.status),
						)
						.then((s) => s.activeTasks),
					1,
				)
				finish.release()
				await running
				assert.equal(
					await runtime
						.runPromise(
							Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.status),
						)
						.then((s) => s.activeTasks),
					0,
				)
				await runtime.runPromise(
					Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.resume),
				)
			} finally {
				finish.release()
			}
		}
		const rows = await runtime.runPromise(
			Effect.flatMap(
				PgClient.PgClient,
				(sql) => sql`SELECT id FROM maintenance_revocations ORDER BY id`,
			),
		)
		assert.deepEqual(rows, [{ id: 1 }, { id: 2 }])
	} finally {
		await runtime.dispose()
		await database.close()
		network.mock.restore()
	}
})

test("restarted maintenance scan blocks durable unknown operations and unfinished developer cleanup", async (t) => {
	const network = authority(t)
	const database = await Postgres.start()
	const layer = Database.layer({
		databaseUrl: Redacted.make(database.url),
	}).pipe(Layer.provide(NodeServices.layer))
	let runtime = ManagedRuntime.make(layer)
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* Database.migrate
				const sql = yield* PgClient.PgClient
				const owner = JSON.stringify(["tenant", "account"])
				yield* sql`INSERT INTO openbot_app_invocations (owner,id,session,status,body) VALUES (${owner},'unknown','session','OutcomeUnknown','{}')`
				yield* sql`INSERT INTO openbot_developer_records (kind,id,owner,scope,body) VALUES ('public:test','cleanup',${owner},'',${JSON.stringify({ value: { status: "Succeeded", cleanup: "Pending" }, cleanupLeaseUntil: 0 })})`
				assert.equal(yield* Stored.pending(options), 2)
			}),
		)
		await runtime.dispose()
		runtime = ManagedRuntime.make(layer)
		assert.equal(
			await runtime.runPromise(Stored.pending(options)),
			2,
			"restart does not erase durable unfinished work",
		)
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				yield* sql`UPDATE openbot_app_invocations SET status='Completed'`
				yield* sql`UPDATE openbot_developer_records SET body=${JSON.stringify({ value: { status: "Succeeded", cleanup: "Complete" }, cleanupLeaseUntil: 0 })}`
				assert.equal(yield* Stored.pending(options), 0)
			}),
		)
	} finally {
		await runtime.dispose()
		await database.close()
		network.mock.restore()
	}
})
