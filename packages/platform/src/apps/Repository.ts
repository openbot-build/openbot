import {
	ConnectionsApi as Api,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
} from "@openbot-build/platform-api"
import { Store } from "@openbot-build/protocol"
import { Context, Effect, Schema } from "effect"

export type Error =
	ExperienceNotFound | ExperienceStorageUnavailable | Api.ConnectionConflict
export const StoredConnection = Schema.Struct({
	connection: Store.UserConnection,
	name: Api.ConnectionName,
	revision: Schema.Natural,
	verification: Schema.NullOr(Api.Availability),
})
export type StoredConnection = typeof StoredConnection.Type
export interface SaveRequest {
	readonly app: Store.AppRecord
	readonly connection: Store.UserConnection
	readonly name: string
	readonly draftRevision?: number
}
export const ownerKey = (owner: {
	readonly organizationId: string
	readonly userId: string
}) => JSON.stringify([owner.organizationId, owner.userId])

export class Repository extends Context.Service<
	Repository,
	{
		readonly list: (
			owner: string,
		) => Effect.Effect<
			ReadonlyArray<StoredConnection>,
			ExperienceStorageUnavailable
		>
		readonly get: (
			owner: string,
			id: string,
		) => Effect.Effect<StoredConnection, Error>
		readonly listApps: (
			owner: string,
		) => Effect.Effect<
			ReadonlyArray<Store.AppRecord>,
			ExperienceStorageUnavailable
		>
		readonly getApp: (
			owner: string,
			cardUrl: string,
		) => Effect.Effect<Store.AppRecord, Error>
		readonly updateApp: (
			owner: string,
			app: Store.AppRecord,
		) => Effect.Effect<void, Error>
		readonly save: (
			owner: string,
			input: SaveRequest,
		) => Effect.Effect<StoredConnection, Error>
		readonly update: (
			owner: string,
			id: string,
			change: (stored: StoredConnection) => StoredConnection,
			revision?: number,
		) => Effect.Effect<StoredConnection, Error>
		readonly remove: (owner: string, id: string) => Effect.Effect<void, Error>
		readonly saveDraft: (
			owner: string,
			draft: Api.ConnectionDraft,
		) => Effect.Effect<Api.ConnectionDraft, ExperienceStorageUnavailable>
		readonly getDraft: (
			owner: string,
			id: string,
		) => Effect.Effect<Api.ConnectionDraft, Error>
		/** Remove the owner's preparation drafts and saved App interface state. */
		readonly clearDrafts: (
			owner: string,
		) => Effect.Effect<void, ExperienceStorageUnavailable>
	}
>()("@openbot-build/platform/apps/Repository") {}
