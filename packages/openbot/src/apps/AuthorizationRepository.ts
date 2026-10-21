import {
	AppAuthorizationApi as Api,
	ConnectionsApi,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
} from "@openbot-build/api"
import { Authorization } from "@openbot-build/protocol"
import { Context, Effect, Schema } from "effect"

export type Error =
	| ExperienceNotFound
	| ExperienceStorageUnavailable
	| ConnectionsApi.ConnectionConflict
	| Api.AppAuthorizationFailed
export const Record = Schema.Struct({
	state: Api.State,
	owner: Schema.NonEmptyString,
	revision: Schema.Natural,
	callback: Schema.NullOr(Schema.String),
})
export type Record = typeof Record.Type

export class AuthorizationRepository extends Context.Service<
	AuthorizationRepository,
	{
		readonly recover: Effect.Effect<void, ExperienceStorageUnavailable>
		readonly begin: (
			flow: Authorization.Flow,
			input: {
				readonly revision: number
				readonly returnTo: string
				readonly resource: string
			},
		) => Effect.Effect<void, Error>
		readonly get: (flowId: string) => Effect.Effect<Record, Error>
		readonly receive: (
			flowId: string,
			input: {
				readonly callback: string | null
				readonly status: "Received" | "Cancelled" | "Failed"
				readonly reason: string | null
			},
		) => Effect.Effect<void, Error>
		readonly claim: (
			owner: string,
			flowId: string,
		) => Effect.Effect<Record, Error>
		readonly finish: (
			owner: string,
			flowId: string,
			status: "Succeeded" | "Failed",
			reason: string | null,
		) => Effect.Effect<void, Error>
	}
>()("@openbot-build/openbot/apps/AuthorizationRepository") {}
