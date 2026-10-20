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
import * as Item from "../memory/Item.ts"
import * as Memory from "../memory/Memory.ts"
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
			let ids = HashSet.empty<string>()
			let history = Chunk.empty<{
				readonly id: string
				readonly content: Schema.Json
			}>()
			for (const ref of snapshot.history) {
				const entry = Option.getOrUndefined(HashMap.get(messages, ref.content))
				if (entry === undefined)
					return yield* error("message-missing", {
						message: "A referenced message content is missing",
						version: snapshot.id,
					})
				if (entry.message !== ref.message || HashSet.has(ids, ref.message))
					return yield* invalid()
				ids = HashSet.add(ids, ref.message)
				history = Chunk.append(history, {
					id: ref.message,
					...(yield* Schema.decodeUnknownEffect(
						Schema.Struct({
							content: Schema.Json,
							origin: Schema.optionalKey(Schema.Json),
						}),
					)(entry.content).pipe(Effect.mapError(invalid))),
				})
			}
			const core = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
				snapshot.value["memory"],
			).pipe(Effect.mapError(invalid))
			return Optic.id<Schema.JsonObject>()
				.key("memory")
				.replace({ ...core, history: Array.from(history) }, snapshot.value)
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
	): (version: Memory.Version) => Effect.Effect<
		{
			readonly snapshot: SessionStore.Snapshot
			readonly messages: ReadonlyArray<SessionStore.Content>
		},
		SessionStore.SessionStoreError
	>
	(
		version: Memory.Version,
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
		version: Memory.Version,
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
				object["memory"],
			).pipe(Effect.mapError(invalid))
			const entries = yield* Schema.decodeUnknownEffect(encodedHistory)(
				core["history"],
			).pipe(Effect.mapError(invalid))
			const { history: _, ...rest } = core
			const value = { ...object, memory: rest }
			let existing = HashMap.empty<string, Chunk.Chunk<SessionStore.Content>>()
			for (const base of reusable)
				for (const message of base.messages) {
					let revisions =
						Option.getOrUndefined(HashMap.get(existing, message.message)) ??
						Chunk.empty<SessionStore.Content>()
					revisions = Chunk.append(revisions, message)
					existing = HashMap.set(existing, message.message, revisions)
				}
			let history = Chunk.empty<SessionStore.Snapshot["history"][number]>()
			let messages = Chunk.empty<SessionStore.Content>()
			let seen = HashSet.empty<string>()
			for (const entry of entries) {
				if (HashSet.has(seen, entry.id)) return yield* invalid()
				seen = HashSet.add(seen, entry.id)
				const payload: Schema.JsonObject = {
					content: entry.content,
					...(entry.origin === undefined ? {} : { origin: entry.origin }),
				}
				const previous = Option.getOrUndefined(
					Option.flatMap(HashMap.get(existing, entry.id), (revisions) =>
						Chunk.findFirst(
							revisions,
							(candidate) =>
								candidate.message === entry.id &&
								same(candidate.content, payload),
						),
					),
				)
				const content = previous ?? {
					id: yield* generate(),
					message: entry.id,
					content: payload,
				}
				if (previous === undefined) messages = Chunk.append(messages, content)
				history = Chunk.append(history, {
					message: entry.id,
					content: content.id,
				})
			}
			return {
				snapshot: {
					...version,
					snapshotFormatVersion: 2,
					value,
					history: Array.from(history),
				},
				messages: Array.from(messages),
			}
		}),
)
export const readRaw: {
	(id: Memory.VersionId): (storage: SessionStore.Persistence) => Effect.Effect<
		{
			snapshot: SessionStore.Snapshot
			messages: Array<SessionStore.Content>
			raw: Schema.JsonObject
		},
		SessionStore.SessionStoreError
	>
	(
		storage: SessionStore.Persistence,
		id: Memory.VersionId,
	): Effect.Effect<
		{
			snapshot: SessionStore.Snapshot
			messages: Array<SessionStore.Content>
			raw: Schema.JsonObject
		},
		SessionStore.SessionStoreError
	>
} = dual(2, (storage: SessionStore.Persistence, id: Memory.VersionId) =>
	Effect.gen(function* () {
		const snapshot = yield* storage.snapshot(id)
		if (snapshot === null)
			return yield* error("parent-missing", {
				message: "The version is missing",
				version: id,
			})
		const ids = EffectArray.dedupe(snapshot.history.map((ref) => ref.content))
		const messages = Array.from(yield* batches(ids, storage.contents))
		const raw = yield* unpack(snapshot, messages)
		return { snapshot, messages, raw }
	}),
)
