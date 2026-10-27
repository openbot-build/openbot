import { Chat, ToolStep, Turn } from "@openbot-build/core"
import { Execution } from "@openbot-build/domain"
import { Array as Arr, Effect, Option, Schema } from "effect"
import * as Db from "../database/Database.ts"
import { Store, storage, type Fence } from "../execution/Store.ts"
import * as ChatHost from "./ChatHost.ts"
import * as StoredChats from "./StoredChats.ts"
import * as ToolOrigins from "./ToolOrigins.ts"
import { TurnAccess } from "./TurnAccess.ts"

/** The saved source of a main or nested call. A child keeps its main call's frame. */
export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const store = yield* Store
	const origins = yield* ToolOrigins.make
	const access = yield* TurnAccess
	const read = Effect.fn("CallFrame.read")(function* (
		fence: Fence,
		site: Execution.CallSite,
	) {
		const saved = yield* store.loadMember(fence)
		yield* access.authorize(fence, saved.identity.actor, "replay")
		if (saved.identity.botId === undefined)
			return yield* Execution.Forbidden.make({})
		if (saved.record.resource.kind !== "Turn") {
			const found = yield* origins.find(fence)
			if (Option.isNone(found)) return yield* Execution.Forbidden.make({})
			const parent = found.value
			if (
				site.main !== parent.child.record.callId ||
				!ToolOrigins.contains(parent.path, site.path)
			)
				return yield* Execution.Conflict.make({ id: fence.id })
			return {
				identity: saved.identity,
				bot: saved.identity.botId,
				parent: parent.key.id,
				position: parent.child.record.position,
				host: parent.child.input.context.host,
				action: parent.child.input.context.action,
				call:
					site.path.length === 0
						? Option.some(parent.child.input.call)
						: Option.none(),
				callPath: [site.main, ...site.path],
			}
		}
		const input = yield* Schema.decodeUnknownEffect(
			Schema.Struct({ chat: Chat.Id }),
		)(saved.input)
		const chat = yield* StoredChats.ref(db, fence.namespace, input.chat)
		const turn = Option.isSome(chat) ? chat.value.turn : undefined
		if (
			turn?.id !== saved.record.resource.id ||
			turn.pendingStep === undefined ||
			!Arr.some(
				ToolStep.pending(Turn.stepPrompt(turn.pendingStep)),
				(call) => call.id === site.main,
			)
		)
			return yield* Execution.Conflict.make({ id: fence.id })
		return {
			identity: saved.identity,
			bot: saved.identity.botId,
			parent: fence.id,
			callPath: [site.main, ...site.path],
			host: ChatHost.hostState(Option.getOrThrow(chat)),
			action: turn.activeAction?.action ?? turn.action,
			call:
				site.path.length === 0
					? Arr.findFirst(
							ToolStep.pending(Turn.stepPrompt(turn.pendingStep)),
							(call) => call.id === site.main,
						)
					: Option.none(),
			position: {
				chat: input.chat,
				turn: Turn.Id.make(saved.record.resource.id),
				item: turn.pendingStep.item,
				step: turn.pendingStep.step,
			},
		}
	}, storage)
	return { read }
})
