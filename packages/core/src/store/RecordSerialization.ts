import {
	Option,
	Chunk,
	HashSet,
	Effect,
	JsonPatch,
	Schema,
	Predicate,
} from "effect"
import { dual } from "effect/Function"

import * as Memory from "../memory/Memory.ts"
import * as Session from "../session/Session.ts"
import * as SessionStore from "./SessionStore.ts"
import type * as Plugin from "../plugins/Plugin.ts"
import * as MemoryPersistence from "./MemoryPersistence.ts"
import { unpack } from "./Snapshots.ts"
import { project } from "./Store.ts"
import { error, invalid } from "./StoreErrors.ts"
import { omitOptional } from "./PromptCodec.ts"

export const original: {
	(
		version?: Memory.VersionId,
	): (
		record: SessionStore.Record,
	) => Effect.Effect<Schema.JsonObject, SessionStore.SessionStoreError>
	(
		record: SessionStore.Record,
		version?: Memory.VersionId,
	): Effect.Effect<Schema.JsonObject, SessionStore.SessionStoreError>
} = dual(
	(args) => Predicate.isObjectOrArray(args[0]),
	(
		record: SessionStore.Record,
		version = record.session.head,
	): Effect.Effect<Schema.JsonObject, SessionStore.SessionStoreError> =>
		Effect.gen(function* () {
			const node = record.versions.find((v) => v.id === version)
			if (node === undefined)
				return yield* error("parent-missing", {
					message: "The version is missing",
					version: version,
				})
			let reachable = HashSet.empty<Memory.VersionId>(),
				pending: Chunk.Chunk<Memory.VersionId> = Chunk.of(record.session.head)
			const visit: Effect.Effect<void, SessionStore.SessionStoreError> =
				Effect.suspend(() => {
					const id = Option.getOrUndefined(Chunk.last(pending))
					pending = Chunk.dropRight(pending, 1)
					if (id === undefined) return Effect.void
					if (HashSet.has(reachable, id)) return visit
					reachable = HashSet.add(reachable, id)
					const current = record.versions.find((v) => v.id === id)
					if (current === undefined)
						return error("parent-missing", {
							message: "A parent version is missing",
							version: id,
						})
					pending = Chunk.appendAll(
						pending,
						Chunk.fromIterable(current.parents),
					)
					return visit
				})
			yield* visit
			if (!HashSet.has(reachable, version))
				return yield* error("version-unreachable", {
					message: "The version is not reachable from the current head",
					version: version,
				})
			return yield* unpack(node, record.messages)
		}),
)
export const make = <
	States extends Plugin.Stores,
>(): SessionStore.Serialization<States> => {
	const materialize: SessionStore.Serialization<States>["materialize"] = (
		input,
	) =>
		Effect.gen(function* () {
			const id = input.version ?? input.record.session.head
			const raw = yield* original(input.record, id)
			const snapshot = input.record.versions.find((v) => v.id === id)!
			return yield* project(input.definition, snapshot, raw)
		})
	const validate = (
		definition: SessionStore.Definition<States>,
		record: SessionStore.Record,
	) =>
		Effect.gen(function* () {
			const refJson = yield* Schema.encodeEffect(Session.Ref)(
				record.session,
			).pipe(
				Effect.flatMap((json) =>
					Schema.decodeUnknownEffect(Schema.Json)(omitOptional(json)),
				),
				Effect.mapError(invalid),
			)
			yield* Schema.decodeEffect(definition.sessionSchema)(refJson).pipe(
				Effect.mapError(invalid),
			)
			const versions = HashSet.fromIterable(
				record.versions.map((version) => version.id),
			)
			for (const turn of [
				...record.session.inheritedTurns,
				...record.session.turns,
			]) {
				if (
					!HashSet.has(versions, turn.start) ||
					(turn.end !== undefined && !HashSet.has(versions, turn.end))
				)
					return yield* error("reference-invalid", {
						message: "A Turn refers to a missing Memory version",
					})
			}
			if (
				record.session.turns.some((turn) => turn.session !== record.session.id)
			)
				return yield* error("reference-invalid", {
					message: "An owned Turn belongs to another Session",
				})
			const storage = yield* MemoryPersistence.make
			yield* storage.save({
				session: record.session,
				expected: null,
				versions: record.versions,
				messages: record.messages,
			})
			for (const version of record.versions)
				yield* materialize({ definition, record, version: version.id })
			return record
		})
	return {
		materialize,
		encode: ({ definition, record }) =>
			validate(definition, record).pipe(
				Effect.flatMap(
					Schema.encodeEffect(Schema.fromJsonString(SessionStore.Record)),
				),
				Effect.mapError((e) =>
					e instanceof SessionStore.SessionStoreError ? e : invalid(e),
				),
			),
		decode: ({ definition, input }) =>
			Effect.gen(function* () {
				const json = yield* Effect.try({
					try: (): unknown => JSON.parse(input),
					catch: () =>
						error("invalid-json", { message: "The record is not valid JSON" }),
				})
				if (
					Predicate.hasProperty(json, "formatVersion") &&
					json.formatVersion !== 3
				)
					return yield* error("unsupported-format", {
						message: "Unsupported record format",
					})
				const decoded = yield* Schema.decodeUnknownEffect(SessionStore.Record)(
					json,
				).pipe(Effect.mapError(invalid))
				return yield* validate(definition, decoded)
			}),
		compare: ({ definition, record, base, target }) =>
			Effect.gen(function* () {
				const before = yield* original(record, base)
				const after = yield* Schema.encodeEffect(definition.schema)(
					target,
				).pipe(
					Effect.mapError((e) =>
						error("encode-failed", { message: e.message }),
					),
				)
				return JsonPatch.get(before, after)
			}),
	}
}
