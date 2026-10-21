import { Array as A, Clock, Effect, Match, Option, Record } from "effect"
import { Item, type Session } from "@openbot-build/core"
import { Prompt } from "effect/ai"
import * as Memory from "./Memory.ts"
import type * as MemorySession from "./MemorySession.ts"

/** The store field is optional. A Session without memory starts empty. */
const stateOf = (view: Session.View<Memory.Values>): Memory.State =>
	view.state.value["@openbot-build/plugin-memory"] ?? Memory.empty()

export const make = (input: {
	readonly store: MemorySession.Store
	readonly model: typeof Memory.MemoryModel.Service
	readonly policy: typeof Memory.MemoryPolicy.Service
}): MemorySession.Operations => {
	const { store, model, policy } = input
	const read: MemorySession.Operations["read"] = (session) =>
		store.read(session).pipe(Effect.map(stateOf))
	const consolidate: MemorySession.Operations["consolidate"] = (
		session,
		options,
	) =>
		Effect.gen(function* () {
			const view = yield* store.read(session),
				state = stateOf(view)
			const history = view.state.value.memory.history.filter(
				(entry) => !state.processed.includes(entry.id),
			)
			if (
				(options?.enabled ?? view.session.settings.memoryGenerationEnabled) ===
					false ||
				history.length === 0
			)
				return view
			const request = {
				state,
				history,
			}
			const extracted = yield* model.extract(request)
			const memory = yield* policy.apply({
				...request,
				changes: extracted.changes,
				now: yield* Clock.currentTimeMillis,
			})
			return (yield* store.modifyEffect({
				session,
				expectedHead: view.session.head,
				update: (current) =>
					Effect.succeed([
						undefined,
						Option.some({
							value: {
								...current.state.value,
								"@openbot-build/plugin-memory": memory,
							},
						}),
					] as const),
			})).view
		})
	const update: MemorySession.Operations["update"] = (base, command) =>
		store
			.modifyEffect({
				session: base.session,
				expectedHead: base.version,
				expectedRevision: base.revision,
				update: (view) =>
					Match.value(command).pipe(
						Match.tag("Configure", (command) =>
							Effect.succeed([
								undefined,
								Option.some({
									session: {
										settings: {
											...view.session.settings,
											memoryEnabled: command.use,
											memoryGenerationEnabled: command.generate,
										},
									},
								}),
							] as const),
						),
						Match.orElse((command) =>
							Effect.gen(function* () {
								const current = stateOf(view)
								const id = Item.Id.make(crypto.randomUUID()),
									now = yield* Clock.currentTimeMillis
								const previous = Record.get(current.entries, command.key)
								const entry = yield* Match.value(command).pipe(
									Match.tag("Remember", (command) =>
										Effect.succeed({
											key: command.key,
											content: command.content,
											kind: command.kind,
											sources: A.append(
												Option.match(previous, {
													onNone: () => [],
													onSome: (previous) => previous.sources,
												}),
												id,
											),
											updatedAt: now,
											status: "active" as const,
										}),
									),
									Match.tag("Forget", () =>
										Option.match(previous, {
											onNone: () =>
												Effect.fail(
													new Memory.MemoryError({
														reason: "invalid-change",
														message: "The memory key does not exist",
													}),
												),
											onSome: (previous) =>
												Effect.succeed({
													...previous,
													sources: A.append(previous.sources, id),
													updatedAt: now,
													status: "retracted" as const,
												}),
										}),
									),
									Match.exhaustive,
								)
								const memory = {
									...current,
									entries: { ...current.entries, [entry.key]: entry },
									processed: A.append(current.processed, id),
								}
								const evidence: Item.Record = {
									id,
									content: Prompt.make([
										{
											role: "user",
											content: `Explicit memory edit: ${JSON.stringify(command)}`,
										},
									]),
								}
								// Explicit edits are lasting evidence. They stay apart from generated model input.
								return [
									undefined,
									Option.some({
										value: {
											...view.state.value,
											"@openbot-build/plugin-memory": memory,
											memory: {
												...view.state.value.memory,
												history: A.append(
													view.state.value.memory.history,
													evidence,
												),
											},
										},
									}),
								] as const
							}),
						),
					),
			})
			.pipe(Effect.map((changed) => changed.view))
	return { read, consolidate, update }
}
