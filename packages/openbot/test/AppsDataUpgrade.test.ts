import { NodeServices } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { assert, it } from "@effect/vitest"
import { Execution } from "@openbot-build/domain"
import * as TestCleanup from "../src/apps/TestCleanup.ts"
import {
	Array as Arr,
	Effect,
	Layer,
	Redacted,
	Schema,
	String as Str,
} from "effect"
import * as DatabasePostgres from "../src/database/DatabasePostgres.ts"
import * as Migrations from "../src/database/Migrations.ts"
import * as Apps from "../src/database/conversion/Apps.ts"
import * as Imported from "../src/database/conversion/Executions.ts"
import * as Legacy from "../src/database/conversion/LegacyApps.ts"
import * as Progress from "../src/database/conversion/Progress.ts"
import * as Store from "../src/execution/Store.ts"
import * as Secrets from "../src/secrets/Secrets.ts"
import * as PostgresTest from "./PostgresTest.ts"

const owner = '["org","person"]'
const json = Schema.fromJsonString(Schema.Json)
const encode = Schema.encodeEffect(json)
const database = () =>
	Store.layer.pipe(
		Layer.provideMerge(
			Layer.unwrap(
				Effect.map(PostgresTest.start, (database) =>
					Layer.merge(
						DatabasePostgres.layer({
							databaseUrl: Redacted.make(database.url),
						}),
						Secrets.layer(Redacted.make("test:" + Str.repeat(32)("11"))),
					),
				),
			),
		),
		Layer.provideMerge(NodeServices.layer),
	)
const source = {
	connectionId: "connection",
	connectionName: "Saved App",
	cardUrl: "https://example.test/card",
	appName: "Saved App",
	remoteIndex: 0,
	revision: 1,
	kind: "tool" as const,
	name: "write",
}
const invocation = (id: string): Legacy.Invocation => ({
	id,
	chat: "chat",
	turn: "turn",
	callId: "tool-call",
	toolName: "apps.saved.write",
	source,
	arguments: { text: "private input" },
	readOnly: false,
	round: 0,
	status: "Sending",
	result: null,
})
const fixture = Effect.gen(function* () {
	const secrets = yield* Secrets.Secrets
	const sql = yield* PgClient.PgClient
	const seal = (value: Schema.Json, binding: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			return yield* secrets.seal(yield* encode(value), yield* encode(binding))
		})
	const addInvocation = (value: Legacy.Invocation) =>
		Effect.gen(function* () {
			yield* sql`insert into openbot_app_invocations ${sql.insert({ owner, id: value.id, chat: value.chat, status: value.status, body: yield* seal(value, ["app-invocation", owner, value.id]) })}`
		})
	return { seal, addInvocation }
})

it.layer(database(), { excludeTestServices: true })((it) => {
	it.effect(
		"The App data move keeps saved views and checks their sealed action keys",
		() =>
			Effect.gen(function* () {
				yield* Migrations.initialize
				const sql = yield* PgClient.PgClient
				const saved = yield* fixture
				const actionId = yield* encode(["view", "request"])
				const values: ReadonlyArray<{
					kind: string
					id: string
					value: Schema.Json
				}> = [
					{
						kind: "app-view",
						id: "view",
						value: {
							id: "view",
							operationId: "call",
							readOnly: true,
							chat: "chat",
							turn: "turn",
							item: "item",
							connectionId: "connection",
							revision: 2,
							expiresAt: 123,
						},
					},
					{
						kind: "app-view-action",
						id: actionId,
						value: {
							requestId: "request",
							kind: "tool",
							target: "read",
							arguments: { note: "private note" },
							ticket: {
								chat: "chat",
								turn: "turn",
								item: "item",
								callId: "call",
								revision: 2,
							},
						},
					},
					{
						kind: "app-ui-state",
						id: yield* encode(["chat", "call"]),
						value: { revision: 3, context: { note: "private context" } },
					},
				]
				const rows = yield* Effect.forEach(values, (value) =>
					Effect.gen(function* () {
						const row = {
							owner,
							kind: value.kind,
							id: value.id,
							connection_id: "connection",
							body: yield* saved.seal(value.value, [
								value.kind,
								owner,
								value.id,
							]),
						}
						yield* sql`insert into openbot_app_secrets ${sql.insert(row)}`
						return row
					}),
				)
				yield* Apps.run
				yield* Apps.check
				yield* Apps.verify
				assert.sameDeepMembers(
					Arr.fromIterable(
						yield* sql`select owner, kind, id, connection_id, body from openbot_app_secrets`,
					),
					rows,
				)
				const changed = yield* saved.seal(
					{
						requestId: "other",
						kind: "tool",
						target: "read",
						arguments: {},
						ticket: null,
					},
					["app-view-action", owner, actionId],
				)
				yield* sql`update openbot_app_secrets set body = ${changed} where kind = 'app-view-action'`
				assert.isTrue(
					Schema.is(Progress.InvalidRecord)(
						yield* Apps.verify.pipe(Effect.flip),
					),
				)
				yield* sql`update openbot_data_upgrade_steps set rows = rows + 1 where step = 'apps:secrets'`
				assert.isTrue(
					Schema.is(Apps.InvalidAppRecord)(yield* Apps.check.pipe(Effect.flip)),
				)
			}),
	)
})

it.layer(database(), { excludeTestServices: true })((it) => {
	it.effect(
		"App and Code Mode history resumes after a broken batch without a new outside call",
		() =>
			Effect.gen(function* () {
				yield* Migrations.initialize
				const sql = yield* PgClient.PgClient
				const store = yield* Store.Store
				const saved = yield* fixture
				yield* saved.addInvocation(invocation("a"))
				yield* sql`insert into openbot_app_invocations ${sql.insert({ owner, id: "b", chat: "chat", status: "PendingApproval", body: "broken secret" })}`
				const move = yield* Apps.make
				const failure = yield* move.run(1).pipe(Effect.flip)
				assert.isTrue(Schema.is(Progress.InvalidRecord)(failure))
				const [first] = yield* sql<{
					id: string
					input: string
					status: string
					principal_kind: string
				}>`select id, input, status, principal_kind from openbot_executions where resource_kind = 'AppCall'`
				assert.strictEqual(first?.status, "outcome_unknown")
				assert.strictEqual(first?.principal_kind, "service")
				assert.notInclude(first?.input ?? "", "private input")
				const [cursor] = yield* sql<{
					rows: string
					complete: boolean
				}>`select rows, complete from openbot_data_upgrade_steps where step = 'apps:invocations'`
				assert.strictEqual(Number(cursor?.rows), 1)
				assert.isFalse(cursor?.complete)
				const pending = {
					...invocation("b"),
					status: "PendingApproval" as const,
				}
				yield* sql`update openbot_app_invocations set body = ${yield* saved.seal(pending, ["app-invocation", owner, "b"])} where id = 'b'`
				yield* saved.addInvocation({
					...invocation("c"),
					status: "Completed",
					result: {
						_tag: "Completed",
						operationId: "c",
						source,
						result: { note: "private result" },
					},
				})
				yield* saved.addInvocation({ ...invocation("d"), readOnly: true })
				const requested = {
					...invocation("e"),
					round: 1,
					result: {
						_tag: "InputRequired" as const,
						source,
						request: { text: "Choose a note." },
						operationId: "e",
					},
				}
				yield* saved.addInvocation(requested)
				yield* saved.addInvocation({
					...invocation("f"),
					status: "OutcomeUnknown",
					result: {
						_tag: "Failed",
						source,
						operationId: "f",
						reason: "OutcomeUnknown",
						message: "The result is not known.",
					},
				})
				yield* saved.addInvocation({
					...requested,
					id: "g",
					status: "InputRequired",
					result: { ...requested.result, operationId: "g" },
				})
				const run = {
					id: "program",
					chat: "chat",
					turn: "turn",
					callId: "tool-call",
					status: "Running",
					code: "await apps.saved.write({ text: 'private input' })",
					reason: "Save the note.",
					calls: [
						{
							index: 0,
							binding: "apps.saved.write",
							source,
							operationId: "a",
							argumentsHash: "saved-hash",
							outcome: { _tag: "Waiting" },
						},
					],
					result: null,
					createdAt: 7,
					updatedAt: 9,
					seed: 42,
					clock: 7,
					organizationId: "org",
					userId: "person",
				} satisfies Schema.Json
				yield* sql`insert into openbot_code_runs ${sql.insert({ owner, id: "program", chat: "chat", call_id: "tool-call", status: "Running", lease_until: 99, body: yield* saved.seal(run, ["code-run", owner, "program"]) })}`
				yield* move.run(1)
				yield* move.run(1)
				const records = yield* sql<{
					namespace: string
					id: string
					resource_kind: string
					resource_id: string
					status: string
				}>`select namespace, id, resource_kind, resource_id, status from openbot_executions order by resource_kind, resource_id`
				assert.strictEqual(records.length, 8)
				assert.deepStrictEqual(
					Arr.map(records, (row) => [row.resource_id, row.status]),
					[
						["a", "outcome_unknown"],
						["b", "interrupted"],
						["c", "completed"],
						["d", "interrupted"],
						["e", "outcome_unknown"],
						["f", "outcome_unknown"],
						["g", "interrupted"],
						["program", "outcome_unknown"],
					],
				)
				for (const row of records) {
					const key = {
						namespace: row.namespace,
						id: yield* Schema.decodeEffect(Execution.Id)(row.id),
					}
					const imported = yield* store.loadService(key, Imported.serviceId)
					const input = yield* Schema.decodeUnknownEffect(Imported.Input)(
						imported.input,
					)
					assert.strictEqual(input.authority._tag, "NeedsAuthorization")
					assert.isFalse("caller" in input.authority)
					if (row.resource_id === "c") {
						const history = yield* Schema.decodeUnknownEffect(Apps.AppHistory)(
							input.history,
						)
						assert.strictEqual(history.invocation.result?._tag, "Completed")
						assert.strictEqual(
							(yield* store.calls(key))[0]?.status,
							"completed",
						)
					}
					if (row.resource_kind === "CodeRun") {
						const history = yield* Schema.decodeUnknownEffect(Apps.CodeHistory)(
							input.history,
						)
						assert.strictEqual(history.run.seed, 42)
						assert.strictEqual(history.run.clock, 7)
						assert.strictEqual(history.run.calls[0]?.operationId, "a")
						assert.strictEqual(
							(yield* store.calls(key))[0]?.status,
							"outcome_unknown",
						)
					}
					if (
						row.resource_id === "e" ||
						row.resource_id === "f" ||
						row.resource_id === "g"
					) {
						const calls = yield* store.calls(key)
						assert.sameDeepMembers(
							Arr.map(calls, (call) => [call.step, call.status]),
							row.resource_id === "e"
								? [
										["app:0", "completed"],
										["app:1", "outcome_unknown"],
									]
								: row.resource_id === "f"
									? [["app:0", "outcome_unknown"]]
									: [["app:0", "completed"]],
						)
					}
				}
				const [kept] = yield* sql<{
					input: string
				}>`select input from openbot_executions where id = ${first?.id ?? ""}`
				assert.strictEqual(kept?.input, first?.input)
				const [outbox] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_execution_outbox`
				assert.strictEqual(outbox?.count, 0)
			}),
	)
})

it.layer(database(), { excludeTestServices: true })((it) => {
	it.effect(
		"OAuth and developer test moves keep sealed grants and record an unknown exchange",
		() =>
			Effect.gen(function* () {
				yield* Migrations.initialize
				const sql = yield* PgClient.PgClient
				const saved = yield* fixture
				const secrets = yield* Secrets.Secrets
				const binding = {
					owner,
					connectionId: "test",
					resource: "https://example.test/mcp",
					issuer: "https://example.test",
				}
				const credential = {
					binding,
					accessToken: "private-access",
					refreshToken: "private-refresh",
					scopes: ["read"],
				}
				const flow = {
					flowId: "flow",
					binding,
					clientId: "https://host.test/metadata",
					redirectUri: "https://host.test/callback",
					scopes: ["read"],
					verifier: "private-verifier",
					expiresAt: 100,
					metadata: {
						issuer: binding.issuer,
						authorization_endpoint: "https://example.test/auth",
						token_endpoint: "https://example.test/token",
						code_challenge_methods_supported: ["S256"],
						response_types_supported: ["code"],
					},
				}
				const authorization = {
					flowId: "flow",
					status: "Exchanging",
					issuer: binding.issuer,
					resource: binding.resource,
					scopes: ["read"],
					expiresAt: 100,
					authorizationUrl: "https://example.test/auth?state=flow",
				}
				const test = {
					id: "test",
					cardUrl: source.cardUrl,
					candidate: {
						cardUrl: source.cardUrl,
						card: { name: "test/app", version: "1" },
						endpoints: [],
						sources: [],
					},
					remoteIndex: 0,
					endpoint: binding.resource,
					configurationKeys: [],
					issuers: [binding.issuer],
					requestedScopes: ["read"],
					createdAt: 1,
					expiresAt: 100,
					status: "AwaitingAuthorization",
					checkedAt: 2,
					stages: [],
					cleanup: "Pending",
					cleanupRemote: "Pending",
					cleanupLocal: "Pending",
					authorization,
					reason: null,
				}
				const privateState = {
					connection: {
						owner,
						connectionId: "test",
						cardUrl: source.cardUrl,
						endpoint: binding.resource,
						remoteIndex: 0,
						configuration: { key: "private-config" },
						headers: {},
						state: "Enabled",
						authorization: {
							_tag: "Authorized",
							binding,
							credentialRef: "credential",
							scopes: ["read"],
						},
					},
					credentials: [{ reference: "credential", credential }],
				}
				const privateBody = yield* saved.seal(privateState, [
					"developer-test",
					owner,
					"test",
				])
				yield* sql`insert into openbot_developer_tests ${sql.insert({ namespace: "public", id: "test", owner, card_url: source.cardUrl, status: test.status, cleanup: test.cleanup, expires_at: 100, value: yield* encode(test), private_state: privateBody })}`
				const flowBody = yield* secrets.seal(
					yield* encode(flow),
					(yield* encode(["developer-test", owner, "test"])) + ":flow:flow",
				)
				const callback = yield* secrets.seal(
					"https://host.test/callback?state=flow&code=private-code",
					yield* encode(["developer-callback", owner, "test", "flow"]),
				)
				yield* sql`insert into openbot_developer_test_flows ${sql.insert({ namespace: "public", flow_id: "flow", test_id: "test", owner, status: authorization.status, expires_at: 100, value: yield* encode(authorization), body: flowBody, callback, consumed: true })}`
				const appFlow = {
					...flow,
					flowId: "app-flow",
					binding: { ...binding, connectionId: "connection" },
				}
				const appBody = yield* saved.seal(appFlow, ["flow", owner, "app-flow"])
				yield* sql`insert into openbot_app_secrets ${sql.insert({ owner, kind: "flow", id: "app-flow", connection_id: "connection", body: appBody, consumed: true })}`
				yield* sql`insert into openbot_app_authorizations ${sql.insert({ id: "app-flow", owner, connection_id: "connection", revision: 1, expires_at: 100, return_to: "/", status: "Processing", callback: null, reason: null, issuer: binding.issuer, resource: binding.resource, scopes: '["read"]' })}`
				const wrongOwner = yield* saved.seal(
					{
						...privateState,
						connection: {
							...privateState.connection,
							owner: '["other","person"]',
						},
					},
					["developer-test", owner, "test"],
				)
				yield* sql`update openbot_developer_tests set private_state = ${wrongOwner} where id = 'test'`
				assert.isTrue(
					Schema.is(Progress.InvalidRecord)(yield* Apps.run.pipe(Effect.flip)),
				)
				const [failedBatch] = yield* sql<{
					count: number
				}>`select count(*)::float8 as count from openbot_executions where resource_kind = 'DeveloperTest'`
				assert.strictEqual(failedBatch?.count, 0)
				yield* sql`update openbot_developer_tests set private_state = ${privateBody} where id = 'test'`
				yield* Apps.run
				yield* Apps.run
				yield* Apps.check
				yield* Apps.verify
				yield* Apps.verify
				const [moved] = yield* sql<{
					status: string
					value: string
					private_state: string
				}>`select status, value, private_state from openbot_developer_tests where id = 'test'`
				assert.strictEqual(moved?.status, "Interrupted")
				assert.strictEqual(moved?.private_state, privateBody)
				assert.include(moved?.value ?? "", "executionId")
				assert.notInclude(moved?.value ?? "", "private-access")
				const records = yield* sql<{
					status: string
					input: string
				}>`select status, input from openbot_executions where workflow = ${Imported.workflowName}`
				assert.strictEqual(records.length, 3)
				for (const row of records) {
					assert.strictEqual(row.status, "outcome_unknown")
					assert.notInclude(row.input, "private-verifier")
					assert.notInclude(row.input, "private-access")
				}
				const cleanupJobs = yield* sql<{
					namespace: string
					id: string
				}>`select namespace, id from openbot_executions where workflow = ${TestCleanup.workflowName}`
				assert.equal(cleanupJobs.length, 1)
				const cleanupKey = {
					namespace: owner,
					id: Execution.Id.make(cleanupJobs[0]!.id),
				}
				const cleanup = yield* (yield* Store.Store).loadService(
					cleanupKey,
					TestCleanup.serviceId,
				)
				assert.equal(cleanup.identity.owner.kind, "organization")
				assert.equal(cleanup.identity.actor.kind, "service")
				assert.deepEqual(cleanup.input, {
					indexNamespace: "public",
					owner,
					testId: "test",
					createdAt: 1,
				})
				assert.include(moved?.value ?? "", cleanupKey.id)
				const queued = yield* sql<{
					kind: string
					sent_at: string | null
				}>`select c.kind, o.sent_at from openbot_execution_outbox o join openbot_execution_commands c on c.namespace = o.namespace and c.id = o.command_id where o.execution_id = ${cleanupKey.id}`
				assert.equal(queued.length, 1)
				assert.equal(queued[0]?.kind, "start")
				assert.equal(queued[0]?.sent_at, null)
				const [app] = yield* sql<{
					status: string
					reason: string
					actor: string | null
					execution_id: string
				}>`select status, reason, actor, execution_id from openbot_app_authorizations where id = 'app-flow'`
				assert.strictEqual(app?.status, "Failed")
				assert.strictEqual(app?.reason, "OutcomeUnknown")
				assert.strictEqual(app?.actor, null)
				assert.isString(app?.execution_id)
				const [kept] = yield* sql<{
					body: string
					callback: string
				}>`select body, callback from openbot_developer_test_flows where flow_id = 'flow'`
				assert.deepStrictEqual(kept, { body: flowBody, callback })
			}),
	)
})
