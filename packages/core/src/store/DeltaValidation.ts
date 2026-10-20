import {
	Array as EffectArray,
	Option,
	Optic,
	HashMap,
	HashSet,
	Effect,
	Equal,
} from "effect"
import { dual } from "effect/Function"

import * as Memory from "../memory/Memory.ts"
import type * as SessionStore from "./SessionStore.ts"
import { batches } from "./GraphTraversal.ts"
import { acyclic, reaches } from "./VersionGraph.ts"
import { readRaw, same, unpack } from "./Snapshots.ts"
import { error, invalid } from "./StoreErrors.ts"

/** Validate only the submitted data and the immutable rows it refers to directly. */
export const validateDelta: {
	(
		input: SessionStore.Delta,
	): (
		storage: SessionStore.Persistence,
	) => Effect.Effect<SessionStore.Delta, SessionStore.SessionStoreError>
	(
		storage: SessionStore.Persistence,
		input: SessionStore.Delta,
	): Effect.Effect<SessionStore.Delta, SessionStore.SessionStoreError>
} = dual(
	2,
	(
		storage: SessionStore.Persistence,
		input: SessionStore.Delta,
	): Effect.Effect<SessionStore.Delta, SessionStore.SessionStoreError> =>
		Effect.gen(function* () {
			const current = yield* storage.getRef(input.session.id)
			if (!Equal.equals(current, input.expected))
				return yield* error("reference-conflict", {
					message: "The full expected reference is stale",
				})
			if (
				current !== null &&
				input.session.revision !== current.revision + 1 &&
				!Equal.equals(current, input.session)
			)
				return yield* error("reference-conflict", {
					message: "A Session update must increase its revision by exactly one",
				})

			const incoming = HashMap.fromIterable(
				input.versions.map((v) => [v.id, v]),
			)
			if (HashMap.size(incoming) !== input.versions.length)
				return yield* error("version-conflict", {
					message: "Duplicate version ID",
				})
			const content = HashMap.fromIterable(input.messages.map((m) => [m.id, m]))
			if (HashMap.size(content) !== input.messages.length)
				return yield* error("message-conflict", {
					message: "Duplicate message content ID",
				})
			let needed = HashSet.fromIterable<Memory.VersionId>([input.session.head])
			for (const version of input.versions) {
				needed = HashSet.add(needed, version.id)
				for (const parent of version.parents)
					needed = HashSet.add(needed, parent)
			}
			const existing = HashMap.fromIterable(
				(yield* batches(Array.from(needed), storage.headers)).map((v) => [
					v.id,
					v,
				]),
			)
			for (const id of needed)
				if (!HashMap.has(incoming, id) && !HashMap.has(existing, id))
					return yield* error(
						id === input.session.head ? "reference-invalid" : "parent-missing",
						{ message: "A referenced version is missing", version: id },
					)
			if (!acyclic(incoming))
				return yield* error("version-cycle", {
					message: "The submitted versions contain a cycle",
				})
			if (current !== null && current.head !== input.session.head) {
				const submitted = HashMap.union(
					incoming,
					HashMap.filter(existing, (_, id) => id === current.head),
				)
				if (!reaches(submitted, input.session.head, current.head, true))
					return yield* error("reference-conflict", {
						message: "The new head must build on the expected head",
					})
			}
			let versions: ReadonlyArray<SessionStore.Snapshot> = []
			let remapped = HashMap.empty<string, string>()
			const ordered = [
				...input.versions.filter((v) => HashMap.has(existing, v.id)),
				...input.versions.filter((v) => !HashMap.has(existing, v.id)),
			]
			for (const supplied of ordered) {
				const version = Optic.id<SessionStore.Snapshot>()
					.key("history")
					.forEach((ref) => ref.key("content"))
					.modifyAll(
						(content) =>
							Option.getOrUndefined(HashMap.get(remapped, content)) ?? content,
					)(supplied)
				const ids = EffectArray.dedupe(
					version.history.map((ref) => ref.content),
				)
				const persisted = yield* batches(
					ids.filter((id) => !HashMap.has(content, id)),
					storage.contentHeaders,
				)
				const references = HashMap.fromIterable(
					[...persisted, ...input.messages].map((message) => [
						message.id,
						message,
					]),
				)
				let identities = HashSet.empty<string>()
				for (const ref of version.history) {
					const message = Option.getOrUndefined(
						HashMap.get(references, ref.content),
					)
					if (message === undefined)
						return yield* error("message-missing", {
							message: "A referenced message content is missing",
							version: version.id,
						})
					if (
						message.message !== ref.message ||
						HashSet.has(identities, ref.message)
					)
						return yield* invalid()
					identities = HashSet.add(identities, ref.message)
				}
				if (Object.hasOwn(version.value, "history")) return yield* invalid()

				if (HashMap.has(existing, version.id)) {
					const previous = yield* readRaw(storage, version.id)
					const raw = yield* unpack(version, [
						...(yield* batches(
							ids.filter((id) => !HashMap.has(content, id)),
							storage.contents,
						)),
						...input.messages,
					])
					const { id, schemaVersion, parents } = version
					if (
						!Equal.equals(Option.getOrUndefined(HashMap.get(existing, id)), {
							id,
							schemaVersion,
							parents,
						}) ||
						!same(previous.raw, raw)
					)
						return yield* error("version-conflict", {
							message: "The same version ID has different contents",
							version: id,
						})
					for (let index = 0; index < supplied.history.length; index++)
						remapped = HashMap.set(
							remapped,
							supplied.history[index]!.content,
							previous.snapshot.history[index]!.content,
						)
				} else versions = EffectArray.append(versions, version)
			}
			const used = HashSet.fromIterable(
				versions.flatMap((v) => v.history.map((ref) => ref.content)),
			)
			const messages = input.messages.filter((m) => HashSet.has(used, m.id))
			const old = HashMap.fromIterable(
				(yield* batches(
					input.messages.map((m) => m.id),
					storage.contents,
				)).map((m) => [m.id, m]),
			)
			for (const message of input.messages) {
				const previous = Option.getOrUndefined(HashMap.get(old, message.id))
				if (
					previous !== undefined &&
					(previous.message !== message.message ||
						!same(previous.content, message.content))
				)
					return yield* error("message-conflict", {
						message: "The same message content ID has different contents",
					})
			}
			return {
				...input,
				versions,
				messages: messages.filter((m) => !HashMap.has(old, m.id)),
			}
		}),
)
