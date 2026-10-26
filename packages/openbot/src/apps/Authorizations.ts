import {
	AppAuthorizationApi as Api,
	ConnectionsApi,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	Identity,
} from "@openbot-build/api"
import {
	App,
	Authorization,
	Client,
	Network,
	Store,
} from "@openbot-build/protocol"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Effect,
	Layer,
	Match,
	Option,
	Record as Rec,
	Schema,
} from "effect"
import { AppHost } from "./AppHost.ts"
import type { PgClient } from "@effect/sql-pg"
import { and, eq } from "drizzle-orm"
import {
	appAuthorizations,
	appConnections,
	appSecrets,
} from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { ProtocolStores } from "./ProtocolStores.ts"
import * as StoredConnections from "./StoredConnections.ts"
import { ownerKey } from "./StoredConnections.ts"
import { Governance } from "./Governance.ts"
import * as ClientMetadata from "./ClientMetadata.ts"
import { ConnectionLocks } from "./ConnectionLocks.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../app/Failures.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"

export type Error =
	| ExperienceNotFound
	| ExperienceStorageUnavailable
	| ConnectionsApi.ConnectionConflict
	| ConnectionsApi.AppRestricted
	| Api.AppAuthorizationFailed
	| Api.AppAuthorizationUnavailable
	| ConnectionsApi.ConnectionCleanupPending
export interface Receipt {
	readonly flowId: string
	readonly returnTo: string
	readonly requiresLogin: boolean
}
/** A flow in these states can still go on. */
const openStatus: ReadonlyArray<Api.State["status"]> = ["Waiting", "Received"]
/**
 * A flow is in `Processing` while one instance completes it. The instance
 * claims the flow before it expires, and each later step has a time limit. So
 * a flow that is still in `Processing` this long after it expired has lost its
 * instance, and nothing can finish it.
 */
const abandonedAfterMillis = 60_000

/** Private operations read the current request identity. @effect-expect-leaking Identity */
export class Authorizations extends Context.Service<
	Authorizations,
	{
		/** The client metadata for the current public origin, for its public route. */
		readonly metadata: Effect.Effect<Authorization.ClientMetadata>
		readonly begin: (
			id: string,
			input: Api.Request,
		) => Effect.Effect<Api.Started, Error, Identity>
		readonly get: (id: string) => Effect.Effect<Api.State, Error, Identity>
		readonly complete: (id: string) => Effect.Effect<Api.State, Error, Identity>
		readonly revoke: (
			id: string,
		) => Effect.Effect<Api.Revocation, Error, Identity>
		readonly receive: (
			url: string,
			/** The owners that the signed-in account can act as: one for each active membership. */
			owners: Option.Option<ReadonlyArray<string>>,
		) => Effect.Effect<Receipt, Error>
	}
>()("@openbot-build/openbot/apps/Authorizations") {}

const failureMessages: Readonly<Record<string, string>> = {
	AlreadyConsumed:
		"This authorization has already been handled. Open My Apps to view the current connection.",
	FlowExpired:
		"This authorization expired. Start a new authorization from My Apps.",
	CimdUnsupported:
		"This authorization provider does not support the required public client metadata.",
	CallbackMismatch:
		"The callback does not match this account's authorization flow.",
	Metadata:
		"The authorization metadata does not match the App resource or issuer.",
	ScopeRequired:
		"Review the requested access and authorize the required scopes.",
	GrantRejected:
		"The authorization provider did not accept this grant. Start a new authorization if you want to try again.",
}
export const authorizationFailure = (reason: string) =>
	Api.AppAuthorizationFailed.make({
		reason,
		message: Option.getOrElse(
			Rec.get(failureMessages, reason),
			() =>
				"App authorization could not complete. Review the current connection before trying again.",
		),
	})
/**
 * Turns the failure of an App authorization step into a public error. The
 * caller can act on some failures, so they keep their meaning. The others
 * become a general error, and this logs them first with their cause. An
 * authorization failure keeps its reason, but the public error has no place
 * for its issue and cause, so this logs them too.
 */
const sdkFailure = (
	error:
		| Authorization.AuthorizationError
		| Network.NetworkError
		| Schema.SchemaError
		| Store.StoreError
		| App.AppError
		| App.CleanupPending
		| ConnectionsApi.ConnectionConfigurationInvalid,
): Effect.Effect<never, Error> => {
	const replace = (replacement: Error) =>
		Effect.fail(error).pipe(
			Failures.replace("An App authorization step failed.", () => replacement),
		)
	return Match.value(error).pipe(
		Match.tag("AuthorizationError", (error) => {
			// A failure with a cause, such as a network error, and a bad client
			// metadata or crypto step are problems of OpenBot or the issuer. The
			// other reasons, such as an expired flow, are normal outcomes.
			const log =
				error.cause === undefined &&
				error.reason !== "ClientMetadata" &&
				error.reason !== "Crypto"
					? Effect.logInfo
					: Effect.logWarning
			return log(
				"An App authorization step did not complete.",
				Cause.fail(error),
			).pipe(
				Effect.annotateLogs({ reason: error.reason, issue: error.issue }),
				Effect.andThen(Effect.fail(authorizationFailure(error.reason))),
			)
		}),
		Match.tag("NetworkError", () =>
			replace(Api.AppAuthorizationUnavailable.make({})),
		),
		Match.tag("SchemaError", () => replace(authorizationFailure("Metadata"))),
		Match.tag("StoreError", (error) =>
			error.operation === "AuthorizationRevisionChanged"
				? Effect.fail(
						ConnectionsApi.ConnectionConflict.make({
							reason: "RevisionChanged",
							message: "This connection changed. Review it before authorizing.",
						}),
					)
				: error.reason === "Missing"
					? Effect.fail(ExperienceNotFound.make({ id: "App authorization" }))
					: replace(ExperienceStorageUnavailable.make({})),
		),
		Match.tag("AppError", () =>
			replace(authorizationFailure("ConnectionUnavailable")),
		),
		Match.tag("CleanupPending", (error) =>
			Effect.fail(
				ConnectionsApi.ConnectionCleanupPending.make({
					connectionId: error.key.connectionId,
					stage: error.stage,
					message:
						"This connection is stopped. Retry cleanup to finish removing its account access.",
				}),
			),
		),
		Match.tag("ConnectionConfigurationInvalid", () =>
			replace(authorizationFailure("ConnectionUnavailable")),
		),
		Match.exhaustive,
	)
}
const policy = Client.InvocationPolicy.of({
	check: (invocation) =>
		Effect.fail(
			Client.PermissionDenied.make({
				action: invocation.action,
				target: invocation.target,
			}),
		),
})

/** An authorization flow as it is kept in the database. */
const FlowRecord = Schema.Struct({
	state: Api.State,
	owner: Schema.NonEmptyString,
	revision: Schema.Natural,
	callback: Schema.NullOr(Schema.String),
})
const ScopesJson = Schema.fromJsonString(Schema.Array(Schema.String))
const flowCodec = Schema.fromJsonString(Schema.toCodecJson(Authorization.Flow))
/** A sealed secret opens only with the same binding: its kind, its owner, and its id. */
const SecretBinding = Schema.fromJsonString(
	Schema.Tuple([Schema.String, Schema.String, Schema.String]),
)
const secretBinding = (kind: string, owner: string, id: string) =>
	// Three strings always make valid JSON, so a failure here is a defect.
	Schema.encodeEffect(SecretBinding)([kind, owner, id]).pipe(Effect.orDie)

export const make: Effect.Effect<
	typeof Authorizations.Service,
	never,
	| AppHost
	| PgClient.PgClient
	| Secrets
	| ProtocolStores
	| Governance
	| ConnectionLocks
	| Settings
> = Effect.gen(function* () {
	const factory = yield* AppHost
	const protocols = yield* ProtocolStores
	const governance = yield* Governance
	const locks = yield* ConnectionLocks
	const settings = yield* Settings
	const db = yield* Db.make
	const secrets = yield* Secrets
	/** The origin of the platform now. A change of the platform settings works on the next call. */
	const publicOrigin = Platform.publicOriginOr(settings, () =>
		Api.AppAuthorizationUnavailable.make({}),
	)
	const callbackBinding = (owner: string, id: string) =>
		secretBinding("app-authorization", owner, id)
	const decodeFlow = Effect.fn("AppAuthorizations.decode")(function* (
		row: typeof appAuthorizations.$inferSelect,
	) {
		const scopes = yield* Schema.decodeEffect(ScopesJson)(row.scopes)
		const callback =
			row.callback === null
				? null
				: yield* secrets.open(
						row.callback,
						yield* callbackBinding(row.owner, row.id),
					)
		return yield* Schema.decodeUnknownEffect(FlowRecord)({
			owner: row.owner,
			revision: row.revision,
			callback,
			state: {
				flowId: row.id,
				connectionId: row.connectionId,
				returnTo: row.returnTo,
				expiresAt: row.expiresAt,
				status: row.status,
				reason: row.reason,
				issuer: row.issuer,
				resource: row.resource,
				scopes,
			},
		})
	})
	const getFlow = Effect.fn("AppAuthorizations.get")(function* (id: string) {
		const row = (yield* db
			.select()
			.from(appAuthorizations)
			.where(eq(appAuthorizations.id, id))
			.pipe(
				Failures.replace("OpenBot could not read an App authorization.", () =>
					ExperienceStorageUnavailable.make({}),
				),
			))[0]
		if (row === undefined) return yield* ExperienceNotFound.make({ id })
		return yield* decodeFlow(row).pipe(
			Failures.replace(
				"OpenBot could not open a stored App authorization.",
				() => ExperienceStorageUnavailable.make({}),
			),
		)
	})
	const beginFlow = (
		flow: Authorization.Flow,
		input: {
			readonly revision: number
			readonly returnTo: string
			readonly resource: string
		},
	) =>
		db
			.transaction((tx) =>
				Effect.gen(function* () {
					const connection = (yield* tx
						.select({ revision: appConnections.revision })
						.from(appConnections)
						.where(
							StoredConnections.connectionWhere(
								flow.binding.owner,
								flow.binding.connectionId,
							),
						)
						.for("update"))[0]
					if (connection === undefined)
						return yield* ExperienceNotFound.make({
							id: flow.binding.connectionId,
						})
					if (connection.revision !== input.revision)
						return yield* ConnectionsApi.ConnectionConflict.make({
							reason: "RevisionChanged",
							message: "This connection changed. Review it before authorizing.",
						})
					const encoded = yield* Schema.encodeEffect(flowCodec)(flow)
					const body = yield* secrets.seal(
						encoded,
						yield* secretBinding("flow", flow.binding.owner, flow.flowId),
					)
					yield* tx.insert(appSecrets).values({
						owner: flow.binding.owner,
						kind: "flow",
						id: flow.flowId,
						connectionId: flow.binding.connectionId,
						body,
					})
					const scopes = yield* Schema.encodeEffect(ScopesJson)(flow.scopes)
					yield* tx.insert(appAuthorizations).values({
						id: flow.flowId,
						owner: flow.binding.owner,
						connectionId: flow.binding.connectionId,
						revision: input.revision,
						expiresAt: flow.expiresAt,
						returnTo: input.returnTo,
						status: "Waiting",
						issuer: flow.binding.issuer,
						resource: input.resource,
						scopes,
					})
				}),
			)
			.pipe(
				Effect.catchTag(
					[
						"EffectDrizzleQueryError",
						"SqlError",
						"SchemaError",
						"SecretStorageError",
					],
					(error) =>
						Effect.fail(error).pipe(
							Failures.replace(
								"OpenBot could not save an App authorization.",
								() => ExperienceStorageUnavailable.make({}),
							),
						),
				),
			)
	const receiveFlow = Effect.fn("AppAuthorizations.receive")(function* (
		id: string,
		input: {
			readonly callback: string | null
			readonly status: "Received" | "Cancelled" | "Failed"
			readonly reason: string | null
		},
	) {
		const record = yield* getFlow(id)
		const callback =
			input.callback === null
				? null
				: yield* secrets
						.seal(input.callback, yield* callbackBinding(record.owner, id))
						.pipe(
							Failures.replace(
								"OpenBot could not seal the callback of an App authorization.",
								() => ExperienceStorageUnavailable.make({}),
							),
						)
		const rows = yield* db
			.update(appAuthorizations)
			.set({ ...input, callback })
			.where(
				and(
					eq(appAuthorizations.id, id),
					eq(appAuthorizations.status, "Waiting"),
				),
			)
			.returning({ id: appAuthorizations.id })
			.pipe(
				Failures.replace(
					"OpenBot could not record the callback of an App authorization.",
					() => ExperienceStorageUnavailable.make({}),
				),
			)
		if (rows.length === 0) return yield* authorizationFailure("AlreadyConsumed")
	})
	const claimFlow = (owner: string, id: string) =>
		db
			.transaction((tx) =>
				Effect.gen(function* () {
					const row = (yield* tx
						.select()
						.from(appAuthorizations)
						.where(
							and(
								eq(appAuthorizations.id, id),
								eq(appAuthorizations.owner, owner),
							),
						)
						.for("update"))[0]
					if (row === undefined) return yield* ExperienceNotFound.make({ id })
					if (row.status !== "Received")
						return yield* authorizationFailure("AlreadyConsumed")
					if (row.expiresAt <= (yield* Clock.currentTimeMillis))
						return yield* authorizationFailure("FlowExpired")
					const connection = (yield* tx
						.select({ revision: appConnections.revision })
						.from(appConnections)
						.where(StoredConnections.connectionWhere(owner, row.connectionId))
						.for("update"))[0]
					if (connection === undefined || connection.revision !== row.revision)
						return yield* ConnectionsApi.ConnectionConflict.make({
							reason: "RevisionChanged",
							message: "This connection changed. Review it before authorizing.",
						})
					yield* tx
						.update(appAuthorizations)
						.set({ status: "Processing" })
						.where(eq(appAuthorizations.id, id))
					return yield* decodeFlow({ ...row, status: "Processing" })
				}),
			)
			.pipe(
				Effect.catchTag(
					[
						"EffectDrizzleQueryError",
						"SqlError",
						"SchemaError",
						"SecretStorageError",
					],
					(error) =>
						Effect.fail(error).pipe(
							Failures.replace(
								"OpenBot could not claim an App authorization.",
								() => ExperienceStorageUnavailable.make({}),
							),
						),
				),
			)
	const finishFlow = (
		owner: string,
		id: string,
		status: "Succeeded" | "Failed",
		reason: string | null,
	) =>
		db
			.update(appAuthorizations)
			.set({ status, reason, callback: null })
			.where(
				and(
					eq(appAuthorizations.owner, owner),
					eq(appAuthorizations.id, id),
					eq(appAuthorizations.status, "Processing"),
				),
			)
			.returning({ id: appAuthorizations.id })
			.pipe(
				Failures.replace("OpenBot could not finish an App authorization.", () =>
					ExperienceStorageUnavailable.make({}),
				),
				Effect.flatMap((rows) =>
					rows.length === 1
						? Effect.void
						: Effect.fail(authorizationFailure("AlreadyConsumed")),
				),
			)
	const owned = Effect.fn("AppAuthorizations.owned")(function* (
		owner: string,
		id: string,
	) {
		const record = yield* getFlow(id)
		if (record.owner !== owner) return yield* ExperienceNotFound.make({ id })
		return record
	})
	const read = Effect.fn("AppAuthorizations.read")(function* (
		owner: string,
		id: string,
	) {
		const record = yield* owned(owner, id)
		const now = yield* Clock.currentTimeMillis
		if (
			openStatus.includes(record.state.status) &&
			record.state.expiresAt <= now
		)
			return yield* authorizationFailure("FlowExpired")
		// This does not change the row. If its instance is still alive after all,
		// its late finish still records the real end.
		if (
			record.state.status === "Processing" &&
			record.state.expiresAt + abandonedAfterMillis <= now
		) {
			const interrupted: Api.State = {
				...record.state,
				status: "Failed",
				reason: "Interrupted",
			}
			return interrupted
		}
		return record.state
	})
	const completeUnlocked = Effect.fn("AppAuthorizations.complete")(function* (
		owner: string,
		id: string,
	) {
		const pending = yield* owned(owner, id)
		const connection = yield* StoredConnections.get(
			db,
			secrets,
			owner,
			pending.state.connectionId,
		)
		yield* governance.check(connection.connection.cardUrl)
		// A claimed flow is in Processing until it ends. If the request stops in
		// the middle, the flow must still end, so nothing can interrupt these
		// steps. Each step has a time limit, so this region does not run for long.
		yield* Effect.uninterruptible(
			Effect.gen(function* () {
				const record = yield* claimFlow(owner, id)
				const result = yield* Effect.result(
					record.callback === null
						? Effect.fail(authorizationFailure("CallbackMismatch"))
						: factory
								.bind(owner, policy)
								.completeAuthorization({
									key: { owner, connectionId: record.state.connectionId },
									flowId: id,
									callbackUrl: record.callback,
								})
								.pipe(Effect.catch(sdkFailure)),
				)
				yield* Match.value(result).pipe(
					Match.tag("Success", () => finishFlow(owner, id, "Succeeded", null)),
					Match.tag("Failure", ({ failure }) =>
						finishFlow(
							owner,
							id,
							"Failed",
							failure._tag === "AppAuthorizationFailed"
								? failure.reason
								: "Unavailable",
						).pipe(Effect.andThen(Effect.fail(failure))),
					),
					Match.exhaustive,
				)
			}),
		)
		return yield* read(owner, id)
	})
	const complete = Effect.fn("AppAuthorizations.completeLocked")(function* (
		owner: string,
		id: string,
	) {
		const pending = yield* owned(owner, id)
		return yield* locks.withConnection(
			{ owner, connectionId: pending.state.connectionId },
			completeUnlocked(owner, id),
		)
	})
	return Authorizations.of({
		metadata: Effect.flatMap(
			Platform.publicOriginInRequest(settings),
			ClientMetadata.metadata,
		),
		begin: Effect.fn("AppAuthorizations.begin")(function* (id, input) {
			const owner = ownerKey(yield* Identity)
			const stored = yield* StoredConnections.get(db, secrets, owner, id)
			if (stored.revision !== input.revision)
				return yield* ConnectionsApi.ConnectionConflict.make({
					reason: "RevisionChanged",
					message: "This connection changed. Refresh it before authorizing.",
				})
			yield* governance.check(stored.connection.cardUrl)
			const app = factory.bind(owner, policy)
			const protection = yield* app
				.inspectAuthorization({ owner, connectionId: id })
				.pipe(Effect.catch(sdkFailure))
			return yield* Match.value(protection).pipe(
				Match.when({ requiresAuthorization: false }, () =>
					Effect.succeed({ _tag: "AuthorizationNotRequired" } as const),
				),
				Match.when({ requiresAuthorization: true }, (protection) =>
					Effect.gen(function* () {
						const issuers = protection.resource.authorization_servers
						const scopes = Arr.dedupe(
							input.scopes.length === 0
								? protection.scopes.length === 0
									? (protection.resource.scopes_supported ?? [])
									: protection.scopes
								: input.scopes,
						)
						if (issuers.length > 1 && input.issuer === undefined)
							return {
								_tag: "IssuerSelectionRequired",
								issuers,
								scopes,
							} as const
						const issuer = input.issuer ?? issuers[0]
						if (!issuers.includes(issuer))
							return yield* authorizationFailure("Metadata")
						const record = yield* StoredConnections.getApp(
							db,
							owner,
							stored.connection.cardUrl,
						)
						const resource =
							record.card.remotes?.[stored.connection.remoteIndex]?.url ?? ""
						const defaults = protocols.bind(owner).flows
						const flowStore: typeof Authorization.FlowStore.Service = {
							...defaults,
							save: (flow) =>
								beginFlow(flow, {
									revision: stored.revision,
									returnTo: input.returnTo ?? "/",
									resource,
								}).pipe(
									Effect.mapError((error) =>
										Match.value(error).pipe(
											Match.tagsExhaustive({
												ConnectionConflict: () =>
													Store.StoreError.make({
														reason: "Invalid",
														operation: "AuthorizationRevisionChanged",
														cause: error,
													}),
												ExperienceNotFound: () =>
													Store.StoreError.make({
														reason: "Missing",
														operation: "Save App authorization",
														cause: error,
													}),
												ExperienceStorageUnavailable: () =>
													Store.StoreError.make({
														reason: "Unavailable",
														operation: "Save App authorization",
														cause: error,
													}),
											}),
										),
									),
								),
						}
						const metadata = yield* Effect.flatMap(
							publicOrigin,
							ClientMetadata.metadata,
						)
						const pending = yield* factory
							.bind(owner, policy, flowStore)
							.beginAuthorization({
								key: { owner, connectionId: id },
								issuer,
								clientId: metadata.client_id,
								redirectUri: metadata.redirect_uris[0],
								scopes,
								...(protection.resourceMetadataUrl === undefined
									? {}
									: { resourceMetadataUrl: protection.resourceMetadataUrl }),
							})
							.pipe(Effect.catch(sdkFailure))
						return {
							_tag: "AuthorizationStarted",
							flowId: pending.flowId,
							authorizationUrl: pending.authorizationUrl,
							issuer: pending.issuer,
							scopes: pending.scopes,
						} as const
					}),
				),
				Match.exhaustive,
			)
		}),
		get: (id) =>
			Effect.flatMap(Identity, (identity) => read(ownerKey(identity), id)),
		complete: (id) =>
			Effect.flatMap(Identity, (identity) => complete(ownerKey(identity), id)),
		revoke: Effect.fn("AppAuthorizations.revoke")(function* (id) {
			const owner = ownerKey(yield* Identity)
			return yield* factory
				.bind(owner, policy)
				.revokeAuthorization({ owner, connectionId: id })
				.pipe(Effect.catch(sdkFailure))
		}),
		receive: Effect.fn("AppAuthorizations.receive")(function* (input, owners) {
			const origin = yield* publicOrigin
			if (!URL.canParse(input, origin))
				return yield* authorizationFailure("CallbackMismatch")
			const url = new URL(input, origin)
			if (
				url.origin !== origin ||
				url.pathname !== "/auth/apps/callback" ||
				Arr.some(
					Arr.fromIterable(url.searchParams.keys()),
					(key) => url.searchParams.getAll(key).length !== 1,
				)
			)
				return yield* authorizationFailure("CallbackMismatch")
			const id = url.searchParams.get("state")
			if (id === null) return yield* authorizationFailure("CallbackMismatch")
			const record = yield* getFlow(id)
			if (Option.exists(owners, (owners) => !owners.includes(record.owner)))
				return yield* ExperienceNotFound.make({ id })
			if (record.state.status !== "Waiting")
				return yield* authorizationFailure("AlreadyConsumed")
			if (record.state.expiresAt <= (yield* Clock.currentTimeMillis))
				return yield* authorizationFailure("FlowExpired")
			const flow = yield* protocols
				.bind(record.owner)
				.flows.get({
					key: {
						owner: record.owner,
						connectionId: record.state.connectionId,
					},
					flowId: id,
				})
				.pipe(Effect.catch(sdkFailure))
			const issuer = url.searchParams.get("iss")
			if (
				(issuer !== null && issuer !== flow.binding.issuer) ||
				(flow.metadata.authorization_response_iss_parameter_supported ===
					true &&
					issuer === null)
			)
				return yield* authorizationFailure("CallbackMismatch")
			const error = url.searchParams.get("error")
			if (error !== null)
				yield* receiveFlow(id, {
					callback: null,
					status: error === "access_denied" ? "Cancelled" : "Failed",
					reason: error === "access_denied" ? null : "GrantRejected",
				})
			else {
				if (url.searchParams.get("code") === null)
					return yield* authorizationFailure("CallbackMismatch")
				yield* receiveFlow(id, {
					callback: url.href,
					status: "Received",
					reason: null,
				})
				// A failed completion is saved on the flow, or the flow stays
				// Received, so the signed-in client can complete it. The caller reads
				// that state after the redirect, so the redirect still happens.
				yield* Option.match(owners, {
					onNone: () => Effect.void,
					// The check above made sure that the account can act as this owner.
					onSome: () =>
						complete(record.owner, id).pipe(
							Effect.catch((error) =>
								Effect.logInfo(
									"An App authorization did not complete after its callback.",
									Cause.fail(error),
								).pipe(Effect.annotateLogs({ flowId: id })),
							),
						),
				})
			}
			return {
				flowId: id,
				returnTo: record.state.returnTo,
				requiresLogin: Option.isNone(owners),
			}
		}),
	})
})
export const layer = Layer.effect(Authorizations, make)
