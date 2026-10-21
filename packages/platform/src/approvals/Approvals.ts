import { Context, Layer } from "effect"
import { Session } from "@openbot-build/core"

export class Approvals extends Context.Service<
	Approvals,
	{
		readonly pending: (
			view: Session.View<{}>,
		) => ReadonlyArray<Session.PendingApproval>
	}
>()("@openbot-build/platform/approvals/Approvals") {}

export const layer = Layer.succeed(Approvals, {
	pending: Session.pendingApprovals,
})
