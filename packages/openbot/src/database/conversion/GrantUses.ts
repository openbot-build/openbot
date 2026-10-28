import { Store as Protocol } from "@openbot-build/protocol"
import { Array as Arr, Clock, Effect, Option, Schema } from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import * as Grants from "../../apps/GrantUses.ts"
import * as Connections from "../../apps/StoredConnections.ts"
import { privateStateCodec } from "../../apps/DeveloperTestStores.ts"
import { Secrets } from "../../secrets/Secrets.ts"
import * as Progress from "./Progress.ts"

export const version = "app-grants/1"
const json = Schema.fromJsonString(Schema.Json)
const credentialCodec = Schema.fromJsonString(
	Schema.toCodecJson(Protocol.Credential),
)
const callInput = Schema.Struct({ grantScope: Grants.Scope })

/** Existing App data needs a checked grant index before a server can use it. */
export const establish = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	yield* sql.withTransaction(
		Effect.gen(function* () {
			const [found] = yield* sql<{
				state: string
			}>`select state from openbot_data_upgrades where version = ${version} for update`
			if (found !== undefined) return
			const [source] = yield* sql<{
				state: string
			}>`select state from openbot_data_upgrades where version = ${Progress.version}`
			const [counts] = yield* sql<{
				connections: number
				tests: number
				calls: number
			}>`select
				(select count(*)::float8 from openbot_app_connections) as connections,
				(select count(*)::float8 from openbot_developer_tests) as tests,
				(select count(*)::float8 from openbot_execution_calls c join openbot_executions e on e.namespace = c.namespace and e.id = c.execution_id where e.status not in ('completed', 'failed', 'cancelled', 'interrupted') and ((e.resource_kind in ('AppAuthorization', 'DeveloperTest') and c.step in ('exchange', 'refresh')) or (e.resource_kind = 'AppGrant' and c.step = 'revoke'))) as calls`
			const empty =
				source?.state === "ready" &&
				counts?.connections === 0 &&
				counts.tests === 0 &&
				counts.calls === 0
			const now = yield* Clock.currentTimeMillis
			yield* sql`insert into openbot_data_upgrades ${sql.insert({
				version,
				source: Progress.version,
				state: empty ? "ready" : "blocked",
				counts: yield* Schema.encodeEffect(json)(counts ?? {}),
				started_at: now,
				updated_at: now,
				checked_at: empty ? now : null,
			})}`
		}),
	)
})

export const checkReady = Progress.checkReadyFor(version)

interface Use {
	readonly namespace: string
	readonly kind: "connection" | "developer-test" | "send" | "revoke"
	readonly reference: string
	readonly scopeKey: string
	readonly executionId: string | null
}

/** Run with all servers stopped. Only this data move reads old private grant records. */
export const run = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	yield* Progress.checkReady
	yield* establish
	const [state] = yield* sql<{
		state: string
	}>`select state from openbot_data_upgrades where version = ${version}`
	if (state?.state === "ready") return
	const progress = yield* Progress.makeFor(version)
	yield* sql`update openbot_data_upgrades set state = 'converting', checked_at = null, updated_at = ${yield* Clock.currentTimeMillis} where version = ${version}`
	const invalid = (message: string) => Progress.InvalidData.make({ message })
	const open = (body: string, binding: ReadonlyArray<string>) =>
		Schema.encodeEffect(json)(binding).pipe(
			Effect.flatMap((aad) => secrets.open(body, aad)),
		)
	const save = (use: Use) =>
		sql`insert into openbot_app_grant_uses ${sql.insert({
			namespace: use.namespace,
			kind: use.kind,
			reference: use.reference,
			scope_key: use.scopeKey,
			execution_id: use.executionId,
		})} on conflict (namespace, kind, reference) do update set scope_key = excluded.scope_key, execution_id = excluded.execution_id`.pipe(
			Effect.asVoid,
		)
	const fill = <A, ReadE, UseE>(step: {
		readonly name: string
		readonly read: (
			cursor: string | null,
			limit: number,
		) => Effect.Effect<ReadonlyArray<A>, ReadE>
		readonly key: (row: A) => string
		readonly use: (row: A) => Effect.Effect<Use | undefined, UseE>
	}) =>
		progress.phase(
			step.name,
			Effect.gen(function* () {
				let complete = false
				while (!complete) {
					const result = yield* progress.batch<
						A,
						ReadE | UseE | SqlError.SqlError
					>(
						{
							...step,
							convert: (row) =>
								step
									.use(row)
									.pipe(
										Effect.flatMap((use) =>
											use === undefined ? Effect.void : save(use),
										),
									),
						},
						100,
					)
					complete = result.complete
				}
				yield* progress.verify<
					A,
					ReadE,
					UseE | SqlError.SqlError | Progress.InvalidData
				>({
					name: `verify:${step.name}`,
					read: step.read,
					key: step.key,
					check: (row) =>
						Effect.gen(function* () {
							const use = yield* step.use(row)
							if (use === undefined) return
							const [saved] = yield* sql<{
								scope_key: string
								execution_id: string | null
							}>`select scope_key, execution_id from openbot_app_grant_uses where namespace = ${use.namespace} and kind = ${use.kind} and reference = ${use.reference}`
							if (
								saved?.scope_key !== use.scopeKey ||
								saved.execution_id !== use.executionId
							)
								return yield* invalid("A grant use does not match its source.")
						}),
				})
			}),
		)
	type ConnectionRow = { key: string; owner: string; id: string; body: string }
	yield* fill({
		name: "connections",
		read: (cursor, limit) =>
			sql<ConnectionRow>`select json_build_array(owner, id)::text as key, owner, id, body from openbot_app_connections where (${cursor}::text is null or json_build_array(owner, id)::text > ${cursor}) order by json_build_array(owner, id)::text limit ${limit}`,
		key: (row) => row.key,
		use: (row) =>
			Effect.gen(function* () {
				const current = yield* Connections.openRecord(
					secrets,
					row.owner,
					row.id,
					row.body,
				)
				const auth = current.connection.authorization
				if (auth._tag !== "Authorized") return
				const [saved] = yield* sql<{
					body: string
				}>`select body from openbot_app_secrets where owner = ${row.owner} and kind = 'credential' and id = ${auth.credentialRef} and connection_id = ${row.id}`
				if (saved === undefined)
					return yield* invalid("A current App grant is missing.")
				const credential = yield* open(saved.body, [
					"credential",
					row.owner,
					auth.credentialRef,
				]).pipe(Effect.flatMap(Schema.decodeEffect(credentialCodec)))
				if (
					credential.binding.owner !== row.owner ||
					credential.binding.connectionId !== row.id ||
					credential.binding.issuer !== auth.binding.issuer
				)
					return yield* invalid("A current App grant has another binding.")
				return {
					namespace: row.owner,
					kind: "connection" as const,
					reference: row.id,
					scopeKey: Grants.scopeKey(Grants.scopeOf(credential)),
					executionId: null,
				}
			}),
	})
	type TestRow = {
		key: string
		namespace: string
		owner: string
		id: string
		private_state: string
	}
	yield* fill({
		name: "developer-tests",
		read: (cursor, limit) =>
			sql<TestRow>`select json_build_array(namespace, id)::text as key, namespace, owner, id, private_state from openbot_developer_tests where private_state is not null and (${cursor}::text is null or json_build_array(namespace, id)::text > ${cursor}) order by json_build_array(namespace, id)::text limit ${limit}`,
		key: (row) => row.key,
		use: (row) =>
			Effect.gen(function* () {
				const current = yield* open(row.private_state, [
					"developer-test",
					row.owner,
					row.id,
				]).pipe(Effect.flatMap(Schema.decodeEffect(privateStateCodec)))
				const auth = current.connection?.authorization
				if (auth?._tag !== "Authorized") return
				const credential = Arr.findFirst(
					current.credentials,
					(saved) => saved.reference === auth.credentialRef,
				)
				if (Option.isNone(credential))
					return yield* invalid("A current test grant is missing.")
				if (
					credential.value.credential.binding.owner !== row.owner ||
					credential.value.credential.binding.connectionId !== row.id ||
					credential.value.credential.binding.issuer !== auth.binding.issuer
				)
					return yield* invalid("A current test grant has another binding.")
				return {
					namespace: row.owner,
					kind: "developer-test" as const,
					reference: Grants.testReference(row.namespace, row.id),
					scopeKey: Grants.scopeKey(
						Grants.scopeOf(credential.value.credential),
					),
					executionId: null,
				}
			}),
	})
	type CallRow = {
		key: string
		namespace: string
		execution_id: string
		id: string
		step: string
		input: string
	}
	yield* fill({
		name: "calls",
		read: (cursor, limit) =>
			sql<CallRow>`select json_build_array(c.namespace, c.id)::text as key, c.namespace, c.execution_id, c.id, c.step, c.input from openbot_execution_calls c join openbot_executions e on e.namespace = c.namespace and e.id = c.execution_id where e.status not in ('completed', 'failed', 'cancelled', 'interrupted') and ((e.resource_kind in ('AppAuthorization', 'DeveloperTest') and c.step in ('exchange', 'refresh')) or (e.resource_kind = 'AppGrant' and c.step = 'revoke')) and (${cursor}::text is null or json_build_array(c.namespace, c.id)::text > ${cursor}) order by json_build_array(c.namespace, c.id)::text limit ${limit}`,
		key: (row) => row.key,
		use: (row) =>
			Effect.gen(function* () {
				const input = yield* open(row.input, [
					"execution",
					row.namespace,
					row.execution_id,
					`call:${row.id}:input`,
				]).pipe(Effect.flatMap(Schema.decodeEffect(json)))
				const scope = Schema.decodeUnknownOption(callInput)(input)
				if (Option.isNone(scope)) return
				return {
					namespace: row.namespace,
					kind: row.step === "revoke" ? ("revoke" as const) : ("send" as const),
					reference: row.id,
					scopeKey: Grants.scopeKey(scope.value.grantScope),
					executionId: row.execution_id,
				}
			}),
	})
	yield* progress.ready(["connections", "developer-tests", "calls"])
	yield* checkReady
})
