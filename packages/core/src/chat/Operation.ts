import {
	Array as Arr,
	Context,
	Data,
	Effect,
	HashMap,
	Order,
	PubSub,
	Ref,
	Schema,
	Stream,
	pipe,
} from "effect"
import type { Duration } from "effect"
import * as ChatIdentity from "./ChatIdentity.ts"
import * as TurnIdentity from "./TurnIdentity.ts"

/**
 * An Operation is one tool call that took more time than its budget. The call goes
 * on in the background, and its result comes back to its Chat as a notice.
 */
export const Id = Schema.String.pipe(
	Schema.brand("@openbot-build/core/OperationId"),
)
export type Id = typeof Id.Type
/** `tool` is a tool call. `session` is a program that takes input, such as a shell. */
export const Kind = Schema.Literals(["tool", "session"])
export type Kind = typeof Kind.Type
export const StatusSchema = Schema.TaggedUnion({
	Running: {},
	Completed: { result: Schema.Json },
	Failed: {
		message: Schema.String,
		result: Schema.optionalKey(Schema.Json),
	},
	/** Someone stopped it. */
	Cancelled: {},
	/** Its server stopped before it came to an end. */
	Interrupted: {},
})
export type Status = typeof StatusSchema.Type
export const Status = Data.taggedEnum<Status>()
export const Record = Schema.Struct({
	id: Id,
	chat: ChatIdentity.Id,
	turn: TurnIdentity.Id,
	callId: Schema.String,
	tool: Schema.String,
	kind: Kind,
	status: StatusSchema,
	startedAt: Schema.Finite,
	endedAt: Schema.optionalKey(Schema.Finite),
})
export type Record = typeof Record.Type
export const isTerminal = (status: Status) => status._tag !== "Running"
const byStart = Order.mapInput(
	Order.Number,
	(record: Record) => record.startedAt,
)

/**
 * A tool annotation. It says how long a call may run before it goes to the
 * background. `foreground` keeps the call in its Turn until it ends. Use it for a
 * tool that needs the resources of its Turn, or that gives its own Operation ids.
 * Zero sends every call to the background at once.
 */
export class Budget extends Context.Service<
	Budget,
	Duration.Input | "foreground"
>()("@openbot-build/core/chat/Operation/Budget") {}

export class NotFound extends Schema.TaggedError<
	NotFound,
	{ readonly brand: unique symbol }
>()("OperationNotFound", {
	id: Id,
}) {}

/** Where Operations are kept. Hosts keep them in a database. */
export interface Store {
	readonly insert: (record: Record) => Effect.Effect<void>
	/**
	 * Gives a Running Operation its end. It returns the new record, or nothing when
	 * the Operation already had an end.
	 */
	readonly finish: (
		id: Id,
		status: Status,
		endedAt: number,
	) => Effect.Effect<Record | undefined>
	readonly get: (id: Id) => Effect.Effect<Record | undefined>
	readonly list: (chat: ChatIdentity.Id) => Effect.Effect<ReadonlyArray<Record>>
	/** The ids of Operations that changed. A host with more servers sends changes from all. */
	readonly changes: Stream.Stream<Id>
	/**
	 * Asks the server that runs an Operation to stop it. A store in one process has no
	 * other server, so it does nothing.
	 */
	readonly requestCancel: (id: Id) => Effect.Effect<void>
	/** The ids that other servers asked this server to stop. */
	readonly cancelRequests: Stream.Stream<Id>
	/** Says that this server still runs these Operations. */
	readonly heartbeat: (ids: ReadonlyArray<Id>) => Effect.Effect<void>
}

/** A Store in memory, for tests and for one process. */
export const memoryStore: Effect.Effect<Store> = Effect.gen(function* () {
	const records = yield* Ref.make(HashMap.empty<Id, Record>())
	const changed = yield* PubSub.unbounded<Id>()
	return {
		insert: (record) =>
			Ref.update(records, HashMap.set(record.id, record)).pipe(
				Effect.andThen(PubSub.publish(changed, record.id)),
				Effect.asVoid,
			),
		finish: (id, status, endedAt) =>
			Ref.modify(records, (current) => {
				const found = HashMap.get(current, id)
				if (found._tag === "None" || isTerminal(found.value.status))
					return [undefined, current] as const
				const next: Record = { ...found.value, status, endedAt }
				return [next, HashMap.set(current, id, next)] as const
			}).pipe(
				Effect.tap((record) =>
					record === undefined ? Effect.void : PubSub.publish(changed, id),
				),
			),
		get: (id) =>
			Ref.get(records).pipe(
				Effect.map((current) => HashMap.get(current, id)),
				Effect.map((found) =>
					found._tag === "Some" ? found.value : undefined,
				),
			),
		list: (chat) =>
			Ref.get(records).pipe(
				Effect.map((current) =>
					pipe(
						Arr.fromIterable(HashMap.values(current)),
						Arr.filter((record) => record.chat === chat),
						Arr.sort(byStart),
					),
				),
			),
		changes: Stream.fromPubSub(changed),
		requestCancel: () => Effect.void,
		cancelRequests: Stream.never,
		heartbeat: () => Effect.void,
	}
})
