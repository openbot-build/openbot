import { AuthorizationCommands, actorBinding } from "./AuthorizationCommands.ts"
import {
	Settings as SettingsApi,
	AppAuthorizations as Api,
	AppConnections as ConnectionsApi,
	AppIndex,
	ConnectionId,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	Caller,
	Execution,
	Identity,
} from "@openbot-build/domain"
import { App, Authorization, Network, Store } from "@openbot-build/protocol"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Match,
	Option,
	Record as Rec,
	Schema,
} from "effect"
import type { PgClient } from "@effect/sql-pg"
import { and, eq } from "drizzle-orm"
import { appAuthorizations, appConnections } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { ProtocolStores } from "./ProtocolStores.ts"
import { ownerKey } from "./StoredConnections.ts"
import * as ClientMetadata from "./ClientMetadata.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../errors/Failures.ts"
import * as Platform from "../settings/Platform.ts"
import { Settings } from "../settings/Settings.ts"

type CommandError = Effect.Error<
	ReturnType<(typeof AuthorizationCommands.Service)["start"]>
>
export type Error =
	| CommandError
	| ExperienceNotFound
	| ExperienceStorageUnavailable
	| ConnectionsApi.ConnectionConflict
	| AppIndex.AppRestricted
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
/** Private operations read the current request identity. @effect-expect-leaking Identity */
export class Authorizations extends Context.Service<
	Authorizations,
	{
		/** The client metadata for the current public origin, for its public route. */
		readonly metadata: Effect.Effect<
			Authorization.ClientMetadata,
			SettingsApi.SettingsUnavailable
		>
		readonly begin: (
			id: string,
			input: Api.Begin & { readonly commandKey: Execution.CommandKey },
		) => Effect.Effect<Execution.Receipt, Error, Identity>
		readonly get: (id: string) => Effect.Effect<Api.State, Error, Identity>
		readonly complete: (
			id: string,
			key: Execution.CommandKey,
		) => Effect.Effect<Execution.Receipt, Error, Identity>
		readonly action: (
			id: Execution.Id,
		) => Effect.Effect<Api.Action, Error, Identity>
		readonly revoke: (
			id: string,
			key: Execution.CommandKey,
		) => Effect.Effect<Execution.Receipt, Error, Identity>
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
 * become a general error. Its full cause stays private until the outside
 * boundary saves it. An authorization failure keeps its public reason.
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
		Match.tag("AuthorizationError", (error) =>
			replace(authorizationFailure(error.reason)),
		),
		Match.tag("NetworkError", () =>
			replace(Api.AppAuthorizationUnavailable.make({})),
		),
		Match.tag("SchemaError", () => replace(authorizationFailure("Metadata"))),
		Match.tag("StoreError", (error) =>
			error.operation === "AuthorizationDenied"
				? Effect.fail(Execution.Forbidden.make({}))
				: error.operation === "AuthorizationRevisionChanged"
					? Effect.fail(
							ConnectionsApi.ConnectionConflict.make({
								reason: "RevisionChanged",
								message:
									"This connection changed. Review it before authorizing.",
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
					connectionId: ConnectionId.make(error.key.connectionId),
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
/** An authorization flow as it is kept in the database. */
const FlowRecord = Schema.Struct({
	state: Api.State,
	owner: Schema.NonEmptyString,
	revision: Schema.Natural,
	actor: Schema.NullOr(Caller),
	callback: Schema.NullOr(Schema.String),
})
const ScopesJson = Schema.fromJsonString(Schema.Array(Schema.String))
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
	| PgClient.PgClient
	| Secrets
	| ProtocolStores
	| AuthorizationCommands
	| Settings
> = Effect.gen(function* () {
	const protocols = yield* ProtocolStores
	const commands = yield* AuthorizationCommands
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
			actor:
				row.actor === null
					? null
					: yield* secrets
							.open(row.actor, actorBinding(row.owner, row.id))
							.pipe(
								Effect.flatMap(
									Schema.decodeEffect(Schema.fromJsonString(Caller)),
								),
							),
			callback,
			state: {
				flowId: row.id,
				executionId: row.executionId,
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
		return record.state
	})
	return Authorizations.of({
		metadata: Effect.flatMap(
			Platform.publicOriginOr(settings, () =>
				SettingsApi.SettingsUnavailable.make({}),
			),
			ClientMetadata.metadata,
		),
		begin: (id, { commandKey, ...input }) =>
			Effect.flatMap(Identity, (actor) =>
				commands.start(
					actor,
					{ kind: "Begin", connectionId: id, input },
					commandKey,
				),
			),
		get: (id) =>
			Effect.gen(function* () {
				const actor = yield* Identity
				const result = yield* read(ownerKey(actor), id)
				yield* commands.check(actor, result.connectionId, "read")
				return result
			}),
		complete: (id, key) =>
			Effect.flatMap(Identity, (actor) =>
				commands.start(actor, { kind: "Complete", flowId: id }, key),
			),
		action: (id) =>
			Effect.flatMap(Identity, (actor) => commands.get(actor, id)),
		revoke: (id, key) =>
			Effect.flatMap(Identity, (actor) =>
				commands.start(actor, { kind: "Revoke", connectionId: id }, key),
			),

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

				// The callback and its command commit together. A session never replaces the original token.
				yield* db
					.transaction(() =>
						Effect.gen(function* () {
							// Commands lock the connection before the flow. Keep the same order here.
							yield* db
								.select({ id: appConnections.id })
								.from(appConnections)
								.where(
									and(
										eq(appConnections.owner, record.owner),
										eq(appConnections.id, record.state.connectionId),
									),
								)
								.for("update")
							yield* receiveFlow(id, {
								callback: url.href,
								status: "Received",
								reason: null,
							})
							if (Option.isSome(owners) && record.actor !== null)
								yield* commands.start(
									record.actor,
									{ kind: "Complete", flowId: id },
									Execution.CommandKey.make(`oauth-callback:${id}`),
								)
						}),
					)
					.pipe(
						Effect.catchTag(["SqlError", "EffectDrizzleQueryError"], (cause) =>
							Effect.fail(Execution.StorageError.make({ cause })),
						),
					)
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
