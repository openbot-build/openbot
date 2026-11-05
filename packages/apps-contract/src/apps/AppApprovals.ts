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
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
	"@openbot-build/openbot/apps-contract/apps/AppApprovals",
) {}
