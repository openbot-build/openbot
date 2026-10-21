import {
	Chunk,
	Array as EffectArray,
	Option,
	HashMap,
	HashSet,
	Effect,
	JsonPatch,
	Schema,
	Predicate,
	Optic,
} from "effect"
import { dual } from "effect/Function"

import { IdGenerator } from "effect/ai"
import * as Item from "../timeline/Item.ts"
import * as Timeline from "../timeline/Timeline.ts"
import type * as SessionStore from "./SessionStore.ts"
import { error, invalid } from "./StoreErrors.ts"
import { batches } from "./GraphTraversal.ts"

/** Compare raw JSON by structure. Object identity and key order do not matter. */
export const same: {
	(right: Schema.Json): (left: Schema.Json) => boolean
	(left: Schema.Json, right: Schema.Json): boolean
} = dual(
	2,
	(left: Schema.Json, right: Schema.Json) =>
		JsonPatch.get(left, right).length === 0,
)
const decodeEntry = Schema.decodeUnknownEffect(
	Schema.Struct({
		content: Schema.Json,
		origin: Schema.optionalKey(Schema.Json),
	}),
)
const encodedHistory = Schema.Array(
	Schema.Struct({
		id: Item.Id,
		content: Schema.Json,
		origin: Schema.optionalKey(Schema.Json),
	}),
)
export const unpack: {
	(
		contents: ReadonlyArray<SessionStore.Content>,
	): (
		snapshot: SessionStore.Snapshot,
	) => Effect.Effect<Schema.JsonObject, SessionStore.SessionStoreError>
	(
		snapshot: SessionStore.Snapshot,
		contents: ReadonlyArray<SessionStore.Content>,
	): Effect.Effect<Schema.JsonObject, SessionStore.SessionStoreError>
} = dual(
	2,
	(
		snapshot: SessionStore.Snapshot,
		contents: ReadonlyArray<SessionStore.Content>,
	): Effect.Effect<Schema.JsonObject, SessionStore.SessionStoreError> =>
		Effect.gen(function* () {
			const messages = HashMap.fromIterable(
				contents.map((entry) => [entry.id, entry]),
			)
			if (
				HashSet.size(
					HashSet.fromIterable(snapshot.history.map((ref) => ref.message)),
				) !== snapshot.history.length
			)
				return yield* invalid()
			const history = yield* Effect.forEach(snapshot.history, (ref) =>
				Option.match(HashMap.get(messages, ref.content), {
					onNone: () =>
						Effect.fail(
							error("message-missing", {
								message: "A referenced message content is missing",
								version: snapshot.id,
							}),
						),
					onSome: (entry) =>
						entry.message !== ref.message
							? Effect.fail(invalid())
							: decodeEntry(entry.content).pipe(
									Effect.mapError(invalid),
									Effect.map((decoded) => ({ id: ref.message, ...decoded })),
								),
				}),
			)
			const core = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
				snapshot.value["conversation"],
			).pipe(Effect.mapError(invalid))
			return Optic.id<Schema.JsonObject>()
				.key("conversation")
				.replace({ ...core, history }, snapshot.value)
		}),
)

export const pack: {
	(
		raw: Schema.Json,
		reusable?: ReadonlyArray<{
			readonly snapshot: SessionStore.Snapshot
			readonly messages: ReadonlyArray<SessionStore.Content>
		}>,
		generate?: () => Effect.Effect<string>,
	): (version: Timeline.Version) => Effect.Effect<
		{
			readonly snapshot: SessionStore.Snapshot
			readonly messages: ReadonlyArray<SessionStore.Content>
		},
		SessionStore.SessionStoreError
	>
	(
		version: Timeline.Version,
		raw: Schema.Json,
		reusable?: ReadonlyArray<{
			readonly snapshot: SessionStore.Snapshot
			readonly messages: ReadonlyArray<SessionStore.Content>
		}>,
		generate?: () => Effect.Effect<string>,
	): Effect.Effect<
		{
			readonly snapshot: SessionStore.Snapshot
			readonly messages: ReadonlyArray<SessionStore.Content>
		},
		SessionStore.SessionStoreError
	>
} = dual(
	(args) => Predicate.hasProperty(args[0], "schemaVersion"),
	(
		version: Timeline.Version,
		raw: Schema.Json,
		reusable: ReadonlyArray<{
			readonly snapshot: SessionStore.Snapshot
			readonly messages: ReadonlyArray<SessionStore.Content>
		}> = [],
		generate: () => Effect.Effect<string> = IdGenerator.defaultIdGenerator
			.generateId,
	): Effect.Effect<
		{
			readonly snapshot: SessionStore.Snapshot
			readonly messages: ReadonlyArray<SessionStore.Content>
		},
		SessionStore.SessionStoreError
	> =>
		Effect.gen(function* () {
			const object = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
				raw,
			).pipe(Effect.mapError(invalid))
			const core = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
				object["conversation"],
			).pipe(Effect.mapError(invalid))
			const entries = yield* Schema.decodeUnknownEffect(encodedHistory)(
				core["history"],
			).pipe(Effect.mapError(invalid))
			const { history: _, ...rest } = core
			const value = { ...object, conversation: rest }
			if (
				HashSet.size(HashSet.fromIterable(entries.map((entry) => entry.id))) !==
				entries.length
			)
				return yield* invalid()
			// Stored contents by message ID, so unchanged messages keep their content rows.
			const existing = reusable
				.flatMap((base) => base.messages)
				.reduce(
					(existing, message) =>
						HashMap.set(
							existing,
							message.message,
							Chunk.append(
								Option.getOrElse(HashMap.get(existing, message.message), () =>
									Chunk.empty<SessionStore.Content>(),
								),
								message,
							),
						),
					HashMap.empty<string, Chunk.Chunk<SessionStore.Content>>(),
				)
			const packed = yield* Effect.forEach(entries, (entry) => {
				const payload: Schema.JsonObject = {
					content: entry.content,
					...(entry.origin === undefined ? {} : { origin: entry.origin }),
				}
				return Option.match(
					Option.flatMap(HashMap.get(existing, entry.id), (revisions) =>
						Chunk.findFirst(revisions, (candidate) =>
							same(candidate.content, payload),
						),
					),
					{
						onSome: (content) =>
							Effect.succeed({
								content,
								created: Option.none<SessionStore.Content>(),
							}),
						onNone: () =>
							Effect.map(generate(), (id) => {
								const content: SessionStore.Content = {
									id,
									message: entry.id,
									content: payload,
								}
								return { content, created: Option.some(content) }
							}),
					},
				)
			})
			return {
				snapshot: {
					...version,
					snapshotFormatVersion: 2,
					value,
					history: packed.map(({ content }) => ({
						message: content.message,
						content: content.id,
					})),
				},
				messages: EffectArray.getSomes(packed.map(({ created }) => created)),
			}
		}),
)
export const readRaw: {
	(id: Timeline.VersionId): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<
		{
			snapshot: SessionStore.Snapshot
			messages: Array<SessionStore.Content>
			raw: Schema.JsonObject
		},
		SessionStore.SessionStoreError
	>
	(
		storage: SessionStore.Persistence,
		id: Timeline.VersionId,
	): Effect.Effect<
		{
			snapshot: SessionStore.Snapshot
			messages: Array<SessionStore.Content>
			raw: Schema.JsonObject
		},
		SessionStore.SessionStoreError
	>
} = dual(2, (storage: SessionStore.Persistence, id: Timeline.VersionId) =>
	Effect.gen(function* () {
		const snapshot = yield* storage.snapshot(id).pipe(
			Effect.flatMap((snapshot) =>
				Effect.fromOption(snapshot, () =>
					error("parent-missing", {
						message: "The version is missing",
						version: id,
					}),
				),
			),
		)
		const ids = EffectArray.dedupe(snapshot.history.map((ref) => ref.content))
		const messages = yield* batches(ids, storage.contents)
		const raw = yield* unpack(snapshot, messages)
		return { snapshot, messages, raw }
	}),
)
