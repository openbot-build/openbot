import * as GrantUses from "./GrantUses.ts"
import * as GrantCleanup from "./GrantCleanup.ts"
import * as RetryingCall from "../execution/RetryingCall.ts"
import {
	AppAuthorizations,
	Authorization,
	Caller,
	ConnectionId,
	Execution,
	ExecutionIdentity,
	executionCallers,
} from "@openbot-build/domain"
import {
	Authorization as OAuth,
	OAuthAuthorization,
	Store as Protocol,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { and, eq, inArray } from "drizzle-orm"
import * as Check from "../authorization/Check.ts"
import * as Db from "../database/Database.ts"
import {
	appAuthorizations,
	appConnections,
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
import * as Connections from "./StoredConnections.ts"

export const workflowName = "openbot.app-authorization"
export const Preparation = Schema.Struct({
	result: AppAuthorizations.Started,
	flow: Schema.NullOr(OAuth.Flow),
})
export type Preparation = typeof Preparation.Type
export const preparationCodec = Schema.toCodecJson(Preparation)
export const Input = Schema.TaggedUnion({
	Begin: {
		connection: Connections.StoredConnection,
		request: AppAuthorizations.Begin,
	},
	Refresh: {
		connection: Connections.StoredConnection,
		credential: Protocol.Credential,
	},
	Complete: {
		connection: Connections.StoredConnection,
		flow: OAuth.Flow,
		callback: Schema.Redacted(Schema.String),
	},
	Remove: {
		connection: Connections.StoredConnection,
		credential: Schema.NullOr(Protocol.Credential),
	},
	Revoke: {
		connection: Connections.StoredConnection,
		credential: Schema.NullOr(Protocol.Credential),
	},
})
export type Input = typeof Input.Type
const inputCodec = Schema.toCodecJson(Input)
const flowCodec = Schema.fromJsonString(Schema.toCodecJson(OAuth.Flow))
const credentialCodec = Schema.fromJsonString(
	Schema.toCodecJson(Protocol.Credential),
)
const connectionCodec = Schema.fromJsonString(
	Schema.toCodecJson(Connections.StoredConnection),
)
const actorCodec = Schema.fromJsonString(Caller)
const sameCaller = Schema.toEquivalence(Caller)
const binding = (kind: string, owner: string, id: string) =>
	JSON.stringify([kind, owner, id])
export const actorBinding = (owner: string, id: string) =>
	binding("app-authorization-actor", owner, id)
const make = Effect.gen(function* () {
	const db = yield* Db.make
	const sql = yield* SqlClient.SqlClient
	const secrets = yield* Secrets
	const uses = GrantUses.makeWith(db, secrets)
	const store = yield* Store
	const cleanup = yield* GrantCleanup.GrantCleanup
	const checks = yield* Check.make
	const governance = yield* Governance
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
			const value = yield* Connections.openRecord(secrets, owner, id, row.body)
			return { row, value }
		})
	const flow = (owner: string, id: string, lock = false) =>
		Effect.gen(function* () {
			const query = db
				.select()
				.from(appAuthorizations)
				.where(
					and(eq(appAuthorizations.owner, owner), eq(appAuthorizations.id, id)),
				)
			const row = (yield* storage(lock ? query.for("update") : query))[0]
			if (row === undefined)
				return yield* Execution.NotFound.make({ id: Execution.Id.make(id) })
			return row
		})
	const secret = (owner: string, kind: string, id: string) =>
		Effect.gen(function* () {
			const row = (yield* storage(
				db
					.select()
					.from(appSecrets)
					.where(
						and(
							eq(appSecrets.owner, owner),
							eq(appSecrets.kind, kind),
							eq(appSecrets.id, id),
						),
					),
			))[0]
			if (row === undefined)
				return yield* Execution.NotFound.make({ id: Execution.Id.make(id) })
			return {
				row,
				value: yield* secrets.open(row.body, binding(kind, owner, id)),
			}
		})
	const writeConnection = (value: Connections.StoredConnection) =>
		Effect.gen(function* () {
			const { owner, connectionId } = value.connection
			const body = yield* secrets.seal(
				yield* Schema.encodeEffect(connectionCodec)(value),
				binding("connection", owner, connectionId),
			)
			yield* storage(
				db
					.update(appConnections)
					.set({ body, revision: value.revision, name: value.name })
					.where(Connections.connectionWhere(owner, connectionId)),
			)
			yield* uses.connection(value.connection).pipe(storage)
		})
	const load = (key: Key) =>
		Effect.gen(function* () {
			const saved = yield* store.loadMember(key)
			const input = yield* Schema.decodeEffect(inputCodec)(saved.input).pipe(
				Effect.orDie,
			)
			if (
				saved.workflow !== workflowName ||
				key.namespace !== Connections.ownerKey(saved.identity.owner) ||
				saved.record.resource.kind !== "AppAuthorization" ||
				saved.record.resource.id !== input.connection.connection.connectionId
			)
				return yield* Execution.Forbidden.make({})
			return { saved, input }
		})
	const authorize: Authorize = (key, actor, mode) =>
		Effect.gen(function* () {
			const { saved, input } = yield* load(key)
			if (
				Connections.ownerKey(actor) !==
					Connections.ownerKey(saved.identity.owner) ||
				((mode === "advance" || mode === "replay") &&
					!sameCaller(actor, saved.identity.actor))
			)
				return yield* Execution.Forbidden.make({})
			const id = input.connection.connection.connectionId
			yield* check(actor, id, mode === "read" ? "read" : "write")
			if (mode === "advance" || mode === "replay") {
				for (const caller of executionCallers(saved.identity))
					yield* check(caller, id)
				// Revocation must still work when an App is blocked.
				if (input._tag !== "Revoke" && input._tag !== "Remove")
					yield* governance.check(input.connection.connection.cardUrl).pipe(
						Effect.catchTags({
							AppRestricted: () => Effect.fail(Execution.Forbidden.make({})),
							ExperienceStorageUnavailable: (cause) =>
								Effect.fail(Execution.StorageError.make({ cause })),
						}),
					)
			}
		})
	const guard = (fence: Fence) =>
		Effect.gen(function* () {
			const { saved, input } = yield* load(fence)
			const current = yield* connection(
				fence.namespace,
				input.connection.connection.connectionId,
				true,
			)
			if (
				current.row.executionId !== fence.id ||
				current.value.revision !== input.connection.revision
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			return { saved, input, current }
		})
	const start = (
		actor: Caller,
		request:
			| {
					readonly kind: "Begin"
					readonly connectionId: string
					readonly input: AppAuthorizations.Begin
			  }
			| { readonly kind: "Complete"; readonly flowId: string }
			| {
					readonly kind: "Revoke" | "Refresh" | "Remove"
					readonly connectionId: string
			  },
		commandKey: Execution.CommandKey,
		parent?: Fence,
	) =>
		Effect.gen(function* () {
			const owner = Connections.ownerKey(actor)
			const pending =
				request.kind === "Complete" ? yield* flow(owner, request.flowId) : null
			const id =
				pending?.connectionId ??
				(request.kind !== "Complete" ? request.connectionId : "")
			yield* check(actor, id)
			return yield* store.accept(
				owner,
				commandKey,
				{ actor, body: { request, parent: parent?.id ?? null } },
				(create) =>
					Effect.gen(function* () {
						const current = yield* connection(owner, id, true)
						yield* check(actor, id)
						if (current.row.executionId !== null)
							return yield* Execution.Conflict.make({
								id: Execution.Id.make(current.row.executionId),
							})
						if (parent !== undefined) {
							yield* store.guard(parent)
							const owning = yield* store.loadMember(parent)
							if (
								parent.namespace !== owner ||
								!sameCaller(owning.identity.actor, actor) ||
								owning.record.status !== "running" ||
								owning.phaseFailed
							)
								return yield* Execution.Forbidden.make({})
						}
						let input: Input
						let identity: ExecutionIdentity = {
							owner: {
								organizationId: actor.organizationId,
								userId: actor.userId,
							},
							actor,
						}
						if (request.kind === "Begin") {
							if (current.value.revision !== request.input.revision)
								return yield* Execution.Conflict.make({
									id: Execution.Id.make(id),
								})
							input = {
								_tag: "Begin",
								connection: current.value,
								request: request.input,
							}
						} else if (request.kind === "Complete") {
							const row = yield* flow(owner, request.flowId, true)
							if (
								row.status !== "Received" ||
								row.callback === null ||
								row.actor === null ||
								row.expiresAt <= (yield* Clock.currentTimeMillis) ||
								row.revision !== current.value.revision
							)
								return yield* AppAuthorizations.AppAuthorizationFailed.make({
									reason: "FlowUnavailable",
									message:
										"This authorization is no longer ready. Start a new authorization.",
								})
							const original = yield* secrets
								.open(row.actor, actorBinding(owner, row.id))
								.pipe(Effect.flatMap(Schema.decodeEffect(actorCodec)))
							if (Connections.ownerKey(original) !== owner)
								return yield* Execution.Forbidden.make({})
							yield* check(original, id)
							identity = { ...identity, constraints: [original] }
							const savedFlow = yield* secret(owner, "flow", row.id)
							if (savedFlow.row.consumed)
								return yield* Execution.Conflict.make({
									id: Execution.Id.make(row.id),
								})
							const value = yield* Schema.decodeEffect(flowCodec)(
								savedFlow.value,
							)
							const callback = yield* secrets.open(
								row.callback,
								binding("app-authorization", owner, row.id),
							)
							yield* OAuthAuthorization.validateCallback(
								current.value.connection,
								value,
								callback,
							)
							// The callback stays private in the sealed execution input.
							input = {
								_tag: "Complete",
								connection: current.value,
								flow: value,
								callback: Redacted.make(callback),
							}
						} else {
							const auth = current.value.connection.authorization
							const credential =
								auth._tag === "Authorized"
									? yield* secret(owner, "credential", auth.credentialRef).pipe(
											Effect.flatMap((saved) =>
												Schema.decodeEffect(credentialCodec)(saved.value),
											),
										)
									: null
							if (request.kind === "Refresh") {
								if (credential === null)
									return yield* AppAuthorizations.AppAuthorizationFailed.make({
										reason: "RefreshUnavailable",
										message: "This connection has no grant to refresh.",
									})
								input = {
									_tag: "Refresh",
									connection: current.value,
									credential,
								}
							} else {
								const stopped = {
									...current.value,
									revision: current.value.revision + 1,
									connection: {
										...current.value.connection,
										state: "Disabled" as const,
									},
								}
								yield* writeConnection(stopped)
								input = { _tag: request.kind, connection: stopped, credential }
							}
						}
						const key = yield* create({
							workflow: workflowName,
							...(parent === undefined ? {} : { ownerExecutionId: parent.id }),
							identity,
							resource: { kind: "AppAuthorization", id },
							input: yield* Schema.encodeEffect(inputCodec)(input),
						})
						yield* storage(
							db
								.update(appConnections)
								.set({ executionId: key.id })
								.where(Connections.connectionWhere(owner, id)),
						)
						if (input._tag === "Complete") {
							yield* storage(
								db
									.update(appAuthorizations)
									.set({ status: "Processing", executionId: key.id })
									.where(eq(appAuthorizations.id, input.flow.flowId)),
							)
							yield* storage(
								db
									.update(appSecrets)
									.set({ consumed: true })
									.where(
										and(
											eq(appSecrets.owner, owner),
											eq(appSecrets.kind, "flow"),
											eq(appSecrets.id, input.flow.flowId),
										),
									),
							)
						}
						return { executionId: key.id, start: true }
					}),
			)
		})
	const commit = (
		fence: Fence,
		result: {
			readonly callId: Execution.CallId
			readonly grant: OAuthAuthorization.Grant
		} | null,
	) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { saved, input } = yield* guard(fence)
					const grant = result?.grant ?? null
					if (grant !== null)
						yield* cleanup.assertInstallable(
							GrantCleanup.scopeOf(grant.credential),
						)
					if (result !== null) {
						if (input._tag !== "Complete" && input._tag !== "Refresh")
							return yield* Execution.Conflict.make({ id: fence.id })
						const call = yield* store.latestCall(
							fence,
							input._tag === "Complete" ? "exchange" : "refresh",
						)
						if (
							Option.isNone(call) ||
							call.value.id !== result.callId ||
							call.value.status !== "completed" ||
							!Schema.toEquivalence(Schema.Json)(
								call.value.result,
								yield* Schema.encodeEffect(
									Schema.toCodecJson(OAuthAuthorization.Grant),
								)(result.grant),
							)
						)
							return yield* Execution.Conflict.make({ id: fence.id })
					}
					if (input._tag === "Begin")
						return yield* Effect.die("This step needs a preparation result.")
					yield* authorize(fence, saved.identity.actor, "advance")
					const currentAuth = input.connection.connection.authorization
					const removing = input._tag === "Revoke" || input._tag === "Remove"
					const credentials =
						removing || currentAuth._tag === "Authorized"
							? yield* storage(
									db
										.select()
										.from(appSecrets)
										.where(
											and(
												eq(appSecrets.owner, fence.namespace),
												eq(
													appSecrets.connectionId,
													input.connection.connection.connectionId,
												),
												eq(appSecrets.kind, "credential"),
												...(removing || currentAuth._tag !== "Authorized"
													? []
													: [eq(appSecrets.id, currentAuth.credentialRef)]),
											),
										),
								)
							: []
					if (
						currentAuth._tag === "Authorized" &&
						!Arr.some(
							credentials,
							(credential) => credential.id === currentAuth.credentialRef,
						)
					)
						return yield* Execution.StorageError.make({
							cause: "The current grant is missing.",
						})
					const cleanupEvents = yield* Effect.forEach(
						credentials,
						(credential) =>
							Effect.gen(function* () {
								const value = yield* secrets
									.open(
										credential.body,
										binding("credential", fence.namespace, credential.id),
									)
									.pipe(Effect.flatMap(Schema.decodeEffect(credentialCodec)))
								const receipt = yield* cleanup.handoff(
									fence,
									credential.id,
									value,
									{
										...(currentAuth._tag === "Authorized" &&
										currentAuth.resourceMetadataUrl !== undefined
											? { resourceMetadataUrl: currentAuth.resourceMetadataUrl }
											: {}),
									},
								)
								return {
									_tag: "Checkpoint" as const,
									resource: {
										kind: "AppGrantCleanup",
										id: receipt.executionId,
									},
									revision: 0,
								}
							}),
					)
					yield* store.commit(
						fence,
						{
							status: "completed",
							events: [
								{ _tag: "Result", resource: saved.record.resource },
								...cleanupEvents,
								...(result === null
									? []
									: [GrantCleanup.installed(result.callId)]),
							],
						},
						Effect.gen(function* () {
							const owner = fence.namespace
							const id = input.connection.connection.connectionId
							if (input._tag !== "Revoke" && input._tag !== "Remove") {
								const expected =
									input._tag === "Complete"
										? input.flow.binding
										: input.credential.binding
								if (
									result === null ||
									grant === null ||
									grant.credential.binding.owner !== owner ||
									grant.credential.binding.connectionId !== id ||
									grant.credential.binding.resource !== expected.resource ||
									grant.credential.binding.issuer !== expected.issuer
								)
									return yield* Effect.die(
										"The saved grant does not match its flow.",
									)
								if (currentAuth._tag === "Authorized")
									yield* storage(
										db
											.delete(appSecrets)
											.where(
												and(
													eq(appSecrets.owner, owner),
													eq(appSecrets.kind, "credential"),
													eq(appSecrets.id, currentAuth.credentialRef),
												),
											),
									)
								const reference = result.callId
								const body = yield* secrets.seal(
									yield* Schema.encodeEffect(credentialCodec)(grant.credential),
									binding("credential", owner, reference),
								)
								yield* storage(
									db.insert(appSecrets).values({
										owner,
										kind: "credential",
										id: reference,
										connectionId: id,
										body,
									}),
								)
								yield* writeConnection({
									...input.connection,
									revision: input.connection.revision + 1,
									verification: null,
									connection: {
										...input.connection.connection,
										authorization: {
											_tag: "Authorized",
											binding: grant.credential.binding,
											credentialRef: reference,
											scopes: grant.credential.scopes,
											...(grant.resourceMetadataUrl === undefined
												? {}
												: { resourceMetadataUrl: grant.resourceMetadataUrl }),
										},
									},
								})
								if (input._tag === "Complete")
									yield* storage(
										db
											.update(appAuthorizations)
											.set({
												status: "Succeeded",
												callback: null,
												reason: null,
											})
											.where(eq(appAuthorizations.id, input.flow.flowId)),
									)
							} else {
								yield* storage(
									db
										.delete(appSecrets)
										.where(
											and(
												eq(appSecrets.owner, owner),
												eq(appSecrets.connectionId, id),
											),
										),
								)
								yield* storage(
									db
										.update(appAuthorizations)
										.set({ status: "Cancelled", callback: null })
										.where(
											and(
												eq(appAuthorizations.owner, owner),
												eq(appAuthorizations.connectionId, id),
												inArray(appAuthorizations.status, [
													"Waiting",
													"Received",
												]),
											),
										),
								)
								if (input._tag === "Remove") {
									yield* uses.hold(owner, "connection", id, null)
									yield* storage(
										db
											.delete(appConnections)
											.where(Connections.connectionWhere(owner, id)),
									)
								} else
									yield* writeConnection({
										...input.connection,
										revision: input.connection.revision + 1,
										verification: null,
										connection: {
											...input.connection.connection,
											authorization:
												input.connection.connection.authorization._tag ===
												"Unprotected"
													? { _tag: "Unprotected" }
													: {
															_tag: "PendingAuthorization",
															resource: input.connection.connection.endpoint,
															scopes: [],
														},
										},
									})
							}
							yield* storage(
								db
									.update(appConnections)
									.set({ executionId: null })
									.where(Connections.connectionWhere(owner, id)),
							)
						}),
					)
				}),
			)
			.pipe(transactionFailures)
	const commitPrepared = (fence: Fence, prepared: Preparation) =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const { saved, input } = yield* guard(fence)
					if (input._tag !== "Begin")
						return yield* Effect.die(
							"This is not an authorization preparation.",
						)
					yield* authorize(fence, saved.identity.actor, "advance")
					yield* store.commit(
						fence,
						{
							status: "completed",
							events: [{ _tag: "Result", resource: saved.record.resource }],
						},
						Effect.gen(function* () {
							const owner = fence.namespace
							const id = input.connection.connection.connectionId
							const flow = prepared.flow
							if (flow !== null) {
								if (
									prepared.result._tag !== "AuthorizationStarted" ||
									prepared.result.flowId !== flow.flowId ||
									flow.binding.owner !== owner ||
									flow.binding.connectionId !== id ||
									flow.binding.resource !== input.connection.connection.endpoint
								)
									return yield* Effect.die(
										"The saved flow does not match its connection.",
									)
								yield* storage(
									db.insert(appSecrets).values({
										owner,
										kind: "flow",
										id: flow.flowId,
										connectionId: id,
										body: yield* secrets.seal(
											yield* Schema.encodeEffect(flowCodec)(flow),
											binding("flow", owner, flow.flowId),
										),
									}),
								)
								yield* storage(
									db.insert(appAuthorizations).values({
										id: flow.flowId,
										owner,
										connectionId: id,
										revision: input.connection.revision,
										executionId: fence.id,
										actor: yield* secrets.seal(
											yield* Schema.encodeEffect(actorCodec)(
												saved.identity.actor,
											),
											actorBinding(owner, flow.flowId),
										),
										expiresAt: flow.expiresAt,
										returnTo: input.request.returnTo ?? "/",
										status: "Waiting",
										issuer: flow.binding.issuer,
										resource: flow.binding.resource,
										scopes: yield* Schema.encodeEffect(
											Schema.fromJsonString(Schema.Array(Schema.String)),
										)(flow.scopes),
									}),
								)
							} else if (prepared.result._tag === "AuthorizationStarted")
								return yield* Effect.die("The authorization has no saved flow.")
							yield* storage(
								db
									.update(appConnections)
									.set({ executionId: null })
									.where(Connections.connectionWhere(owner, id)),
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
					const close = Effect.gen(function* () {
						if (
							input._tag === "Refresh" &&
							Arr.some(
								yield* store.calls(fence),
								(call) => call.step === "refresh" && call.status !== "intended",
							)
						)
							yield* writeConnection({
								...input.connection,
								revision: input.connection.revision + 1,
								verification: { _tag: "AuthorizationExpired" },
								connection: {
									...input.connection.connection,
									state: "Disabled",
								},
							})

						yield* storage(
							db
								.update(appConnections)
								.set({ executionId: null })
								.where(
									Connections.connectionWhere(
										fence.namespace,
										input.connection.connection.connectionId,
									),
								),
						)
						if (input._tag === "Complete")
							yield* storage(
								db
									.update(appAuthorizations)
									.set({
										status: end.status === "cancelled" ? "Cancelled" : "Failed",
										reason:
											end.status === "failed"
												? end.failure.errorId
												: "Interrupted",
										callback: null,
									})
									.where(eq(appAuthorizations.id, input.flow.flowId)),
							)
					})
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
			.pipe(transactionFailures, Effect.asVoid)
	const get = (actor: Caller, id: Execution.Id) =>
		Effect.gen(function* () {
			const key = { namespace: Connections.ownerKey(actor), id }
			yield* authorize(key, actor, "read")
			const { saved, input } = yield* load(key)
			let result: AppAuthorizations.ActionResult | null = null
			let cleanupExecutions: ReadonlyArray<Execution.Record> = []
			let cursor = 0
			while (true) {
				const events = yield* store.events(key, cursor)
				for (const event of events)
					if (
						event.body._tag === "Checkpoint" &&
						event.body.resource.kind === "AppGrantCleanup"
					)
						cleanupExecutions = Arr.append(
							cleanupExecutions,
							yield* store.get({
								namespace: key.namespace,
								id: Execution.Id.make(event.body.resource.id),
							}),
						)
				if (events.length < 128) break
				if (Arr.isReadonlyArrayNonEmpty(events))
					cursor = Arr.lastNonEmpty(events).sequence
			}
			if (saved.record.status === "completed") {
				if (input._tag === "Remove")
					result = {
						_tag: "Removed",
						connectionId: ConnectionId.make(
							input.connection.connection.connectionId,
						),
					}
				else if (input._tag === "Begin") {
					const call = Arr.findLast(
						yield* store.calls(key),
						(call) => call.step === "prepare" && call.status === "completed",
					)
					if (Option.isNone(call))
						return yield* Effect.die("The completed preparation has no result.")
					result = (yield* Schema.decodeEffect(preparationCodec)(
						call.value.result,
					)).result
				} else if (input._tag === "Complete")
					result = {
						_tag: "Authorized",
						flowId: input.flow.flowId,
						connectionId: ConnectionId.make(
							input.connection.connection.connectionId,
						),
					}
				else if (input._tag === "Refresh")
					result = {
						_tag: "Refreshed",
						connectionId: ConnectionId.make(
							input.connection.connection.connectionId,
						),
					}
				else {
					result = { _tag: "LocalOnly" }
					if (
						Arr.some(
							cleanupExecutions,
							(execution) => execution.status !== "completed",
						)
					)
						result = { _tag: "RevocationPending" }
					else if (Arr.isReadonlyArrayNonEmpty(cleanupExecutions)) {
						result = { _tag: "Revoked" }
						for (const execution of cleanupExecutions) {
							const call = Arr.findLast(
								yield* store.calls({
									namespace: key.namespace,
									id: execution.id,
								}),
								(call) => call.step === "revoke" && call.status === "completed",
							)
							if (Option.isNone(call))
								return yield* Effect.die(
									"The completed revocation has no result.",
								)
							const completed = yield* Schema.decodeUnknownEffect(
								RetryingCall.Result,
							)(call.value.result)
							if (completed._tag !== "Completed")
								return yield* Effect.die("The revocation has no final result.")
							const remote = yield* Schema.decodeUnknownEffect(
								AppAuthorizations.Revocation,
							)(completed.value)
							if (remote._tag === "LocalOnly") result = remote
						}
					}
				}
			}
			return { execution: saved.record, cleanupExecutions, result }
		})
	return { start, get, load, authorize, commit, commitPrepared, finish, check }
})
export class AuthorizationCommands extends Context.Service<
	AuthorizationCommands,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/apps/AuthorizationCommands") {}
export const layer = Layer.effect(AuthorizationCommands, make)
