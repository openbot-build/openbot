import { Execution, ServiceId, ServiceIdentity } from "@openbot-build/domain"
import { Array as Arr, Cause, Crypto, Effect, Schema } from "effect"
import { Hex } from "effect/encoding"
import { SqlClient } from "effect/sql"
import { Secrets } from "../../secrets/Secrets.ts"
import { snapshot } from "../../errors/Snapshot.ts"
import * as Authority from "./Authority.ts"
import * as Legacy from "./LegacyV1.ts"
import * as Progress from "./Progress.ts"

export const workflowName = "openbot.imported-record"
export const serviceId = ServiceId.make("data-upgrade")
/** Imported history has no right to make a new outside call. */
export const Input = Schema.TaggedStruct("Imported", {
	format: Schema.Literal(1),
	source: Schema.Literal(Legacy.source),
	owner: Authority.Owner,
	authority: Authority.Authority,
	reason: Schema.Literals([
		"History",
		"OriginalCallerMissing",
		"CheckpointMissing",
		"OutsideResultUnknown",
	]),
	/** The feature's new history codec. It must keep its old business ID. */
	history: Schema.Json,
})
export type Input = typeof Input.Type
export interface RecordInput {
	readonly namespace: string
	readonly collection: string
	readonly sourceKey: string
	readonly resource: Execution.Resource
	readonly context?: Execution.Resource
	readonly input: Input
	readonly status:
		"completed" | "failed" | "cancelled" | "interrupted" | "outcome_unknown"
	readonly createdAt: number
	readonly updatedAt: number
	readonly calls?: ReadonlyArray<{
		readonly step: string
		readonly attempt: number
		readonly status: "completed" | "outcome_unknown"
		readonly input: Schema.Json
		readonly result: Schema.Json | null
	}>
}
const json = Schema.fromJsonString(Schema.Json)
const event = Schema.fromJsonString(Execution.EventBody)
export class InvalidImport extends Schema.TaggedError<
	InvalidImport,
	{ readonly brand: unique symbol }
>()("DataUpgradeInvalidImport", { message: Schema.String }) {}
/** The caller's conversion batch owns the SQL transaction. This writer makes no outbox row. */
export const make = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const crypto = yield* Crypto.Crypto
	const progress = yield* Progress.make
	const stable = (parts: ReadonlyArray<string>) =>
		Effect.gen(function* () {
			const bytes = new TextEncoder().encode(
				yield* Schema.encodeEffect(json)(parts),
			)
			return Hex.encode(yield* crypto.digest("SHA-256", bytes))
		})
	const write = (input: RecordInput) =>
		Effect.gen(function* () {
			const calls = input.calls ?? []
			if (
				(input.status === "outcome_unknown") !==
				Arr.some(calls, (call) => call.status === "outcome_unknown")
			)
				return yield* InvalidImport.make({
					message: "An unknown execution must keep its unknown outside call.",
				})
			const digest = yield* stable([
				Legacy.source,
				input.namespace,
				input.collection,
				input.sourceKey,
			])
			const id = Execution.Id.make(`import_${digest}`)
			const namespace = input.namespace
			const proofKey = yield* Schema.encodeEffect(json)([
				namespace,
				input.collection,
				input.sourceKey,
			])
			const proof = {
				...input,
				id,
				context: input.context ?? null,
				calls,
			} satisfies Schema.Json
			const seal = (field: string, value: Schema.Json) =>
				Effect.gen(function* () {
					return yield* secrets.seal(
						yield* Schema.encodeEffect(json)(value),
						yield* Schema.encodeEffect(json)([
							"execution",
							namespace,
							id,
							field,
						]),
					)
				})
			const exists = yield* sql<{
				id: string
			}>`select id from openbot_executions where namespace = ${namespace} and id = ${id}`
			const [savedProof] = yield* sql<{
				body: string
			}>`select body from openbot_data_upgrade_records where version = ${Progress.version} and collection = 'execution' and key = ${proofKey}`
			if (exists.length > 0 || savedProof !== undefined) {
				if (exists.length === 0 || savedProof === undefined)
					return yield* InvalidImport.make({
						message: "An imported execution has no matching data move record.",
					})
				const saved = yield* secrets
					.open(
						savedProof.body,
						yield* Schema.encodeEffect(json)([
							"data-upgrade",
							Progress.version,
							"execution",
							proofKey,
						]),
					)
					.pipe(Effect.flatMap(Schema.decodeEffect(json)))
				if (!Schema.toEquivalence(Schema.Json)(proof, saved))
					return yield* InvalidImport.make({
						message: "The source of an imported execution changed.",
					})
				return { namespace, id }
			}
			const identity: ServiceIdentity = {
				owner: {
					kind: "organization",
					organizationId: input.input.owner.organizationId,
				},
				actor: { kind: "service", serviceId },
			}
			const failure =
				input.status === "interrupted" ||
				input.status === "outcome_unknown" ||
				input.status === "failed"
					? {
							errorId: Execution.ErrorId.make(`import_error_${digest}`),
							category:
								input.status === "failed"
									? ("external" as const)
									: input.status,
						}
					: null
			if (failure !== null) {
				const cause = yield* secrets.seal(
					yield* Cause.fail({
						_tag: "ImportedRecord",
						source: Legacy.source,
						reason: input.input.reason,
					}).pipe(snapshot, Schema.encodeEffect(json)),
					`failure:${failure.errorId}`,
				)
				yield* sql`insert into openbot_execution_failures ${sql.insert({ id: failure.errorId, execution_id: id, cause, created_at: input.updatedAt })}`
			}
			// A missing outside result stays visible even when the original caller is unknown.
			const storedCalls = yield* Effect.forEach(calls, (call) =>
				Effect.gen(function* () {
					const callId = Execution.CallId.make(
						`import_call_${yield* stable([id, call.step, String(call.attempt)])}`,
					)
					return { ...call, id: callId }
				}),
			)
			const decisions = Arr.filter(
				storedCalls,
				(call) => call.status === "outcome_unknown",
			)
			const events: ReadonlyArray<Execution.EventBody> = [
				{ _tag: "Result", resource: input.resource },
				...Arr.map(decisions, (call): Execution.EventBody => ({
					_tag: "DecisionNeeded",
					decisionId: call.id,
					choices: ["stop"],
				})),
				// Observation ends at a terminal State. Keep all result events before it.
				{ _tag: "State", status: input.status, failure },
			]
			yield* sql`insert into openbot_executions ${sql.insert({
				namespace,
				id,
				workflow: workflowName,
				resource_kind: input.resource.kind,
				resource_id: input.resource.id,
				context_kind: input.context?.kind ?? null,
				context_id: input.context?.id ?? null,
				organization_id: input.input.owner.organizationId,
				user_id: null,
				principal_kind: "service",
				service_id: serviceId,
				identity: yield* seal("identity", identity),
				input: yield* seal("input", input.input),
				status: input.status,
				sequence: events.length,
				failure:
					failure === null
						? null
						: yield* Schema.encodeEffect(
								Schema.fromJsonString(Execution.Failure),
							)(failure),
				created_at: input.createdAt,
				updated_at: input.updatedAt,
			})}`
			for (const [index, body] of events.entries()) {
				const sequence = index + 1
				const encoded = yield* Schema.encodeEffect(event)(body)
				const sealed = yield* secrets.seal(
					encoded,
					yield* Schema.encodeEffect(json)([
						"execution",
						namespace,
						id,
						`event:${sequence}`,
					]),
				)
				yield* sql`insert into openbot_execution_events ${sql.insert({ namespace, execution_id: id, sequence, body: sealed, created_at: input.updatedAt })}`
			}
			for (const call of storedCalls) {
				yield* sql`insert into openbot_execution_calls ${sql.insert({
					namespace,
					id: call.id,
					execution_id: id,
					step: call.step,
					attempt: call.attempt,
					generation: 0,
					retry: "never",
					status: call.status,
					input: yield* seal(`call:${call.id}:input`, call.input),
					result:
						call.result === null
							? null
							: yield* seal(`call:${call.id}:result`, call.result),
					created_at: input.createdAt,
					updated_at: input.updatedAt,
				})}`
			}
			for (const call of decisions) {
				yield* sql`insert into openbot_execution_decisions ${sql.insert({
					namespace,
					execution_id: id,
					id: call.id,
					choices: yield* Schema.encodeEffect(json)(["stop"]),
					created_at: input.updatedAt,
				})}`
			}
			yield* progress.record("execution", proofKey, "converted", proof)
			return { namespace, id }
		})
	return { write }
})

/** Read the saved history again. A finished batch alone does not prove that it can be read. */
export const verify = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const progress = yield* Progress.make
	const fail = (message: string) => InvalidImport.make({ message })
	const open = (namespace: string, id: string, field: string, value: string) =>
		Effect.gen(function* () {
			return yield* secrets.open(
				value,
				yield* Schema.encodeEffect(json)(["execution", namespace, id, field]),
			)
		})
	yield* progress.verify({
		name: "verify:imported-executions",
		read: (cursor, limit) =>
			sql<{
				id: string
				namespace: string
				identity: string
				input: string
				organization_id: string
				principal_kind: string
				service_id: string | null
				user_id: string | null
				failure: string | null
				status: string
				sequence: bigint
				resource_kind: string
				resource_id: string
			}>`select id, namespace, identity, input, organization_id, principal_kind, service_id, user_id, failure, status, sequence, resource_kind, resource_id from openbot_executions where workflow = ${workflowName} and (${cursor}::text is null or id > ${cursor}) order by id limit ${limit}`,
		key: (row) => row.id,
		check: (row) =>
			Effect.gen(function* () {
				const identity = yield* open(
					row.namespace,
					row.id,
					"identity",
					row.identity,
				).pipe(
					Effect.flatMap(
						Schema.decodeEffect(Schema.fromJsonString(ServiceIdentity)),
					),
				)
				const input = yield* open(
					row.namespace,
					row.id,
					"input",
					row.input,
				).pipe(
					Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Input))),
				)
				const status = yield* Schema.decodeUnknownEffect(Execution.Status)(
					row.status,
				)
				if (
					identity.actor.serviceId !== serviceId ||
					identity.owner.kind !== "organization" ||
					identity.owner.organizationId !== row.organization_id ||
					input.owner.organizationId !== row.organization_id ||
					row.principal_kind !== "service" ||
					row.service_id !== serviceId ||
					row.user_id !== null
				)
					return yield* fail("An imported execution has another owner.")
				const failure =
					row.failure === null
						? null
						: yield* Schema.decodeEffect(
								Schema.fromJsonString(Execution.Failure),
							)(row.failure)
				if (failure !== null) {
					const [report] = yield* sql<{
						execution_id: string | null
						cause: string
					}>`select execution_id, cause from openbot_execution_failures where id = ${failure.errorId}`
					if (report === undefined || report.execution_id !== row.id)
						return yield* fail(
							"An imported execution has no matching error record.",
						)
					yield* secrets
						.open(report.cause, `failure:${failure.errorId}`)
						.pipe(Effect.flatMap(Schema.decodeEffect(json)))
				}
				let last = 0
				let lastBody: Execution.EventBody | undefined
				while (true) {
					const events = yield* sql<{
						sequence: bigint
						body: string
					}>`select sequence, body from openbot_execution_events where namespace = ${row.namespace} and execution_id = ${row.id} and sequence > ${last} order by sequence limit 100`
					for (const event of events) {
						if (event.sequence !== BigInt(last + 1))
							return yield* fail(
								"An imported execution has a gap in its events.",
							)
						last += 1
						lastBody = yield* open(
							row.namespace,
							row.id,
							`event:${last}`,
							event.body,
						).pipe(
							Effect.flatMap(
								Schema.decodeEffect(Schema.fromJsonString(Execution.EventBody)),
							),
						)
						if (
							lastBody._tag === "Result" &&
							(lastBody.resource.kind !== row.resource_kind ||
								lastBody.resource.id !== row.resource_id)
						)
							return yield* fail("An imported result has another resource.")
						if (
							lastBody._tag === "State" &&
							Execution.isTerminal(lastBody.status) &&
							BigInt(last) !== row.sequence
						)
							return yield* fail(
								"An imported execution has an event after its end.",
							)
					}
					if (events.length < 100) break
				}
				if (
					BigInt(last) !== row.sequence ||
					lastBody?._tag !== "State" ||
					lastBody.status !== status ||
					!Schema.toEquivalence(Schema.NullOr(Execution.Failure))(
						lastBody.failure,
						failure,
					)
				)
					return yield* fail(
						"An imported execution state does not match its last event.",
					)
				let callCursor: string | null = null
				while (true) {
					type Call = {
						id: string
						status: string
						input: string
						result: string | null
					}
					const calls: ReadonlyArray<Call> =
						yield* sql<Call>`select id, status, input, result from openbot_execution_calls where namespace = ${row.namespace} and execution_id = ${row.id} and (${callCursor}::text is null or id > ${callCursor}) order by id limit 100`
					for (const call of calls) {
						callCursor = call.id
						yield* Schema.decodeUnknownEffect(Execution.CallStatus)(call.status)
						yield* open(
							row.namespace,
							row.id,
							`call:${call.id}:input`,
							call.input,
						).pipe(Effect.flatMap(Schema.decodeEffect(json)))
						if (call.result !== null)
							yield* open(
								row.namespace,
								row.id,
								`call:${call.id}:result`,
								call.result,
							).pipe(Effect.flatMap(Schema.decodeEffect(json)))
						if (call.status === "outcome_unknown") {
							const [decision] = yield* sql<{
								choices: string
							}>`select choices from openbot_execution_decisions where namespace = ${row.namespace} and execution_id = ${row.id} and id = ${call.id}`
							if (decision === undefined)
								return yield* fail(
									"An unknown imported call has no saved decision.",
								)
							const choices = yield* Schema.decodeEffect(
								Schema.fromJsonString(Schema.Array(Execution.Answer)),
							)(decision.choices)
							if (choices.length !== 1 || choices[0] !== "stop")
								return yield* fail(
									"An imported call can only stop after an unknown result.",
								)
						}
					}
					if (calls.length < 100) break
				}
			}),
	})
})
