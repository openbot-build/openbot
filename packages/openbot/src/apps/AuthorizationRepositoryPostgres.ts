import {
	AppAuthorizationApi as Api,
	ConnectionsApi,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
} from "@openbot-build/api"
import { Authorization } from "@openbot-build/protocol"
import type { PgClient } from "@effect/sql-pg"
import { Clock, Effect, Layer, Schema } from "effect"
import { and, eq } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import {
	appAuthorizations,
	appConnections,
	appSecrets,
} from "../database/Schema.ts"
import { AuthorizationRepository, Record } from "./AuthorizationRepository.ts"
import { Secrets } from "../secrets/Secrets.ts"

const unavailable = () => ExperienceStorageUnavailable.make({})
const conflict = () =>
	ConnectionsApi.ConnectionConflict.make({
		reason: "RevisionChanged",
		message: "This connection changed. Review it before authorizing.",
	})
const consumed = () =>
	Api.AppAuthorizationFailed.make({
		reason: "AlreadyConsumed",
		message:
			"This authorization has already been handled. Open My Apps to view the current connection.",
	})
/** Keep the errors that callers handle. Every other storage failure becomes one error. */
const fail = (error: unknown) =>
	error instanceof ExperienceNotFound ||
	error instanceof ConnectionsApi.ConnectionConflict ||
	error instanceof Api.AppAuthorizationFailed
		? error
		: unavailable()
const flowCodec = Schema.fromJsonString(Schema.toCodecJson(Authorization.Flow))

export const make: Effect.Effect<
	typeof AuthorizationRepository.Service,
	never,
	PgClient.PgClient | Secrets
> = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const secrets = yield* Secrets
	const callbackBinding = (owner: string, id: string) =>
		JSON.stringify(["app-authorization", owner, id])
	const decode = Effect.fn("AppAuthorizations.decode")(function* (
		row: typeof appAuthorizations.$inferSelect,
	) {
		const scopes = yield* Schema.decodeEffect(
			Schema.fromJsonString(Schema.Array(Schema.String)),
		)(row.scopes)
		const callback =
			row.callback === null
				? null
				: yield* secrets.open(row.callback, callbackBinding(row.owner, row.id))
		return yield* Schema.decodeUnknownEffect(Record)({
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
	const get = Effect.fn("AppAuthorizations.get")(function* (id: string) {
		const row = (yield* db
			.select()
			.from(appAuthorizations)
			.where(eq(appAuthorizations.id, id))
			.pipe(Effect.mapError(unavailable)))[0]
		if (row === undefined) return yield* ExperienceNotFound.make({ id })
		return yield* decode(row).pipe(Effect.mapError(unavailable))
	})
	return AuthorizationRepository.of({
		recover: db
			.update(appAuthorizations)
			.set({ status: "Failed", reason: "Interrupted", callback: null })
			.where(eq(appAuthorizations.status, "Processing"))
			.pipe(Effect.asVoid, Effect.mapError(unavailable)),
		begin: (flow, input) =>
			db
				.transaction((tx) =>
					Effect.gen(function* () {
						const connection = (yield* tx
							.select({ revision: appConnections.revision })
							.from(appConnections)
							.where(
								and(
									eq(appConnections.owner, flow.binding.owner),
									eq(appConnections.id, flow.binding.connectionId),
								),
							)
							.for("update"))[0]
						if (connection === undefined)
							return yield* ExperienceNotFound.make({
								id: flow.binding.connectionId,
							})
						if (connection.revision !== input.revision) return yield* conflict()
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
							scopes: JSON.stringify(flow.scopes),
						})
					}),
				)
				.pipe(Effect.mapError(fail)),
		get,
		receive: (id, input) =>
			Effect.gen(function* () {
				const record = yield* get(id)
				const callback =
					input.callback === null
						? null
						: yield* secrets
								.seal(input.callback, callbackBinding(record.owner, id))
								.pipe(Effect.mapError(unavailable))
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
					.pipe(Effect.mapError(unavailable))
				if (rows.length === 0) return yield* consumed()
			}),
		claim: (owner, id) =>
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
						if (row.status !== "Received") return yield* consumed()
						if (row.expiresAt <= (yield* Clock.currentTimeMillis))
							return yield* Api.AppAuthorizationFailed.make({
								reason: "FlowExpired",
								message:
									"This authorization expired. Start a new authorization from My Apps.",
							})
						const connection = (yield* tx
							.select({ revision: appConnections.revision })
							.from(appConnections)
							.where(
								and(
									eq(appConnections.owner, owner),
									eq(appConnections.id, row.connectionId),
								),
							)
							.for("update"))[0]
						if (
							connection === undefined ||
							connection.revision !== row.revision
						)
							return yield* conflict()
						yield* tx
							.update(appAuthorizations)
							.set({ status: "Processing" })
							.where(eq(appAuthorizations.id, id))
						return yield* decode({ ...row, status: "Processing" })
					}),
				)
				.pipe(Effect.mapError(fail)),
		finish: (owner, id, status, reason) =>
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
					Effect.mapError(unavailable),
					Effect.flatMap((rows) =>
						rows.length === 1 ? Effect.void : Effect.fail(consumed()),
					),
				),
	})
})
export const layer = Layer.effect(AuthorizationRepository, make)
