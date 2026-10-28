import {
	type Loaded,
	type MemberExecution,
	Store,
	storage,
	transactionFailures,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import {
	type Developers,
	Execution,
	ExecutionIdentity,
	ServiceIdentity,
	ServiceId,
} from "@openbot-build/domain"
import type { SecretStorageError } from "../secrets/Secrets.ts"
import * as GrantUses from "./GrantUses.ts"
import { IndexNamespace } from "./IndexNamespace.ts"
import * as Rows from "./DeveloperRows.ts"
import {
	Authorization,
	OAuthAuthorization,
	Store as Protocol,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect"
import { and, eq } from "drizzle-orm"
import { SqlClient } from "effect/sql"
import * as Db from "../database/Database.ts"
import { appConnections, developerTests } from "../database/Schema.ts"
import type { End } from "../execution/Program.ts"
import * as Observation from "../execution/Observation.ts"
import * as Connections from "./StoredConnections.ts"

export const workflowName = "openbot.app-grant-cleanup"
export const serviceId = ServiceId.make("app-grant-cleanup")
const Reference = Schema.Struct({
	sourceId: Execution.Id,
	callId: Execution.CallId,
	metadata: Authorization.ServerMetadata,
})
const Detached = Schema.TaggedStruct("Detached", {
	sourceId: Execution.Id,
	reference: Schema.String,
	credential: Protocol.Credential,
	metadata: Schema.optionalKey(Authorization.ServerMetadata),
	resourceMetadataUrl: Schema.optionalKey(Schema.String),
})
const inputCodec = Schema.toCodecJson(Schema.Union([Reference, Detached]))
const detachedId = (source: Key, reference: string) =>
	"detached:" + source.id + ":" + reference
const grantCodec = Schema.toCodecJson(OAuthAuthorization.Grant)
/** This event commits with installation. It remains after a connection is removed. */
export const installed = (
	callId: Execution.CallId,
): Extract<Execution.EventBody, { readonly _tag: "Checkpoint" }> => ({
	_tag: "Checkpoint",
	resource: { kind: "InstalledAppGrant", id: callId },
	revision: 0,
})
export const GrantScope = GrantUses.Scope
export type GrantScope = GrantUses.Scope
export const scopeOf = GrantUses.scopeOf
const organizationOf = (identity: ExecutionIdentity | ServiceIdentity) =>
	Schema.is(ExecutionIdentity)(identity)
		? identity.owner.organizationId
		: identity.owner.kind === "organization"
			? identity.owner.organizationId
			: null
export interface Service {
	readonly enqueue: (
		source: Key,
		callId: Execution.CallId,
		metadata: Authorization.ServerMetadata,
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.StorageError
	>
	readonly handoff: (
		source: Key,
		reference: string,
		credential: Protocol.Credential,
		options?: {
			readonly metadata?: Authorization.ServerMetadata
			readonly resourceMetadataUrl?: string
		},
	) => Effect.Effect<
		Execution.Receipt,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Developers.StorageFailure
	>
	readonly assertInstallable: (
		scope: GrantScope,
	) => Effect.Effect<undefined, Execution.Conflict | Developers.StorageFailure>
	readonly writeAttempt: (
		fence: Fence,
		step: "exchange" | "refresh",
		input: Schema.Json,
		scope: GrantScope,
	) => Effect.Effect<
		Execution.Call,
		Execution.Conflict | Execution.NotFound | Developers.StorageFailure
	>
	readonly load: (key: Key) => Effect.Effect<
		| {
				detached: true
				ref: typeof Detached.Type
				sourceKey: { namespace: string; id: Execution.Id }
				source: Loaded
				grant: { credential: Protocol.Credential; resourceMetadataUrl?: string }
		  }
		| {
				detached: false
				ref: typeof Reference.Type
				sourceKey: { namespace: string; id: Execution.Id }
				source: MemberExecution
				grant: OAuthAuthorization.Grant
		  },
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly claim: (fence: Fence) => Effect.Effect<
		| {
				key: { namespace: string; id: Execution.Id }
				sequence: number
				_tag: "Wait"
		  }
		| { _tag: "InUse" }
		| {
				_tag: "Revoke"
				grant: { credential: Protocol.Credential; resourceMetadataUrl?: string }
				metadata: Authorization.ServerMetadata | undefined
		  }
		| { _tag: "Retained"; grant?: never; metadata?: never }
		| {
				_tag: "Revoke"
				grant: OAuthAuthorization.Grant
				metadata: Authorization.ServerMetadata
		  },
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly finish: (
		fence: Fence,
		outcome: End | { readonly status: "completed" },
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly complete: (
		fence: Fence,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly authorize: (
		key: Key,
	) => Effect.Effect<
		void,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
}

export class GrantCleanup extends Context.Service<GrantCleanup, Service>()(
	"@openbot-build/openbot/apps/GrantCleanup",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const store = yield* Store
	const uses = yield* GrantUses.make
	const indexNamespace = yield* IndexNamespace
	const observation = yield* Observation.Observation
	/** Call only from Calls.onResult, in the result transaction. */
	const enqueue = (
		source: Key,
		callId: Execution.CallId,
		metadata: Authorization.ServerMetadata,
	) =>
		Effect.gen(function* () {
			const organizationId = organizationOf(
				(yield* store.load(source)).identity,
			)
			if (organizationId === null) return yield* Execution.Forbidden.make({})
			return yield* store.submit(
				source.namespace,
				Execution.CommandKey.make("grant-cleanup:" + callId),
				{
					workflow: workflowName,
					identity: {
						owner: { kind: "organization", organizationId },
						actor: { kind: "service", serviceId },
					},
					resource: { kind: "AppGrant", id: callId },
					input: { sourceId: source.id, callId, metadata },
				},
			)
		})
	/** Call in the transaction that drops the local credential reference. */
	const handoff = (
		source: Key,
		reference: string,
		credential: Protocol.Credential,
		options: {
			readonly metadata?: Authorization.ServerMetadata
			readonly resourceMetadataUrl?: string
		} = {},
	) =>
		Effect.gen(function* () {
			if (credential.binding.owner !== source.namespace)
				return yield* Execution.Forbidden.make({})
			const organizationId = organizationOf(
				(yield* store.load(source)).identity,
			)
			if (organizationId === null) return yield* Execution.Forbidden.make({})
			return yield* store.submit(
				source.namespace,
				Execution.CommandKey.make(
					"grant-cleanup:" + detachedId(source, reference),
				),
				{
					workflow: workflowName,
					identity: {
						owner: { kind: "organization", organizationId },
						actor: { kind: "service", serviceId },
					},
					resource: { kind: "AppGrant", id: detachedId(source, reference) },
					// Store seals this input. Engine messages contain only its execution key.
					input: yield* Schema.encodeEffect(inputCodec)({
						_tag: "Detached",
						sourceId: source.id,
						reference,
						credential,
						...options,
					}),
				},
			)
		})
	const load = (key: Key) =>
		Effect.gen(function* () {
			const saved = yield* store.loadService(key, serviceId)
			const ref = yield* Schema.decodeEffect(inputCodec)(saved.input).pipe(
				Effect.orDie,
			)
			if ("_tag" in ref) {
				const sourceKey = { namespace: key.namespace, id: ref.sourceId }
				const source = yield* store.load(sourceKey)
				if (
					saved.workflow !== workflowName ||
					saved.identity.owner.kind !== "organization" ||
					saved.identity.owner.organizationId !==
						organizationOf(source.identity) ||
					saved.record.resource.kind !== "AppGrant" ||
					saved.record.resource.id !== detachedId(sourceKey, ref.reference) ||
					ref.credential.binding.owner !== key.namespace ||
					ref.credential.binding.connectionId !== source.record.resource.id ||
					!(
						(source.workflow === "openbot.app-authorization" &&
							source.record.resource.kind === "AppAuthorization" &&
							Schema.is(ExecutionIdentity)(source.identity) &&
							Connections.ownerKey(source.identity.owner) === key.namespace) ||
						(source.workflow === "openbot.app-connection" &&
							source.record.resource.kind === "AppConnection" &&
							source.identity.actor.kind !== "service" &&
							Connections.ownerKey(source.identity.actor) === key.namespace) ||
						(source.workflow === "openbot.developer-test-cleanup" &&
							source.record.resource.kind === "DeveloperTestCleanup" &&
							Schema.is(ServiceIdentity)(source.identity) &&
							source.identity.actor.serviceId === "developer-test-cleanup" &&
							source.identity.owner.kind === "organization" &&
							source.identity.owner.organizationId ===
								(yield* Rows.identityOf(key.namespace).pipe(Effect.orDie))
									.organizationId)
					) ||
					(ref.metadata !== undefined &&
						ref.metadata.issuer !== ref.credential.binding.issuer)
				)
					return yield* Execution.Forbidden.make({})
				return {
					detached: true as const,
					ref,
					sourceKey,
					source,
					grant: {
						credential: ref.credential,
						...(ref.resourceMetadataUrl === undefined
							? {}
							: {
									resourceMetadataUrl: ref.resourceMetadataUrl,
								}),
					},
				}
			}
			if (
				saved.workflow !== workflowName ||
				saved.identity.owner.kind !== "organization" ||
				saved.record.resource.kind !== "AppGrant" ||
				saved.record.resource.id !== ref.callId
			)
				return yield* Execution.Forbidden.make({})
			const sourceKey = { namespace: key.namespace, id: ref.sourceId }
			const source = yield* store.loadMember(sourceKey)
			if (
				saved.identity.owner.organizationId !==
					source.identity.owner.organizationId ||
				!(
					(source.workflow === "openbot.app-authorization" &&
						source.record.resource.kind === "AppAuthorization") ||
					(source.workflow === "openbot.developer-test" &&
						source.record.resource.kind === "DeveloperTest")
				) ||
				Connections.ownerKey(source.identity.owner) !== key.namespace
			)
				return yield* Execution.Forbidden.make({})
			const call = yield* store.call(sourceKey, ref.callId)
			if (
				Option.isNone(call) ||
				call.value.status !== "completed" ||
				(call.value.step !== "exchange" && call.value.step !== "refresh")
			)
				return yield* Execution.Forbidden.make({})
			const grant = yield* Schema.decodeEffect(grantCodec)(
				call.value.result,
			).pipe(Effect.orDie)
			if (
				grant.credential.binding.owner !== key.namespace ||
				grant.credential.binding.connectionId !== source.record.resource.id ||
				grant.credential.binding.issuer !== ref.metadata.issuer
			)
				return yield* Execution.Forbidden.make({})
			return { detached: false as const, ref, sourceKey, source, grant }
		})
	/** Call in the installation transaction, after locking the business row. */
	const assertInstallable = (scope: GrantScope) =>
		Effect.gen(function* () {
			yield* uses.lock(scope)
			const held = yield* uses.pending(scope, "revoke")
			if (Option.isSome(held))
				return yield* Execution.Conflict.make({ id: held.value.key.id })
		})
	/** Reserve the grant family before saving intent. A grant send uses this method. */
	const writeAttempt = (
		fence: Fence,
		step: "exchange" | "refresh",
		input: Schema.Json,
		scope: GrantScope,
	) =>
		Effect.gen(function* () {
			while (true) {
				const next = yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* uses.lock(scope)
							const held = yield* uses.pending(scope, "revoke")
							if (Option.isSome(held))
								return { _tag: "Wait" as const, ...held.value }
							const call = yield* store.writeAttempt(fence, step, {
								input,
								grantScope: scope,
							})
							yield* uses.reserve(fence, "send", call.id, scope)
							return { _tag: "Ready" as const, call }
						}),
					)
					.pipe(transactionFailures)
				if (next._tag === "Ready") return next.call
				yield* observation
					.observe(next.key, next.sequence)
					.pipe(Stream.runDrain)
			}
		})
	const reserveRevocation = (fence: Fence, credential: Protocol.Credential) =>
		Effect.gen(function* () {
			const scope = scopeOf(credential)
			yield* uses.lock(scope)
			const held = yield* uses.pending(scope, "revoke", fence)
			if (Option.isSome(held)) return { _tag: "Wait" as const, ...held.value }
			const sending = yield* uses.pending(scope, "send")
			if (Option.isSome(sending))
				return { _tag: "Wait" as const, ...sending.value }
			if (yield* uses.inUse(scope)) return { _tag: "InUse" as const }
			const prior = yield* store.firstCall(fence, "revoke")
			if (
				Option.isNone(prior) &&
				(yield* store.get(fence)).status === "waiting"
			)
				yield* store.commit(fence, { status: "running" }, Effect.void)
			const call = Option.isSome(prior)
				? prior.value
				: yield* store.writeAttempt(
						fence,
						"revoke",
						{ grantScope: scope },
						"idempotent",
					)
			yield* uses.reserve(fence, "revoke", call.id, scope)

			return { _tag: "Ready" as const }
		})
	const wasInstalled = (source: Key, callId: Execution.CallId) =>
		Effect.gen(function* () {
			let cursor = 0
			while (true) {
				const events = yield* store.events(source, cursor)
				if (
					Arr.some(
						events,
						(event) =>
							event.body._tag === "Checkpoint" &&
							event.body.resource.kind === "InstalledAppGrant" &&
							event.body.resource.id === callId,
					)
				)
					return true
				if (events.length < 128) return false
				if (Arr.isReadonlyArrayNonEmpty(events))
					cursor = Arr.lastNonEmpty(events).sequence
			}
		})
	const claim = (fence: Fence) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const input = yield* load(fence)
					if (input.detached) {
						yield* store.guard(fence)
						const active = yield* store.load(fence)
						if (
							(active.record.status !== "running" &&
								active.record.status !== "waiting") ||
							active.phaseFailed
						)
							return yield* Execution.Conflict.make({ id: fence.id })
						const permit = yield* reserveRevocation(
							fence,
							input.grant.credential,
						)
						if (permit._tag !== "Ready") return permit
						return {
							_tag: "Revoke" as const,
							grant: input.grant,
							metadata: input.ref.metadata,
						}
					}
					const { grant, sourceKey, source, ref } = input
					if (!Execution.isTerminal(source.record.status))
						return {
							_tag: "Wait" as const,
							key: sourceKey,
							sequence: source.record.sequence,
						}
					if (yield* wasInstalled(sourceKey, ref.callId))
						return { _tag: "Retained" as const }
					const id = grant.credential.binding.connectionId
					if (source.record.resource.kind === "DeveloperTest") {
						const row = (yield* storage(
							db
								.select()
								.from(developerTests)
								.where(
									and(
										eq(developerTests.namespace, indexNamespace),
										eq(developerTests.owner, fence.namespace),
										eq(developerTests.id, id),
									),
								)
								.for("update"),
						))[0]
						yield* store.guard(fence)
						const active = yield* store.load(fence)
						if (
							(active.record.status !== "running" &&
								active.record.status !== "waiting") ||
							active.phaseFailed
						)
							return yield* Execution.Conflict.make({ id: fence.id })
						if (row !== undefined) {
							const record = yield* Rows.decodeTest(row)
							for (const executionId of [
								row.grantCleanupExecutionId,
								record.value.executionId,
							]) {
								if (executionId == null || executionId === fence.id) continue
								const key = {
									namespace: fence.namespace,
									id: Execution.Id.make(executionId),
								}
								const execution = yield* store.get(key)
								if (!Execution.isTerminal(execution.status))
									return {
										_tag: "Wait" as const,
										key,
										sequence: execution.sequence,
									}
							}
							const permit = yield* reserveRevocation(fence, grant.credential)
							if (permit._tag !== "Ready") return permit
							yield* storage(
								db
									.update(developerTests)
									.set({ grantCleanupExecutionId: fence.id })
									.where(
										and(
											eq(developerTests.namespace, indexNamespace),
											eq(developerTests.owner, fence.namespace),
											eq(developerTests.id, id),
										),
									),
							)
						}
						if (row === undefined) {
							const permit = yield* reserveRevocation(fence, grant.credential)
							if (permit._tag !== "Ready") return permit
						}
						return { _tag: "Revoke" as const, grant, metadata: ref.metadata }
					}
					const row = (yield* storage(
						db
							.select()
							.from(appConnections)
							.where(Connections.connectionWhere(fence.namespace, id))
							.for("update"),
					))[0]
					if (
						row !== undefined &&
						row.executionId !== null &&
						row.executionId !== fence.id
					) {
						const key = {
							namespace: fence.namespace,
							id: Execution.Id.make(row.executionId),
						}
						const active = yield* store.get(key)
						if (Execution.isTerminal(active.status))
							return yield* Execution.Conflict.make({ id: key.id })
						return { _tag: "Wait" as const, key, sequence: active.sequence }
					}
					yield* store.guard(fence)
					const active = yield* store.load(fence)
					if (
						(active.record.status !== "running" &&
							active.record.status !== "waiting") ||
						active.phaseFailed
					)
						return yield* Execution.Conflict.make({ id: fence.id })
					const permit = yield* reserveRevocation(fence, grant.credential)
					if (permit._tag !== "Ready") return permit
					if (row !== undefined) {
						// Keep the connection reserved across retries and process takeover.
						yield* storage(
							db
								.update(appConnections)
								.set({ executionId: fence.id })
								.where(Connections.connectionWhere(fence.namespace, id)),
						)
					}
					return { _tag: "Revoke" as const, grant, metadata: ref.metadata }
				}),
			)
			.pipe(transactionFailures)
	const end = (fence: Fence, outcome: End | { readonly status: "completed" }) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const input = yield* load(fence)
					if (input.detached) {
						if (outcome.status === "cancelled")
							yield* store.finishCancellation(fence, outcome.epoch, () =>
								Effect.succeed([]),
							)
						else
							yield* store.commit(
								fence,
								{
									status: outcome.status,
									events: [
										{
											_tag: "Result",
											resource: {
												kind: "AppGrant",
												id: detachedId(input.sourceKey, input.ref.reference),
											},
										},
									],
									...(outcome.status === "failed"
										? { failure: outcome.failure }
										: {}),
								},
								Effect.void,
							)
						return
					}
					const { grant, ref, source } = input
					const release =
						source.record.resource.kind === "DeveloperTest" ||
						source.record.resource.kind === "DeveloperTestCleanup"
							? storage(
									db
										.update(developerTests)
										.set({ grantCleanupExecutionId: null })
										.where(
											and(
												eq(developerTests.namespace, indexNamespace),
												eq(developerTests.owner, fence.namespace),
												eq(
													developerTests.id,
													grant.credential.binding.connectionId,
												),
												eq(developerTests.grantCleanupExecutionId, fence.id),
											),
										),
								)
							: storage(
									db
										.update(appConnections)
										.set({ executionId: null })
										.where(
											and(
												Connections.connectionWhere(
													fence.namespace,
													grant.credential.binding.connectionId,
												),
												eq(appConnections.executionId, fence.id),
											),
										),
								)
					// Acquire the resource before the execution, just as claim does.
					const lock =
						source.record.resource.kind === "DeveloperTest" ||
						source.record.resource.kind === "DeveloperTestCleanup"
							? storage(
									db
										.select({ id: developerTests.id })
										.from(developerTests)
										.where(
											and(
												eq(developerTests.namespace, indexNamespace),
												eq(developerTests.owner, fence.namespace),
												eq(
													developerTests.id,
													grant.credential.binding.connectionId,
												),
											),
										)
										.for("update"),
								)
							: storage(
									db
										.select({ id: appConnections.id })
										.from(appConnections)
										.where(
											Connections.connectionWhere(
												fence.namespace,
												grant.credential.binding.connectionId,
											),
										)
										.for("update"),
								)
					yield* lock
					const writes = release

					const events = [
						{
							_tag: "Result" as const,
							resource: {
								kind: "AppGrant",
								id: ref.callId,
							},
						},
					]
					if (outcome.status === "cancelled")
						yield* store.finishCancellation(fence, outcome.epoch, () =>
							writes.pipe(Effect.as(events)),
						)
					else
						yield* store.commit(
							fence,
							{
								status: outcome.status,
								events,
								...(outcome.status === "failed"
									? { failure: outcome.failure }
									: {}),
							},
							writes,
						)
				}),
			)
			.pipe(transactionFailures, Effect.asVoid)
	return GrantCleanup.of({
		enqueue,
		handoff,
		assertInstallable,
		writeAttempt,
		load,
		claim,
		finish: end,
		complete: (fence: Fence) => end(fence, { status: "completed" }),
		authorize: (key: Key) => load(key).pipe(Effect.asVoid),
	})
})

export const layer = Layer.effect(GrantCleanup, make).pipe(
	Layer.provide(Observation.layer),
)
