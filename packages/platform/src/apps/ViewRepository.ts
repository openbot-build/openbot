import {
	AppViewsApi as Api,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	SessionConflict,
} from "@openbot-build/platform-api"
import { Context, Effect, Schema } from "effect"
import { Item, Session, Turn } from "@openbot-build/core"

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
	kind: Schema.Literals(["tool", "resource"]),
	target: Schema.String,
	arguments: Schema.JsonObject,
	ticket: Schema.NullOr(Api.ActionTicket),
})
export type Action = typeof Action.Type
export class ViewRepository extends Context.Service<
	ViewRepository,
	{
		readonly recover: Effect.Effect<void, ExperienceStorageUnavailable>
		readonly open: (owner: string, view: View) => Effect.Effect<void, Error>
		readonly get: (owner: string, id: string) => Effect.Effect<View, Error>
		readonly close: (owner: string, id: string) => Effect.Effect<void, Error>
		readonly interaction: (
			owner: string,
			session: string,
			operationId: string,
		) => Effect.Effect<Api.Interaction, Error>
		readonly confirm: (
			owner: string,
			view: View,
			revision: number,
			context: Schema.JsonObject,
		) => Effect.Effect<Api.Interaction, Error>
		readonly claim: (
			owner: string,
			view: View,
			action: Action,
		) => Effect.Effect<boolean, Error>
		readonly action: (
			owner: string,
			viewId: string,
			requestId: string,
		) => Effect.Effect<Action, Error>
		readonly accepted: (
			owner: string,
			view: View,
			requestId: string,
			ticket: Api.ActionTicket,
		) => Effect.Effect<void, Error>
		readonly contexts: (
			owner: string,
			session: string,
		) => Effect.Effect<
			ReadonlyArray<{
				readonly operationId: string
				readonly context: Schema.JsonObject
			}>,
			Error
		>
	}
>()("@openbot-build/platform/apps/ViewRepository") {}
