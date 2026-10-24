import {
	Clock,
	Context,
	Effect,
	Equal,
	Layer,
	Option,
	PubSub,
	Schema,
	Semaphore,
	Stream,
	type Scope,
} from "effect"
import { dual } from "effect/Function"
import { IdGenerator } from "effect/ai"
import * as Chat from "../chat/Chat.ts"
import * as Item from "../chat/Item.ts"
import * as Turn from "../chat/Turn.ts"
import { initial } from "../chat/ChatState.ts"
import * as ChatStore from "./ChatStore.ts"
import type * as Plugin from "../plugins/Plugin.ts"
import { omitOptional } from "./PromptCodec.ts"
import { error, invalid } from "./StoreErrors.ts"

type CodecServices<S extends Plugin.Stores> =
	ChatStore.DecodingServices<S> | ChatStore.EncodingServices<S>

/** Encodes a value to JSON. Optional keys that are not set are left out. */
const json = <A, I, RD, RE>(schema: Schema.Codec<A, I, RD, RE>) => {
	const encode = Schema.encodeEffect(schema)
	return (value: A) =>
		encode(value).pipe(
			Effect.flatMap((encoded) =>
				Schema.decodeUnknownEffect(Schema.Json)(omitOptional(encoded)),
			),
			Effect.mapError(
				(e) =>
					new ChatStore.ChatStoreError({
						reason: "encode-failed",
						message: "Failed to encode the Chat",
						issue: e.issue,
					}),
			),
		)
}
const encodeItem = json(Item.Record)
const encodeTurn = json(Turn.Record)
const decodeItem = Schema.decodeUnknownEffect(Item.Record)
const decodeTurn = Schema.decodeUnknownEffect(Turn.Record)

/**
 * A store over a persistence. The Items of a Chat form a log that only grows, so a
 * change writes the small record and its new Items, never the whole history.
 */
export const make = <S extends Plugin.Stores>(
	options: ChatStore.Options<S>,
): Effect.Effect<
	ChatStore.Store<ChatStore.Plugins<S>>,
	never,
	Scope.Scope | CodecServices<S>
> =>
	Effect.gen(function* () {
		type P = ChatStore.Plugins<S>
		const services = yield* Effect.context<CodecServices<S>>()
		const provide = <A, E, R>(program: Effect.Effect<A, E, R>) =>
			Effect.provideContext(program, services)
		const storage = options.persistence
		// All writes run one at a time.
		const atomic = (yield* Semaphore.make(1)).withPermits(1)
		const bus = yield* PubSub.unbounded<ChatStore.Change<P>>()
		yield* Effect.addFinalizer(() => PubSub.shutdown(bus))
		const publish = (change: ChatStore.Change<P>) =>
			PubSub.publish(bus, change).pipe(Effect.asVoid)
		const generator = Option.getOrElse(
			yield* Effect.serviceOption(IdGenerator.IdGenerator),
			() => IdGenerator.defaultIdGenerator,
		)
		const id = () => generator.generateId()
		const encodeRef = (ref: Chat.Ref) =>
			provide(json(options.definition.recordSchema)(ref))
		const encodeState = (value: ChatStore.Definition<S>["schema"]["Type"]) =>
			provide(json(options.definition.schema)(value))
		const decodeRef = (raw: Schema.Json) =>
			provide(
				Schema.decodeEffect(options.definition.recordSchema)(raw).pipe(
					Effect.mapError(invalid),
				),
			)
		const decodeState = (raw: Schema.Json) =>
			provide(
				Schema.decodeEffect(options.definition.schema)(raw).pipe(
					Effect.mapError(invalid),
				),
			)
		const read: ChatStore.Store<P>["read"] = (chat) =>
			Effect.gen(function* () {
				const stored = yield* storage.get(chat)
				if (Option.isNone(stored)) return yield* new Chat.ChatNotFound({ chat })
				return {
					chat: yield* decodeRef(stored.value.ref),
					state: yield* decodeState(stored.value.state),
				}
			})
		const save = (
			delta: ChatStore.Delta,
			previous: Chat.Ref | null,
			view: Chat.View<P>,
			items: ReadonlyArray<Item.Record>,
		) =>
			Effect.uninterruptibleMask((restore) =>
				restore(
					options.onCommit === undefined
						? storage.save(delta)
						: options.onCommit({ delta, previous, view }),
				).pipe(
					Effect.andThen(publish({ _tag: "Committed", previous, view, items })),
				),
			)
		const modifyEffect: ChatStore.Store<P>["modifyEffect"] = (input) =>
			atomic(
				Effect.gen(function* () {
					const before = yield* read(input.chat)
					if (
						input.expectedRevision !== undefined &&
						input.expectedRevision !== before.chat.revision
					)
						return yield* error("reference-conflict", {
							message: "The Chat revision is out of date",
							chat: input.chat,
						})
					const [result, next] = yield* input.update(before)
					if (Option.isNone(next)) return { result, view: before, items: [] }
					const mutation = next.value
					const changed =
						mutation.value !== undefined &&
						!Equal.equals(mutation.value, before.state)
					const appended = mutation.append ?? []
					if (!changed && mutation.chat === undefined && appended.length === 0)
						return { result, view: before, items: [] }
					const items = appended.map((entry, index): Item.Record => ({
						...entry,
						seq: Item.Seq.make(before.chat.seq + index + 1),
					}))
					const ref: Chat.Ref = {
						...before.chat,
						...mutation.chat,
						seq: Item.Seq.make(before.chat.seq + items.length),
						revision: Chat.Revision.make(before.chat.revision + 1),
					}
					const view: Chat.View<P> = {
						chat: ref,
						state: changed ? mutation.value! : before.state,
					}
					const turn =
						ref.turn !== undefined && !Equal.equals(ref.turn, before.chat.turn)
							? ref.turn
							: undefined
					const delta: ChatStore.Delta = {
						chat: ref.id,
						ref: yield* encodeRef(ref),
						revision: ref.revision,
						expected: before.chat.revision,
						...(changed ? { state: yield* encodeState(view.state) } : {}),
						items: yield* Effect.forEach(items, (item) =>
							encodeItem(item).pipe(
								Effect.map((value) => ({
									seq: item.seq,
									id: item.id,
									turn: item.origin?.turn ?? null,
									value,
								})),
							),
						),
						...(turn === undefined
							? {}
							: { turn: { id: turn.id, value: yield* encodeTurn(turn) } }),
					}
					yield* save(delta, before.chat, view, items)
					return { result, view, items }
				}),
			)
		const create: ChatStore.Store<P>["create"] = (input) =>
			atomic(
				Effect.gen(function* () {
					const value = input.value ?? initial({} as P)
					const ref: Chat.Ref = {
						id: input.id ?? Chat.Id.make(yield* id()),
						revision: Chat.Revision.make(0),
						settings: { mode: "build", ...input.settings },
						inbox: [],
						seq: Item.Seq.make(0),
						business: input.business ?? {},
						createdAt: yield* Clock.currentTimeMillis,
					}
					const view = { chat: ref, state: value }
					yield* save(
						{
							chat: ref.id,
							ref: yield* encodeRef(ref),
							revision: ref.revision,
							expected: null,
							state: yield* encodeState(value),
							items: [],
						},
						null,
						view,
						[],
					)
					return view
				}),
			)
		const decodeAll = <A>(
			rows: ReadonlyArray<Schema.Json>,
			decode: (row: unknown) => Effect.Effect<A, Schema.SchemaError>,
		) =>
			Effect.forEach(rows, (row) => decode(row).pipe(Effect.mapError(invalid)))
		const store: ChatStore.Store<P> = {
			get: (chat) =>
				storage.get(chat).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.succeedNone,
							onSome: (stored) => decodeRef(stored.ref).pipe(Effect.asSome),
						}),
					),
				),
			list: storage.list.pipe(
				Effect.flatMap((refs) => Effect.forEach(refs, decodeRef)),
			),
			read,
			create,
			modifyEffect,
			items: (chat, query = {}) =>
				storage
					.items(chat, query)
					.pipe(Effect.flatMap((rows) => decodeAll(rows, decodeItem))),
			turns: (chat, query = {}) =>
				storage
					.turns(chat, query)
					.pipe(Effect.flatMap((rows) => decodeAll(rows, decodeTurn))),
			turn: (chat, turn) =>
				storage.turn(chat, turn).pipe(
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.succeedNone,
							onSome: (row) =>
								decodeTurn(row).pipe(Effect.mapError(invalid), Effect.asSome),
						}),
					),
				),
			remove: (ref) =>
				atomic(
					Effect.gen(function* () {
						yield* options.onRemove === undefined
							? storage.remove(ref.id)
							: options.onRemove(ref)
						yield* publish({ _tag: "Removed", ref })
					}),
				),
			changes: (input) =>
				Stream.fromPubSub(bus).pipe(
					Stream.filter(
						(change) =>
							input?.chat === undefined ||
							(change._tag === "Committed"
								? change.view.chat.id
								: change.ref.id) === input.chat,
					),
				),
		}
		return store
	})
export const layer: {
	<S extends Plugin.Stores>(
		options: ChatStore.Options<S>,
	): <I>(
		tag: Context.Service<I, ChatStore.Store<ChatStore.Plugins<S>>>,
	) => Layer.Layer<I, never, CodecServices<S>>
	<I, S extends Plugin.Stores>(
		tag: Context.Service<I, ChatStore.Store<ChatStore.Plugins<S>>>,
		options: ChatStore.Options<S>,
	): Layer.Layer<I, never, CodecServices<S>>
} = dual(
	2,
	<I, S extends Plugin.Stores>(
		tag: Context.Service<I, ChatStore.Store<ChatStore.Plugins<S>>>,
		options: ChatStore.Options<S>,
	) => Layer.effect(tag, make(options)),
)
