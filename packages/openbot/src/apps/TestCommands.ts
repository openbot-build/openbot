import { and, eq } from "drizzle-orm"
import { developerTests } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import * as GrantCleanup from "./GrantCleanup.ts"
import {
	Authorization as OAuth,
	OAuthAuthorization,
	Store as Protocol,
} from "@openbot-build/protocol"
import { DeveloperTestStores } from "./DeveloperTestStores.ts"
import {
	Authorization,
	Caller,
	Developers,
	Execution,
	executionCallers,
	type ExecutionIdentity,
} from "@openbot-build/domain"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Schema,
	Option,
	Redacted,
	Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import * as Check from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import type { Authorize } from "../execution/Engine.ts"
import { Observation } from "../execution/Observation.ts"
import type { End } from "../execution/Program.ts"
import {
	Store,
	transactionFailures,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import { DeveloperAccess } from "./DeveloperAccess.ts"
import * as Rows from "./DeveloperRows.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import { ownerKey } from "./StoredConnections.ts"

export const workflowName = "openbot.developer-test"
export const Action = Schema.TaggedUnion({
	Run: {},
	Exchange: {},
	Prepare: {
		issuer: Schema.optionalKey(Schema.String),
		scopes: Schema.Array(Schema.String),
	},
})
export const Exchange = Schema.Struct({
	connection: Protocol.UserConnection,
	flow: OAuth.Flow,
	callback: Schema.Redacted(Schema.String),
})
export type Exchange = typeof Exchange.Type
const Reference = Schema.Struct({
	testId: Schema.String,
	action: Action,
	exchange: Schema.optionalKey(Exchange),
})
const referenceCodec = Schema.toCodecJson(Reference)
export const callbackBinding = (
	owner: string,
	testId: string,
	flowId: string,
) =>
	Schema.encodeEffect(
		Schema.fromJsonString(
			Schema.Tuple([
				Schema.Literal("developer-callback"),
				Schema.String,
				Schema.String,
				Schema.String,
			]),
		),
	)(["developer-callback", owner, testId, flowId])
const running = (action: typeof Action.Type) =>
	action._tag === "Run"
		? ("Running" as const)
		: action._tag === "Prepare"
			? ("PreparingAuthorization" as const)
			: ("ExchangingAuthorization" as const)

export const Preparation = Schema.Struct({
	flow: OAuth.Flow,
	authorizationUrl: Schema.String,
})
export type Preparation = typeof Preparation.Type
export const Result = Schema.TaggedUnion({
	Completed: { stages: Schema.Array(Developers.TestStage) },
	Failed: { stages: Schema.Array(Developers.TestStage), reason: Schema.String },
	AwaitingAuthorization: {
		stages: Schema.Array(Developers.TestStage),
		issuers: Schema.Array(Schema.String),
		scopes: Schema.Array(Schema.String),
		resourceMetadataUrl: Schema.optionalKey(Schema.String),
	},
})
export type Result = typeof Result.Type
const actorCodec = Schema.fromJsonString(Caller)
const actorBinding = (owner: string, id: string) =>
	Schema.encodeEffect(
		Schema.fromJsonString(
			Schema.Tuple([
				Schema.Literal("developer-flow-actor"),
				Schema.String,
				Schema.String,
			]),
		),
	)(["developer-flow-actor", owner, id])
const sameCaller = Schema.toEquivalence(Caller)
const make = Effect.gen(function* () {
	const db = yield* Db.make
	const namespace = yield* IndexNamespace
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const observation = yield* Observation
	const checks = yield* Check.make
	const access = yield* DeveloperAccess
	const tests = yield* DeveloperTestStores
	const secrets = yield* Secrets
	const grants = yield* GrantCleanup.GrantCleanup
	const owned = (owner: string, id: string, lock = false) =>
		Rows.getTest(db, namespace, id, lock).pipe(
			Effect.filterOrElse(
				(record) => record.owner === owner,
				() => Developers.DeveloperNotFound.make({}),
			),
		)
	const check = (actor: Caller, record: Rows.TestRecord) =>
		Effect.gen(function* () {
			yield* checks.check(actor, {
				action: "publish",
				resource: Authorization.App.make({
					organizationId: actor.organizationId,
					ownerUserId: actor.userId,
				}),
			})
			yield* access.authorize(ownerKey(actor), record.value.cardUrl, true)
		}).pipe(
			Effect.catchTags({
				Forbidden: () => Effect.fail(Execution.Forbidden.make({})),
				Pending: () => Effect.fail(Execution.Forbidden.make({})),
				PolicyUnavailable: (cause) =>
					Effect.fail(Execution.StorageError.make({ cause })),
			}),
		)
	const editable = (record: Rows.TestRecord) =>
		Effect.gen(function* () {
			if (record.value.expiresAt <= (yield* Clock.currentTimeMillis))
				return yield* Developers.DeveloperConflict.make({
					reason: "TestExpired",
				})
			if (
				record.value.cleanup === "Pending" ||
				record.value.status === "Cancelled"
			)
				return yield* Developers.DeveloperConflict.make({
					reason: "TestStopped",
				})
		})
	const load = (key: Key, lock = false) =>
		Effect.gen(function* () {
			const saved = yield* store.loadMember(key)
			const ref = yield* Schema.decodeEffect(referenceCodec)(saved.input).pipe(
				Effect.orDie,
			)
			if (
				saved.workflow !== workflowName ||
				saved.record.resource.kind !== "DeveloperTest" ||
				saved.record.resource.id !== ref.testId ||
				key.namespace !== ownerKey(saved.identity.owner)
			)
				return yield* Execution.Forbidden.make({})
			const record = yield* owned(key.namespace, ref.testId, lock)
			return { saved, record, action: ref.action, exchange: ref.exchange }
		})
	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const { saved, record, action } = yield* load(key)
			if (
				ownerKey(actor) !== key.namespace ||
				((mode === "advance" || mode === "replay") &&
					!sameCaller(actor, saved.identity.actor))
			)
				return yield* Execution.Forbidden.make({})
			yield* check(actor, record)
			if (mode === "advance" || mode === "replay") {
				yield* editable(record)
				for (const caller of executionCallers(saved.identity))
					yield* check(caller, record)
				if (
					record.value.executionId !== key.id ||
					record.value.status !== running(action)
				)
					return yield* Execution.Forbidden.make({})
			}
		}).pipe(
			Effect.catchTags({
				DeveloperNotFound: () =>
					Effect.fail(Execution.NotFound.make({ id: key.id })),
				DeveloperForbidden: () => Effect.fail(Execution.Forbidden.make({})),
				DeveloperConflict: () => Effect.fail(Execution.Forbidden.make({})),
				DeveloperInputInvalid: () => Effect.fail(Execution.Forbidden.make({})),
				ExecutionConflict: () => Effect.fail(Execution.Forbidden.make({})),
				ExecutionKeyConflict: () => Effect.fail(Execution.Forbidden.make({})),
				DeveloperRestricted: () => Effect.fail(Execution.Forbidden.make({})),
				DeveloperUnavailable: (cause) =>
					Effect.fail(Execution.StorageError.make({ cause })),
				SchemaError: Effect.die,
			}),
		)
	const available = (owner: string, id: string) =>
		Effect.gen(function* () {
			const row = (yield* db
				.select({ executionId: developerTests.grantCleanupExecutionId })
				.from(developerTests)
				.where(
					and(
						eq(developerTests.namespace, namespace),
						eq(developerTests.owner, owner),
						eq(developerTests.id, id),
					),
				)
				.pipe(transactionFailures))[0]
			if (row?.executionId != null)
				return yield* Developers.DeveloperConflict.make({ reason: "TestBusy" })
		})
	const submit = (
		actor: Caller,
		testId: string,
		commandKey: Execution.CommandKey,
		action: typeof Action.Type,
	) =>
		Effect.gen(function* () {
			yield* check(actor, yield* owned(ownerKey(actor), testId))
			return yield* store.accept(
				ownerKey(actor),
				commandKey,
				{ actor, body: { kind: "developer-test", testId, action } },
				(create) =>
					Effect.gen(function* () {
						const record = yield* owned(ownerKey(actor), testId, true)
						yield* check(actor, record)
						yield* editable(record)
						yield* available(record.owner, testId)
						if (
							record.value.status === "Running" ||
							record.value.status === "PreparingAuthorization" ||
							record.value.status === "ExchangingAuthorization" ||
							record.value.authorization?.status === "Exchanging"
						)
							return yield* Developers.DeveloperConflict.make({
								reason: "TestBusy",
							})
						if (record.value.endpoint === null)
							return yield* Developers.DeveloperConflict.make({
								reason: "ConfigurationRequired",
							})
						if (action._tag === "Prepare") {
							if (record.value.status !== "AwaitingAuthorization")
								return yield* Developers.DeveloperConflict.make({
									reason: "AuthorizationNotRequired",
								})
							const authorization = record.value.authorization
							if (
								authorization !== null &&
								["Waiting", "Received"].includes(authorization.status) &&
								authorization.expiresAt > (yield* Clock.currentTimeMillis)
							)
								return yield* Developers.DeveloperConflict.make({
									reason: "AuthorizationPending",
								})
						}

						let exchange: Exchange | undefined
						let constraints: ExecutionIdentity["constraints"]
						if (action._tag === "Exchange") {
							const authorization = record.value.authorization
							if (authorization?.status !== "Received")
								return yield* Developers.DeveloperConflict.make({
									reason: "AuthorizationNotReceived",
								})
							const flow = yield* Rows.getFlow(
								db,
								namespace,
								authorization.flowId,
								true,
							)
							if (
								flow.owner !== record.owner ||
								flow.testId !== testId ||
								flow.callback === null ||
								flow.actor == null ||
								flow.consumed ||
								flow.value.expiresAt <= (yield* Clock.currentTimeMillis)
							)
								return yield* Developers.DeveloperConflict.make({
									reason: "AuthorizationFlowUnavailable",
								})
							const original = yield* secrets
								.open(
									flow.actor,
									yield* actorBinding(record.owner, flow.value.flowId),
								)
								.pipe(Effect.flatMap(Schema.decodeEffect(actorCodec)))
							if (ownerKey(original) !== record.owner)
								return yield* Execution.Forbidden.make({})
							yield* check(original, record)
							constraints = [original]
							const bound = tests.bind(record.owner, testId)
							const connection = yield* bound.apps
								.get({ owner: record.owner, connectionId: testId })
								.pipe(
									Effect.mapError((cause) =>
										Execution.StorageError.make({ cause }),
									),
								)
							const savedFlow = yield* bound.flows
								.get({ key: connection, flowId: flow.value.flowId })
								.pipe(
									Effect.mapError((cause) =>
										Execution.StorageError.make({ cause }),
									),
								)
							const callback = yield* secrets.open(
								flow.callback,
								yield* callbackBinding(record.owner, testId, flow.value.flowId),
							)
							yield* OAuthAuthorization.validateCallback(
								connection,
								savedFlow,
								callback,
							).pipe(
								Effect.mapError((cause) =>
									Execution.StorageError.make({ cause }),
								),
							)
							exchange = {
								connection,
								flow: savedFlow,
								callback: Redacted.make(callback),
							}
							yield* Rows.putFlow(db, namespace, {
								...flow,
								consumed: true,
								callback: null,
								value: { ...flow.value, status: "Exchanging" },
							})
						}
						const key = yield* create({
							workflow: workflowName,
							identity: {
								owner: {
									organizationId: actor.organizationId,
									userId: actor.userId,
								},
								actor,
								...(constraints === undefined ? {} : { constraints }),
							},
							resource: { kind: "DeveloperTest", id: testId },
							input: yield* Schema.encodeEffect(referenceCodec)({
								testId,
								action,
								...(exchange === undefined ? {} : { exchange }),
							}),
						})
						yield* Rows.putTest(db, namespace, {
							...record,
							value: {
								...record.value,
								executionId: key.id,
								status: running(action),
								authorization:
									action._tag === "Exchange" &&
									record.value.authorization !== null
										? { ...record.value.authorization, status: "Exchanging" }
										: record.value.authorization,
								stages:
									action._tag !== "Run"
										? record.value.stages
										: Arr.filter(
												record.value.stages,
												(stage) => stage.name === "configuration",
											),
								reason: null,
							},
						})
						return { executionId: key.id, start: true }
					}),
			)
		}).pipe(
			Effect.catchTag("SecretStorageError", (cause) =>
				Effect.fail(Execution.StorageError.make({ cause })),
			),
		)
	const progress = (
		fence: Fence,
		stages: ReadonlyArray<Developers.TestStage>,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { record, saved, action } = yield* load(fence, true)
					if (action._tag !== "Run")
						return yield* Execution.Conflict.make({ id: fence.id })
					yield* authorize(fence, saved.identity.actor, "advance")
					yield* store.commit(
						fence,
						{
							events: [
								{
									_tag: "Checkpoint",
									resource: saved.record.resource,
									revision: stages.length,
								},
							],
						},
						Rows.putTest(db, namespace, {
							...record,
							value: {
								...record.value,
								stages: [
									...Arr.filter(
										record.value.stages,
										(stage) => stage.name === "configuration",
									),
									...stages,
								],
							},
						}),
					)
				}),
			)
			.pipe(
				transactionFailures,
				Effect.catchTag("SecretStorageError", (cause) =>
					Effect.fail(Execution.StorageError.make({ cause })),
				),
			)
	const complete = (fence: Fence, result: Result) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { record, saved, action } = yield* load(fence, true)
					if (action._tag !== "Run")
						return yield* Execution.Conflict.make({ id: fence.id })
					yield* authorize(fence, saved.identity.actor, "advance")
					const checkedAt = yield* Clock.currentTimeMillis
					yield* store.commit(
						fence,
						{
							status: "completed",
							events: [{ _tag: "Result", resource: saved.record.resource }],
						},
						Rows.putTest(db, namespace, {
							...record,
							...(result._tag === "AwaitingAuthorization"
								? { resourceMetadataUrl: result.resourceMetadataUrl ?? null }
								: {}),
							value: {
								...record.value,
								checkedAt,
								status:
									result._tag === "Completed"
										? "Succeeded"
										: result._tag === "Failed"
											? "Failed"
											: "AwaitingAuthorization",
								stages: [
									...Arr.filter(
										record.value.stages,
										(stage) => stage.name === "configuration",
									),
									...result.stages,
								],
								reason: result._tag === "Failed" ? result.reason : null,
								...(result._tag === "AwaitingAuthorization"
									? { issuers: result.issuers, requestedScopes: result.scopes }
									: {}),
							},
						}),
					)
				}),
			)
			.pipe(
				transactionFailures,
				Effect.catchTag("SecretStorageError", (cause) =>
					Effect.fail(Execution.StorageError.make({ cause })),
				),
			)
	const prepared = (fence: Fence, prepared: Preparation) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { record, saved, action } = yield* load(fence, true)
					if (action._tag !== "Prepare")
						return yield* Execution.Conflict.make({ id: fence.id })
					yield* authorize(fence, saved.identity.actor, "advance")
					if (prepared.flow.expiresAt <= (yield* Clock.currentTimeMillis))
						return yield* Developers.DeveloperConflict.make({
							reason: "AuthorizationExpired",
						})
					yield* store.commit(
						fence,
						{
							status: "completed",
							events: [{ _tag: "Result", resource: saved.record.resource }],
						},
						Effect.gen(function* () {
							yield* tests
								.bind(record.owner, record.value.id)
								.flows.save(prepared.flow)
								.pipe(
									Effect.mapError((cause) =>
										Execution.StorageError.make({ cause }),
									),
								)
							const flow = yield* Rows.getFlow(
								db,
								namespace,
								prepared.flow.flowId,
							)
							const authorization = {
								...flow.value,
								authorizationUrl: prepared.authorizationUrl,
							}
							yield* Rows.putFlow(db, namespace, {
								...flow,
								actor: yield* secrets.seal(
									yield* Schema.encodeEffect(actorCodec)(saved.identity.actor),
									yield* actorBinding(record.owner, flow.value.flowId),
								),
								value: authorization,
							})
							yield* Rows.putTest(db, namespace, {
								...record,
								value: {
									...record.value,
									status: "AwaitingAuthorization",
									authorization,
									reason: null,
								},
							})
						}),
					)
				}),
			)
			.pipe(transactionFailures)

	const exchanged = (
		fence: Fence,
		callId: Execution.CallId,
		grant: OAuthAuthorization.Grant,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { record, saved, exchange, action } = yield* load(fence, true)
					if (action._tag !== "Exchange" || exchange === undefined)
						return yield* Execution.Conflict.make({ id: fence.id })
					yield* authorize(fence, saved.identity.actor, "advance")
					const call = yield* store.latestCall(fence, "exchange")
					if (
						Option.isNone(call) ||
						call.value.id !== callId ||
						call.value.status !== "completed" ||
						!Schema.toEquivalence(Schema.Json)(
							call.value.result,
							yield* Schema.encodeEffect(
								Schema.toCodecJson(OAuthAuthorization.Grant),
							)(grant),
						) ||
						!Schema.toEquivalence(Protocol.CredentialBinding)(
							grant.credential.binding,
							exchange.flow.binding,
						)
					)
						return yield* Execution.Conflict.make({ id: fence.id })
					yield* grants.assertInstallable(
						GrantCleanup.scopeOf(grant.credential),
					)
					yield* store.commit(
						fence,
						{
							status: "completed",
							events: [
								GrantCleanup.installed(callId),
								{ _tag: "Result", resource: saved.record.resource },
							],
						},
						Effect.gen(function* () {
							const bound = tests.bind(record.owner, record.value.id)
							const reference = yield* bound.credentials
								.put(grant.credential)
								.pipe(
									Effect.mapError((cause) =>
										Execution.StorageError.make({ cause }),
									),
								)
							yield* bound.apps
								.update({
									key: exchange.connection,
									change: (current) => ({
										...current,
										authorization: {
											_tag: "Authorized",
											binding: grant.credential.binding,
											credentialRef: reference,
											scopes: grant.credential.scopes,
											...(grant.resourceMetadataUrl === undefined
												? {}
												: { resourceMetadataUrl: grant.resourceMetadataUrl }),
										},
									}),
								})
								.pipe(
									Effect.mapError((cause) =>
										Execution.StorageError.make({ cause }),
									),
								)
							const flow = yield* Rows.getFlow(
								db,
								namespace,
								exchange.flow.flowId,
							)
							const authorization = {
								...flow.value,
								status: "Succeeded" as const,
							}
							yield* Rows.putFlow(db, namespace, {
								...flow,
								body: null,
								callback: null,
								value: authorization,
							})
							yield* Rows.putTest(db, namespace, {
								...record,
								value: {
									...record.value,
									status: "Queued",
									authorization,
									cleanupRemote: "Pending",
									reason: null,
								},
							})
						}),
					)
				}),
			)
			.pipe(transactionFailures)

	const finish = (fence: Fence, end: End) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { record, saved, action } = yield* load(fence, true)
					if (record.value.executionId !== fence.id)
						return yield* Execution.Conflict.make({ id: fence.id })
					const write = Effect.gen(function* () {
						let authorization = record.value.authorization
						if (action._tag === "Exchange" && authorization !== null) {
							authorization = { ...authorization, status: "Failed" }
							const flow = yield* Rows.getFlow(
								db,
								namespace,
								authorization.flowId,
							)
							yield* Rows.putFlow(db, namespace, {
								...flow,
								body: null,
								callback: null,
								value: authorization,
							})
						}
						yield* Rows.putTest(db, namespace, {
							...record,
							value: {
								...record.value,
								authorization,
								status:
									record.value.cleanup === "Pending"
										? "Cancelling"
										: end.status === "cancelled"
											? "Cancelled"
											: action._tag !== "Run"
												? "AwaitingAuthorization"
												: "Interrupted",
								reason:
									end.status === "failed"
										? end.failure.category
										: end.status === "interrupted"
											? "ExecutionInterrupted"
											: null,
							},
						})
					})
					if (end.status === "cancelled")
						yield* store.finishCancellation(fence, end.epoch, () =>
							write.pipe(
								Effect.as([
									{ _tag: "Result" as const, resource: saved.record.resource },
								]),
							),
						)
					else
						yield* store.commit(
							fence,
							{
								status: end.status,
								...(end.status === "failed" ? { failure: end.failure } : {}),
							},
							write,
						)
				}),
			)
			.pipe(transactionFailures, Effect.asVoid)
	/** Cleanup can run after the member loses access. The owned test fixes which execution it can stop. */
	const stop = (owner: string, testId: string) =>
		Effect.gen(function* () {
			const record = yield* owned(owner, testId)
			if (record.value.executionId === undefined) return
			const key = { namespace: owner, id: record.value.executionId }
			const linked = yield* store.load(key)
			if (
				linked.record.resource.kind !== "DeveloperTest" ||
				linked.record.resource.id !== testId
			)
				return yield* Execution.Forbidden.make({})
			if (Execution.isTerminal(linked.record.status)) return
			if (
				linked.workflow === "openbot.imported-record" &&
				linked.identity.actor.kind === "service" &&
				linked.identity.actor.serviceId === "data-upgrade" &&
				linked.record.resource.kind === "DeveloperTest" &&
				linked.record.resource.id === testId
			) {
				// An imported unknown send keeps its decision. Cleanup cannot invent its old caller.
				return yield* observation.observe(key, 0).pipe(Stream.runDrain)
			}
			const { saved } = yield* load(key)
			if (!Execution.isTerminal(saved.record.status))
				yield* store
					.cancel(
						key,
						Execution.CommandKey.make("test-cleanup:" + key.id),
						saved.identity.actor,
					)
					.pipe(
						Effect.catchTag("ExecutionConflict", (error) =>
							store
								.get(key)
								.pipe(
									Effect.flatMap((state) =>
										Execution.isTerminal(state.status)
											? Effect.void
											: Effect.fail(error),
									),
								),
						),
					)
			yield* observation.observe(key, 0).pipe(Stream.runDrain)
		})
	return {
		request: (actor: Caller, testId: string, key: Execution.CommandKey) =>
			submit(actor, testId, key, { _tag: "Run" }),
		prepare: (
			actor: Caller,
			testId: string,
			input: {
				readonly issuer?: string
				readonly scopes: ReadonlyArray<string>
			},
			key: Execution.CommandKey,
		) =>
			submit(actor, testId, key, {
				_tag: "Prepare",
				scopes: input.scopes,
				...(input.issuer === undefined ? {} : { issuer: input.issuer }),
			}),
		exchange: (actor: Caller, testId: string, key: Execution.CommandKey) =>
			submit(actor, testId, key, { _tag: "Exchange" }),
		available,
		exchanged,
		load,
		authorize,
		progress,
		complete,
		prepared,
		finish,
		stop,
	}
})
export class TestCommands extends Context.Service<
	TestCommands,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/TestCommands") {}
export const layer = Layer.effect(TestCommands, make)
