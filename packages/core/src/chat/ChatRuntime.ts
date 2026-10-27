import {
	Array as Arr,
	Cause,
	Chunk,
	Clock,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberMap,
	FiberSet,
	HashMap,
	Layer,
	Option,
	PubSub,
	Queue,
	Ref,
	Schema,
	Semaphore,
	Stream,
	Scope,
} from "effect"
import { dual } from "effect/Function"
import { AiError, IdGenerator, Prompt, Toolkit, type Tool } from "effect/ai"
import * as Chat from "./Chat.ts"
import * as Turn from "./Turn.ts"
import * as ModelStep from "./ModelStep.ts"
import * as TurnState from "./TurnState.ts"
import * as TurnRunner from "./TurnRunner.ts"
import * as Item from "./Item.ts"
import * as ChatState from "./ChatState.ts"
import * as Bot from "../bot/Bot.ts"
import * as ContextCompaction from "../context/ContextCompaction.ts"
import { ChatStoreError } from "../store/ChatStore.ts"
import { logFailure } from "./Failures.ts"

/**
 * How many events wait for a slow subscriber. When more events come, the oldest
 * go, so a slow client cannot make memory grow without limit.
 */
const eventCapacity = 1024
/** How many recent events a new subscriber gets first, so it can catch up with recent revisions. */
const replayedEvents = 64
/** How many events of a Turn wait for a slow caller of `stream`. Then the Turn waits for it. */
const streamCapacity = 64
/**
 * Each start of a Turn holds one permit. The runtime takes all of them when it
 * closes, so it waits for the starts that are in progress.
 */
const admissionPermits = Number.MAX_SAFE_INTEGER

/**
 * The status of a Turn that failed. The message of a model failure is short and
 * safe to show. Other failures can hold private details, such as an error of the
 * database, so the status gets a fixed text, and the cause goes only to the log.
 */
const failedStatus = (
	cause: Cause.Cause<unknown>,
): Extract<Turn.Status, { readonly _tag: "Failed" }> => {
	const internal: Extract<Turn.Status, { readonly _tag: "Failed" }> = {
		_tag: "Failed",
		code: "internal_error",
		message: "The Turn stopped because of an internal error.",
	}
	if (Cause.hasDies(cause)) return internal
	if (
		Option.exists(
			Cause.findErrorOption(cause),
			Schema.is(Schema.Union([ModelStep.Incomplete, ModelStep.Failed])),
		)
	)
		return {
			_tag: "Failed",
			code: "model_error",
			message: "The model did not give a complete response.",
		}
	return Option.match(Cause.findErrorOption(cause), {
		onNone: () => internal,
		onSome: (error): Extract<Turn.Status, { readonly _tag: "Failed" }> =>
			AiError.isAiError(error) ||
			Schema.is(ContextCompaction.ContextCompactionError)(error)
				? { _tag: "Failed", code: "model_error", message: error.message }
				: internal,
	})
}

export const make = <
	P = {},
	Tools extends Record<string, Tool.Any> = {},
	E = never,
	R = never,
	BuildE = never,
	BuildR = never,
	HostTools extends Record<string, Tool.Any> = {},
>(
	options: Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
): Effect.Effect<
	Chat.Runtime<P, Tools, E | BuildE, HostTools>,
	never,
	Exclude<BuildR, Bot.Context> | Bot.RuntimeServices<Tools, R> | Scope.Scope
> =>
	Effect.gen(function* () {
		type Event = Bot.Event<
			Toolkit.MergedTools<[Toolkit.Toolkit<Tools>, Toolkit.Toolkit<HostTools>]>,
			P
		>
		const store = options.store
		const generator = Option.getOrElse(
			yield* Effect.serviceOption(IdGenerator.IdGenerator),
			() => IdGenerator.defaultIdGenerator,
		)
		const id = () => generator.generateId()
		const bus = yield* PubSub.sliding<Event>({
			capacity: eventCapacity,
			replay: replayedEvents,
		})
		// A waiter subscribes before it reads the Chat, so it needs no old signals.
		const activity = yield* PubSub.sliding<Chat.Id>(eventCapacity)
		yield* Effect.addFinalizer(() => PubSub.shutdown(bus))
		yield* Effect.addFinalizer(() => PubSub.shutdown(activity))
		const running = yield* FiberMap.make<Chat.Id>()
		const watchers = yield* FiberSet.make()
		/** True when the runtime closes. Then no Turn starts, and input waits in the inbox. */
		const closing = yield* Ref.make(false)
		const admission = yield* Semaphore.make(admissionPermits)
		const isActive = (chat: Chat.Id) => FiberMap.has(running, chat)
		const publish = (event: Event) =>
			PubSub.publish(bus, event).pipe(Effect.asVoid)
		const chatEvent = (view: Chat.View<P>): Event => ({
			_tag: "ChatUpdated",
			view,
		})
		yield* Effect.forkScoped(
			store.changes().pipe(
				Stream.runForEach((change) =>
					change._tag === "Committed"
						? publish(chatEvent(change.view))
						: Effect.void,
				),
				Effect.tapCause(logFailure("The listener for Chat changes stopped")),
			),
			{ startImmediately: true },
		)
		// The scope closes what it holds in the reverse order, so this runs first,
		// while the buses are open. After it, no Turn starts, and it waits for the
		// starts that are in progress. Then it stops the running Turns while their
		// watchers still run, so each watcher closes its Turn, also a Turn whose
		// fiber stopped before it ran.
		yield* Effect.addFinalizer(() =>
			Ref.set(closing, true).pipe(
				Effect.andThen(admission.withPermits(admissionPermits)(Effect.void)),
				Effect.andThen(FiberMap.clear(running)),
				Effect.andThen(FiberSet.awaitEmpty(watchers)),
			),
		)
		const runner = yield* TurnRunner.make<
			P,
			Tools,
			E,
			R,
			BuildE,
			BuildR,
			HostTools
		>({
			bot: options.bot,
			store: options.store,
			...(options.operations === undefined
				? {}
				: {
						background: {
							operations: options.operations,
							notify: (input: Chat.DeliverInput) =>
								Effect.suspend(() => deliver(input)),
						},
					}),
		})
		const requireTurn = TurnState.requireTurn

		const itemsOf = (
			chat: Chat.Id,
			turn: Turn.Id,
			step: number,
			entries: ReadonlyArray<Chat.InboxEntry>,
		) => TurnState.inputs(id, chat, turn, step, entries)

		/**
		 * Starts a Turn in one atomic step. `select` picks the input from the inbox
		 * of the current Chat. It gives nothing when no Turn should start.
		 */
		const accept = (input: {
			readonly chat: Chat.Id
			readonly select: (
				view: Chat.View<P>,
			) => Option.Option<Arr.NonEmptyReadonlyArray<Chat.InboxEntry>>
			readonly author?: Turn.Author
			readonly overrides?: Partial<Turn.Settings>
			readonly action?: Turn.Action
			readonly expectedRevision?: Chat.Revision
		}) =>
			Effect.gen(function* () {
				const turn = Turn.Id.make(yield* id())
				const changed = yield* store.modifyEffect({
					chat: input.chat,
					...(input.expectedRevision === undefined
						? {}
						: { expectedRevision: input.expectedRevision }),
					update: (view) =>
						Effect.gen(function* () {
							if (yield* Ref.get(closing))
								return yield* Chat.Conflict.make({
									chat: view.chat.id,
									message: "The runtime is closing",
								})
							if (yield* isActive(view.chat.id))
								return yield* Chat.Conflict.make({
									chat: view.chat.id,
									message: "The previous Turn is still releasing its resources",
								})
							const selected = input.select(view)
							if (Option.isNone(selected))
								return [Option.none(), Option.none()] as const
							const head = Arr.headNonEmpty(selected.value)
							const items = yield* itemsOf(
								view.chat.id,
								turn,
								0,
								selected.value,
							)
							const mutation = yield* TurnState.start(view, {
								turn,
								selected: selected.value,
								items,
								startedAt: yield* Clock.currentTimeMillis,
								...(input.author === undefined ? {} : { author: input.author }),
								...(input.action === undefined ? {} : { action: input.action }),
								...(input.overrides === undefined
									? {}
									: { overrides: input.overrides }),
							})
							return [
								Option.some({ items, first: head.id }),
								Option.some(mutation),
							] as const
						}),
				})
				return Option.map(changed.result, (result): TurnRunner.Accepted<P> => ({
					view: changed.view,
					turn,
					item: result.first,
					prompt: ChatState.promptOf(result.items),
				}))
			})
		const close = (
			chat: Chat.Id,
			turn: Turn.Id,
			status: Exclude<Turn.Status, { readonly _tag: "Running" }>,
		) =>
			store
				.modifyEffect({
					chat,
					update: (view) =>
						Effect.gen(function* () {
							const current = yield* requireTurn(view, turn)
							if (Turn.isTerminal(current.status))
								return [Option.none(), Option.none()] as const
							// Record an unavailable result for each unanswered tool call before later input uses this history.
							const calls = ChatState.unansweredCalls(
								yield* store.items(chat, { turn }),
							)
							const completedAt = yield* Clock.currentTimeMillis
							const item = Item.Id.make(yield* id())
							const prompt = Prompt.make(
								HashMap.size(calls) === 0
									? []
									: [
											{
												role: "tool",
												content: Array.from(calls, ([id, call]) =>
													Prompt.toolResultPart({
														id,
														name: call.name,
														isFailure: true,
														providerExecuted: false,
														result:
															"The tool result is unavailable because its execution context ended.",
													}),
												),
											},
										],
							)
							const items: ReadonlyArray<Item.Entry> =
								prompt.content.length === 0
									? []
									: [
											{
												id: item,
												content: prompt,
												origin: { chat, turn, step: current.steps },
											},
										]
							const ended = yield* TurnState.end(view, {
								turn,
								status,
								completedAt,
								items,
							})
							return [
								Option.some(ended.turn),
								Option.some(ended.mutation),
							] as const
						}),
				})
				.pipe(
					Effect.tap(({ result, view }) =>
						Option.match(result, {
							onNone: () => Effect.void,
							onSome: (turn) => publish({ _tag: "TurnCompleted", view, turn }),
						}),
					),
					Effect.map(({ view }) => view),
				)
		/** Only the memory host saves a partial step as part of a failed Turn. */
		const phases = (accepted: TurnRunner.Accepted<P>) =>
			Stream.unwrap(
				Effect.gen(function* () {
					type Part = Extract<Event, { readonly _tag: "ResponsePart" }>
					const pending = yield* Ref.make<
						Option.Option<{
							readonly event: Part
							readonly parts: Chunk.Chunk<Part["part"]>
						}>
					>(Option.none())
					const savePartial = Effect.gen(function* () {
						const buffer = yield* Ref.get(pending)
						yield* store
							.modifyEffect({
								chat: accepted.view.chat.id,
								update: (view) =>
									Effect.gen(function* () {
										const turn = yield* requireTurn(view, accepted.turn)
										const saved = turn.pendingStep
										const event = Option.getOrUndefined(
											Option.map(buffer, (buffer) => buffer.event),
										)
										const item = saved?.item ?? event?.item
										if (
											item === undefined ||
											Turn.isTerminal(turn.status) ||
											Arr.contains(turn.items, item)
										)
											return [undefined, Option.none()] as const
										const parts = Option.isSome(buffer)
											? Chunk.toReadonlyArray(buffer.value.parts)
											: []
										// Saved results win over a stream that stopped before it could publish them.
										const content =
											saved?.model !== undefined
												? Prompt.concat(
														saved.before,
														Prompt.concat(saved.model.output, saved.after),
													)
												: Prompt.concat(
														saved?.before ?? Prompt.empty,
														Prompt.fromResponseParts(
															Arr.filter(
																parts,
																(part) =>
																	(part.type !== "tool-result" ||
																		part.providerExecuted === true) &&
																	part.type !== "tool-approval-request",
															),
														),
													)
										if (content.content.length === 0)
											return [undefined, Option.none()] as const
										const step =
											event?.step ??
											(turn.activeAction !== undefined ||
											turn.action !== undefined
												? 0
												: (saved?.step ?? turn.steps))
										return [
											undefined,
											Option.some({
												...TurnState.append(view, [
													{
														id: item,
														content,
														origin: { chat: view.chat.id, turn: turn.id, step },
													},
												]),
												chat: {
													turn: {
														...turn,
														steps: step === 0 ? turn.steps : step,
														items: Arr.append(turn.items, item),
													},
												},
											}),
										] as const
									}),
							})
							.pipe(
								Effect.catchCause(
									logFailure("The partial model response could not be saved"),
								),
							)
					})
					return runner.run(accepted).pipe(
						Stream.tap((event) =>
							event._tag === "ChatUpdated" ? Effect.void : publish(event),
						),
						Stream.tap((event) => {
							if (event._tag === "ChatUpdated")
								return Ref.set(pending, Option.none())
							if (event._tag !== "ResponsePart") return Effect.void
							return Ref.update(pending, (prior) =>
								Option.some({
									event,
									parts: Chunk.append(
										Option.isSome(prior) &&
											prior.value.event.item === event.item
											? prior.value.parts
											: Chunk.empty(),
										event.part,
									),
								}),
							)
						}),
						Stream.onExit((exit) =>
							Exit.isSuccess(exit)
								? Effect.void
								: Effect.gen(function* () {
										if (
											!Option.exists(
												Cause.findErrorOption(exit.cause),
												Schema.is(ChatStoreError),
											)
										)
											yield* savePartial
										if (Cause.hasInterruptsOnly(exit.cause)) return
										yield* Effect.logWarning("A Turn failed", exit.cause)
										yield* close(
											accepted.view.chat.id,
											accepted.turn,
											failedStatus(exit.cause),
										).pipe(
											Effect.catchTag("TurnConflict", () => Effect.void),
											Effect.catchCause(
												logFailure("The ended Turn could not be closed"),
											),
										)
									}),
						),
					)
				}),
			)

		/**
		 * Runs a Turn in its own fiber. A Chat has one such fiber at most, and the
		 * runtime stops them all when it closes. A watcher waits for the end of the
		 * fiber, when the Chat is no longer active. It closes the Turn if the fiber
		 * did not, tells the waiters, and starts the next Turn from the inbox.
		 *
		 * The fiber can stop before it runs any work, so a caller that waits for
		 * the Turn must also wait for the end of the fiber.
		 *
		 * The caller holds a permit of `admission` from `accept` to the end of this,
		 * so the runtime does not close between the two.
		 */
		const start = <EW, RW>(
			accepted: TurnRunner.Accepted<P>,
			work: Effect.Effect<void, EW, RW>,
		) =>
			Effect.gen(function* () {
				const chat = accepted.view.chat.id
				// Every log line of the Turn and of its watcher names the Chat and the Turn.
				const annotations = { chatId: chat, turnId: accepted.turn }
				// `accept` found no fiber for the Chat. But a Turn can end before its fiber
				// starts, and a newer Turn can start in that time. Then the second fiber
				// does not run, and its watcher closes its Turn if it is still open.
				// The fiber starts only when it is in the map, so the Chat is active
				// before the Turn does any work.
				const turn = yield* FiberMap.run(
					running,
					chat,
					work.pipe(Effect.annotateLogs(annotations)),
					{ onlyIfMissing: true, startImmediately: false },
				)
				yield* PubSub.publish(activity, chat)
				const watcher = yield* FiberSet.run(
					watchers,
					Fiber.await(turn).pipe(
						Effect.andThen(
							close(chat, accepted.turn, { _tag: "Interrupted" }).pipe(
								// A later Turn is current.
								Effect.catchTag("TurnConflict", () => Effect.void),
								Effect.catchCause(
									logFailure("The ended Turn could not be closed"),
								),
							),
						),
						Effect.andThen(PubSub.publish(activity, chat)),
						// After any end, the next input in the inbox starts the next Turn.
						Effect.andThen(drainQuietly(chat)),
						Effect.annotateLogs(annotations),
					),
				)
				return { turn, watcher }
			})
		/**
		 * Runs a Turn in the background. `untilStarted` waits until it has started,
		 * so the caller can let its permit go before it waits.
		 */
		const launch = (accepted: TurnRunner.Accepted<P>) =>
			Effect.gen(function* () {
				const started = yield* Deferred.make<void>()
				const { turn } = yield* start(
					accepted,
					phases(accepted).pipe(
						Stream.runForEach((event) =>
							event._tag === "TurnStarted"
								? Deferred.succeed(started, undefined)
								: Effect.void,
						),
					),
				)
				return { started, turn }
			})
		const untilStarted = (launched: {
			readonly started: Deferred.Deferred<void>
			readonly turn: Fiber.Fiber<void, unknown>
		}) =>
			Effect.asVoid(
				Effect.raceFirst(
					Deferred.await(launched.started),
					Fiber.await(launched.turn),
				),
			)
		const drain: Chat.Runtime<P, Tools, E | BuildE, HostTools>["drain"] = (
			chat,
		) =>
			Effect.gen(function* () {
				// A quick check first. `accept` checks the same things again in one step.
				const view = yield* store.read(chat)
				const current = Chat.currentTurn(view.chat)
				if (
					(current !== undefined && !Turn.isTerminal(current.status)) ||
					(yield* isActive(chat)) ||
					Option.isNone(TurnState.leading(view))
				)
					return Option.none()
				return yield* Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const started = yield* admission.withPermits(1)(
							Effect.gen(function* () {
								const accepted = yield* restore(
									accept({ chat, select: TurnState.leading }),
								).pipe(
									// Another caller started a Turn first, and its end drains the inbox
									// again. Or the runtime closes, and the input waits for the next one.
									Effect.catchTag("ChatConflict", () => Effect.succeedNone),
								)
								if (Option.isNone(accepted)) return Option.none()
								const launched = yield* launch(accepted.value)
								return Option.some({ accepted: accepted.value, launched })
							}),
						)
						if (Option.isNone(started)) return Option.none()
						const { accepted, launched } = started.value
						yield* untilStarted(launched)
						const delivery: Chat.Delivery = {
							delivery: "started",
							chat,
							turn: accepted.turn,
							item: accepted.item,
							revision: accepted.view.chat.revision,
						}
						return Option.some(delivery)
					}),
				)
			})
		const drainQuietly = (chat: Chat.Id) =>
			drain(chat).pipe(
				Effect.catchCause(logFailure("The next Turn could not start")),
				Effect.asVoid,
				Effect.annotateLogs({ chatId: chat }),
			)
		/** The inbox entry for input that a caller gives. */
		const entryOf = (input: Chat.DeliverInput) =>
			Effect.map(id(), (item): Chat.InboxEntry => ({
				id: Item.Id.make(item),
				content: Prompt.make(input.input),
				kind: "message",
				...(input.author === undefined ? {} : { author: input.author }),
				...(input.notice === undefined ? {} : { notice: input.notice }),
				...(input.approved === undefined ? {} : { approved: input.approved }),
			}))
		const deliver: Chat.Runtime<P, Tools, E | BuildE, HostTools>["deliver"] = (
			input,
		) =>
			Effect.gen(function* () {
				const entry = yield* entryOf(input)
				const item = entry.id
				const placed = yield* store.modifyEffect({
					chat: input.chat,
					update: (view) =>
						Effect.sync(() => {
							const placed = TurnState.place(view.chat, entry, input.queue)
							return [
								placed.turn,
								Option.some({ chat: { inbox: placed.inbox } }),
							] as const
						}),
				})
				if (Option.isSome(placed.result)) {
					const steered: Chat.Delivery = {
						delivery: "steered",
						chat: input.chat,
						turn: placed.result.value,
						item,
						revision: placed.view.chat.revision,
					}
					return steered
				}
				yield* drain(input.chat)
				const view = yield* store.read(input.chat)
				const current = Chat.currentTurn(view.chat)
				const result: Chat.Delivery =
					current !== undefined && current.input.includes(item)
						? {
								delivery: "started",
								chat: input.chat,
								turn: current.id,
								item,
								revision: view.chat.revision,
							}
						: {
								delivery: "queued",
								chat: input.chat,
								item,
								revision: view.chat.revision,
							}
				return result
			})
		const acceptNow = (input: Chat.StartInput, action?: Turn.Action) =>
			Effect.gen(function* () {
				const entry = yield* entryOf(input)
				const accepted = yield* accept({
					chat: input.chat,
					select: () => Option.some(Arr.of(entry)),
					...(input.author === undefined ? {} : { author: input.author }),
					...(input.overrides === undefined
						? {}
						: { overrides: input.overrides }),
					...(action === undefined ? {} : { action }),
				})
				if (Option.isNone(accepted))
					return yield* Chat.Conflict.make({
						chat: input.chat,
						message: "The Turn could not start",
					})
				return accepted.value
			})
		const stream: Chat.Runtime<P, Tools, E | BuildE, HostTools>["stream"] = (
			input,
		) =>
			Stream.unwrap(
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const { turn, watcher, events } = yield* admission.withPermits(1)(
							Effect.gen(function* () {
								const accepted = yield* restore(acceptNow(input))
								const events = yield* Queue.bounded<
									Event,
									| Chat.RuntimeError
									| Bot.ExecutionError<Tools, E | BuildE>
									| Cause.Done
								>(streamCapacity)
								const { turn, watcher } = yield* start(
									accepted,
									phases(accepted).pipe(Stream.runIntoQueue(events)),
								)
								return { turn, watcher, events }
							}),
						)
						const stop = Fiber.interrupt(turn).pipe(
							Effect.andThen(Fiber.await(watcher)),
						)
						// The caller can stop before it reads the stream, also while the Turn
						// starts. The scope of the stream still closes then, so this stops the Turn.
						yield* Effect.addFinalizer(() => stop)
						return Stream.merge(
							Stream.fromQueue(events),
							// The fiber ends the queue. When it stops before it runs, its
							// end ends the queue here.
							Stream.fromEffectDrain(
								Effect.flatMap(Fiber.await(turn), (exit) =>
									Queue.into(events)(exit),
								),
							),
						).pipe(
							// A caller that stops early stops the Turn. The stream ends after
							// the watcher, so input that waits in the inbox has started its
							// Turn by then.
							Stream.ensuring(stop),
						)
					}),
				),
			)
		const interrupt: Chat.Runtime<
			P,
			Tools,
			E | BuildE,
			HostTools
		>["interrupt"] = (input) =>
			Effect.gen(function* () {
				const view = yield* store.read(input.chat),
					turn = yield* requireTurn(view, input.turn)
				if (Turn.isTerminal(turn.status))
					return yield* Turn.Conflict.make({
						chat: input.chat,
						turn: input.turn,
						message: "The Turn has already ended",
					})
				// The target Turn is open, so a fiber of the Chat in this runtime runs it,
				// or an older Turn that ended already. Both must stop.
				yield* FiberMap.remove(running, input.chat)
				// When the fiber stops, it closes the Turn, and the next input in the inbox
				// can start a new Turn at once. Then the target Turn is no longer current,
				// but it has ended, so this is not a conflict.
				return yield* close(input.chat, input.turn, {
					_tag: "Interrupted",
				}).pipe(Effect.catchTag("TurnConflict", () => store.read(input.chat)))
			})
		/** An event with a view takes its position from it. Other events carry `at`. */
		const positionOf = (event: Event) =>
			"view" in event ? Chat.position(event.view.chat) : event.at
		const revision = (event: Event) => positionOf(event).revision
		const events: Chat.Runtime<P, Tools, E | BuildE, HostTools>["events"] = (
			input,
		) =>
			Stream.unwrap(
				Effect.gen(function* () {
					yield* store.read(input.chat)
					const subscription = yield* PubSub.subscribe(bus)
					// The subscription gives the replay first: the recent events from before
					// it began. Later events come once, after them.
					const recent = yield* PubSub.takeUpTo(
						subscription,
						yield* PubSub.remaining(subscription),
					)
					return Stream.concat(
						Stream.fromArray(
							Arr.filter(
								recent,
								(event) =>
									positionOf(event).chat === input.chat &&
									input.after !== undefined &&
									revision(event) > input.after,
							),
						),
						Stream.fromSubscription(subscription).pipe(
							Stream.filter((event) => positionOf(event).chat === input.chat),
						),
					)
				}),
			)
		const wait: Chat.Runtime<P, Tools, E | BuildE, HostTools>["wait"] = (
			input,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					// The fiber belongs to the scope of this call, so it stops on every return.
					const observed = yield* Effect.forkScoped(
						Effect.raceFirst(
							store
								.changes({ chat: input.chat })
								.pipe(Stream.take(1), Stream.runDrain),
							Stream.fromPubSub(activity).pipe(
								Stream.filter((chat) => chat === input.chat),
								Stream.take(1),
								Stream.runDrain,
							),
						),
						{ startImmediately: true },
					)
					const view = yield* store.read(input.chat)
					if (view.chat.revision !== input.after) return view
					if (
						input.afterActive !== undefined &&
						(yield* isActive(input.chat)) !== input.afterActive
					)
						return view
					yield* Fiber.join(observed).pipe(Effect.timeoutOption(input.timeout))
					return yield* store.read(input.chat)
				}),
			)
		const startAction: Chat.Runtime<
			P,
			Tools,
			E | BuildE,
			HostTools
		>["startAction"] = (input) =>
			Effect.gen(function* () {
				const content = Prompt.make(
					input.input ?? "Host-selected action: " + input.action.name,
				)
				if (input.turn === undefined) {
					const accepted = yield* Effect.suspend(() =>
						Effect.uninterruptibleMask((restore) =>
							Effect.gen(function* () {
								const { accepted, launched } = yield* admission.withPermits(1)(
									Effect.gen(function* () {
										const accepted = yield* restore(
											acceptNow(
												{
													chat: input.chat,
													input: content,
													...(input.author === undefined
														? {}
														: { author: input.author }),
												},
												input.action,
											),
										)
										return { accepted, launched: yield* launch(accepted) }
									}),
								)
								yield* untilStarted(launched)
								return accepted
							}),
						),
					)
					const receipt: Chat.ActionReceipt = {
						chat: input.chat,
						turn: accepted.turn,
						item: accepted.item,
						revision: accepted.view.chat.revision,
						callId: "host-action-" + accepted.turn,
					}
					return receipt
				}
				const turn = input.turn
				const item = Item.Id.make(yield* id())
				const changed = yield* store.modifyEffect({
					chat: input.chat,
					update: (view) =>
						Effect.gen(function* () {
							const record = yield* requireTurn(view, turn)
							// The Turn is current and open, so a fiber of its Chat here runs it.
							if (
								!(yield* isActive(view.chat.id)) ||
								Turn.isTerminal(record.status)
							)
								return yield* Turn.Conflict.make({
									chat: view.chat.id,
									turn,
									message:
										"Related host actions need the current Turn to run in this runtime",
								})
							return [
								undefined,
								Option.some({
									chat: {
										inbox: Arr.append(view.chat.inbox, {
											id: item,
											kind: "action" as const,
											turn,
											action: input.action,
											content,
										}),
									},
								}),
							] as const
						}),
				})
				const receipt: Chat.ActionReceipt = {
					chat: input.chat,
					turn,
					item,
					revision: changed.view.chat.revision,
					callId: "host-action-" + item,
				}
				return receipt
			})
		return {
			isActive,
			deliver,
			stream,
			execute: (input) =>
				stream(input).pipe(
					Stream.runDrain,
					Effect.andThen(store.read(input.chat)),
				),
			startAction,
			interrupt,
			drain,
			status: store.read,
			events,
			wait,
			compact: runner.compact,
		}
	})
export const layer: {
	<
		P,
		Tools extends Record<string, Tool.Any> = {},
		E = never,
		R = never,
		BuildE = never,
		BuildR = never,
		HostTools extends Record<string, Tool.Any> = {},
	>(
		options: Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
	): <I>(
		tag: Context.Service<I, Chat.Runtime<P, Tools, E | BuildE, HostTools>>,
	) => Layer.Layer<
		I,
		never,
		Exclude<
			BuildR | R | Bot.RuntimeServices<Tools, R>,
			Scope.Scope | Bot.Context
		>
	>
	<
		I,
		P,
		Tools extends Record<string, Tool.Any> = {},
		E = never,
		R = never,
		BuildE = never,
		BuildR = never,
		HostTools extends Record<string, Tool.Any> = {},
	>(
		tag: Context.Service<I, Chat.Runtime<P, Tools, E | BuildE, HostTools>>,
		options: Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
	): Layer.Layer<
		I,
		never,
		Exclude<
			BuildR | R | Bot.RuntimeServices<Tools, R>,
			Scope.Scope | Bot.Context
		>
	>
} = dual(
	2,
	<
		I,
		P,
		Tools extends Record<string, Tool.Any> = {},
		E = never,
		R = never,
		BuildE = never,
		BuildR = never,
		HostTools extends Record<string, Tool.Any> = {},
	>(
		tag: Context.Service<I, Chat.Runtime<P, Tools, E | BuildE, HostTools>>,
		options: Chat.RuntimeOptions<P, Tools, E, R, BuildE, BuildR, HostTools>,
	) => Layer.effect(tag, make(options)),
)
