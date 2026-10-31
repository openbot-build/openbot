import { Chat, type Item, type Turn } from "@openbot-build/core"
import type { Execution } from "@openbot-build/domain"
import type {
	ChatInfo,
	ChatSummary,
	ChatView,
	OpenWork,
} from "@openbot-build/api"
import * as ChatHost from "./ChatHost.ts"
import { response } from "./ResponseMapping.ts"
import { Array as Arr } from "effect"

export const info = (ref: Chat.Ref): ChatInfo => {
	const state = ChatHost.hostState(ref)
	return {
		id: ref.id,
		revision: ref.revision,
		kind: state.kind,
		bot: state.bot,
		parent: state.parent ?? null,
		...(state.title === undefined ? {} : { title: state.title }),
		settings: ref.settings,
		...(state.planApproval === undefined
			? {}
			: { planApproval: state.planApproval }),
		createdAt: ref.createdAt,
	}
}

/** HTTP views use saved state. A local fiber is not proof of execution ownership. */
export const project = (input: {
	readonly view: Chat.View<ChatHost.Values>
	readonly items: ReadonlyArray<Item.Record>
	readonly executionId: Execution.Id | null
	readonly open: OpenWork
}): ChatView => {
	const ref = input.view.chat
	const turn = Chat.currentTurn(ref)
	return {
		chat: info(ref),
		status: Chat.status(ref)._tag,
		turn: turn ?? null,
		response: turn === undefined ? null : response(ref.id, turn, input.items),
		executionId: input.executionId,
		inbox: ref.inbox.length,
		queuedInputs: Arr.flatMap(ref.inbox, (entry) =>
			entry.kind === "action" ||
			entry.action !== undefined ||
			entry.notice !== undefined ||
			entry.approved !== undefined
				? []
				: [
						{
							id: entry.id,
							kind: entry.kind,
							turn: entry.turn ?? null,
							content: entry.content,
						},
					],
		),
		open: input.open,
	}
}
export const summary = (
	ref: Chat.Ref,
	executionId: Execution.Id | null,
): ChatSummary => {
	const turn: Turn.Record | undefined = ref.turn
	const latest = turn === undefined ? undefined : response(ref.id, turn, [])
	return {
		chat: info(ref),
		status: Chat.status(ref)._tag,
		turn: turn?.id ?? null,
		response:
			latest === undefined
				? null
				: {
						id: latest.id,
						created_at: latest.created_at,
						status: latest.status,
					},
		executionId,
	}
}
