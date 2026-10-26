import { type Chat } from "@openbot-build/core"
import { Clock, Effect } from "effect"
import type { Chats } from "../Chats.ts"
import * as Execution from "../Execution.ts"

/** The record lives with the Chat, so two servers cannot own the same session. */
export const lifetimeMillis = 30_000
export const renewEveryMillis = 10_000
type Service = typeof Chats.Service

export interface Owner {
	readonly chat: Chat.Id
	readonly generation: number
	readonly sessionId: string
}

const lost = () =>
	Execution.blocked(
		"connection",
		"This Live connection no longer owns the Chat.",
	)

export const valid = (chats: Service, owner: Owner) =>
	Effect.gen(function* () {
		const execution = Execution.of((yield* chats.read(owner.chat)).chat)
		const now = yield* Clock.currentTimeMillis
		return (
			execution.mode === "live" &&
			execution.generation === owner.generation &&
			execution.lease?.sessionId === owner.sessionId &&
			execution.lease.generation === owner.generation &&
			execution.lease.expiresAt > now
		)
	})

export const claim = (chats: Service, owner: Owner) =>
	chats.changeExecution(owner.chat, (chat) =>
		Effect.gen(function* () {
			const execution = Execution.of(chat)
			const now = yield* Clock.currentTimeMillis
			if (
				execution.mode !== "live" ||
				execution.generation !== owner.generation ||
				Execution.transitionActive(execution, now)
			)
				return yield* lost()
			if (execution.lease !== undefined && execution.lease.expiresAt > now)
				return yield* Execution.blocked(
					"connection",
					"The Chat already has a Live connection.",
				)
			return {
				...execution,
				lease: {
					sessionId: owner.sessionId,
					generation: owner.generation,
					expiresAt: now + lifetimeMillis,
					phase: "connecting" as const,
					busy: false,
				},
			}
		}),
	)

export const update = (
	chats: Service,
	owner: Owner,
	change: {
		readonly phase?: "connecting" | "ready"
		readonly busy?: boolean
	} = {},
) =>
	chats.changeExecution(owner.chat, (chat) =>
		Effect.gen(function* () {
			const execution = Execution.of(chat)
			const now = yield* Clock.currentTimeMillis
			const lease = execution.lease
			if (
				execution.mode !== "live" ||
				execution.generation !== owner.generation ||
				((change.phase !== undefined || change.busy !== undefined) &&
					Execution.transitionActive(execution, now)) ||
				lease?.sessionId !== owner.sessionId ||
				lease.generation !== owner.generation ||
				lease.expiresAt <= now
			)
				return yield* lost()
			return {
				...execution,
				lease: { ...lease, ...change, expiresAt: now + lifetimeMillis },
			}
		}),
	)

/** An old finalizer never removes a newer session or changes its execution mode. */
export const release = (chats: Service, owner: Owner) =>
	chats.changeExecution(owner.chat, (chat) =>
		Effect.sync(() => {
			const execution = Execution.of(chat)
			if (
				execution.generation !== owner.generation ||
				execution.lease?.sessionId !== owner.sessionId
			)
				return execution
			const { lease: _lease, ...rest } = execution
			return rest
		}),
	)
