import { type PlatformError, Context, Effect, Option, Schema } from "effect"
import type { SecretStorageError } from "@openbot-build/server-kernel/secrets/Secrets"
import {
	type ServiceExecution,
	type Key,
	type Fence,
} from "@openbot-build/server-execution/execution/Store"
import { AppIndex, Execution } from "@openbot-build/domain"
import { Discovery, Index, Indexing } from "@openbot-build/protocol"
import { appIndexJobs } from "@openbot-build/server-database/Schema"

export const CheckInput = Schema.Struct({
	cardUrl: Schema.String,
	sources: Schema.Array(Discovery.Source),
	previous: Schema.NullOr(Index.Entry),
})

export type CheckInput = typeof CheckInput.Type

export const CheckResult = Schema.TaggedUnion({
	Checked: { result: Indexing.SyncResult },
	Failed: { failure: Execution.Failure },
})

export type CheckResult = typeof CheckResult.Type

/** The Index owns checks and results. The shared engine owns all scheduling. */
export interface Service {
	readonly request: (
		cardUrl: string,
		sources: readonly Discovery.Source[],
	) => Effect.Effect<
		{
			job: {
				cardUrl: string
				generation: string
				requestedAt: number
				status: AppIndex.JobStatus
				check: AppIndex.Check | null
			}
			execution: { namespace: string; id: Execution.Id }
		},
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| PlatformError.PlatformError
		| Schema.SchemaError
		| Execution.StorageError
	>
	readonly job: (
		cardUrl: string,
		generation?: string | undefined,
	) => Effect.Effect<
		Option.Option<AppIndex.Job>,
		Schema.SchemaError | Execution.StorageError
	>
	readonly load: (
		key: Key,
		lock?: boolean,
	) => Effect.Effect<
		{
			saved: ServiceExecution
			row: typeof appIndexJobs.$inferSelect
		},
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| Execution.StorageError
	>
	readonly authorize: (
		key: Key,
	) => Effect.Effect<
		void,
		Execution.Forbidden | Execution.NotFound | Execution.StorageError
	>
	readonly begin: (fence: Fence) => Effect.Effect<
		{
			generation: string
			input: {
				cardUrl: string
				sources: readonly Discovery.Source[]
				previous: Index.Entry | null
			}
		},
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| PlatformError.PlatformError
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
	readonly restriction: (
		cardUrl: string,
	) => Effect.Effect<
		Option.Option<AppIndex.Restriction>,
		Execution.StorageError
	>
	readonly inspect: (
		input: CheckInput,
		restriction: Option.Option<AppIndex.Restriction>,
	) => Effect.Effect<
		| {
				readonly _tag: "Unconfirmed"
				readonly stages: readonly Indexing.InspectionStage[]
				readonly cardUrl: string
				readonly reason: string
				readonly url: string
				readonly issue: string
		  }
		| { _tag: "Indexed"; entry: Index.Entry }
		| { _tag: "Excluded" | "Withdrawn"; cardUrl: string; reason: string },
		Indexing.IndexingError | Execution.StorageError
	>
	readonly complete: (
		fence: Fence,
		generation: string,
		outcome: CheckResult,
	) => Effect.Effect<
		undefined,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.NotFound
		| Schema.SchemaError
		| SecretStorageError
		| Execution.StorageError
	>
}

export class IndexWork extends Context.Service<IndexWork, Service>()(
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
	"@openbot-build/openbot/apps-contract/apps/IndexWork",
) {}
