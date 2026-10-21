import { Match, Predicate, Record as EffectRecord, Schema } from "effect"
import { dual } from "effect/Function"
import { Session, Turn } from "@openbot-build/core"
import type { Memory } from "@openbot-build/plugin-memory"
import {
	SessionNotFound,
	SessionStorageUnavailable,
	SessionInvalidRecord,
	SessionConflict,
	type SessionResponse,
	type StartTurnRequest,
} from "@openbot-build/platform-api"
import { Prompt, type Response } from "effect/ai"
import type { ServiceError } from "./Sessions.ts"

export const publicError = (
	error:
		| Session.RuntimeError
		| Schema.SchemaError
		| ServiceError
		| Memory.MemoryError,
): ServiceError =>
	Match.value(error).pipe(
		Match.tag(
			"SessionBusy",
			"SessionConflict",
			"SessionInvalidRecord",
			"SessionStorageUnavailable",
			"SessionModelInvalid",
			(error) => error,
		),
		Match.tag("SessionNotFound", (error) =>
			SessionNotFound.make({ session: error.session }),
		),
		Match.tag("SessionStoreError", (error) => {
			if (error.reason === "storage-failed")
				return SessionStorageUnavailable.make({})
			return ["reference-conflict", "version-conflict"].includes(error.reason)
				? SessionConflict.make({ message: error.message })
				: SessionInvalidRecord.make({ message: error.message })
		}),
		Match.orElse((error) => SessionConflict.make({ message: error.message })),
	)

export const inputPrompt = (input: StartTurnRequest["input"]): Prompt.Prompt =>
	Predicate.isString(input)
		? Prompt.make(input)
		: Prompt.fromMessages(
				input.map((message) =>
					Prompt.makeMessage("user", {
						content: Predicate.isString(message.content)
							? [Prompt.makePart("text", { text: message.content })]
							: message.content.map((part) =>
									Prompt.makePart("text", { text: part.text }),
								),
					}),
				),
			)

export const addUsage: {
	(next: Response.Usage): (previous: SessionResponse["usage"]) => {
		inputTokens: Record<string, number>
		outputTokens: Record<string, number>
	}
	(
		previous: SessionResponse["usage"],
		next: Response.Usage,
	): {
		inputTokens: Record<string, number>
		outputTokens: Record<string, number>
	}
} = dual(2, (previous: SessionResponse["usage"], next: Response.Usage) => {
	const sum = (a: number | undefined, b: number | undefined) =>
		a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
	const clean = (values: Readonly<Record<string, number | undefined>>) =>
		EffectRecord.filter(values, Predicate.isNotUndefined)
	return {
		inputTokens: clean({
			total: sum(previous?.inputTokens.total, next.inputTokens.total),
			uncached: sum(previous?.inputTokens.uncached, next.inputTokens.uncached),
			cacheRead: sum(
				previous?.inputTokens.cacheRead,
				next.inputTokens.cacheRead,
			),
			cacheWrite: sum(
				previous?.inputTokens.cacheWrite,
				next.inputTokens.cacheWrite,
			),
		}),
		outputTokens: clean({
			total: sum(previous?.outputTokens.total, next.outputTokens.total),
			text: sum(previous?.outputTokens.text, next.outputTokens.text),
			reasoning: sum(
				previous?.outputTokens.reasoning,
				next.outputTokens.reasoning,
			),
		}),
	}
})

/** Later Session and Timeline updates keep the Turn identity and its final Timeline version. */
export const response: {
	(turn: Turn.Record): (view: Session.View) => SessionResponse
	(view: Session.View, turn: Turn.Record): SessionResponse
} = dual(2, (view: Session.View, turn: Turn.Record): SessionResponse => {
	const state = turn.status
	const phase: SessionResponse["status"] = Match.value(state).pipe(
		Match.tag("Running", () => "in_progress" as const),
		Match.tag("WaitingApproval", () => "incomplete" as const),
		Match.tag("Completed", ({ result }) =>
			["stop", "tool-calls"].includes(result.finishReason)
				? ("completed" as const)
				: ("incomplete" as const),
		),
		Match.tag("Failed", () => "failed" as const),
		Match.tag("Interrupted", () => "cancelled" as const),
		Match.exhaustive,
	)
	const finish = Match.value(state).pipe(
		Match.tag(
			"Completed",
			"WaitingApproval",
			({ result }) => result.finishReason,
		),
		Match.orElse(() => "unknown" as const),
	)
	const output = view.state.value.conversation.history
		.filter((entry) => entry.origin?.turn === turn.id)
		.flatMap((entry) => {
			const messages = entry.content.content.filter(
				(message) => message.role === "assistant",
			)
			if (
				messages.length === 0 &&
				!(entry.content.content.length === 0 && (entry.origin?.step ?? 0) > 0)
			)
				return []
			return [
				{
					id: entry.id,
					type: "message" as const,
					role: "assistant" as const,
					status:
						phase === "in_progress"
							? ("in_progress" as const)
							: phase === "completed"
								? ("completed" as const)
								: ("incomplete" as const),
					content: [
						{
							type: "output_text" as const,
							text: messages
								.flatMap((message) => message.content)
								.flatMap((part) =>
									Match.value(part).pipe(
										Match.when({ type: "text" }, (part) => [part.text]),
										Match.orElse(() => []),
									),
								)
								.join(""),
							annotations: [] as const,
						},
					],
				},
			]
		})
	const usage = turn.usage?.reduce<SessionResponse["usage"]>(
		(previous, next) => addUsage(previous, next),
		undefined,
	)
	return {
		id: turn.id,
		object: "response",
		created_at: Math.floor(turn.startedAt / 1000),
		session: view.session.id,
		version: turn.end ?? view.session.head,
		background: true,
		status: phase,
		output,
		error: Match.value(state).pipe(
			Match.tag("Failed", (state) => ({
				code: state.code,
				message: state.message,
			})),
			Match.orElse(() => null),
		),
		incomplete_details:
			phase === "incomplete"
				? {
						reason:
							finish === "length"
								? "max_output_tokens"
								: finish === "content-filter"
									? "content_filter"
									: "other",
					}
				: null,
		...(usage === undefined ? {} : { usage }),
	}
})
