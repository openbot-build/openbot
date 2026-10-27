import { Array as Arr, Effect, Match, Option, Struct, pipe } from "effect"
import { Prompt, type Response } from "effect/ai"
import * as Chat from "./Chat.ts"
import * as ChatState from "./ChatState.ts"
import * as Turn from "./Turn.ts"
import * as Item from "./Item.ts"
import type * as ChatStore from "../store/ChatStore.ts"
import * as ContextWindow from "../context/ContextWindow.ts"

/** The first message of a window that was rebuilt for another model. */
const compactedNote =
	"Earlier messages of this Chat were compacted for another model, so they are not shown here."

/** The inbox after a Turn ends. Steers that the Turn did not read wait for the next Turn. */
export const after = (
	inbox: ReadonlyArray<Chat.InboxEntry>,
	turn: Turn.Id,
): ReadonlyArray<Chat.InboxEntry> =>
	Arr.flatMap(inbox, (entry) =>
		entry.turn !== turn
			? [entry]
			: entry.kind === "steer"
				? [{ ...Struct.omit(entry, ["turn"]), kind: "message" as const }]
				: [],
	)

/** The changes that add Items to the log and to the window of the model. */
export const append = <P>(
	view: Chat.View<P>,
	entries: ReadonlyArray<Item.Entry>,
	conversation: Partial<ChatState.Conversation> = {},
): Pick<ChatStore.Mutation<P>, "value" | "append"> => ({
	append: entries,
	value: {
		...view.state,
		conversation: {
			...view.state.conversation,
			context: ContextWindow.append(
				view.state.conversation.context,
				ChatState.promptOf(entries),
			),
			...conversation,
		},
	},
})

/** A window for the model of a Turn. A native window of another model is rebuilt. */
export const windowFor = (
	window: ChatState.Conversation["context"],
	settings: Turn.Settings,
) =>
	Match.value(window).pipe(
		Match.tag("Native", (window) =>
			settings.model?.provider === window.provider &&
			settings.model.model === window.model
				? window
				: ContextWindow.fromPrompt(
						Prompt.concat(
							Prompt.make([{ role: "user", content: compactedNote }]),
							window.prompt,
						),
					),
		),
		Match.tag("Prompt", (window) => window),
		Match.exhaustive,
	)

/** The first run of inbox messages that have the same author. */
export const leading = <P>(
	view: Chat.View<P>,
): Option.Option<Arr.NonEmptyReadonlyArray<Chat.InboxEntry>> =>
	pipe(
		Arr.filter(view.chat.inbox, (entry) => entry.kind === "message"),
		Arr.match({
			onEmpty: () => Option.none(),
			onNonEmpty: (messages) => {
				const head = Arr.headNonEmpty(messages)
				return Option.some(
					Arr.prepend(
						Arr.takeWhile(
							Arr.tailNonEmpty(messages),
							(entry) => entry.author === head.author,
						),
						head,
					),
				)
			},
		}),
	)

/** Put input in its Chat. Only input from the current author may steer a Turn. */
export const place = (
	chat: Chat.Ref,
	entry: Chat.InboxEntry,
	queue: boolean = false,
) => {
	const current = Chat.currentTurn(chat)
	const turn =
		current !== undefined &&
		current.status._tag === "Running" &&
		current.author === entry.author &&
		!queue
			? Option.some(current.id)
			: Option.none<Turn.Id>()
	return {
		turn,
		inbox: Arr.append(
			chat.inbox,
			Option.match(turn, {
				onNone: () => entry,
				onSome: (turn): Chat.InboxEntry => ({ ...entry, kind: "steer", turn }),
			}),
		),
	}
}

/** Build one admitted Turn. The store must commit this change as one step. */
export const start = <P>(
	view: Chat.View<P>,
	input: {
		readonly turn: Turn.Id
		readonly selected: Arr.NonEmptyReadonlyArray<Chat.InboxEntry>
		readonly items: ReadonlyArray<Item.Entry>
		readonly startedAt: number
		readonly author?: Turn.Author
		readonly overrides?: Partial<Turn.Settings>
		readonly action?: Turn.Action
	},
): Effect.Effect<ChatStore.Mutation<P>, Chat.Conflict> => {
	const previous = Chat.currentTurn(view.chat)
	if (previous !== undefined && !Turn.isTerminal(previous.status))
		return Effect.fail(
			Chat.Conflict.make({
				chat: view.chat.id,
				message: "The Chat already has an unfinished Turn",
			}),
		)
	const head = Arr.headNonEmpty(input.selected)
	const author = input.author ?? head.author
	const settings = { ...view.chat.settings, ...input.overrides }
	const selectedIds = Arr.map(input.selected, (entry) => entry.id)
	const record: Turn.Record = {
		...(input.action === undefined ? {} : { action: input.action }),
		...(author === undefined ? {} : { author }),
		id: input.turn,
		chat: view.chat.id,
		settings,
		status: { _tag: "Running" },
		steps: 0,
		input: selectedIds,
		items: Arr.map(input.items, (item) => item.id),
		startedAt: input.startedAt,
	}
	const prepared: Chat.View<P> = {
		...view,
		state: {
			...view.state,
			conversation: {
				...view.state.conversation,
				context: windowFor(view.state.conversation.context, settings),
			},
		},
	}
	return Effect.succeed({
		...append(prepared, input.items, { closed: false }),
		chat: {
			turn: record,
			inbox: Arr.filter(
				view.chat.inbox,
				(entry) => !Arr.contains(selectedIds, entry.id),
			),
		},
	})
}

/** A saved step may only change the current Turn. */
export const requireTurn = <P>(view: Chat.View<P>, turn: Turn.Id) => {
	const current = Chat.currentTurn(view.chat)
	return current?.id === turn
		? Effect.succeed(current)
		: Effect.fail(
				Turn.Conflict.make({
					chat: view.chat.id,
					turn,
					message: "The target Turn is no longer current",
				}),
			)
}

/** A late step cannot undo the end of a Turn. */
export const requireOpen = <P>(view: Chat.View<P>, turn: Turn.Id) =>
	Effect.gen(function* () {
		const current = yield* requireTurn(view, turn)
		if (Turn.isTerminal(current.status))
			return yield* Turn.Conflict.make({
				chat: view.chat.id,
				turn,
				message: "The Turn has already ended",
			})
		return current
	})

/** Finish reasons that end a Turn even when input waits. */
const endingReasons: ReadonlyArray<Response.FinishReason> = [
	"length",
	"content-filter",
	"error",
	"pause",
]

/**
 * Commit a finished step against the latest Chat, including input that came while
 * it ran. Tool results and approval answers must already be in its content.
 * A host commits the returned mutation together with its step result and events.
 */
export const finishStep = <P>(
	view: Chat.View<P>,
	input: {
		readonly turn: Turn.Id
		readonly item: Item.Id
		readonly step: number
		readonly content: Prompt.Prompt
		readonly output: Turn.Output
		readonly model: boolean
		readonly followUp: boolean
		readonly answered: boolean
		readonly usage?: Response.Usage
		readonly completedAt: number
	},
): Effect.Effect<
	{
		readonly stop: boolean
		readonly turn: Turn.Record
		readonly mutation: ChatStore.Mutation<P>
	},
	Turn.Conflict
> =>
	Effect.gen(function* () {
		const current = yield* requireOpen(view, input.turn)
		const endsTurn = Arr.contains(endingReasons, input.output.finishReason)
		const wouldStop =
			!input.answered && (!input.model || endsTurn || !input.followUp)
		const steered =
			input.model &&
			Arr.some(
				view.chat.inbox,
				(entry) => entry.kind === "steer" && entry.turn === input.turn,
			)
		const stop = wouldStop && (endsTurn || !steered)
		const moreActions = Arr.some(
			view.chat.inbox,
			(entry) => entry.kind === "action" && entry.turn === input.turn,
		)
		const terminal = stop && !moreActions
		const turn: Turn.Record = {
			...Struct.omit(
				current,
				input.answered ? ["pendingStep"] : ["activeAction", "pendingStep"],
			),
			status: terminal
				? { _tag: "Completed", result: input.output }
				: { _tag: "Running" },
			steps: input.model ? input.step : current.steps,
			items: Arr.append(current.items, input.item),
			usage:
				input.usage === undefined
					? (current.usage ?? [])
					: [...(current.usage ?? []), input.usage],
			...(terminal ? { completedAt: input.completedAt } : {}),
		}
		return {
			stop,
			turn,
			mutation: {
				...append(
					view,
					[
						{
							id: input.item,
							content: input.content,
							origin: {
								chat: view.chat.id,
								turn: input.turn,
								step: input.model ? input.step : 0,
							},
						},
					],
					{ closed: terminal },
				),
				chat: {
					turn,
					...(terminal ? { inbox: after(view.chat.inbox, input.turn) } : {}),
				},
			},
		}
	})

/** Close an open Turn with the results that its host saved for unfinished calls. */
export const end = <P>(
	view: Chat.View<P>,
	input: {
		readonly turn: Turn.Id
		readonly status: Exclude<Turn.Status, { readonly _tag: "Running" }>
		readonly completedAt: number
		readonly items: ReadonlyArray<Item.Entry>
	},
): Effect.Effect<
	{ readonly turn: Turn.Record; readonly mutation: ChatStore.Mutation<P> },
	Turn.Conflict
> =>
	Effect.gen(function* () {
		const current = yield* requireOpen(view, input.turn)
		const turn: Turn.Record = {
			...Struct.omit(current, ["pendingStep"]),
			status: input.status,
			completedAt: input.completedAt,
			items: [...current.items, ...Arr.map(input.items, (entry) => entry.id)],
		}
		return {
			turn,
			mutation: {
				...append(view, input.items, { closed: true }),
				chat: { inbox: after(view.chat.inbox, input.turn), turn },
			},
		}
	})

/** Build Items for inbox input. An approved call includes its saved decision. */
export const inputs = <E, R>(
	id: () => Effect.Effect<string, E, R>,
	chat: Chat.Id,
	turn: Turn.Id,
	step: number,
	entries: ReadonlyArray<Chat.InboxEntry>,
) =>
	Effect.forEach(entries, (entry) =>
		Effect.gen(function* () {
			const origin: Item.Origin = {
				chat,
				turn,
				step,
				...(entry.notice === undefined ? {} : { notice: entry.notice }),
			}
			const input: Item.Entry = {
				id: entry.id,
				content: entry.content,
				origin,
			}
			if (entry.approved === undefined) return [input]
			const call = entry.approved
			const approved: Item.Entry = {
				id: Item.Id.make(yield* id()),
				content: Prompt.make([
					{
						role: "assistant",
						content: [
							Prompt.toolCallPart({
								id: call.id,
								name: call.name,
								params: call.params,
								providerExecuted: false,
							}),
							Prompt.toolApprovalRequestPart({
								approvalId: call.id,
								toolCallId: call.id,
							}),
						],
					},
					{
						role: "tool",
						content: [
							Prompt.toolApprovalResponsePart({
								approvalId: call.id,
								approved: true,
							}),
						],
					},
				]),
				origin,
			}
			return [input, approved]
		}),
	).pipe(Effect.map(Arr.flatten))
