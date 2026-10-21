import { Chunk, Option, HashMap, Effect, Equal, SynchronizedRef } from "effect"
import type * as Session from "../session/Session.ts"
import * as Memory from "../memory/Memory.ts"
import type * as SessionStore from "./SessionStore.ts"
import { validateDelta } from "./DeltaValidation.ts"
import { error } from "./StoreErrors.ts"

/** Rows whose ID is in the map, in the order of the IDs. Missing IDs are left out. */
const pick = <K, V>(rows: HashMap.HashMap<K, V>, ids: ReadonlyArray<K>) =>
	ids.flatMap((id) => Option.toArray(HashMap.get(rows, id)))

export const make: Effect.Effect<SessionStore.Persistence> = Effect.gen(
	function* () {
		const state = yield* SynchronizedRef.make({
			refs: HashMap.empty<Session.Id, Session.Ref>(),
			order: Chunk.empty<Session.Id>(),
			versions: HashMap.empty<Memory.VersionId, SessionStore.Snapshot>(),
			messages: HashMap.empty<string, SessionStore.Content>(),
		})
		const storage: SessionStore.Persistence = {
			getRef: (id) =>
				SynchronizedRef.get(state).pipe(
					Effect.map((s) => HashMap.get(s.refs, id)),
				),
			listRefs: (input) =>
				SynchronizedRef.get(state).pipe(
					Effect.map((s) =>
						pick(s.refs, Chunk.toReadonlyArray(s.order)).filter(
							(ref) =>
								input?.archived === undefined ||
								ref.metadata.archived === input.archived,
						),
					),
				),
			headers: (ids) =>
				SynchronizedRef.get(state).pipe(
					Effect.map((s) =>
						pick(s.versions, ids).map((v) => ({
							id: v.id,
							schemaVersion: v.schemaVersion,
							parents: v.parents,
						})),
					),
				),
			snapshot: (id) =>
				SynchronizedRef.get(state).pipe(
					Effect.map((s) => HashMap.get(s.versions, id)),
				),
			contentHeaders: (ids) =>
				SynchronizedRef.get(state).pipe(
					Effect.map((s) =>
						pick(s.messages, ids).map((message) => ({
							id: message.id,
							message: message.message,
						})),
					),
				),
			contents: (ids) =>
				SynchronizedRef.get(state).pipe(
					Effect.map((s) => pick(s.messages, ids)),
				),
			save: (input) =>
				Effect.gen(function* () {
					const delta = yield* validateDelta(storage, input)
					yield* SynchronizedRef.updateEffect(state, (s) =>
						Effect.gen(function* () {
							if (
								!Equal.equals(
									Option.getOrNull(HashMap.get(s.refs, input.session.id)),
									input.expected,
								)
							)
								return yield* error("reference-conflict", {
									message: "The full expected reference is stale",
								})
							// validateDelta rejects duplicate IDs, so each row only needs a check against stored rows.
							const version = delta.versions.find((v) =>
								Option.exists(
									HashMap.get(s.versions, v.id),
									(prior) => !Equal.equals(prior, v),
								),
							)
							if (version !== undefined)
								return yield* error("version-conflict", {
									message: "Immutable version conflict",
									version: version.id,
								})
							if (
								delta.messages.some((m) =>
									Option.exists(
										HashMap.get(s.messages, m.id),
										(prior) => !Equal.equals(prior, m),
									),
								)
							)
								return yield* error("message-conflict", {
									message: "Immutable message content conflict",
								})
							return {
								refs: HashMap.set(s.refs, delta.session.id, delta.session),
								versions: delta.versions.reduce(
									(versions, v) => HashMap.set(versions, v.id, v),
									s.versions,
								),
								messages: delta.messages.reduce(
									(messages, m) => HashMap.set(messages, m.id, m),
									s.messages,
								),
								order: HashMap.has(s.refs, delta.session.id)
									? s.order
									: Chunk.append(s.order, delta.session.id),
							}
						}),
					)
				}),
			remove: (ref) =>
				SynchronizedRef.updateEffect(state, (s) =>
					Option.match(HashMap.get(s.refs, ref.id), {
						onNone: () => Effect.succeed(s),
						onSome: (current) =>
							Equal.equals(current, ref)
								? Effect.succeed({ ...s, refs: HashMap.remove(s.refs, ref.id) })
								: Effect.fail(
										error("reference-conflict", {
											message: "The full expected reference is stale",
										}),
									),
					}),
				),
		}
		return storage
	},
)
