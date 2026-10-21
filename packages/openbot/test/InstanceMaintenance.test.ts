// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { setTimeout } from "node:timers/promises"
import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Network } from "@openbot-build/protocol"
import { AppExecution } from "@openbot-build/api"
import { SessionStoreRepository, Store, Turn } from "@openbot-build/core"
import { Effect, Fiber, Layer, ManagedRuntime, Redacted } from "effect"
import * as InstanceWork from "../src/execution/InstanceWork.ts"
import * as Fence from "../src/execution/ExecutionFence.ts"
import * as Barrier from "../src/auth/Barrier.ts"
import * as Stored from "../src/execution/StoredExecutions.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as IndexWork from "../src/apps/IndexWork.ts"
import { IndexNamespace } from "../src/apps/IndexNamespace.ts"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as BrowserHost from "./BrowserHost.ts"
import * as AppFixture from "./AppFixture.ts"
import * as Postgres from "./PostgresTest.ts"
import * as StoredSessions from "../src/sessions/StoredSessions.ts"
import * as StoredInvocations from "../src/apps/StoredInvocations.ts"

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
								fence.guard(
									"nested-account",
									"write",
									Effect.gen(function* () {
										yield* Effect.sync(childEntered.release)
										yield* Effect.promise(() => childFinish.promise)
										return "committed"
									}),
								),
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
				Effect.gen(function* () {
					return yield* IndexWork.enqueue(
						yield* makeWithDefaults(),
						yield* IndexNamespace,
						cardUrl,
						[],
					)
				}),
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
				Effect.gen(function* () {
					return yield* IndexWork.enqueue(
						yield* makeWithDefaults(),
						yield* IndexNamespace,
						cardUrl,
						[],
					)
				}),
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

test("queued work reserves its count before pause and releases after its consumer finishes", async () => {
	const runtime = ManagedRuntime.make(InstanceWork.layer)
	try {
		const reserved = await runtime.runPromise(InstanceWork.reserve)
		await runtime.runPromise(
			Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.quiesce),
		)
		assert.equal(
			(
				await runtime.runPromise(
					Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.status),
				)
			).activeTasks,
			1,
		)
		assert.equal(
			(await runtime.runPromise(Effect.flip(InstanceWork.reserve)))._tag,
			"InstancePaused",
		)
		assert.equal(
			await runtime.runPromise(
				reserved.run(InstanceWork.wrap(Effect.succeed("finished"))),
			),
			"finished",
		)
		assert.equal(
			(
				await runtime.runPromise(
					Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.status),
				)
			).activeTasks,
			0,
		)
		assert.equal(
			(await runtime.runPromise(Effect.flip(reserved.run(Effect.void))))._tag,
			"InstancePaused",
		)
		await runtime.runPromise(reserved.release)
		await runtime.runPromise(
			Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.resume),
		)
		const failed = await runtime.runPromise(InstanceWork.reserve)
		assert.equal(
			await runtime.runPromise(Effect.flip(failed.run(Effect.fail("failed")))),
			"failed",
		)
		assert.equal(
			(
				await runtime.runPromise(
					Effect.flatMap(InstanceWork.InstanceWork, (gate) => gate.status),
				)
			).activeTasks,
			0,
		)
	} finally {
		await runtime.dispose()
	}
})

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
	const layer = Layer.merge(
		Database.layer({
			databaseUrl: Redacted.make(database.url),
		}),
		Secrets.layer(Redacted.make("test:" + "11".repeat(32))),
	).pipe(Layer.provide(NodeServices.layer))
	let runtime = ManagedRuntime.make(layer)
	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* Database.migrate
				const sql = yield* PgClient.PgClient
				const owner = JSON.stringify(["tenant", "account"])
				yield* sql`INSERT INTO openbot_app_invocations (owner,id,session,status,body) VALUES (${owner},'unknown','session','OutcomeUnknown','{}')`
				yield* sql`INSERT INTO openbot_developer_tests (namespace,id,owner,card_url,status,cleanup,expires_at,value) VALUES ('public','cleanup',${owner},'https://example.test/card','Succeeded','Pending',0,'{}')`
				yield* sql`INSERT INTO openbot_agent_records (kind,organization_id,id,owner,scope,status,body) VALUES ('delegation','tenant','delegation','account','','authorizing',${JSON.stringify({ userId: "account" })}), ('request','tenant','approval','agent:approver','','pending',${JSON.stringify({ chain: { organizationId: "tenant", userId: "account" } })}), ('delegation','tenant','other','other-account','','queued',${JSON.stringify({ userId: "other-account" })})`
				assert.equal(yield* Stored.pending(options), 5)
				assert.equal(yield* Stored.forNamespace(owner), 4)
				assert.equal(
					yield* Stored.forNamespace(
						JSON.stringify(["tenant", "other-account"]),
					),
					1,
				)
				assert.equal(
					yield* Stored.forNamespace(
						JSON.stringify(["other-tenant", "account"]),
					),
					0,
				)
			}),
		)
		await runtime.dispose()
		runtime = ManagedRuntime.make(layer)
		assert.equal(
			await runtime.runPromise(Stored.pending(options)),
			5,
			"restart does not erase durable unfinished work",
		)
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* PgClient.PgClient
				yield* sql`UPDATE openbot_app_invocations SET status='Completed'`
				yield* sql`UPDATE openbot_developer_tests SET cleanup='Complete' `
				yield* sql`UPDATE openbot_agent_records SET status=CASE WHEN kind='request' THEN 'allowed' ELSE 'completed' END`
				assert.equal(
					yield* Stored.pending(options),
					3,
					"decisions and completed delegations wait until their parent call resumes",
				)
				yield* sql`UPDATE openbot_agent_records SET status='resolved' WHERE kind='request'`
				assert.equal(yield* Stored.pending(options), 2)
				yield* sql`UPDATE openbot_agent_records SET status='resolved' WHERE kind='delegation'`
				assert.equal(yield* Stored.pending(options), 0)
			}),
		)
	} finally {
		await runtime.dispose()
		await database.close()
		network.mock.restore()
	}
})

test("drain reads encrypted proposals against the current Turn and never discards unknown outcomes", async () => {
	const database = await Postgres.start()
	const runtime = ManagedRuntime.make(
		Layer.merge(
			Database.layer({ databaseUrl: Redacted.make(database.url) }),
			Secrets.layer(Redacted.make("test:" + "11".repeat(32))),
		).pipe(Layer.provide(NodeServices.layer)),
	)
	try {
		await runtime.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					yield* Database.migrate
					const sql = yield* PgClient.PgClient
					const db = yield* makeWithDefaults()
					const secrets = yield* Secrets.Secrets
					const owner = JSON.stringify(["tenant", "account"])
					const definition = yield* Store.define({
						stores: {},
						schemaVersion: "timeline/1",
					})
					const store = yield* SessionStoreRepository.make({
						definition,
						persistence: StoredSessions.persistence(db, owner),
					})
					const initial = yield* store.create({ metadata: {} })
					const turn: Turn.Record = {
						id: Turn.Id.make("turn-history"),
						session: initial.session.id,
						settings: { mode: "default" },
						status: {
							_tag: "Completed",
							result: { text: "done", finishReason: "stop" },
						},
						steps: 1,
						input: [],
						items: [],
						start: initial.session.head,
						startedAt: 0,
						completedAt: 1,
					}
					const ref = { ...initial.session, turns: [turn] }
					yield* sql`UPDATE openbot_session_references SET body=${JSON.stringify(ref)} WHERE namespace=${owner}`
					const source: AppExecution.Source = {
						connectionId: "connection",
						connectionName: "Test",
						cardUrl: "https://example.test/card",
						appName: "Test",
						remoteIndex: 0,
						revision: 0,
						kind: "tool",
						name: "write",
					}
					for (const status of ["PendingApproval", "Approved"] as const) {
						const operation: AppExecution.Invocation = {
							id: status,
							session: ref.id,
							turn: turn.id,
							callId: "call",
							toolName: "write",
							source,
							arguments: {},
							readOnly: false,
							grantReads: false,
							round: 0,
							status,
							result: null,
						}
						const body = yield* StoredInvocations.seal(
							secrets,
							owner,
							operation,
						)
						yield* sql`INSERT INTO openbot_app_invocations (owner,id,session,status,body) VALUES (${owner},${status},${ref.id},${status},${body})`
					}
					assert.equal(
						yield* Stored.forNamespace(owner),
						0,
						"terminal Turn proposals remain history",
					)
					yield* sql`UPDATE openbot_session_references SET body=${JSON.stringify(initial.session)} WHERE namespace=${owner}`
					assert.equal(
						yield* Stored.forNamespace(owner),
						2,
						"missing originating Turns are not proof of a terminal proposal",
					)
					yield* sql`UPDATE openbot_session_references SET body=${JSON.stringify(ref)} WHERE namespace=${owner}`
					yield* sql`UPDATE openbot_app_invocations SET status='Approved' WHERE id='PendingApproval'`
					assert.equal(
						yield* Stored.forNamespace(owner),
						1,
						"the index and encrypted proposal must agree",
					)
					yield* sql`UPDATE openbot_app_invocations SET status='PendingApproval' WHERE id='PendingApproval'`
					yield* sql`UPDATE openbot_session_references SET body=${JSON.stringify({ ...ref, turns: [{ ...turn, status: { _tag: "Waiting", result: { text: "", finishReason: "tool-calls" } } }] })} WHERE namespace=${owner}`
					assert.equal(
						yield* Stored.forNamespace(owner),
						3,
						"the waiting Turn and both exact-Turn proposals block",
					)
					yield* sql`UPDATE openbot_session_references SET body=${JSON.stringify(ref)} WHERE namespace=${owner}`
					yield* sql`UPDATE openbot_app_invocations SET status='Sending' WHERE id='Approved'`
					assert.equal(yield* Stored.forNamespace(owner), 1)
					yield* sql`UPDATE openbot_app_invocations SET status='OutcomeUnknown' WHERE id='Approved'`
					assert.equal(yield* Stored.forNamespace(owner), 1)
					assert.deepEqual(
						(yield* sql<{
							status: string
						}>`SELECT status FROM openbot_app_invocations ORDER BY id`).map(
							(row) => row.status,
						),
						["OutcomeUnknown", "PendingApproval"],
						"scanning does not mutate or resend old proposals",
					)
				}),
			),
		)
	} finally {
		await runtime.dispose()
		await database.close()
	}
})

test("drain retains waiting authorizations until expiry without a saved callback", async (t) => {
	const database = await Postgres.start()
	const layer = Layer.merge(
		Database.layer({ databaseUrl: Redacted.make(database.url) }),
		Secrets.layer(Redacted.make("test:" + "11".repeat(32))),
	).pipe(Layer.provide(NodeServices.layer))
	let runtime = ManagedRuntime.make(layer)
	const owner = JSON.stringify(["organization", "waiting-account"])
	try {
		await runtime.runPromise(Database.migrate)
		for (const sample of [
			{
				name: "unexpired Waiting",
				status: "Waiting",
				offset: 60000,
				callback: null,
				count: 1,
			},
			{
				name: "expired Waiting without callback",
				status: "Waiting",
				offset: -60000,
				callback: null,
				count: 0,
			},
			{
				name: "expired Waiting with callback",
				status: "Waiting",
				offset: -60000,
				callback: "saved-callback",
				count: 1,
			},
			{
				name: "unknown status",
				status: "Expired",
				offset: -60000,
				callback: null,
				count: 1,
			},
		]) {
			await t.test(sample.name, async () => {
				await runtime.runPromise(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient
						yield* sql`DELETE FROM openbot_app_authorizations`
						yield* sql`INSERT INTO openbot_app_authorizations
					 (id,owner,connection_id,revision,expires_at,return_to,status,callback,issuer,resource,scopes)
					 VALUES ('waiting-flow',${owner},'connection',0,
					 floor(extract(epoch FROM clock_timestamp())*1000)+${sample.offset},
					 '{}',${sample.status},${sample.callback},'https://issuer.test','resource','[]')`
						assert.equal(yield* Stored.forNamespace(owner), sample.count)
						assert.equal(yield* Stored.pending(), sample.count)
						assert.equal(
							yield* Stored.forNamespace(
								JSON.stringify(["organization", "other-account"]),
							),
							0,
						)
					}),
				)
				await runtime.dispose()
				runtime = ManagedRuntime.make(layer)
				assert.equal(
					await runtime.runPromise(Stored.forNamespace(owner)),
					sample.count,
					"restart must preserve the same durable blocker",
				)
			})
		}
	} finally {
		await runtime.dispose()
		await database.close()
	}
})
