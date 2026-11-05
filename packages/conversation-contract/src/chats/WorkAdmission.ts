import { Context } from "effect"
import * as Admission from "@openbot-build/server-execution/execution/Admission"

/** Pauses control new work. They do not replace access checks or block saved results. */
export interface Service {
	readonly check: Admission.Check
}

export class WorkAdmission extends Context.Service<WorkAdmission, Service>()(
	// @effect-diagnostics-next-line deterministicKeys:off -- The key keeps the name it had in the openbot package, so code built for that name still finds this service.
	"@openbot-build/openbot/conversation-contract/chats/WorkAdmission",
) {}
