import {
	AppExecution,
	ExperienceNotFound,
	ExperienceStorageUnavailable,
	SessionConflict,
} from "@openbot-build/api"
import { Context, Effect } from "effect"

export type Error =
	ExperienceNotFound | ExperienceStorageUnavailable | SessionConflict
export class InvocationRepository extends Context.Service<
	InvocationRepository,
	{
		readonly recover: Effect.Effect<void, ExperienceStorageUnavailable>
		readonly put: (
			owner: string,
			invocation: AppExecution.Invocation,
		) => Effect.Effect<AppExecution.Invocation, Error>
		readonly get: (
			owner: string,
			id: string,
		) => Effect.Effect<AppExecution.Invocation, Error>
		readonly list: (
			owner: string,
			session: string,
		) => Effect.Effect<
			ReadonlyArray<AppExecution.Invocation>,
			ExperienceStorageUnavailable
		>
		readonly change: (
			owner: string,
			id: string,
			expected: ReadonlyArray<AppExecution.Invocation["status"]>,
			change: (value: AppExecution.Invocation) => AppExecution.Invocation,
			round?: number,
		) => Effect.Effect<AppExecution.Invocation, Error>
	}
>()("@openbot-build/openbot/apps/InvocationRepository") {}
