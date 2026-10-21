// @effect-diagnostics strictEffectProvide:off
import assert from "node:assert/strict"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Network, Store } from "@openbot-build/protocol"
import {
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Redacted,
	Scope,
	Schema,
	Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import { HttpClientRequest } from "effect/http"
import * as Fence from "../src/execution/ExecutionFence.ts"
import * as AccountNetwork from "../src/execution/AccountNetwork.ts"
import * as OwnedWrites from "../src/execution/OwnedWrites.ts"
import * as ProtocolStores from "../src/apps/ProtocolStores.ts"
import * as Repository from "../src/apps/RepositoryPostgres.ts"
import * as Developer from "../src/apps/DeveloperRepositoryPostgres.ts"
import { DeveloperRepository } from "../src/apps/DeveloperRepository.ts"
import * as Invocations from "../src/apps/InvocationRepositoryPostgres.ts"
import { InvocationRepository } from "../src/apps/InvocationRepository.ts"
import * as Secrets from "../src/apps/Secrets.ts"
import * as Database from "../src/database/DatabasePostgres.ts"
import * as Postgres from "./PostgresTest.ts"
import * as AgentRecords from "../src/agents/AgentRecords.ts"
import * as Agents from "../src/agents/Agents.ts"

test("account persistence, background recovery and MCP sends retain routing leases", async (t) => {
	const database = await Postgres.start()
	const owner = JSON.stringify(["org", "alice"])
	const bob = JSON.stringify(["org", "bob"])
	let phase = "ACTIVE",
		epoch = 1,
		serial = 0,
		sends = 0
	const leases = new Map<string, { accountId: string; intent: string }>()
	t.mock.method(
		globalThis,
		"fetch",
		async (url: URL | RequestInfo, init?: RequestInit) => {
			const path = new URL(String(url)).pathname.split("/").at(-1)
			const body = JSON.parse(String(init?.body))
			if (path === "release") {
				leases.delete(body.leaseId)
				return Response.json({ released: true })
			}
			const allowed =
				body.accountId !== "bob" &&
				(phase === "ACTIVE" ||
					(phase === "DRAINING" &&
						path !== "resolve" &&
						body.intent !== "admit")) &&
				(body.epoch === undefined || body.epoch === epoch)
			const leaseId = String(++serial)
			if (allowed && path === "acquire") leases.set(leaseId, body)
			return Response.json({ allowed, epoch, phase, leaseId })
		},
	)
	const transport = Layer.succeed(
		Network.Network,
		Network.Network.of({
			identity: { scope: "user", owner },
			execute: (request) =>
				Effect.sync(() => {
					sends++
					return {
						url: request.url,
						status: 200,
						headers: {},
						body: Stream.make(new Uint8Array([1])),
					}
				}),
			readDocument: (input) =>
				Effect.sync(() => {
					sends++
					return { url: input.url, status: 200, headers: {}, text: "ok" }
				}),
		}),
	)
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			ProtocolStores.layer.pipe(Layer.provideMerge(Repository.layer)),
			Developer.layer,
			Invocations.layer,
			AccountNetwork.layer(owner, transport),
			Fence.layer({
				origin: "http://authority.test",
				token: Redacted.make("test-only"),
				backend: "openbot",
			}),
		).pipe(
			Layer.provide(Secrets.layer(Redacted.make("11".repeat(32)))),
			Layer.provideMerge(
				Database.layer({ databaseUrl: Redacted.make(database.url) }),
			),
			Layer.provide(NodeServices.layer),
		),
	)
	const lease: Fence.Lease = {
		accountId: "alice",
		backend: "openbot",
		epoch: 1,
		leaseId: "request",
		intent: "admit",
	}
	const admitted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.provideService(Fence.CurrentExecution, lease))
	try {
		await runtime.runPromise(Database.migrate)
		const credential = await Effect.runPromise(
			Store.Credential.decode({
				binding: {
					owner,
					connectionId: "docs",
					resource: "https://example.test/mcp",
					issuer: "https://auth.test",
				},
				clientId: "client",
				accessToken: Redacted.make("initial"),
				scopes: [],
			}),
		)
		let reference = await runtime.runPromise(
			admitted(
				Effect.flatMap(ProtocolStores.ProtocolStores, (stores) =>
					stores.bind(owner).credentials.put(credential),
				),
			),
		)
		phase = "DRAINING"
		reference = await runtime.runPromise(
			admitted(
				Effect.flatMap(ProtocolStores.ProtocolStores, (stores) =>
					stores.bind(owner).credentials.put({
						...credential,
						accessToken: Redacted.make("drained"),
					}),
				),
			),
		)
		phase = "FROZEN"
		epoch = 2
		await assert.rejects(
			runtime.runPromise(
				admitted(
					Effect.flatMap(ProtocolStores.ProtocolStores, (stores) =>
						stores.bind(owner).credentials.put({
							...credential,
							accessToken: Redacted.make("bad"),
						}),
					),
				),
			),
		)
		const persisted = await runtime.runPromise(
			Effect.flatMap(ProtocolStores.ProtocolStores, (stores) =>
				stores
					.bind(owner)
					.credentials.get({ binding: credential.binding, reference }),
			),
		)
		assert.equal(Redacted.value(persisted.accessToken), "drained")
		await assert.rejects(
			runtime.runPromise(
				admitted(
					Effect.scoped(
						Effect.flatMap(Network.Network, (network) =>
							network.execute(
								HttpClientRequest.get("https://example.test/mcp"),
							),
						),
					),
				),
			),
		)
		assert.equal(sends, 0)
		phase = "ACTIVE"
		epoch = 1
		const scope = await Effect.runPromise(Scope.make())
		await runtime.runPromise(
			admitted(
				Effect.flatMap(Network.Network, (network) =>
					network.execute(HttpClientRequest.get("https://example.test/mcp")),
				),
			).pipe(Effect.provideService(Scope.Scope, scope)),
		)
		assert.equal(sends, 1)
		assert.equal(leases.size, 1)
		await Effect.runPromise(Scope.close(scope, Exit.void))
		assert.equal(leases.size, 0)
		let writes = 0
		await assert.rejects(
			runtime.runPromise(
				admitted(
					OwnedWrites.sessionWrite(
						"other",
						Effect.sync(() => {
							writes++
						}),
					),
				).pipe(
					Effect.provideService(Fence.CurrentSessionOwner, {
						namespace: "tenant",
						accountId: "alice",
					}),
				),
			),
		)
		await runtime.runPromise(
			admitted(
				OwnedWrites.sessionWrite(
					"tenant",
					Effect.sync(() => {
						writes++
					}),
				),
			).pipe(
				Effect.provideService(Fence.CurrentSessionOwner, {
					namespace: "tenant",
					accountId: "alice",
				}),
			),
		)
		assert.equal(writes, 1)
		await runtime.runPromise(
			Effect.gen(function* () {
				const records = yield* DeveloperRepository
				yield* records.transaction(
					"test",
					Effect.gen(function* () {
						yield* records.secrets.put("secret", owner, "scope", {
							owner,
							body: "opaque",
						})
						assert.ok(
							leases.size > 0,
							"background account lease must remain until commit",
						)
						yield* records.transaction(
							"nested",
							records.secrets.put("secret", owner, "scope", {
								owner,
								body: "updated",
							}),
						)
						assert.ok(
							leases.size > 0,
							"nested transaction must not release outer leases",
						)
					}),
				)
				assert.equal(leases.size, 0)
				assert.equal((yield* records.secrets.get("secret")).body, "updated")
				const otherOwner = JSON.stringify(["org", "charlie"])
				yield* admitted(
					records.transaction(
						"cross-account",
						Effect.gen(function* () {
							yield* records.secrets.put("shared", otherOwner, "scope", {
								owner: otherOwner,
								body: "cross-account",
							})
							assert.ok(
								[...leases.values()].some(
									(value) => value.accountId === "charlie",
								),
								"target account lease must span the caller's transaction",
							)
						}),
					),
				)
				assert.equal(leases.size, 0)
				yield* records.secrets
					.put("secret", otherOwner, "scope", {
						owner: otherOwner,
						body: "stolen",
					})
					.pipe(Effect.flip)
				assert.equal((yield* records.secrets.get("secret")).owner, owner)

				yield* records.secrets
					.put("blocked", bob, "scope", { owner: bob, body: "bad" })
					.pipe(Effect.flip)
				const sql = yield* SqlClient.SqlClient
				assert.equal(
					(yield* sql`SELECT id FROM openbot_developer_records WHERE id = 'blocked'`)
						.length,
					0,
				)
				yield* sql`INSERT INTO openbot_app_invocations (owner,id,session,status,body) VALUES (${owner},'allowed','session','Sending','opaque'),(${bob},'blocked','session','Sending','opaque')`
				yield* (yield* InvocationRepository).recover
				const rows = yield* sql<{
					id: string
					status: string
				}>`SELECT id,status FROM openbot_app_invocations ORDER BY id`
				assert.deepEqual(
					rows.map((row) => [row.id, row.status]),
					[
						["allowed", "OutcomeUnknown"],
						["blocked", "Sending"],
					],
				)
			}),
		)
	} finally {
		await runtime.dispose()
		await database.close()
	}
})

test("Agent records and lazy Main creation keep owner and epoch leases through rollback", async (t) => {
	const database = await Postgres.start()
	let phase = "OPENBOT_ACTIVE",
		epoch = 1,
		serial = 0,
		admits = 0
	const leases = new Map<string, { accountId: string; intent: string }>()
	const actualFetch = globalThis.fetch
	t.mock.method(
		globalThis,
		"fetch",
		async (input: URL | RequestInfo, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			if (url.origin !== "http://agent-authority.test")
				return actualFetch(input, init)
			const body = JSON.parse(String(init?.body))
			if (url.pathname.endsWith("/release")) {
				leases.delete(body.leaseId)
				return Response.json({ released: true })
			}
			if (url.pathname.endsWith("/resolve")) admits++
			const allowed =
				phase === "OPENBOT_ACTIVE" &&
				(body.epoch === undefined || body.epoch === epoch)
			const leaseId = String(++serial)
			if (allowed && url.pathname.endsWith("/acquire"))
				leases.set(leaseId, body)
			return Response.json({ allowed, epoch, phase, leaseId })
		},
	)
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			Agents.layer.pipe(Layer.provideMerge(AgentRecords.layer)),
			Fence.layer({
				origin: "http://agent-authority.test",
				token: Redacted.make("test-only"),
				backend: "openbot",
			}),
		).pipe(
			Layer.provideMerge(
				Database.layer({ databaseUrl: Redacted.make(database.url) }),
			),
			Layer.provide(NodeServices.layer),
		),
	)
	const alice = { organizationId: "org", userId: "alice" }
	const captured: Fence.Lease = {
		accountId: "alice",
		backend: "openbot",
		epoch: 1,
		leaseId: "captured",
		intent: "admit",
	}
	const admitted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.provideService(Fence.CurrentExecution, captured))
	try {
		await runtime.runPromise(Database.migrate)
		const mains = await Promise.all(
			[1, 2].map(() =>
				runtime.runPromise(
					Effect.flatMap(Agents.Agents, (agents) => agents.ensureMain(alice)),
				),
			),
		)
		assert.equal(mains[0]?.id, mains[1]?.id)
		assert.equal(leases.size, 0)
		phase = "FROZEN"
		epoch = 2
		const before = admits
		assert.equal(
			(
				await runtime.runPromise(
					Effect.flatMap(Agents.Agents, (agents) => agents.ensureMain(alice)),
				)
			).id,
			mains[0]?.id,
		)
		assert.equal(
			admits,
			before,
			"an existing Main needs no new execution admission",
		)
		await assert.rejects(
			runtime.runPromise(
				Effect.flatMap(Agents.Agents, (agents) =>
					agents.ensureMain({ organizationId: "org", userId: "bob" }),
				),
			),
		)
		phase = "OPENBOT_ACTIVE"
		await assert.rejects(
			runtime.runPromise(
				admitted(
					Effect.flatMap(AgentRecords.AgentRecords, (records) =>
						records
							.collection("agent", Schema.Struct({ value: Schema.String }))
							.put(
								{
									organizationId: "org",
									id: "stale",
									owner: "alice",
									scope: "",
									status: "test",
								},
								{ value: "stale" },
							),
					),
				),
			),
		)
		epoch = 1
		await runtime.runPromise(
			admitted(
				Effect.gen(function* () {
					const records = yield* AgentRecords.AgentRecords
					const agents = records.collection(
						"agent",
						Schema.Struct({ value: Schema.String }),
					)
					const keys = {
						organizationId: "org",
						id: "temporary",
						owner: "alice",
						scope: "",
						status: "test",
					}
					const rolledBack = yield* records
						.transaction(
							"rollback",
							Effect.gen(function* () {
								yield* agents.put(keys, { value: "temporary" })
								assert.ok(
									[...leases.values()].some(
										(lease) =>
											lease.accountId === "alice" && lease.intent === "write",
									),
								)
								return yield* Effect.fail("rollback")
							}),
						)
						.pipe(Effect.flip)
					assert.equal(rolledBack, "rollback")
					assert.equal(leases.size, 0)
					assert.equal((yield* agents.find("org", "temporary"))._tag, "None")
					const sql = yield* SqlClient.SqlClient
					yield* sql`INSERT INTO openbot_agent_records (kind,organization_id,id,owner,scope,status,body) VALUES ('agent','org','bob-record','bob','','test','{"value":"original"}')`
					yield* agents
						.put(
							{ ...keys, id: "new-bob", owner: "bob" },
							{ value: "wrong owner" },
						)
						.pipe(Effect.flip)
					yield* agents
						.put({ ...keys, id: "bob-record" }, { value: "stolen" })
						.pipe(Effect.flip)
					yield* agents.remove("org", "bob-record").pipe(Effect.flip)
					assert.deepEqual(
						yield* sql`SELECT owner,body FROM openbot_agent_records WHERE id='bob-record'`,
						[{ owner: "bob", body: '{"value":"original"}' }],
					)
					assert.equal(
						(yield* sql`SELECT id FROM openbot_agent_records WHERE id IN ('stale','new-bob','temporary')`)
							.length,
						0,
					)
				}),
			),
		)
		assert.equal(leases.size, 0)
	} finally {
		await runtime.dispose()
		await database.close()
	}
})
