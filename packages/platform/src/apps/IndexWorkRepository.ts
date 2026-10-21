import { AppIndexApi } from "@openbot-build/platform-api"
import { Discovery, Index } from "@openbot-build/protocol"
import { Context, Effect, Option, Schema } from "effect"

export const Claim = Schema.Struct({
	cardUrl: Schema.NonEmptyString,
	token: Schema.NonEmptyString,
	generation: Schema.String,
	sources: Schema.Array(Discovery.Source),
})
export type Claim = typeof Claim.Type
export const Job = Schema.Struct({
	cardUrl: Schema.String,
	generation: Schema.String,
	status: Schema.Literals(["Waiting", "Verifying", "Completed"]),
	check: Schema.NullOr(AppIndexApi.Check),
	requestedAt: Schema.Finite,
})
export type Job = typeof Job.Type
export class IndexWorkRepository extends Context.Service<
	IndexWorkRepository,
	{
		readonly restart: Effect.Effect<void, Index.IndexError>
		readonly enqueue: (
			cardUrl: string,
			sources: ReadonlyArray<Discovery.Source>,
		) => Effect.Effect<Job, Index.IndexError>
		readonly get: (
			cardUrl: string,
			generation?: string,
		) => Effect.Effect<Option.Option<Job>, Index.IndexError>
		readonly claim: (
			cardUrl?: string,
		) => Effect.Effect<Option.Option<Claim>, Index.IndexError>
		readonly finish: (
			claim: Claim,
			check: AppIndexApi.Check,
			nextCheckAt: number,
		) => Effect.Effect<void, Index.IndexError>
		readonly release: (claim: Claim) => Effect.Effect<void, Index.IndexError>
	}
>()("@openbot-build/platform/apps/IndexWorkRepository") {}
