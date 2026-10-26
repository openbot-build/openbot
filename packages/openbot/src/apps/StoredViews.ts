import {
	AppViewsApi as Api,
	AppExecution,
	ConnectionsApi,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	ChatConflict,
} from "@openbot-build/api"
import { Chat, Item, Turn } from "@openbot-build/core"
import { and, eq, like } from "drizzle-orm"
import {
	Array as Arr,
	Effect,
	Option,
	pipe,
	Schema,
	String as Str,
} from "effect"
import { appSecrets } from "../database/Schema.ts"
import type { Secrets } from "../secrets/Secrets.ts"
import * as Db from "../database/Database.ts"
import * as Failures from "../app/Failures.ts"

/** The open App views, their actions and their confirmed interaction state, kept sealed in Postgres. */
export type Error =
	ExperienceNotFound | ExperienceStorageUnavailable | ChatConflict
export const View = Schema.Struct({
	id: Api.AppViewId,
	operationId: AppExecution.AppOperationId,
	readOnly: Schema.Boolean,
	chat: Chat.Id,
	turn: Turn.Id,
	item: Item.Id,
	connectionId: ConnectionsApi.ConnectionId,
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

/**
 * Log a storage failure that the caller can not act on, and replace it with
 * one error. The error goes to the client, so it does not hold the failure.
 */
const unavailable = (message: string) =>
	Failures.replace(message, () => ExperienceStorageUnavailable.make({}))
export const initial: Api.Interaction = { revision: 0, context: null }
export const interactionKey = (chat: string, operationId: string) =>
	JSON.stringify([chat, operationId])
export const actionKey = (viewId: string, requestId: string) =>
	JSON.stringify([viewId, requestId])
const ChatJson = Schema.fromJsonString(Schema.Tuple([Schema.String]))
type Sealer = typeof Secrets.Service

export const where = (owner: string, kind: string, id: string) =>
	and(
		eq(appSecrets.owner, owner),
		eq(appSecrets.kind, kind),
		eq(appSecrets.id, id),
	)
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
	).pipe(
		Effect.flatMap((body) =>
			secrets.seal(body, JSON.stringify([kind, owner, id])),
		),
	)
export const open = <S extends Schema.Top>(
	secrets: Sealer,
	schema: S,
	row: typeof appSecrets.$inferSelect,
) =>
	secrets
		.open(row.body, JSON.stringify([row.kind, row.owner, row.id]))
		.pipe(
			Effect.flatMap(
				Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema))),
			),
		)

/** The confirmed interaction context of each App operation in a Chat. */
export const contexts = (
	db: Db.Database,
	secrets: Sealer,
	owner: string,
	chat: string,
): Effect.Effect<
	ReadonlyArray<{
		readonly operationId: string
		readonly context: Schema.JsonObject
	}>,
	Error
> =>
	Effect.gen(function* () {
		const start = yield* Schema.encodeEffect(ChatJson)([chat]).pipe(
			Effect.orDie,
		)
		const prefix =
			pipe(Str.slice(0, -1)(start) + ",", Str.replace(/[\\%_]/g, "\\$&")) + "%"
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
				const [boundChat, operationId] = yield* Schema.decodeEffect(
					Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
				)(row.id)
				const state = yield* open(secrets, Api.Interaction, row)
				return boundChat === chat && state.context !== null
					? Option.some({ operationId, context: state.context })
					: Option.none()
			}),
		)
		return Arr.getSomes(values)
	}).pipe(
		Effect.catchTag(
			["EffectDrizzleQueryError", "SchemaError", "SecretStorageError"],
			(error) =>
				Effect.fail(error).pipe(
					unavailable(
						"Could not read the confirmed App interactions of a Chat.",
					),
				),
		),
	)
