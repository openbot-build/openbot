import type { PgClient } from "@effect/sql-pg"
import {
	AppViewsApi as Api,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	SessionConflict,
} from "@openbot-build/api"
import { and, eq, like } from "drizzle-orm"
import { makeWithDefaults } from "drizzle-orm/effect-postgres"
import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import { appSecrets } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { Action, View, ViewRepository } from "./ViewRepository.ts"

const unavailable = () => ExperienceStorageUnavailable.make({})
const conflict = () =>
	SessionConflict.make({
		message:
			"The App view or confirmed interaction changed. Read its current state before continuing.",
	})
const missing = () => ExperienceNotFound.make({ id: "App view" })
/** Keep the errors that callers handle. Every other storage failure becomes one error. */
const error = (value: unknown) =>
	value instanceof ExperienceNotFound || value instanceof SessionConflict
		? value
		: unavailable()
const initial: Api.Interaction = { revision: 0, context: null }
const key = (session: string, operationId: string) =>
	JSON.stringify([session, operationId])
const actionKey = (viewId: string, requestId: string) =>
	JSON.stringify([viewId, requestId])
export const make: Effect.Effect<
	typeof ViewRepository.Service,
	never,
	PgClient.PgClient | Secrets
> = Effect.gen(function* () {
	const db = yield* makeWithDefaults()
	const secrets = yield* Secrets
	const where = (owner: string, kind: string, id: string) =>
		and(
			eq(appSecrets.owner, owner),
			eq(appSecrets.kind, kind),
			eq(appSecrets.id, id),
		)
	const binding = (owner: string, kind: string, id: string) =>
		JSON.stringify([kind, owner, id])
	const seal = <S extends Schema.Top>(
		schema: S,
		owner: string,
		kind: string,
		id: string,
		value: S["Type"],
	) =>
		Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(
			value,
		).pipe(
			Effect.flatMap((body) => secrets.seal(body, binding(owner, kind, id))),
		)
	const decode = <S extends Schema.Top>(
		schema: S,
		row: typeof appSecrets.$inferSelect,
	) =>
		secrets
			.open(row.body, binding(row.owner, row.kind, row.id))
			.pipe(
				Effect.flatMap(
					Schema.decodeEffect(
						Schema.fromJsonString(Schema.toCodecJson(schema)),
					),
				),
			)
	const read = (owner: string, kind: string, id: string) =>
		db
			.select()
			.from(appSecrets)
			.where(where(owner, kind, id))
			.pipe(Effect.map(Arr.head))
	const required = <A>(found: Option.Option<A>) =>
		Effect.fromOption(found).pipe(Effect.mapError(missing))
	const action = (owner: string, viewId: string, requestId: string) =>
		read(owner, "app-view-action", actionKey(viewId, requestId)).pipe(
			Effect.flatMap(required),
			Effect.flatMap((row) => decode(Action, row)),
			Effect.mapError(error),
		)
	return ViewRepository.of({
		recover: db
			.update(appSecrets)
			.set({ consumed: true })
			.where(eq(appSecrets.kind, "app-view"))
			.pipe(Effect.asVoid, Effect.mapError(unavailable)),
		open: (owner, view) =>
			Effect.gen(function* () {
				const body = yield* seal(View, owner, "app-view", view.id, view)
				yield* db.insert(appSecrets).values({
					owner,
					kind: "app-view",
					id: view.id,
					connectionId: view.connectionId,
					body,
				})
			}).pipe(Effect.mapError(error)),
		get: (owner, id) =>
			read(owner, "app-view", id).pipe(
				Effect.map(Option.filter((row) => !row.consumed)),
				Effect.flatMap(required),
				Effect.flatMap((row) => decode(View, row)),
				Effect.mapError(error),
			),
		close: (owner, id) =>
			db
				.update(appSecrets)
				.set({ consumed: true })
				.where(where(owner, "app-view", id))
				.returning({ id: appSecrets.id })
				.pipe(
					Effect.flatMap((rows) =>
						rows.length === 0 ? Effect.fail(missing()) : Effect.void,
					),
					Effect.mapError(error),
				),
		interaction: (owner, session, operationId) =>
			Effect.gen(function* () {
				const found = yield* read(
					owner,
					"app-ui-state",
					key(session, operationId),
				)
				return yield* Option.match(found, {
					onNone: () => Effect.succeed(initial),
					onSome: (row) => decode(Api.Interaction, row),
				})
			}).pipe(Effect.mapError(error)),
		confirm: (owner, view, revision, context) =>
			Effect.gen(function* () {
				const id = key(view.session, view.operationId)
				const initialBody = yield* seal(
					Api.Interaction,
					owner,
					"app-ui-state",
					id,
					initial,
				)
				return yield* db.transaction((tx) =>
					Effect.gen(function* () {
						yield* tx
							.insert(appSecrets)
							.values({
								owner,
								kind: "app-ui-state",
								id,
								connectionId: view.connectionId,
								body: initialBody,
							})
							.onConflictDoNothing()
						const row = (yield* tx
							.select()
							.from(appSecrets)
							.where(where(owner, "app-ui-state", id))
							.for("update"))[0]
						if (row === undefined) return yield* missing()
						const previous = yield* decode(Api.Interaction, row)
						if (previous.revision !== revision) return yield* conflict()
						const next: Api.Interaction = { revision: revision + 1, context }
						const body = yield* seal(
							Api.Interaction,
							owner,
							"app-ui-state",
							id,
							next,
						)
						yield* tx
							.update(appSecrets)
							.set({ body })
							.where(where(owner, "app-ui-state", id))
						return next
					}),
				)
			}).pipe(Effect.mapError(error)),
		claim: (owner, view, input) =>
			Effect.gen(function* () {
				const id = actionKey(view.id, input.requestId)
				const body = yield* seal(Action, owner, "app-view-action", id, input)
				const inserted = yield* db
					.insert(appSecrets)
					.values({
						owner,
						kind: "app-view-action",
						id,
						connectionId: view.connectionId,
						body,
					})
					.onConflictDoNothing()
					.returning({ id: appSecrets.id })
				if (inserted.length !== 0) return true
				const saved = yield* action(owner, view.id, input.requestId)
				if (
					saved.kind !== input.kind ||
					saved.target !== input.target ||
					!Schema.toEquivalence(Schema.JsonObject)(
						saved.arguments,
						input.arguments,
					)
				)
					return yield* conflict()
				return false
			}).pipe(Effect.mapError(error)),
		action,
		accepted: (owner, view, requestId, ticket) =>
			db
				.transaction((tx) =>
					Effect.gen(function* () {
						const id = actionKey(view.id, requestId)
						const row = (yield* tx
							.select()
							.from(appSecrets)
							.where(where(owner, "app-view-action", id))
							.for("update"))[0]
						if (row === undefined) return yield* missing()
						const saved = yield* decode(Action, row)
						if (
							saved.ticket !== null &&
							!Schema.toEquivalence(Api.ActionTicket)(saved.ticket, ticket)
						)
							return yield* conflict()
						const body = yield* seal(Action, owner, "app-view-action", id, {
							...saved,
							ticket,
						})
						yield* tx
							.update(appSecrets)
							.set({ body })
							.where(where(owner, "app-view-action", id))
					}),
				)
				.pipe(Effect.mapError(error)),
		contexts: (owner, session) =>
			Effect.gen(function* () {
				const prefix =
					(JSON.stringify([session]).slice(0, -1) + ",").replace(
						/[\\%_]/g,
						"\\$&",
					) + "%"
				const rows = yield* db
					.select()
					.from(appSecrets)
					.where(
						and(
							eq(appSecrets.owner, owner),
							eq(appSecrets.kind, "app-ui-state"),
							like(appSecrets.id, prefix),
						),
					)
				const values = yield* Effect.forEach(rows, (row) =>
					Effect.gen(function* () {
						const [boundSession, operationId] = yield* Schema.decodeEffect(
							Schema.fromJsonString(
								Schema.Tuple([Schema.String, Schema.String]),
							),
						)(row.id)
						const state = yield* decode(Api.Interaction, row)
						return boundSession === session && state.context !== null
							? Option.some({ operationId, context: state.context })
							: Option.none()
					}),
				)
				return Arr.getSomes(values)
			}).pipe(Effect.mapError(error)),
	})
})
export const layer = Layer.effect(ViewRepository, make)
