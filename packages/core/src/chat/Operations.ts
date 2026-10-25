import {
	Cause,
	Clock,
	Context,
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
import * as Operation from "./Operation.ts"
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
		/** Stops every Operation of a Chat on this server, such as when the Chat is deleted. */
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
): Effect.Effect<typeof Operations.Service, never, Scope.Scope> =>
	Effect.gen(function* () {
		const store = options.store
		const settingsOf =
			options.settings ?? (() => Effect.succeed(defaultSettings))
		const scope = yield* Effect.scope
		const local = yield* Ref.make(HashMap.empty<Operation.Id, Local>())
		const cancelled = yield* Ref.make(HashSet.empty<Operation.Id>())

		const stopLocal = (id: Operation.Id) =>
			Effect.gen(function* () {
				const found = HashMap.get(yield* Ref.get(local), id)
				if (Option.isNone(found)) return false
				yield* Ref.update(cancelled, HashSet.add(id))
				yield* Fiber.interrupt(found.value.fiber)
				return true
			})

		yield* Effect.forkScoped(
			store.cancelRequests.pipe(Stream.runForEach(stopLocal)),
			{ startImmediately: true },
		)
		yield* Effect.forkScoped(
			Ref.get(local).pipe(
				Effect.flatMap((current) =>
					HashMap.size(current) === 0
						? Effect.void
						: store.heartbeat(Array.from(HashMap.keys(current))),
				),
				Effect.repeat(Schedule.spaced("20 seconds")),
			),
		)

		const runningIn = (chat: ChatIdentity.Id) =>
			Ref.get(local).pipe(
				Effect.map(
					(current) =>
						Array.from(HashMap.values(current)).filter(
							(entry) => entry.chat === chat,
						).length,
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
				if ((yield* runningIn(input.chat)) >= settings.limit)
					return yield* foreground

				const id = Operation.Id.make(crypto.randomUUID())
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

				const finish = (end: Operation.Status) =>
					Effect.gen(function* () {
						yield* Deferred.await(inserted)
						const endedAt = yield* Clock.currentTimeMillis
						const finished = yield* store.finish(id, end, endedAt)
						yield* Ref.update(local, HashMap.remove(id))
						if (finished !== undefined) yield* input.notify(finished)
					})

				const tooLong = Operation.Status.Failed({
					message: `The call ran for more than ${Duration.format(Duration.fromInputUnsafe(settings.maxDuration))}, so it was stopped.`,
				})
				const body = Effect.exit(work).pipe(
					Effect.timeoutOption(settings.maxDuration),
					Effect.flatMap((result) =>
						Effect.gen(function* () {
							const before = yield* Ref.getAndUpdate(phase, (current) =>
								current === "waiting" ? "done" : current,
							)
							if (Option.isSome(result))
								yield* Deferred.succeed(done, result.value)
							if (before === "background")
								yield* finish(
									Option.isSome(result) ? status(result.value) : tooLong,
								)
						}),
					),
					Effect.onInterrupt(() =>
						Effect.gen(function* () {
							if ((yield* Ref.get(phase)) !== "background") {
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
				const fiber = yield* Effect.forkIn(body, scope)

				const waited = yield* Deferred.await(done).pipe(
					Effect.timeoutOption(budget),
					Effect.onInterrupt(() =>
						Ref.get(phase).pipe(
							Effect.flatMap((current) =>
								current === "background" ? Effect.void : Fiber.interrupt(fiber),
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
					return { _tag: "Done" as const, exit: yield* Deferred.await(done) }
				const entry: Local = { chat: input.chat, fiber }
				yield* Ref.update(local, HashMap.set(id, entry))
				yield* store.insert(record)
				yield* Deferred.succeed(inserted, undefined)
				return { _tag: "Background" as const, record }
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
						records.some((record) => Operation.isTerminal(record.status)) ||
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
			Ref.get(local).pipe(
				Effect.flatMap((current) =>
					Effect.forEach(
						Array.from(HashMap.entries(current)).filter(
							([, entry]) => entry.chat === chat,
						),
						([id]) => stopLocal(id),
						{ discard: true },
					),
				),
			)

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

/** A short message for the failure of a tool call. */
export const failureMessage = (cause: Cause.Cause<unknown>) =>
	Cause.hasInterruptsOnly(cause)
		? "The call was stopped."
		: (Cause.pretty(cause).split("\n")[0] ?? "The call failed.")
