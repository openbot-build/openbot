import { Context } from "effect"
import * as Admission from "@openbot-build/server-execution/Admission"

/** Pauses control new work. They do not replace access checks or block saved results. */
export interface Service {
	readonly check: Admission.Check
}

export class WorkAdmission extends Context.Service<WorkAdmission, Service>()(
	"@openbot-build/conversation-contract/chats/WorkAdmission",
) {}
