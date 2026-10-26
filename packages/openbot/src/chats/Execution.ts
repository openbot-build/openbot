import { ChatExecutionBlocked, type ChatExecution } from "@openbot-build/api"
import { Chat, Turn } from "@openbot-build/core"
import { and, eq, inArray } from "drizzle-orm"
import { Array as Arr, Effect, Schema } from "effect"
import type * as Db from "../database/Database.ts"
import {
	appInvocations,
	botRecords,
	codeRuns,
	operations,
} from "../database/Schema.ts"
import * as ChatHost from "./ChatHost.ts"
import { databaseError } from "./ChatEncoding.ts"
import { toPublic } from "./ResponseMapping.ts"
import type { ServiceError } from "./Chats.ts"

/** Keep an execution conflict when a store write also has a public storage error. */
export const toPublicExecution = <A, R>(
	effect: Effect.Effect<
		A,
		Chat.RuntimeError | ServiceError | ChatExecutionBlocked,
		R
	>,
): Effect.Effect<A, ServiceError | ChatExecutionBlocked, R> =>
	Effect.matchEffect(effect, {
		onSuccess: Effect.succeed,
		onFailure: (
			error,
		): Effect.Effect<never, ServiceError | ChatExecutionBlocked> =>
			Schema.is(ChatExecutionBlocked)(error)
				? Effect.fail(error)
				: toPublic(Effect.fail(error)),
	})

export const timeoutMillis = 30_000
export const transitionActive = (state: ChatHost.ExecutionState, now: number) =>
	state.transition !== undefined &&
	state.transition.startedAt + timeoutMillis > now

/** Old Chats keep their old mode until a client changes it. */
export const of = (chat: Chat.Ref): ChatHost.ExecutionState => {
	const state = ChatHost.hostState(chat)
	if (state.execution !== undefined) return state.execution
	const live = state.kind === "live"
	return {
		mode: live ? "live" : "chat",
		generation: 0,
		...(chat.settings.model === undefined
			? {}
			: live
				? { liveModel: chat.settings.model }
				: { chatModel: chat.settings.model }),
	}
}

export const view = (chat: Chat.Ref, now: number): ChatExecution => {
	const state = of(chat)
	const lease = state.lease
	return {
		mode: state.mode,
		generation: state.generation,
		phase: transitionActive(state, now)
			? "switching"
			: state.mode === "chat"
				? "ready"
				: lease !== undefined &&
					  lease.generation === state.generation &&
					  lease.expiresAt > now
					? lease.phase
					: "selected",
		...(state.chatModel === undefined ? {} : { chatModel: state.chatModel }),
		...(state.liveModel === undefined ? {} : { liveModel: state.liveModel }),
	}
}

export const blocked = (
	reason: ChatExecutionBlocked["reason"],
	message: string,
	ids: ReadonlyArray<string> = [],
) => ChatExecutionBlocked.make({ reason, message, ids })

/** Plain queued messages can pass to another mode without running old tool calls. */
export const isTextMessage = (entry: Chat.InboxEntry) =>
	entry.kind === "message" &&
	entry.passive !== true &&
	entry.approved === undefined &&
	Arr.every(
		entry.content.content,
		(message) =>
			message.role === "system" ||
			Arr.every(
				message.content,
				(part: { readonly type: string }) => part.type === "text",
			),
	)

/** This check runs under the same revision check that reserves the change. */
export const idleProblem = (chat: Chat.Ref, active: boolean, now: number) => {
	const state = ChatHost.hostState(chat)
	if (state.kind !== "direct" && state.kind !== "live")
		return blocked(
			"kind",
			"Only direct Chats and live Chats can change execution.",
		)
	const execution = of(chat)
	if (transitionActive(execution, now) && execution.transition !== undefined)
		return blocked("transition", "The Chat is already changing execution.", [
			execution.transition.id,
		])
	const turn = Chat.currentTurn(chat)
	if (active || (turn !== undefined && !Turn.isTerminal(turn.status)))
		return blocked(
			"running",
			"Wait for the current Turn to end.",
			turn === undefined ? [] : [turn.id],
		)
	const waiting = Arr.filter(
		chat.inbox,
		(entry) => entry.kind !== "message" || entry.approved !== undefined,
	)
	if (waiting.length > 0)
		return blocked(
			"inbox",
			"Finish queued tool input before changing execution.",
			Arr.map(waiting, (entry) => entry.id),
		)
	const lease = execution.lease
	if (
		lease !== undefined &&
		lease.generation === execution.generation &&
		lease.expiresAt > now &&
		lease.busy
	)
		return blocked("connection", "Wait for the Live input to end.", [
			lease.sessionId,
		])
	return undefined
}

/** A finished Turn can still have approval, App input or work outside the model. */
export const checkWork = (
	db: Effect.Success<typeof Db.make>,
	input: {
		readonly chat: Chat.Id
		readonly namespace: string
		readonly organizationId: string
		readonly owner: string
	},
) =>
	Effect.gen(function* () {
		const pending = yield* db
			.select({ id: botRecords.id })
			.from(botRecords)
			.where(
				and(
					eq(botRecords.kind, "request"),
					eq(botRecords.organizationId, input.organizationId),
					eq(botRecords.scope, input.chat),
					eq(botRecords.status, "pending"),
				),
			)
			.pipe(Effect.mapError(databaseError), toPublic)
		if (pending.length > 0)
			return yield* blocked(
				"approval",
				"Finish the pending decisions before changing execution.",
				Arr.map(pending, (row) => row.id),
			)
		const calls = yield* db
			.select({ id: appInvocations.id })
			.from(appInvocations)
			.where(
				and(
					eq(appInvocations.owner, input.owner),
					eq(appInvocations.chat, input.chat),
					inArray(appInvocations.status, [
						"PendingApproval",
						"Approved",
						"Sending",
						"InputRequired",
						"OutcomeUnknown",
					]),
				),
			)
			.pipe(Effect.mapError(databaseError), toPublic)
		const background = yield* db
			.select({ id: operations.id })
			.from(operations)
			.where(
				and(
					eq(operations.namespace, input.namespace),
					eq(operations.chat, input.chat),
					eq(operations.status, "Running"),
				),
			)
			.pipe(Effect.mapError(databaseError), toPublic)
		const programs = yield* db
			.select({ id: codeRuns.id })
			.from(codeRuns)
			.where(
				and(
					eq(codeRuns.owner, input.owner),
					eq(codeRuns.chat, input.chat),
					inArray(codeRuns.status, ["Running", "Waiting"]),
				),
			)
			.pipe(Effect.mapError(databaseError), toPublic)
		const ids = Arr.map([...calls, ...background, ...programs], (row) => row.id)
		if (ids.length > 0)
			return yield* blocked(
				"operation",
				"Finish or check the open operations before changing execution.",
				ids,
			)
	})
