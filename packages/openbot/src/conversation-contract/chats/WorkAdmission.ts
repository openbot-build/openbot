import { Context } from "effect"
import * as Admission from "../../server-execution/execution/Admission.ts"

/** Pauses control new work. They do not replace access checks or block saved results. */
export interface Service {
	readonly check: Admission.Check
}

export class WorkAdmission extends Context.Service<WorkAdmission, Service>()(
	"@openbot-build/openbot/conversation-contract/chats/WorkAdmission",
) {}
