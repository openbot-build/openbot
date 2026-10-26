import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	HashMap,
	HashSet,
	Layer,
	Option,
	Ref,
	Schedule,
	Stream,
	type Scope,
} from "effect"
import { AiError } from "effect/ai"
import * as Operation from "./Operation.ts"
import { logFailure } from "./Failures.ts"
import type * as ChatIdentity from "./ChatIdentity.ts"
import type * as TurnIdentity from "./TurnIdentity.ts"

/** The limits of the Operations of one Chat. */
export interface Settings {
	/** How long a call runs in its Turn before it goes to the background. */
	readonly budget: Duration.Input
	/** How long an Operation may run in all. After that it stops and fails. */
	readonly maxDuration: Duration.Input
	/** How many Operations of the Chat may run at one time. More calls stay in their Turn. */
	readonly limit: number
}
export const defaultSettings: Settings = {
	budget: "30 seconds",
	maxDuration: "1 hour",
	limit: 8,
}
export interface Options {
	readonly store: Operation.Store
	readonly settings?: (chat: ChatIdentity.Id) => Effect.Effect<Settings>
}
export interface RunInput {
	readonly chat: ChatIdentity.Id
	readonly turn: TurnIdentity.Id
	readonly callId: string
	readonly tool: string
	readonly kind?: Operation.Kind
	/** The budget of the tool. Without it, the budget of the Chat applies. */
	readonly budget?: Duration.Input | "foreground"
	/** Gives the end of a background Operation to its Chat. */
	readonly notify: (record: Operation.Record) => Effect.Effect<void>
}
export type Outcome<A, E> =
	| { readonly _tag: "Done"; readonly exit: Exit.Exit<A, E> }
	| { readonly _tag: "Background"; readonly record: Operation.Record }

export class Operations extends Context.Service<
	Operations,
	{
		/**
		 * Runs `work`. When it ends inside its budget, the caller gets its exit. When
		 * it does not, it goes on in the background, and the caller gets its record.
		 * `status` gives the end that the store keeps.
		 */
		readonly run: <A, E, R>(
			input: RunInput,
			work: Effect.Effect<A, E, R>,
			status: (exit: Exit.Exit<A, E>) => Operation.Status,
		) => Effect.Effect<Outcome<A, E>, never, R>
		readonly get: (
			chat: ChatIdentity.Id,
			id: Operation.Id,
		) => Effect.Effect<Operation.Record, Operation.NotFound>
		readonly list: (
			chat: ChatIdentity.Id,
		) => Effect.Effect<ReadonlyArray<Operation.Record>>
		/**
		 * Waits until one of the Operations has an end, or until `timeout`. It gives
		 * the records as they are then.
		 */
		readonly wait: (
			chat: ChatIdentity.Id,
			ids: ReadonlyArray<Operation.Id>,
			timeout: Duration.Input,
		) => Effect.Effect<ReadonlyArray<Operation.Record>, Operation.NotFound>
		/** Stops an Operation. It gives the record as it is then. */
		readonly cancel: (
			chat: ChatIdentity.Id,
			id: Operation.Id,
		) => Effect.Effect<Operation.Record, Operation.NotFound>
		/**
		 * Stops every Operation of a Chat, such as when the Chat is deleted. It stops
		 * the Operations that this server runs, and asks other servers to stop theirs.
		 */
		readonly cancelChat: (chat: ChatIdentity.Id) => Effect.Effect<void>
	}
>()("@openbot-build/core/chat/Operations") {}

/** What a tool call that went to the background gives the model. */
export const backgroundResult = (record: Operation.Record) => ({
	operation: record.id,
	status: "running",
	note: "This call takes more time, so it goes on in the background. Its result comes back to this Chat as a message when it ends.",
})

/** The text of the notice that gives the end of an Operation to its Chat. */
export const noticeText = (record: Operation.Record) =>
	JSON.stringify({
		operation: record.id,
		tool: record.tool,
		callId: record.callId,
		status: record.status,
	})

type Phase = "waiting" | "background" | "done"
interface Local {
	readonly chat: ChatIdentity.Id
	readonly fiber: Fiber.Fiber<unknown, unknown>
}

export const make = (
	options: Options,
): Effect.Effect<
	typeof Operations.Service,
	never,
	Scope.Scope | Crypto.Crypto
> =>
	Effect.gen(function* () {
		const store = options.store
		const crypto = yield* Crypto.Crypto
		const settingsOf =
			options.settings ?? (() => Effect.succeed(defaultSettings))
		const scope = yield* Effect.scope
		const local = yield* Ref.make(HashMap.empty<Operation.Id, Local>())
		const cancelled = yield* Ref.make(HashSet.empty<Operation.Id>())
		/** How many calls of each Chat hold a slot. A call holds it while it waits in its budget and while it runs in the background. */
		const slots = yield* Ref.make(HashMap.empty<ChatIdentity.Id, number>())
		const usedSlots = (
			current: HashMap.HashMap<ChatIdentity.Id, number>,
			chat: ChatIdentity.Id,
		) => Option.getOrElse(HashMap.get(current, chat), () => 0)
		const reserve = (chat: ChatIdentity.Id, limit: number) =>
			Ref.modify(slots, (current) => {
				const used = usedSlots(current, chat)
				return used >= limit
					? ([false, current] as const)
					: ([true, HashMap.set(current, chat, used + 1)] as const)
			})
		const release = (chat: ChatIdentity.Id) =>
			Ref.update(slots, (current) => {
				const used = usedSlots(current, chat)
				return used <= 1
					? HashMap.remove(current, chat)
					: HashMap.set(current, chat, used - 1)
			})

		const stopLocal = (id: Operation.Id) =>
			Effect.gen(function* () {
				const found = HashMap.get(yield* Ref.get(local), id)
				if (Option.isNone(found)) return false
				yield* Ref.update(cancelled, HashSet.add(id))
				yield* Fiber.interrupt(found.value.fiber)
				return true
			})

		yield* Effect.forkScoped(
			store.cancelRequests.pipe(
				Stream.runForEach(stopLocal),
				Effect.tapCause(
					logFailure("The listener for Operation cancel requests stopped"),
				),
			),
			{ startImmediately: true },
		)
		yield* Effect.forkScoped(
			Ref.get(local).pipe(
				Effect.flatMap((current) =>
					HashMap.size(current) === 0
						? Effect.void
						: store.heartbeat(Arr.fromIterable(HashMap.keys(current))),
				),
				// One bad heartbeat must not stop the next ones.
				Effect.catchCause(logFailure("The Operations heartbeat failed")),
				Effect.repeat(Schedule.spaced("20 seconds")),
			),
		)

		const run = <A, E, R>(
			input: RunInput,
			work: Effect.Effect<A, E, R>,
			status: (exit: Exit.Exit<A, E>) => Operation.Status,
		): Effect.Effect<Outcome<A, E>, never, R> =>
			Effect.gen(function* () {
				const settings = yield* settingsOf(input.chat)
				const budget = input.budget ?? settings.budget
				const foreground = Effect.map(Effect.exit(work), (exit) => ({
					_tag: "Done" as const,
					exit,
				}))
				if (budget === "foreground") return yield* foreground

				const id = Operation.Id.make(
					yield* crypto.randomUUIDv4().pipe(Effect.orDie),
				)
				const startedAt = yield* Clock.currentTimeMillis
				const record: Operation.Record = {
					id,
					chat: input.chat,
					turn: input.turn,
					callId: input.callId,
					tool: input.tool,
					kind: input.kind ?? "tool",
					status: Operation.Status.Running(),
					startedAt,
				}
				const phase = yield* Ref.make<Phase>("waiting")
				const done = yield* Deferred.make<Exit.Exit<A, E>>()
				const inserted = yield* Deferred.make<void>()
				// The time limit ended while the caller still waits, so the caller must
				// move the call to the background, and the end is stored there.
				const timeUp = yield* Deferred.make<void>()
				const annotations = {
					operationId: id,
					chatId: input.chat,
					turnId: input.turn,
					tool: input.tool,
				}

				const finish = (end: Operation.Status) =>
					Effect.gen(function* () {
						// The wait stays interruptible. When the caller stops before it
						// completes `inserted`, it must still be able to stop this fiber.
						yield* Deferred.await(inserted)
						// When the store has the end, the Chat must get its notice too. So an
						// interruption waits until both are done.
						yield* Effect.uninterruptible(
							Effect.gen(function* () {
								const endedAt = yield* Clock.currentTimeMillis
								const finished = yield* store.finish(id, end, endedAt)
								if (finished !== undefined) yield* input.notify(finished)
							}).pipe(Effect.ensuring(Ref.update(local, HashMap.remove(id)))),
						)
					})

				const tooLong = Operation.Status.Failed({
					message: `The call ran for more than ${Duration.format(Duration.fromInputUnsafe(settings.maxDuration))}, so it was stopped.`,
				})
				const body = Effect.exit(work).pipe(
					Effect.timeoutOption(settings.maxDuration),
					Effect.flatMap((result) =>
						Effect.gen(function* () {
							const before = yield* Ref.getAndUpdate(phase, (current) =>
								current === "waiting" && Option.isSome(result)
									? "done"
									: current,
							)
							if (Option.isSome(result)) {
								yield* Deferred.succeed(done, result.value)
								if (before !== "background") return
								// The caller has gone on, so this is the only place that sees
								// the full cause. The store keeps only a short message.
								if (
									Exit.isFailure(result.value) &&
									!Cause.hasInterruptsOnly(result.value.cause)
								)
									yield* Effect.logWarning(
										"A background Operation failed",
										result.value.cause,
									).pipe(Effect.annotateLogs(annotations))
								return yield* finish(status(result.value))
							}
							if (before === "waiting")
								yield* Deferred.succeed(timeUp, undefined)
							yield* Effect.logInfo(
								"An Operation ran past its time limit",
							).pipe(Effect.annotateLogs(annotations))
							yield* finish(tooLong)
						}),
					),
					Effect.onInterrupt(() =>
						Effect.gen(function* () {
							const before = yield* Ref.getAndUpdate(phase, (current) =>
								current === "waiting" ? "done" : current,
							)
							if (before !== "background") {
								// The caller still waits, so it must learn of the end.
								yield* Deferred.succeed(done, Exit.failCause(Cause.interrupt()))
								return
							}
							const wasCancelled = HashSet.has(yield* Ref.get(cancelled), id)
							yield* Ref.update(cancelled, HashSet.remove(id))
							yield* finish(
								wasCancelled
									? Operation.Status.Cancelled()
									: Operation.Status.Interrupted(),
							)
						}),
					),
				)

				// Only the waits can be interrupted. So when the caller stops, the call
				// either stops with it, or it is all the way in the background: its slot,
				// its entry in `local`, its record and `inserted` are all in place.
				return yield* Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						if (!(yield* reserve(input.chat, settings.limit)))
							return yield* restore(foreground)
						// The child fiber can be interrupted, even when it is forked here.
						const fiber = yield* Effect.forkIn(
							body.pipe(Effect.ensuring(release(input.chat))),
							scope,
						)

						const waited = yield* restore(
							Effect.raceFirst(
								Deferred.await(done).pipe(Effect.asSome),
								Deferred.await(timeUp).pipe(Effect.as(Option.none())),
							).pipe(Effect.timeoutOption(budget), Effect.map(Option.flatten)),
						).pipe(
							Effect.onInterrupt(() =>
								Ref.get(phase).pipe(
									Effect.flatMap((current) =>
										current === "background"
											? Effect.void
											: Fiber.interrupt(fiber),
									),
								),
							),
						)
						if (Option.isSome(waited))
							return { _tag: "Done" as const, exit: waited.value }
						const moved = yield* Ref.modify(phase, (current) =>
							current === "waiting"
								? ([true, "background"] as const)
								: ([false, current] as const),
						)
						if (!moved)
							return {
								_tag: "Done" as const,
								exit: yield* restore(Deferred.await(done)),
							}
						const entry: Local = { chat: input.chat, fiber }
						yield* Ref.update(local, HashMap.set(id, entry))
						// `finish` waits for `inserted`, so complete it even when the insert
						// dies. Then `store.finish` finds no record and announces nothing.
						yield* store
							.insert(record)
							.pipe(Effect.ensuring(Deferred.succeed(inserted, undefined)))
						return { _tag: "Background" as const, record }
					}),
				)
			})

		const get = (chat: ChatIdentity.Id, id: Operation.Id) =>
			store.get(id).pipe(
				Effect.filterOrFail(
					(record): record is Operation.Record =>
						record !== undefined && record.chat === chat,
					() => Operation.NotFound.make({ id }),
				),
			)

		const wait = (
			chat: ChatIdentity.Id,
			ids: ReadonlyArray<Operation.Id>,
			timeout: Duration.Input,
		) =>
			Effect.gen(function* () {
				const until =
					(yield* Clock.currentTimeMillis) + Duration.toMillis(timeout)
				while (true) {
					const records = yield* Effect.forEach(ids, (id) => get(chat, id))
					const now = yield* Clock.currentTimeMillis
					if (
						records.length === 0 ||
						Arr.some(records, (record) =>
							Operation.isTerminal(record.status),
						) ||
						now >= until
					)
						return records
					// A change can come between the read and the subscription, so look again
					// at least once a second.
					yield* store.changes.pipe(
						Stream.filter((id) => ids.includes(id)),
						Stream.runHead,
						Effect.timeoutOption(Math.min(until - now, 1000)),
					)
				}
			})

		const cancel = (chat: ChatIdentity.Id, id: Operation.Id) =>
			Effect.gen(function* () {
				const record = yield* get(chat, id)
				if (Operation.isTerminal(record.status)) return record
				if (!(yield* stopLocal(id))) yield* store.requestCancel(id)
				const after = yield* wait(chat, [id], "5 seconds")
				return after[0] ?? record
			})

		const cancelChat = (chat: ChatIdentity.Id) =>
			Effect.gen(function* () {
				// A call that just went to the background can be in `local` before
				// the store has its record.
				const mine = HashMap.filter(
					yield* Ref.get(local),
					(entry) => entry.chat === chat,
				)
				yield* Effect.forEach(HashMap.keys(mine), stopLocal, { discard: true })
				// Other servers can run Operations of the Chat too. They get a cancel request.
				const records = yield* store.list(chat)
				yield* Effect.forEach(
					Arr.filter(
						records,
						(record) =>
							!Operation.isTerminal(record.status) &&
							!HashMap.has(mine, record.id),
					),
					(record) => store.requestCancel(record.id),
					{ discard: true },
				)
			})

		return Operations.of({
			run,
			get,
			list: store.list,
			wait,
			cancel,
			cancelChat,
		})
	})

export const layer = (options: Options) =>
	Layer.effect(Operations, make(options))

/**
 * A short message for the failure of a tool call. The message of an AiError is
 * safe to show. Other failures and defects can hold private details, such as an
 * error of the database, so they get a fixed text. The cause goes only to the log.
 */
export const failureMessage = (cause: Cause.Cause<unknown>): string => {
	if (Cause.hasInterruptsOnly(cause)) return "The call was stopped."
	const internal = "The call stopped because of an internal error."
	if (Cause.hasDies(cause)) return internal
	return Option.match(Cause.findErrorOption(cause), {
		onNone: () => internal,
		onSome: (error) => (AiError.isAiError(error) ? error.message : internal),
	})
}
