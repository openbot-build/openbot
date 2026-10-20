import { Chunk, Option, HashMap, Effect, Equal, SynchronizedRef } from "effect"
import type * as Session from "../session/Session.ts"
import * as Memory from "../memory/Memory.ts"
import type * as SessionStore from "./SessionStore.ts"
import { validateDelta } from "./DeltaValidation.ts"
import { error } from "./StoreErrors.ts"

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
					Effect.map(
						(s) => Option.getOrUndefined(HashMap.get(s.refs, id)) ?? null,
					),
				),
			listRefs: (input) =>
				SynchronizedRef.get(state).pipe(
					Effect.map((s) =>
						Array.from(s.order)
							.flatMap((id) => Option.toArray(HashMap.get(s.refs, id)))
							.filter(
								(ref) =>
									input?.archived === undefined ||
									ref.metadata.archived === input.archived,
							),
					),
				),
			headers: (ids) =>
				SynchronizedRef.get(state).pipe(
					Effect.map((s) =>
						ids.flatMap((id) => {
							const v = Option.getOrUndefined(HashMap.get(s.versions, id))
							return v === undefined
								? []
								: [
										{
											id: v.id,
											schemaVersion: v.schemaVersion,
											parents: v.parents,
										},
									]
						}),
					),
				),
			snapshot: (id) =>
				SynchronizedRef.get(state).pipe(
					Effect.map(
						(s) => Option.getOrUndefined(HashMap.get(s.versions, id)) ?? null,
					),
				),
			contentHeaders: (ids) =>
				SynchronizedRef.get(state).pipe(
					Effect.map((s) =>
						ids.flatMap((id) => {
							const message = Option.getOrUndefined(HashMap.get(s.messages, id))
							return message === undefined
								? []
								: [{ id: message.id, message: message.message }]
						}),
					),
				),
			contents: (ids) =>
				SynchronizedRef.get(state).pipe(
					Effect.map((s) =>
						ids.flatMap((id) => {
							const m = Option.getOrUndefined(HashMap.get(s.messages, id))
							return m === undefined ? [] : [m]
						}),
					),
				),
			save: (input) =>
				Effect.gen(function* () {
					const delta = yield* validateDelta(storage, input)
					yield* SynchronizedRef.modifyEffect(state, (s) =>
						Effect.gen(function* () {
							if (
								!Equal.equals(
									Option.getOrUndefined(
										HashMap.get(s.refs, input.session.id),
									) ?? null,
									input.expected,
								)
							)
								return yield* error("reference-conflict", {
									message: "The full expected reference is stale",
								})
							let refs = s.refs,
								versions = s.versions,
								messages = s.messages
							for (const v of delta.versions) {
								const prior = Option.getOrUndefined(HashMap.get(versions, v.id))
								if (prior !== undefined && !Equal.equals(prior, v))
									return yield* error("version-conflict", {
										message: "Immutable version conflict",
										version: v.id,
									})
								versions = HashMap.set(versions, v.id, v)
							}
							for (const m of delta.messages) {
								const prior = Option.getOrUndefined(HashMap.get(messages, m.id))
								if (prior !== undefined && !Equal.equals(prior, m))
									return yield* error("message-conflict", {
										message: "Immutable message content conflict",
									})
								messages = HashMap.set(messages, m.id, m)
							}
							refs = HashMap.set(refs, delta.session.id, delta.session)
							return [
								undefined,
								{
									refs,
									versions,
									messages,
									order: HashMap.has(s.refs, delta.session.id)
										? s.order
										: Chunk.append(s.order, delta.session.id),
								},
							] as const
						}),
					)
				}),
			remove: (ref) =>
				SynchronizedRef.updateEffect(state, (s) =>
					Effect.gen(function* () {
						const current = Option.getOrUndefined(HashMap.get(s.refs, ref.id))
						if (current === undefined) return s
						if (!Equal.equals(current, ref))
							return yield* error("reference-conflict", {
								message: "The full expected reference is stale",
							})
						return { ...s, refs: HashMap.remove(s.refs, ref.id) }
					}),
				),
		}
		return storage
	},
)
