import { type Execution, AppCalls } from "@openbot-build/domain"
import { Context, Effect } from "effect"

export interface Service {
	readonly decide: (
		owner: string,
		proposal: AppCalls.Invocation,
		allowed: boolean,
	) => Effect.Effect<"Changed" | "Saved", Execution.StorageError>
}

export class AppApprovals extends Context.Service<AppApprovals, Service>()(
	"@openbot-build/openbot/apps-contract/apps/AppApprovals",
) {}
