import {
	AppConnections,
	Authorization,
	Caller,
	ConnectionId,
	Execution,
	executionCallers,
} from "@openbot-build/domain"
import { Discovery, Store as Protocol } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Record as Rec,
	Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { and, eq, inArray } from "drizzle-orm"
import * as Check from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import {
	appAuthorizations,
	appConnections,
	appDrafts,
	appRecords,
	appSecrets,
} from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import {
	Store,
	storage,
	transactionFailures,
	type Fence,
	type Key,
} from "../execution/Store.ts"
import type { Authorize } from "../execution/Engine.ts"
import type { End } from "../execution/Program.ts"
import { Governance } from "./Governance.ts"
import * as DiscoveryService from "./Discovery.ts"
import * as GrantCleanup from "./GrantCleanup.ts"
import * as Connections from "./StoredConnections.ts"

export const workflowName = "openbot.app-connection"
export const Action = Schema.TaggedUnion({
	Verify: {},
	Update: { request: AppConnections.Update },
	Manual: { request: AppConnections.ManualUpdate },
	Revalidate: { request: AppConnections.Revalidation },
})
export type Action = typeof Action.Type
export const Input = Schema.Struct({
	action: Action,
	connection: Connections.StoredConnection,
	app: Protocol.AppRecord,
	credential: Schema.NullOr(Protocol.Credential),
	candidate: Schema.NullOr(Discovery.Candidate),
})
export type Input = typeof Input.Type
export const Prepared = Schema.Struct({
	connection: Connections.StoredConnection,
	app: Protocol.AppRecord,
	capabilities: Schema.NullOr(AppConnections.CapabilityLists),
	discardCredential: Schema.Boolean,
})
export type Prepared = typeof Prepared.Type
export const preparedCodec = Schema.toCodecJson(Prepared)
const inputCodec = Schema.toCodecJson(Input)
const connectionCodec = Schema.fromJsonString(
	Schema.toCodecJson(Connections.StoredConnection),
)
const credentialCodec = Schema.fromJsonString(
	Schema.toCodecJson(Protocol.Credential),
)
const sameCaller = Schema.toEquivalence(Caller)
const binding = (kind: string, owner: string, id: string) =>
	JSON.stringify([kind, owner, id])
const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const store = yield* Store
	const checks = yield* Check.make
	const governance = yield* Governance
	const rules = yield* Discovery.Rules
	const cleanup = yield* GrantCleanup.GrantCleanup
	const check = (
		actor: Caller,
		id: string,
		action: "read" | "write" = "write",
	) =>
		checks
			.check(actor, {
				action,
				resource: Authorization.Connection.make({
					organizationId: actor.organizationId,
					ownerUserId: actor.userId,
					id: ConnectionId.make(id),
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
	const connection = (owner: string, id: string, lock = false) =>
		Effect.gen(function* () {
			const query = db
				.select()
				.from(appConnections)
				.where(Connections.connectionWhere(owner, id))
			const row = (yield* storage(lock ? query.for("update") : query))[0]
			if (row === undefined)
				return yield* Execution.NotFound.make({ id: Execution.Id.make(id) })
			return {
				row,
				value: yield* Connections.openRecord(secrets, owner, id, row.body),
			}
		})
	const load = (key: Key) =>
		Effect.gen(function* () {
			const saved = yield* store.loadMember(key)
			const input = yield* Schema.decodeEffect(inputCodec)(saved.input).pipe(
				Effect.orDie,
			)
			if (
				saved.workflow !== workflowName ||
				Connections.ownerKey(saved.identity.owner) !== key.namespace ||
				saved.record.resource.kind !== "AppConnection" ||
				saved.record.resource.id !== input.connection.connection.connectionId
			)
				return yield* Execution.Forbidden.make({})
			return { saved, input }
		})
	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const { saved, input } = yield* load(key)
			if (
				Connections.ownerKey(actor) !== key.namespace ||
				((mode === "advance" || mode === "replay") &&
					!sameCaller(actor, saved.identity.actor))
			)
				return yield* Execution.Forbidden.make({})
			const id = saved.record.resource.id
			yield* check(actor, id, mode === "read" ? "read" : "write")
			if (mode === "advance" || mode === "replay") {
				for (const caller of executionCallers(saved.identity))
					yield* check(caller, id)
				// A member may still stop or rename a connection to a blocked App.
				if (input.action._tag !== "Update")
					yield* governance
						.check(
							input.action._tag === "Manual"
								? input.action.request.url
								: input.connection.connection.cardUrl,
						)
						.pipe(
							Effect.catchTags({
								AppRestricted: () => Effect.fail(Execution.Forbidden.make({})),
								ExperienceStorageUnavailable: (cause) =>
									Effect.fail(Execution.StorageError.make({ cause })),
							}),
						)
				const current = yield* connection(key.namespace, id)
				if (
					current.row.executionId !== key.id ||
					current.value.revision !== input.connection.revision
				)
					return yield* Execution.Forbidden.make({})
			}
		}).pipe(
			Effect.catchTag(["SecretStorageError", "SchemaError"], (cause) =>
				Effect.fail(Execution.StorageError.make({ cause })),
			),
		)
	const guard = (fence: Fence) =>
		Effect.gen(function* () {
			const loaded = yield* load(fence)
			const current = yield* connection(
				fence.namespace,
				loaded.saved.record.resource.id,
				true,
			)
			if (
				current.row.executionId !== fence.id ||
				current.value.revision !== loaded.input.connection.revision
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			return { ...loaded, current }
		})
	const start = (
		actor: Caller,
		id: string,
		action: Action,
		commandKey: Execution.CommandKey,
	) =>
		Effect.gen(function* () {
			const owner = Connections.ownerKey(actor)
			yield* check(actor, id)
			return yield* store.accept(
				owner,
				commandKey,
				{ actor, body: { id, action } },
				(create) =>
					Effect.gen(function* () {
						const current = yield* connection(owner, id, true)
						yield* check(actor, id)
						if (current.row.executionId !== null)
							return yield* Execution.Conflict.make({
								id: Execution.Id.make(current.row.executionId),
							})
						if (
							action._tag !== "Verify" &&
							action.request.revision !== current.value.revision
						)
							return yield* Execution.Conflict.make({
								id: Execution.Id.make(id),
							})
						if (current.value.connection.state === "CleanupPending")
							return yield* AppConnections.ConnectionCleanupPending.make({
								connectionId: ConnectionId.make(id),
								stage: "Connection",
								message: "Finish cleanup before changing this connection.",
							})
						const appRow = (yield* storage(
							db
								.select()
								.from(appRecords)
								.where(
									and(
										eq(appRecords.owner, owner),
										eq(appRecords.cardUrl, current.value.connection.cardUrl),
									),
								),
						))[0]
						if (appRow === undefined)
							return yield* Execution.NotFound.make({
								id: Execution.Id.make(id),
							})
						const app = yield* Schema.decodeEffect(Connections.appCodec)(
							appRow.body,
						)
						if (
							action._tag === "Manual" &&
							!Arr.some(app.sources, (source) => source.role === "manual")
						)
							return yield* Execution.Conflict.make({
								id: Execution.Id.make(id),
							})
						let candidate: Discovery.Candidate | null = null
						if (action._tag === "Revalidate") {
							const row = (yield* storage(
								db
									.select()
									.from(appDrafts)
									.where(Connections.draftWhere(owner, action.request.draftId)),
							))[0]
							if (row === undefined)
								return yield* Execution.NotFound.make({
									id: Execution.Id.make(action.request.draftId),
								})
							const draft = yield* Schema.decodeEffect(Connections.draftCodec)(
								row.body,
							)
							if (draft.expiresAt <= (yield* Clock.currentTimeMillis))
								return yield* AppConnections.ConnectionConflict.make({
									reason: "DraftExpired",
									message: "This draft expired. Discover the App again.",
								})
							const candidates =
								draft.discovery._tag === "Single"
									? [draft.discovery.candidate]
									: draft.discovery.candidates
							candidate = Option.getOrNull(
								Arr.findFirst(
									candidates,
									(value) => value.cardUrl === current.value.connection.cardUrl,
								),
							)
							if (candidate === null)
								return yield* AppConnections.ConnectionConfigurationInvalid.make(
									{ keys: [], message: "Use a draft for this App." },
								)
						}

						if (action._tag === "Revalidate" && candidate !== null)
							yield* rules
								.configureEndpoint({
									candidate,
									index: action.request.remoteIndex,
									values: action.request.values,
								})
								.pipe(
									Effect.catchTag(["DiscoveryError", "SchemaError"], (error) =>
										Effect.fail(
											AppConnections.ConnectionConfigurationInvalid.make({
												keys: DiscoveryService.configurationKeys(
													error,
													candidate!,
													action.request.remoteIndex,
												),
												message:
													"Complete the required configuration for the selected endpoint.",
											}),
										),
									),
								)
						if (action._tag === "Manual") {
							const previous = Redacted.value(current.value.connection.headers)
							const missing = Rec.keys(
								Rec.filter(
									action.request.headers,
									(value, name) =>
										value === null && previous[name] === undefined,
								),
							)
							if (missing.length > 0)
								return yield* AppConnections.ConnectionConfigurationInvalid.make(
									{
										keys: Arr.map(missing, (name) => "header:" + name),
										message: "Give a value for each new header.",
									},
								)
						}
						let credential: Protocol.Credential | null = null
						const auth = current.value.connection.authorization
						if (auth._tag === "Authorized") {
							const row = (yield* storage(
								db
									.select()
									.from(appSecrets)
									.where(
										and(
											eq(appSecrets.owner, owner),
											eq(appSecrets.kind, "credential"),
											eq(appSecrets.id, auth.credentialRef),
										),
									),
							))[0]
							if (row === undefined)
								return yield* Execution.NotFound.make({
									id: Execution.Id.make(auth.credentialRef),
								})
							credential = yield* secrets
								.open(row.body, binding("credential", owner, row.id))
								.pipe(Effect.flatMap(Schema.decodeEffect(credentialCodec)))
						}
						const key = yield* create({
							workflow: workflowName,
							identity: {
								owner: {
									organizationId: actor.organizationId,
									userId: actor.userId,
								},
								actor,
							},
							resource: { kind: "AppConnection", id },
							input: yield* Schema.encodeEffect(inputCodec)({
								action,
								connection: current.value,
								app,
								credential,
								candidate,
							}),
						})
						yield* storage(
							db
								.update(appConnections)
								.set({ executionId: key.id })
								.where(Connections.connectionWhere(owner, id)),
						)
						return { executionId: key.id, start: true }
					}),
			)
		})
	const write = (
		value: Connections.StoredConnection,
		executionId: string | null,
	) =>
		Effect.gen(function* () {
			const { owner, connectionId: id } = value.connection
			const body = yield* secrets.seal(
				yield* Schema.encodeEffect(connectionCodec)(value),
				binding("connection", owner, id),
			)
			yield* storage(
				db
					.update(appConnections)
					.set({
						body,
						name: value.name,
						revision: value.revision,
						executionId,
					})
					.where(Connections.connectionWhere(owner, id)),
			)
		})
	const commit = (fence: Fence, prepared: Prepared, callId: Execution.CallId) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { saved, input } = yield* guard(fence)
					yield* authorize(fence, saved.identity.actor, "advance")
					const history = yield* store.calls(fence)
					const call = Arr.findFirst(history, (value) => value.id === callId)
					if (
						Option.isNone(call) ||
						call.value.step !== "prepare" ||
						call.value.status !== "completed" ||
						Arr.some(
							history,
							(other) =>
								other.step === "prepare" && other.attempt > call.value.attempt,
						) ||
						!Schema.toEquivalence(Schema.Json)(
							call.value.result,
							yield* Schema.encodeEffect(preparedCodec)(prepared),
						)
					)
						return yield* Execution.Conflict.make({ id: fence.id })

					const id = ConnectionId.make(saved.record.resource.id)
					if (
						prepared.connection.connection.owner !== fence.namespace ||
						prepared.connection.connection.connectionId !== id ||
						prepared.connection.connection.cardUrl !==
							input.connection.connection.cardUrl ||
						prepared.app.cardUrl !== input.app.cardUrl
					)
						return yield* Execution.Forbidden.make({})
					if (
						prepared.connection.connection.authorization._tag ===
							"Authorized" &&
						input.credential !== null
					)
						yield* cleanup.assertInstallable(
							GrantCleanup.scopeOf(input.credential),
						)
					const changed =
						input.action._tag === "Update" ||
						input.action._tag === "Manual" ||
						!Schema.toEquivalence(Connections.StoredConnection)(
							input.connection,
							prepared.connection,
						)
					const revision = input.connection.revision + (changed ? 1 : 0)

					yield* store.commit(
						fence,
						{
							status: "completed",
							events: [
								{
									_tag: "Checkpoint",
									resource: { kind: "AppConnectionResult", id: callId },
									revision,
								},
								{ _tag: "Result", resource: saved.record.resource },
							],
						},
						Effect.gen(function* () {
							yield* write({ ...prepared.connection, revision }, null)
							yield* storage(
								db
									.update(appRecords)
									.set({
										body: yield* Schema.encodeEffect(Connections.appCodec)(
											prepared.app,
										),
									})
									.where(
										and(
											eq(appRecords.owner, fence.namespace),
											eq(appRecords.cardUrl, prepared.app.cardUrl),
										),
									),
							)
							if (prepared.discardCredential) {
								const auth = input.connection.connection.authorization
								if (input.credential !== null && auth._tag === "Authorized")
									yield* cleanup.handoff(
										fence,
										auth.credentialRef,
										input.credential,
										auth.resourceMetadataUrl === undefined
											? {}
											: { resourceMetadataUrl: auth.resourceMetadataUrl },
									)
								yield* storage(
									db
										.delete(appSecrets)
										.where(
											and(
												eq(appSecrets.owner, fence.namespace),
												eq(appSecrets.connectionId, id),
												inArray(appSecrets.kind, ["credential", "flow"]),
											),
										),
								)
							}
							yield* storage(
								db
									.update(appAuthorizations)
									.set({ status: "Cancelled", callback: null })
									.where(
										and(
											eq(appAuthorizations.owner, fence.namespace),
											eq(appAuthorizations.connectionId, id),
											inArray(appAuthorizations.status, [
												"Waiting",
												"Received",
											]),
										),
									),
							)
						}),
					)
				}),
			)
			.pipe(transactionFailures)
	const finish = (fence: Fence, end: End) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { input } = yield* guard(fence)
					const close = write(input.connection, null)
					if (end.status === "cancelled")
						yield* store.finishCancellation(fence, end.epoch, () =>
							close.pipe(Effect.as([])),
						)
					else
						yield* store.commit(
							fence,
							{
								status: end.status,
								...(end.status === "failed" ? { failure: end.failure } : {}),
							},
							close,
						)
				}),
			)
			.pipe(transactionFailures)
	const get = (actor: Caller, id: string, executionId: Execution.Id) =>
		Effect.gen(function* () {
			const key = { namespace: Connections.ownerKey(actor), id: executionId }
			yield* authorize(key, actor, "read")
			const { saved } = yield* load(key)
			if (saved.record.resource.id !== id)
				return yield* Execution.NotFound.make({ id: executionId })
			let result: AppConnections.Result | null = null
			if (saved.record.status === "completed") {
				// The final checkpoint names the exact result, even if an older attempt returns late.
				const events = yield* store.events(
					key,
					Math.max(0, saved.record.sequence - 3),
				)
				const marker = Arr.findFirst(
					events,
					(event) =>
						event.body._tag === "Checkpoint" &&
						event.body.resource.kind === "AppConnectionResult",
				)
				if (Option.isNone(marker) || marker.value.body._tag !== "Checkpoint")
					return yield* Effect.die("The connection result has no checkpoint.")
				const checkpoint = marker.value.body
				const call = Arr.findFirst(
					yield* store.calls(key),
					(call) => call.id === checkpoint.resource.id,
				)
				if (Option.isNone(call) || call.value.status !== "completed")
					return yield* Effect.die("The connection result has no saved call.")
				const prepared = yield* Schema.decodeEffect(preparedCodec)(
					call.value.result,
				)
				const { input } = yield* load(key)
				const connectionId = ConnectionId.make(id)
				const revision = checkpoint.revision
				result =
					input.action._tag !== "Verify"
						? { _tag: "Updated", connectionId, revision }
						: prepared.capabilities === null
							? { _tag: "Unavailable", connectionId, revision }
							: {
									_tag: "Verified",
									connectionId,
									revision,
									capabilities: prepared.capabilities,
								}
			}

			return { execution: saved.record, result }
		})
	return { start, load, authorize, commit, finish, get }
})
export class ConnectionCommands extends Context.Service<
	ConnectionCommands,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/ConnectionCommands") {}
export const layer = Layer.effect(ConnectionCommands, make)
