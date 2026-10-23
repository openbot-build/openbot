import { Session, Turn } from "@openbot-build/core"
import type { BotsApi } from "@openbot-build/api"
import { Clock, Context, Effect, Layer, type Option, Schema } from "effect"
import { BotRecords } from "../../bots/BotRecords.ts"
import { hash } from "../../capabilities/Capability.ts"

export const WaitStatus = Schema.Literals(["waiting", "done", "cancelled"])
export type WaitStatus = typeof WaitStatus.Type

/** One `openbot_wait` call. The tool call waits until `dueAt`, and then goes on. */
export const Wait = Schema.Struct({
	id: Schema.String,
	userId: Schema.String,
	session: Session.Id,
	turn: Turn.Id,
	toolCallId: Schema.String,
	createdAt: Schema.Finite,
	dueAt: Schema.Finite,
	status: WaitStatus,
})
export type Wait = typeof Wait.Type

/** The waits of the tool `openbot_wait`. They are saved, so they last over a restart. */
export class Waits extends Context.Service<
	Waits,
	{
		/** Saves a wait for a tool call. A second call for the same tool call keeps the first. */
		readonly start: (
			organizationId: string,
			input: Pick<Wait, "userId" | "session" | "turn" | "toolCallId" | "dueAt">,
		) => Effect.Effect<Wait, BotsApi.BotStorageUnavailable>
		readonly find: (
			organizationId: string,
			id: string,
		) => Effect.Effect<Option.Option<Wait>, BotsApi.BotStorageUnavailable>
		/** The open waits in every organization. */
		readonly open: Effect.Effect<
			ReadonlyArray<{ readonly organizationId: string; readonly value: Wait }>,
			BotsApi.BotStorageUnavailable
		>
		/** The waits whose time came, in every organization. */
		readonly due: Effect.Effect<
			ReadonlyArray<{ readonly organizationId: string; readonly value: Wait }>,
			BotsApi.BotStorageUnavailable
		>
		readonly close: (
			organizationId: string,
			wait: Wait,
			status: Exclude<WaitStatus, "waiting">,
		) => Effect.Effect<void, BotsApi.BotStorageUnavailable>
		/** The open waits of a Session. */
		readonly forSession: (
			organizationId: string,
			session: Session.Id,
		) => Effect.Effect<ReadonlyArray<Wait>, BotsApi.BotStorageUnavailable>
	}
>()("@openbot-build/openbot/plugins/work/Waits") {}

export const make: Effect.Effect<typeof Waits.Service, never, BotRecords> =
	Effect.gen(function* () {
		const records = yield* BotRecords
		const waits = records.collection("wait", Wait, WaitStatus)
		const keys = (organizationId: string, wait: Wait) => ({
			organizationId,
			id: wait.id,
			owner: wait.userId,
			scope: wait.session,
			status: wait.status,
		})
		return Waits.of({
			start: (organizationId, input) =>
				Effect.gen(function* () {
					const id =
						"wat_" + hash([input.session, input.toolCallId]).slice(0, 32)
					return yield* records.transaction(
						id,
						Effect.gen(function* () {
							const found = yield* waits.find(organizationId, id)
							if (found._tag === "Some") return found.value
							const wait: Wait = {
								...input,
								id,
								createdAt: yield* Clock.currentTimeMillis,
								status: "waiting",
							}
							yield* waits.put(keys(organizationId, wait), wait)
							return wait
						}),
					)
				}),
			find: waits.find,
			open: waits.withStatus("waiting"),
			due: Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis
				const open = yield* waits.withStatus("waiting")
				return open.filter((entry) => entry.value.dueAt <= now)
			}),
			close: (organizationId, wait, status) =>
				waits.put(keys(organizationId, { ...wait, status }), {
					...wait,
					status,
				}),
			forSession: (organizationId, session) =>
				waits.list(organizationId, { scope: session, status: "waiting" }),
		})
	})
export const layer = Layer.effect(Waits, make)
