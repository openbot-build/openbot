import { type Caller, Execution } from "@openbot-build/domain"
import { Effect } from "effect"
import { ownerKey } from "../../src/apps-contract/apps/StoredConnections.ts"
import { Store } from "../../src/server-execution/execution/Store.ts"
import type { Host } from "../BrowserHost.ts"

/** Reads the saved receipt for one completed task notice. */
export const delegationNoticeReceipt = (
	host: Host,
	actor: Caller,
	delegation: Execution.Id,
	result: string,
) =>
	host.run(
		Effect.gen(function* () {
			const store = yield* Store
			return yield* store.receipt(
				ownerKey(actor),
				Execution.CommandKey.make(`delegation-end:${delegation}:result`),
				{ actor, body: { status: "completed", result } },
			)
		}),
	)
