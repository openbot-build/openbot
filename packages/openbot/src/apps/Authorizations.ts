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
	Clock,
	Context,
	Effect,
	Layer,
	Match,
	Option,
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
/** Private operations read the current request identity. @effect-expect-leaking Identity */
/** A flow in these states can still go on. */
const openStatus: ReadonlyArray<Api.State["status"]> = ["Waiting", "Received"]

export class Authorizations extends Context.Service<
	Authorizations,
	{
		readonly metadata: Authorization.ClientMetadata
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

export const authorizationFailure = (reason: string) =>
	Api.AppAuthorizationFailed.make({
		reason,
		message:
			(
				{
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
				} as Readonly<Record<string, string>>
			)[reason] ??
			"App authorization could not complete. Review the current connection before trying again.",
	})
const sdkFailure = (
	error:
		| Authorization.AuthorizationError
		| Network.NetworkError
		| Schema.SchemaError
		| Store.StoreError
		| App.AppError
		| App.CleanupPending
		| ConnectionsApi.ConnectionConfigurationInvalid,
): Error =>
	Match.value(error).pipe(
		Match.tag("AuthorizationError", ({ reason }) =>
			authorizationFailure(reason),
		),
		Match.tag("NetworkError", () => Api.AppAuthorizationUnavailable.make({})),
		Match.tag("SchemaError", () => authorizationFailure("Metadata")),
		Match.tag("StoreError", (error) =>
			error.operation === "AuthorizationRevisionChanged"
				? ConnectionsApi.ConnectionConflict.make({
						reason: "RevisionChanged",
						message: "This connection changed. Review it before authorizing.",
					})
				: error.reason === "Missing"
					? ExperienceNotFound.make({ id: "App authorization" })
					: ExperienceStorageUnavailable.make({}),
		),
		Match.tag("AppError", () => authorizationFailure("ConnectionUnavailable")),
		Match.tag("CleanupPending", (error) =>
			ConnectionsApi.ConnectionCleanupPending.make({
				connectionId: error.key.connectionId,
				stage: error.stage,
				message:
					"This connection is stopped. Retry cleanup to finish removing its account access.",
			}),
		),
		Match.tag("ConnectionConfigurationInvalid", () =>
			authorizationFailure("ConnectionUnavailable"),
		),
		Match.exhaustive,
	)
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
/** Keep the errors that callers handle. Every other storage failure becomes one error. */
const storageFailure = (error: unknown) =>
	error instanceof ExperienceNotFound ||
	error instanceof ConnectionsApi.ConnectionConflict ||
	error instanceof Api.AppAuthorizationFailed
		? error
		: ExperienceStorageUnavailable.make({})
const ScopesJson = Schema.fromJsonString(Schema.Array(Schema.String))
const flowCodec = Schema.fromJsonString(Schema.toCodecJson(Authorization.Flow))

export const make = (
	publicOrigin: string,
): Effect.Effect<
	typeof Authorizations.Service,
	ExperienceStorageUnavailable | Authorization.AuthorizationError,
	| AppHost
	| PgClient.PgClient
	| Secrets
	| ProtocolStores
	| Governance
	| ConnectionLocks
> =>
	Effect.gen(function* () {
		const factory = yield* AppHost
		const protocols = yield* ProtocolStores
		const governance = yield* Governance
		const locks = yield* ConnectionLocks
		const metadata = yield* ClientMetadata.metadata(publicOrigin)
		const db = yield* Db.make
		const secrets = yield* Secrets
		const callbackBinding = (owner: string, id: string) =>
			JSON.stringify(["app-authorization", owner, id])
		const decodeFlow = Effect.fn("AppAuthorizations.decode")(function* (
			row: typeof appAuthorizations.$inferSelect,
		) {
			const scopes = yield* Schema.decodeEffect(ScopesJson)(row.scopes)
			const callback =
				row.callback === null
					? null
					: yield* secrets.open(
							row.callback,
							callbackBinding(row.owner, row.id),
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
				.pipe(Effect.mapError(() => ExperienceStorageUnavailable.make({}))))[0]
			if (row === undefined) return yield* ExperienceNotFound.make({ id })
			return yield* decodeFlow(row).pipe(
				Effect.mapError(() => ExperienceStorageUnavailable.make({})),
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
								message:
									"This connection changed. Review it before authorizing.",
							})
						const encoded = yield* Schema.encodeEffect(flowCodec)(flow)
						const body = yield* secrets.seal(
							encoded,
							JSON.stringify(["flow", flow.binding.owner, flow.flowId]),
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
				.pipe(Effect.mapError(storageFailure))
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
							.seal(input.callback, callbackBinding(record.owner, id))
							.pipe(
								Effect.mapError(() => ExperienceStorageUnavailable.make({})),
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
				.pipe(Effect.mapError(() => ExperienceStorageUnavailable.make({})))
			if (rows.length === 0)
				return yield* Api.AppAuthorizationFailed.make({
					reason: "AlreadyConsumed",
					message:
						"This authorization has already been handled. Open My Apps to view the current connection.",
				})
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
							return yield* Api.AppAuthorizationFailed.make({
								reason: "AlreadyConsumed",
								message:
									"This authorization has already been handled. Open My Apps to view the current connection.",
							})
						if (row.expiresAt <= (yield* Clock.currentTimeMillis))
							return yield* Api.AppAuthorizationFailed.make({
								reason: "FlowExpired",
								message:
									"This authorization expired. Start a new authorization from My Apps.",
							})
						const connection = (yield* tx
							.select({ revision: appConnections.revision })
							.from(appConnections)
							.where(StoredConnections.connectionWhere(owner, row.connectionId))
							.for("update"))[0]
						if (
							connection === undefined ||
							connection.revision !== row.revision
						)
							return yield* ConnectionsApi.ConnectionConflict.make({
								reason: "RevisionChanged",
								message:
									"This connection changed. Review it before authorizing.",
							})
						yield* tx
							.update(appAuthorizations)
							.set({ status: "Processing" })
							.where(eq(appAuthorizations.id, id))
						return yield* decodeFlow({ ...row, status: "Processing" })
					}),
				)
				.pipe(Effect.mapError(storageFailure))
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
					Effect.mapError(() => ExperienceStorageUnavailable.make({})),
					Effect.flatMap((rows) =>
						rows.length === 1
							? Effect.void
							: Effect.fail(
									Api.AppAuthorizationFailed.make({
										reason: "AlreadyConsumed",
										message:
											"This authorization has already been handled. Open My Apps to view the current connection.",
									}),
								),
					),
				)
		// A flow that was processing when the host stopped can never finish.
		yield* db
			.update(appAuthorizations)
			.set({ status: "Failed", reason: "Interrupted", callback: null })
			.where(eq(appAuthorizations.status, "Processing"))
			.pipe(Effect.mapError(() => ExperienceStorageUnavailable.make({})))
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
			if (
				openStatus.includes(record.state.status) &&
				record.state.expiresAt <= (yield* Clock.currentTimeMillis)
			)
				return yield* authorizationFailure("FlowExpired")
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
			const record = yield* claimFlow(owner, id)
			if (record.callback === null)
				return yield* authorizationFailure("CallbackMismatch")
			const result = yield* factory
				.bind(owner, policy)
				.completeAuthorization({
					key: { owner, connectionId: record.state.connectionId },
					flowId: id,
					callbackUrl: record.callback,
				})
				.pipe(Effect.mapError(sdkFailure), Effect.result)
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
			metadata,
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
					.pipe(Effect.mapError(sdkFailure))
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
											Store.StoreError.make({
												reason:
													error._tag === "ConnectionConflict"
														? "Invalid"
														: "Unavailable",
												operation:
													error._tag === "ConnectionConflict"
														? "AuthorizationRevisionChanged"
														: "Save App authorization",
											}),
										),
									),
							}
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
								.pipe(Effect.mapError(sdkFailure))
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
				Effect.flatMap(Identity, (identity) =>
					complete(ownerKey(identity), id),
				),
			revoke: Effect.fn("AppAuthorizations.revoke")(function* (id) {
				const owner = ownerKey(yield* Identity)
				return yield* factory
					.bind(owner, policy)
					.revokeAuthorization({ owner, connectionId: id })
					.pipe(Effect.mapError(sdkFailure))
			}),
			receive: Effect.fn("AppAuthorizations.receive")(
				function* (input, owners) {
					const url = yield* Effect.try({
						try: () => new URL(input, publicOrigin),
						catch: () => authorizationFailure("CallbackMismatch"),
					})
					if (
						url.origin !== publicOrigin ||
						url.pathname !== "/auth/apps/callback" ||
						[...url.searchParams.keys()].some(
							(key) => url.searchParams.getAll(key).length !== 1,
						)
					)
						return yield* authorizationFailure("CallbackMismatch")
					const id = url.searchParams.get("state")
					if (id === null)
						return yield* authorizationFailure("CallbackMismatch")
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
						.pipe(Effect.mapError(sdkFailure))
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
						// A failed completion is already saved on the flow. The caller reads
						// that state after the redirect, so the redirect still happens.
						yield* Option.match(owners, {
							onNone: () => Effect.void,
							// The check above made sure that the account can act as this owner.
							onSome: () =>
								complete(record.owner, id).pipe(
									Effect.catchTag("AppAuthorizationFailed", () => Effect.void),
								),
						})
					}
					return {
						flowId: id,
						returnTo: record.state.returnTo,
						requiresLogin: Option.isNone(owners),
					}
				},
			),
		})
	})
export const layer = (publicOrigin: string) =>
	Layer.effect(Authorizations, make(publicOrigin))
