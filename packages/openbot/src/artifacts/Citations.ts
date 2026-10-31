import { Chat, ChatStore, Item, Turn } from "@openbot-build/core"
import { Artifacts, Execution } from "@openbot-build/domain"
import { and, eq, inArray } from "drizzle-orm"
import {
	Array as Arr,
	Effect,
	Option,
	Ref,
	Schema,
	String as Str,
} from "effect"
import type { Database } from "../database/Database.ts"
import {
	artifactCitations,
	artifactCitationIntents,
} from "../database/Schema.ts"

const references = Schema.fromJsonString(
	Schema.Array(Artifacts.SourceReference),
)
const sameReference = Schema.toEquivalence(Artifacts.SourceReference)

/** A tool's own Item is not the answer that follows the tool. */
export const target = (
	items: ReadonlyArray<Item.Entry>,
	turn: string,
	afterStep: number,
) =>
	Arr.findFirst(
		items,
		(item) =>
			item.origin?.turn === turn &&
			item.origin.step > afterStep &&
			!Arr.some(
				item.content.content,
				(message) =>
					message.role === "assistant" &&
					Arr.some(message.content, (part) => part.type === "tool-call"),
			) &&
			Arr.some(
				item.content.content,
				(message) =>
					message.role === "assistant" &&
					Arr.some(
						message.content,
						(part) => part.type === "text" && Str.trim(part.text) !== "",
					),
			),
	)

/** The caller saves this write under its current execution fence. */
export const remember = (
	db: Database,
	input: {
		readonly namespace: string
		readonly chat: Chat.Id
		readonly turn: Turn.Id
		readonly callId: Execution.CallId
		readonly afterStep: number
		readonly citations: ReadonlyArray<Artifacts.SourceReference>
	},
) =>
	Effect.gen(function* () {
		const text = yield* Schema.encodeEffect(references)(input.citations)
		yield* db
			.insert(artifactCitationIntents)
			.values({
				namespace: input.namespace,
				chat: input.chat,
				turn: input.turn,
				callId: input.callId,
				afterStep: input.afterStep,
				citations: text,
			})
			.onConflictDoNothing()
	})

/** Called in the same transaction that saves the Items and their Checkpoint. */
export const bind = (
	db: Database,
	namespace: string,
	turn: Turn.Id,
	delta: ChatStore.Delta,
) =>
	Effect.gen(function* () {
		const pending = yield* db
			.select()
			.from(artifactCitationIntents)
			.where(
				and(
					eq(artifactCitationIntents.namespace, namespace),
					eq(artifactCitationIntents.chat, delta.chat),
					eq(artifactCitationIntents.turn, turn),
				),
			)
		const items = yield* Effect.forEach(delta.items, (item) =>
			Schema.decodeUnknownEffect(Item.Entry)(item.value),
		)
		const events = yield* Ref.make<
			ReadonlyArray<
				Extract<Execution.EventBody, { readonly _tag: "CitationRecorded" }>
			>
		>([])
		for (const intent of pending) {
			const next = target(items, turn, intent.afterStep)
			if (Option.isNone(next)) continue
			const item = next.value.id
			const where = and(
				eq(artifactCitations.namespace, namespace),
				eq(artifactCitations.chat, delta.chat),
				eq(artifactCitations.item, item),
			)
			const prior = (yield* db.select().from(artifactCitations).where(where))[0]
			const citations = Arr.dedupeWith(
				[
					...(prior === undefined
						? []
						: yield* Schema.decodeEffect(references)(prior.citations)),
					...(yield* Schema.decodeEffect(references)(intent.citations)),
				],
				sameReference,
			)
			yield* db
				.insert(artifactCitations)
				.values({
					namespace,
					chat: delta.chat,
					item,
					citations: yield* Schema.encodeEffect(references)(citations),
				})
				.onConflictDoUpdate({
					target: [
						artifactCitations.namespace,
						artifactCitations.chat,
						artifactCitations.item,
					],
					set: { citations: yield* Schema.encodeEffect(references)(citations) },
				})
			yield* db
				.delete(artifactCitationIntents)
				.where(
					and(
						eq(artifactCitationIntents.namespace, namespace),
						eq(artifactCitationIntents.callId, intent.callId),
					),
				)
			yield* Ref.update(events, (events) =>
				Arr.append(events, {
					_tag: "CitationRecorded",
					chatId: delta.chat,
					itemId: item,
					citations,
				}),
			)
		}
		if (delta.turn !== undefined) {
			const saved = yield* Schema.decodeUnknownEffect(Turn.Record)(
				delta.turn.value,
			)
			if (Turn.isTerminal(saved.status))
				yield* db
					.delete(artifactCitationIntents)
					.where(
						and(
							eq(artifactCitationIntents.namespace, namespace),
							eq(artifactCitationIntents.chat, delta.chat),
							eq(artifactCitationIntents.turn, turn),
						),
					)
		}
		return yield* Ref.get(events)
	})

/** The caller has already checked read access to this Chat. */
export const enrich = (
	db: Database,
	namespace: string,
	chat: Chat.Id,
	items: ReadonlyArray<Artifacts.ChatItem>,
) =>
	Effect.gen(function* () {
		if (items.length === 0) return items
		const rows = yield* db
			.select()
			.from(artifactCitations)
			.where(
				and(
					eq(artifactCitations.namespace, namespace),
					eq(artifactCitations.chat, chat),
					inArray(
						artifactCitations.item,
						Arr.map(items, (item) => item.id),
					),
				),
			)
		return yield* Effect.forEach(items, (item) => {
			const row = Arr.findFirst(rows, (row) => row.item === item.id)
			return Option.isNone(row)
				? Effect.succeed(item)
				: Effect.map(
						Schema.decodeEffect(references)(row.value.citations),
						(citations) => ({ ...item, citations }),
					)
		})
	})
