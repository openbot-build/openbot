import {
	Array as Arr,
	Cause,
	Effect,
	Match,
	Option,
	pipe,
	Predicate,
	Record as Rec,
} from "effect"
import { dual } from "effect/Function"
import type { Chat, Item, Operation, Turn } from "@openbot-build/core"
import {
	ChatNotFound,
	ChatStorageUnavailable,
	ChatConflict,
	type ChatResponse,
	type MessageInput,
} from "@openbot-build/api"
import { Prompt, type Response } from "effect/ai"
import type { ServiceError } from "./Chats.ts"

type Failure = Chat.RuntimeError | ServiceError | Operation.StoreError

const conflict = (error: { readonly message: string }) =>
	ChatConflict.make({ message: error.message })

/**
 * Sorts a failure by its meaning. A conflict and a missing Chat keep their
 * meaning. A server fault, such as a database failure or stored data that does
 * not decode, becomes `ChatStorageUnavailable`, because the client cannot act
 * on it.
 */
const publicError = (error: Failure): ServiceError =>
	Match.value(error).pipe(
		Match.tag("ChatStorageUnavailable", "ChatModelInvalid", (error) => error),
		Match.tag("ChatConflict", "TurnConflict", conflict),
		Match.tag("ChatNotFound", (error) =>
			ChatNotFound.make({ chat: error.chat }),
		),
		Match.tag("OperationStoreError", () => ChatStorageUnavailable.make({})),
		Match.tag("ChatStoreError", (error) =>
			error.reason === "reference-conflict"
				? conflict(error)
				: ChatStorageUnavailable.make({}),
		),
		Match.tag("ChatError", (error) =>
			error.reason === "state-conflict"
				? conflict(error)
				: ChatStorageUnavailable.make({}),
		),
		Match.tag("ContextCompactionError", (error) =>
			error.reason === "head-conflict"
				? conflict(error)
				: ChatStorageUnavailable.make({}),
		),
		Match.exhaustive,
	)

const isFault = (error: Failure) =>
	error._tag !== "ChatStorageUnavailable" &&
	publicError(error)._tag === "ChatStorageUnavailable"

/**
 * Gives the public error of a Chat failure. The public error goes to the
 * client, so it must not hold the inside failure. For a server fault, this
 * logs the full cause first, at level Warn, as `Failures.replace` does.
 */
export const toPublic = <A, E extends Failure, R>(
	self: Effect.Effect<A, E, R>,
): Effect.Effect<A, ServiceError, R> =>
	self.pipe(
		Effect.tapCauseIf(
			(cause) => Option.exists(Cause.findErrorOption(cause), isFault),
			(cause) => Effect.logWarning("Chat storage failed", cause),
		),
		Effect.mapError(publicError),
	)

export const inputPrompt = (
	input: MessageInput | Prompt.Prompt,
): Prompt.Prompt =>
	Prompt.isPrompt(input)
		? input
		: Predicate.isString(input)
			? Prompt.make(input)
			: Prompt.fromMessages(
					Arr.map(input, (message) =>
						Prompt.makeMessage("user", {
							content: Predicate.isString(message.content)
								? [Prompt.makePart("text", { text: message.content })]
								: // The Files service turns file parts into prompts. Here only text is left.
									Arr.flatMap(message.content, (part) =>
										part.type === "input_text"
											? [Prompt.makePart("text", { text: part.text })]
											: [],
									),
						}),
					),
				)

export const addUsage: {
	(next: Response.Usage): (previous: ChatResponse["usage"]) => {
		inputTokens: Record<string, number>
		outputTokens: Record<string, number>
	}
	(
		previous: ChatResponse["usage"],
		next: Response.Usage,
	): {
		inputTokens: Record<string, number>
		outputTokens: Record<string, number>
	}
} = dual(2, (previous: ChatResponse["usage"], next: Response.Usage) => {
	const sum = (a: number | undefined, b: number | undefined) =>
		a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
	const clean = (values: Readonly<Record<string, number | undefined>>) =>
		Rec.filter(values, Predicate.isNotUndefined)
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

/** The text that the Bot wrote in some Items. */
export const textOf = (items: ReadonlyArray<Item.Entry>): string =>
	pipe(
		items,
		Arr.flatMap((entry) => entry.content.content),
		Arr.filter((message) => message.role === "assistant"),
		Arr.flatMap((message) => message.content),
		Arr.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		Arr.join(""),
	)

/** One Turn in the Responses format. `items` are the Items of that Turn. */
export const response: {
	(
		turn: Turn.Record,
		items: ReadonlyArray<Item.Entry>,
	): (chat: Chat.Id) => ChatResponse
	(
		chat: Chat.Id,
		turn: Turn.Record,
		items: ReadonlyArray<Item.Entry>,
	): ChatResponse
} = dual(
	3,
	(
		chat: Chat.Id,
		turn: Turn.Record,
		items: ReadonlyArray<Item.Entry>,
	): ChatResponse => {
		const state = turn.status
		const phase: ChatResponse["status"] = Match.value(state).pipe(
			Match.tag("Running", () => "in_progress" as const),
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
			Match.tag("Completed", ({ result }) => result.finishReason),
			Match.orElse(() => "unknown" as const),
		)
		const output = pipe(
			items,
			Arr.filter((entry) => entry.origin?.turn === turn.id),
			Arr.flatMap((entry) => {
				const messages = Arr.filter(
					entry.content.content,
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
								text: textOf([entry]),
								annotations: [] as const,
							},
						],
					},
				]
			}),
		)
		const usage = Arr.reduce<Response.Usage, ChatResponse["usage"]>(
			turn.usage ?? [],
			undefined,
			(previous, next) => addUsage(previous, next),
		)
		return {
			id: turn.id,
			object: "response",
			created_at: Math.floor(turn.startedAt / 1000),
			chat,
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
	},
)
