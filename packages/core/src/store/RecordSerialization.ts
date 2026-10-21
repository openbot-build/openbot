import {
	Array as EffectArray,
	Option,
	HashMap,
	HashSet,
	Effect,
	JsonPatch,
	Schema,
	Predicate,
} from "effect"
import { dual } from "effect/Function"

import * as Timeline from "../timeline/Timeline.ts"
import * as Session from "../session/Session.ts"
import * as SessionStore from "./SessionStore.ts"
import type * as Plugin from "../plugins/Plugin.ts"
import * as MemoryPersistence from "./MemoryPersistence.ts"
import { unpack } from "./Snapshots.ts"
import { project } from "./Store.ts"
import { error, invalid } from "./StoreErrors.ts"
import { omitOptional } from "./PromptCodec.ts"

/** Find the version in the record and check that the current head reaches it. */
const reachable = (
	record: SessionStore.Record,
	version: Timeline.VersionId,
): Effect.Effect<SessionStore.Snapshot, SessionStore.SessionStoreError> =>
	Effect.gen(function* () {
		const node = record.versions.find((v) => v.id === version)
		if (node === undefined)
			return yield* error("parent-missing", {
				message: "The version is missing",
				version,
			})
		const versions = HashMap.fromIterable(
			record.versions.map((v) => [v.id, v] as const),
		)
		const visit = (
			pending: ReadonlyArray<Timeline.VersionId>,
			seen: HashSet.HashSet<Timeline.VersionId>,
		): Effect.Effect<
			HashSet.HashSet<Timeline.VersionId>,
			SessionStore.SessionStoreError
		> =>
			// suspend keeps long histories off the JavaScript call stack.
			Effect.suspend(() =>
				EffectArray.match(pending, {
					onEmpty: () => Effect.succeed(seen),
					onNonEmpty: ([id, ...rest]) =>
						HashSet.has(seen, id)
							? visit(rest, seen)
							: Option.match(HashMap.get(versions, id), {
									onNone: () =>
										Effect.fail(
											error("parent-missing", {
												message: "A parent version is missing",
												version: id,
											}),
										),
									onSome: (current) =>
										visit([...current.parents, ...rest], HashSet.add(seen, id)),
								}),
				}),
			)
		const seen = yield* visit([record.session.head], HashSet.empty())
		if (!HashSet.has(seen, version))
			return yield* error("version-unreachable", {
				message: "The version is not reachable from the current head",
				version,
			})
		return node
	})

export const original: {
	(
		version?: Timeline.VersionId,
	): (
		record: SessionStore.Record,
	) => Effect.Effect<Schema.JsonObject, SessionStore.SessionStoreError>
	(
		record: SessionStore.Record,
		version?: Timeline.VersionId,
	): Effect.Effect<Schema.JsonObject, SessionStore.SessionStoreError>
} = dual(
	(args) => Predicate.isObjectOrArray(args[0]),
	(
		record: SessionStore.Record,
		version = record.session.head,
	): Effect.Effect<Schema.JsonObject, SessionStore.SessionStoreError> =>
		reachable(record, version).pipe(
			Effect.flatMap((node) => unpack(node, record.messages)),
		),
)
export const make = <
	States extends Plugin.Stores,
>(): SessionStore.Serialization<States> => {
	const materialize: SessionStore.Serialization<States>["materialize"] = (
		input,
	) =>
		Effect.gen(function* () {
			const snapshot = yield* reachable(
				input.record,
				input.version ?? input.record.session.head,
			)
			const raw = yield* unpack(snapshot, input.record.messages)
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
			if (
				[...record.session.inheritedTurns, ...record.session.turns].some(
					(turn) =>
						!HashSet.has(versions, turn.start) ||
						(turn.end !== undefined && !HashSet.has(versions, turn.end)),
				)
			)
				return yield* error("reference-invalid", {
					message: "A Turn refers to a missing Timeline version",
				})
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
