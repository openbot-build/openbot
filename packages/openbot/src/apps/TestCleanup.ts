import {
	type ServiceExecution,
	Store,
	transactionFailures,
	type Key,
	type Fence,
	type Submission,
} from "../execution/Store.ts"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import * as Grants from "./GrantCleanup.ts"
import * as RetryingCall from "../execution/RetryingCall.ts"
import {
	AppAuthorizations,
	Authorization,
	type Caller,
	Developers,
	Execution,
	ServiceId,
} from "@openbot-build/domain"
import { and, eq, inArray, ne, or } from "drizzle-orm"
import {
	Array as Arr,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Check from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import {
	developerTestFlows,
	developerTests,
	executionCalls,
	executions,
} from "../database/Schema.ts"
import type { Authorize } from "../execution/Engine.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import { DeveloperTestStores } from "./DeveloperTestStores.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import { ownerKey } from "./StoredConnections.ts"

export const workflowName = "openbot.developer-test-cleanup"
export const serviceId = ServiceId.make("developer-test-cleanup")
export const signal = "cleanup"
const Input = Schema.Struct({
	indexNamespace: Schema.String,
	testId: Schema.String,
	owner: Schema.String,
	createdAt: Schema.Finite,
})
/** Creation and maintenance use the same service command. No old caller is needed. */
export const submission = (
	indexNamespace: string,
	owner: string,
	testId: string,
	createdAt: number,
) =>
	Effect.gen(function* () {
		const identity = yield* Rows.identityOf(owner)
		return {
			workflow: workflowName,
			identity: {
				owner: {
					kind: "organization",
					organizationId: identity.organizationId,
				},
				actor: { kind: "service", serviceId },
			},
			resource: { kind: "DeveloperTestCleanup", id: testId },
			input: { indexNamespace, testId, owner, createdAt },
		} satisfies Submission
	})
export interface Service {
	readonly transfer: (
		fence: Fence,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Developers.DeveloperNotFound
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly ensure: (
		record: Rows.TestRecord,
	) => Effect.Effect<
		{ namespace: string; id: Execution.Id },
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Developers.StorageFailure
	>
	readonly request: (
		actor: Caller,
		id: string,
		commandKey: Execution.CommandKey,
		remove: boolean,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Developers.DeveloperNotFound
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Developers.StorageFailure
	>
	readonly load: (key: Key) => Effect.Effect<
		{
			saved: ServiceExecution
			input: typeof Input.Type
		},
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly current: (
		fence: Fence,
		lock?: boolean,
	) => Effect.Effect<
		{
			revision: number
			remove: boolean
			retired: boolean
			grants: readonly Execution.Id[]
			saved: ServiceExecution
			record: Rows.TestRecord
		},
		| Execution.Conflict
		| Developers.DeveloperNotFound
		| Execution.Forbidden
		| Execution.NotFound
		| Developers.StorageFailure
	>
	readonly tick: (
		fence: Fence,
	) => Effect.Effect<boolean, SecretStorageError | Developers.Failure>
	readonly pendingGrant: (
		fence: Fence,
	) => Effect.Effect<
		Option.None<Key> | Option.Some<Key>,
		| Execution.Conflict
		| Developers.DeveloperNotFound
		| Execution.Forbidden
		| Execution.NotFound
		| Developers.StorageFailure
	>
	readonly complete: (
		fence: Fence,
	) => Effect.Effect<
		Option.None<Key> | Option.Some<Key>,
		| Execution.Conflict
		| Developers.DeveloperNotFound
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly authorize: Authorize
	readonly serviceAuthorize: (
		key: Key,
	) => Effect.Effect<
		void,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
}

export class TestCleanup extends Context.Service<TestCleanup, Service>()(
	"@openbot-build/openbot/apps/TestCleanup",
) {}

const make = Effect.gen(function* () {
	const crypto = yield* Crypto.Crypto
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const namespace = yield* IndexNamespace
	const store = yield* Store
	const checks = yield* Check.make
	const access = yield* DeveloperAccess
	const tests = yield* DeveloperTestStores
	const grants = yield* Grants.GrantCleanup
	const owned = (owner: string, id: string, lock = false) =>
		Rows.getTest(db, namespace, id, lock).pipe(
			Effect.filterOrElse(
				(record) => record.owner === owner,
				() => Developers.DeveloperNotFound.make({}),
			),
		)
	const check = (actor: Caller) =>
		checks
			.check(actor, {
				action: "publish",
				resource: Authorization.App.make({
					organizationId: actor.organizationId,
					ownerUserId: actor.userId,
				}),
			})
			.pipe(
				Effect.catchTags({
					Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
					Pending: () => Effect.fail(Execution.Forbidden.make({})),
					PolicyUnavailable: (cause) =>
						Effect.fail(Execution.StorageError.make({ cause })),
				}),
			)
	/** The caller holds the test row lock. Creation and this command share one transaction. */
	const ensure = (record: Rows.TestRecord) =>
		Effect.gen(function* () {
			const previous = record.value.cleanupExecutionId
			if (
				previous !== undefined &&
				!Execution.isTerminal(
					(yield* store.get({ namespace: record.owner, id: previous })).status,
				)
			)
				return { namespace: record.owner, id: previous }
			const receipt = yield* store.submit(
				record.owner,
				Execution.CommandKey.make(
					`test-expiry:${yield* crypto.randomUUIDv7().pipe(Effect.orDie)}`,
				),
				yield* submission(
					namespace,
					record.owner,
					record.value.id,
					record.value.createdAt,
				),
			)
			yield* Rows.putTest(db, namespace, {
				...record,
				value: { ...record.value, cleanupExecutionId: receipt.executionId },
			})
			return { namespace: record.owner, id: receipt.executionId }
		})
	const load = (key: Key) =>
		Effect.gen(function* () {
			const saved = yield* store.loadService(key, serviceId)
			const input = yield* Schema.decodeUnknownEffect(Input)(saved.input).pipe(
				Effect.orDie,
			)
			const owner = yield* Rows.identityOf(input.owner).pipe(Effect.orDie)
			if (
				saved.workflow !== workflowName ||
				input.indexNamespace !== namespace ||
				saved.identity.owner.kind !== "organization" ||
				saved.identity.owner.organizationId !== owner.organizationId ||
				key.namespace !== input.owner ||
				saved.record.resource.kind !== "DeveloperTestCleanup" ||
				saved.record.resource.id !== input.testId
			)
				return yield* Execution.Forbidden.make({})
			return { saved, input }
		})
	const authorize: Authorize = (key, actor) =>
		Effect.gen(function* () {
			const { input } = yield* load(key)
			if (ownerKey(actor) !== input.owner)
				return yield* Execution.Forbidden.make({})
			yield* check(actor)
		})
	const request = (
		actor: Caller,
		id: string,
		commandKey: Execution.CommandKey,
		remove: boolean,
	) =>
		Effect.gen(function* () {
			yield* check(actor)
			return yield* store.accept(
				ownerKey(actor),
				commandKey,
				{ actor, body: { kind: "developer-test-cleanup", id, remove } },
				() =>
					Effect.gen(function* () {
						const record = yield* owned(ownerKey(actor), id, true)
						const key = yield* ensure(record)
						const current = yield* owned(record.owner, id)
						yield* Rows.putTest(db, namespace, {
							...current,
							value: {
								...current.value,
								status: "Cancelling",
								cleanup: "Pending",
								cleanupLocal: "Pending",
								reason: null,
							},
						})
						yield* store.notify(
							key,
							Execution.CommandKey.make(`test-cleanup-wake:${commandKey}`),
							actor,
							signal,
						)
						return {
							executionId: key.id,
							start: false,
							events: remove
								? [
										{
											_tag: "Checkpoint" as const,
											resource: { kind: "DeveloperTestDelete", id },
											revision: 0,
										},
									]
								: [],
						}
					}),
			)
		})
	const progress = (key: Key) =>
		Effect.gen(function* () {
			let cursor = 0
			let revision = 0
			let remove = false
			let retired = false
			let grants: ReadonlyArray<Execution.Id> = []
			while (true) {
				const events = yield* store.events(key, cursor)
				for (const event of events) {
					if (event.body._tag !== "Checkpoint") continue
					if (event.body.resource.kind === "DeveloperTestExpiry")
						revision = Math.max(revision, event.body.revision)
					if (event.body.resource.kind === "DeveloperTestDelete") remove = true
					if (event.body.resource.kind === "DeveloperTestRetired")
						retired = true
					if (event.body.resource.kind === "DeveloperTestGrantCleanup")
						grants = Arr.append(
							grants,
							Execution.Id.make(event.body.resource.id),
						)
				}
				if (events.length < 128) return { revision, remove, retired, grants }
				if (Arr.isReadonlyArrayNonEmpty(events))
					cursor = Arr.lastNonEmpty(events).sequence
			}
		})
	const current = (fence: Fence, lock = false) =>
		Effect.gen(function* () {
			const { saved, input } = yield* load(fence)
			const record = yield* owned(input.owner, input.testId, lock)
			if (
				record.value.createdAt !== input.createdAt ||
				record.value.cleanupExecutionId !== fence.id
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			return { saved, record, ...(yield* progress(fence)) }
		})
	const tick = (fence: Fence) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const state = yield* current(fence, true)
					const { record, revision } = state
					const now = yield* Clock.currentTimeMillis
					const stop =
						record.value.cleanup === "Pending" ||
						record.value.expiresAt <= now ||
						!(yield* access.allows(record.owner, record.value.cardUrl, true))
					yield* store.commit(
						fence,
						{
							events: [
								{
									_tag: "Checkpoint",
									resource: {
										kind: "DeveloperTestExpiry",
										id: record.value.id,
									},
									revision: revision + 1,
								},
							],
						},
						Effect.gen(function* () {
							const flows = yield* db
								.select()
								.from(developerTestFlows)
								.where(
									and(
										eq(developerTestFlows.namespace, namespace),
										eq(developerTestFlows.owner, record.owner),
										eq(developerTestFlows.testId, record.value.id),
									),
								)
							let authorization = record.value.authorization
							for (const row of flows) {
								const flow = yield* Rows.decodeFlow(row)
								if (
									flow.value.expiresAt > now ||
									flow.value.status === "Exchanging"
								)
									continue
								const value = ["Waiting", "Received"].includes(
									flow.value.status,
								)
									? { ...flow.value, status: "Expired" as const }
									: flow.value
								yield* Rows.putFlow(db, namespace, {
									...flow,
									actor: null,
									body: null,
									callback: null,
									consumed: true,
									value,
								})
								if (authorization?.flowId === value.flowId)
									authorization = value
							}
							yield* Rows.putTest(db, namespace, {
								...record,
								value: {
									...record.value,
									authorization,
									...(stop
										? {
												status: "Cancelling" as const,
												cleanup: "Pending" as const,
												cleanupLocal: "Pending" as const,
											}
										: {}),
								},
							})
						}),
					)
					return stop
				}),
			)
			.pipe(transactionFailures)
	/** Save every credential in the shared cleanup before dropping its local use. */
	const transfer = (fence: Fence) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { record, retired } = yield* current(fence, true)
					if (retired) return
					const bound = tests.bind(record.owner, record.value.id)
					const snapshot = yield* bound.snapshot.pipe(
						Effect.mapError((cause) => Execution.StorageError.make({ cause })),
					)
					const auth = snapshot.connection?.authorization
					const jobs = yield* Effect.forEach(
						snapshot.credentials,
						({ reference, credential }) =>
							grants.handoff(
								fence,
								reference,
								credential,
								auth?._tag === "Authorized" &&
									auth.credentialRef === reference &&
									auth.resourceMetadataUrl !== undefined
									? { resourceMetadataUrl: auth.resourceMetadataUrl }
									: {},
							),
					)
					yield* store.commit(
						fence,
						{
							events: [
								{
									_tag: "Checkpoint",
									resource: {
										kind: "DeveloperTestRetired",
										id: record.value.id,
									},
									revision: 0,
								},
								...Arr.map(jobs, (job) => ({
									_tag: "Checkpoint" as const,
									resource: {
										kind: "DeveloperTestGrantCleanup",
										id: job.executionId,
									},
									revision: 0,
								})),
							],
						},
						snapshot.connection === null
							? Effect.void
							: bound.apps
									.update({
										key: snapshot.connection,
										change: (value) => ({
											...value,
											state: "Disabled",
											authorization: {
												_tag: "AuthorizationFailed",
												reason: "TestClosed",
											},
										}),
									})
									.pipe(
										Effect.mapError((cause) =>
											Execution.StorageError.make({ cause }),
										),
									),
					)
				}),
			)
			.pipe(transactionFailures)
	/** A grant result owns its cleanup even if it arrives after the test stops. */
	const pendingGrant = (fence: Fence) =>
		Effect.gen(function* () {
			const { record, grants } = yield* current(fence)
			const sources = yield* db
				.select({ id: executions.id })
				.from(executions)
				.where(
					and(
						eq(executions.namespace, record.owner),
						eq(executions.workflow, "openbot.developer-test"),
						eq(executions.resourceKind, "DeveloperTest"),
						eq(executions.resourceId, record.value.id),
					),
				)
			const calls = yield* db
				.select({ id: executionCalls.id })
				.from(executionCalls)
				.where(
					and(
						eq(executionCalls.namespace, record.owner),
						inArray(
							executionCalls.executionId,
							Arr.map(sources, (source) => source.id),
						),
						inArray(executionCalls.step, ["exchange", "refresh"]),
					),
				)
			if (calls.length === 0 && grants.length === 0) return Option.none<Key>()
			const pending = yield* db
				.select({ id: executions.id })
				.from(executions)
				.where(
					and(
						eq(executions.namespace, record.owner),
						eq(executions.workflow, "openbot.app-grant-cleanup"),
						or(
							inArray(executions.id, grants),
							inArray(
								executions.resourceId,
								Arr.map(calls, (call) => call.id),
							),
						),
						ne(executions.status, "completed"),
					),
				)
				.limit(1)
			const next = Arr.head(pending)
			if (Option.isSome(next)) {
				const state = yield* store.get({
					namespace: record.owner,
					id: Execution.Id.make(next.value.id),
				})
				if (Execution.isTerminal(state.status))
					return yield* Execution.StorageError.make({
						cause: "The test grant cleanup did not complete.",
					})
			}
			return Option.map(next, (value) => ({
				namespace: record.owner,
				id: Execution.Id.make(value.id),
			}))
		}).pipe(transactionFailures)
	const remoteResult = (fence: Fence) =>
		Effect.gen(function* () {
			const { grants } = yield* progress(fence)
			if (grants.length === 0) return "LocalOnly" as const
			for (const id of grants) {
				const calls = yield* store.calls({ namespace: fence.namespace, id })
				const call = Arr.head(
					Arr.sort(
						Arr.filter(
							calls,
							(call) => call.step === "revoke" && call.status === "completed",
						),
						(a: Execution.Call, b: Execution.Call) =>
							a.attempt === b.attempt ? 0 : a.attempt > b.attempt ? -1 : 1,
					),
				)
				if (Option.isNone(call)) return "LocalOnly" as const
				const result = yield* Schema.decodeUnknownEffect(RetryingCall.Result)(
					call.value.result,
				)
				if (result._tag !== "Completed") return "LocalOnly" as const
				const remote = yield* Schema.decodeUnknownEffect(
					AppAuthorizations.Revocation,
				)(result.value)
				if (remote._tag !== "Revoked") return "LocalOnly" as const
			}
			return "Revoked" as const
		}).pipe(transactionFailures)

	const complete = (fence: Fence) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { record, remove, retired } = yield* current(fence, true)
					if (!retired) return yield* Execution.Conflict.make({ id: fence.id })
					const pending = yield* pendingGrant(fence)
					if (Option.isSome(pending)) return pending
					const remote = yield* remoteResult(fence)
					const row = (yield* db
						.select({ grant: developerTests.grantCleanupExecutionId })
						.from(developerTests)
						.where(
							and(
								eq(developerTests.namespace, namespace),
								eq(developerTests.id, record.value.id),
							),
						))[0]
					if (row?.grant != null)
						return Option.some({
							namespace: record.owner,
							id: Execution.Id.make(row.grant),
						})
					yield* store.commit(
						fence,
						{
							status: "completed",
							events: [
								{
									_tag: "Result",
									resource: {
										kind: "DeveloperTestCleanup",
										id: record.value.id,
									},
								},
							],
						},
						Effect.gen(function* () {
							yield* tests
								.bind(record.owner, record.value.id)
								.clear.pipe(
									Effect.mapError((cause) =>
										Execution.StorageError.make({ cause }),
									),
								)
							if (remove)
								yield* db
									.delete(developerTests)
									.where(
										and(
											eq(developerTests.namespace, namespace),
											eq(developerTests.id, record.value.id),
											eq(developerTests.owner, record.owner),
										),
									)
							else
								yield* Rows.putTest(db, namespace, {
									...record,
									value: {
										...record.value,
										status: "Cancelled",
										cleanup: "Complete",
										cleanupLocal: "Complete",
										cleanupRemote:
											record.value.cleanupRemote === "NotRequired" ||
											record.value.cleanupRemote === "Complete"
												? record.value.cleanupRemote
												: remote === "Revoked"
													? "Complete"
													: "LocalOnly",
										configurationKeys: [],
										authorization: null,
										reason: null,
									},
								})
						}),
					)
					return Option.none<Key>()
				}),
			)
			.pipe(transactionFailures)
	return TestCleanup.of({
		transfer,
		ensure,
		request,
		load,
		current,
		tick,
		pendingGrant,
		complete,
		authorize,
		serviceAuthorize: (key: Key) => load(key).pipe(Effect.asVoid),
	})
})

export const layer = Layer.effect(TestCleanup, make)
