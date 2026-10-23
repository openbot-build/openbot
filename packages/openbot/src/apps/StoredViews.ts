import {
	AppViewsApi as Api,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	SessionConflict,
} from "@openbot-build/api"
import { Item, Session, Turn } from "@openbot-build/core"
import { and, eq, like } from "drizzle-orm"
import { Array as Arr, Effect, Option, Schema } from "effect"
import { appSecrets } from "../database/Schema.ts"
import type { Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"

/** The open App views, their actions and their confirmed interaction state, kept sealed in Postgres. */
export type Error =
	ExperienceNotFound | ExperienceStorageUnavailable | SessionConflict
export const View = Schema.Struct({
	id: Schema.String,
	operationId: Schema.String,
	readOnly: Schema.Boolean,
	session: Session.Id,
	turn: Turn.Id,
	item: Item.Id,
	connectionId: Schema.String,
	revision: Schema.Natural,
	expiresAt: Schema.Finite,
})
export type View = typeof View.Type
export const Action = Schema.Struct({
	requestId: Schema.String,
	kind: Api.ActionKind,
	target: Schema.String,
	arguments: Schema.JsonObject,
	ticket: Schema.NullOr(Api.ActionTicket),
})
export type Action = typeof Action.Type

export const unavailable = () => ExperienceStorageUnavailable.make({})
export const conflict = () =>
	SessionConflict.make({
		message:
			"The App view or confirmed interaction changed. Read its current state before continuing.",
	})
export const missing = () => ExperienceNotFound.make({ id: "App view" })
/** Keep the errors that callers handle. Every other storage failure becomes one error. */
export const failure = (value: unknown) =>
	value instanceof ExperienceNotFound || value instanceof SessionConflict
		? value
		: unavailable()
export const initial: Api.Interaction = { revision: 0, context: null }
export const interactionKey = (session: string, operationId: string) =>
	JSON.stringify([session, operationId])
export const actionKey = (viewId: string, requestId: string) =>
	JSON.stringify([viewId, requestId])
type Sealer = typeof Secrets.Service

export const where = (owner: string, kind: string, id: string) =>
	and(
		eq(appSecrets.owner, owner),
		eq(appSecrets.kind, kind),
		eq(appSecrets.id, id),
	)
const binding = (owner: string, kind: string, id: string) =>
	JSON.stringify([kind, owner, id])
export const seal = <S extends Schema.Top>(
	secrets: Sealer,
	schema: S,
	owner: string,
	kind: string,
	id: string,
	value: S["Type"],
) =>
	Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(
		value,
	).pipe(Effect.flatMap((body) => secrets.seal(body, binding(owner, kind, id))))
export const open = <S extends Schema.Top>(
	secrets: Sealer,
	schema: S,
	row: typeof appSecrets.$inferSelect,
) =>
	secrets
		.open(row.body, binding(row.owner, row.kind, row.id))
		.pipe(
			Effect.flatMap(
				Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema))),
			),
		)

/** The confirmed interaction context of each App operation in a Session. */
export const contexts = (
	db: Db.Database,
	secrets: Sealer,
	owner: string,
	session: string,
): Effect.Effect<
	ReadonlyArray<{
		readonly operationId: string
		readonly context: Schema.JsonObject
	}>,
	Error
> =>
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
					Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
				)(row.id)
				const state = yield* open(secrets, Api.Interaction, row)
				return boundSession === session && state.context !== null
					? Option.some({ operationId, context: state.context })
					: Option.none()
			}),
		)
		return Arr.getSomes(values)
	}).pipe(Effect.mapError(failure))
