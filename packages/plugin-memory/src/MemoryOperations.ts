import { Array as A, Clock, Effect, Match, Option } from "effect"
import { Item } from "@openbot-build/core"
import { Prompt } from "effect/ai"
import * as Memory from "./Memory.ts"
import type * as MemorySession from "./MemorySession.ts"

export const make = (input: {
	readonly store: MemorySession.Store
	readonly model: typeof Memory.MemoryModel.Service
	readonly policy: typeof Memory.MemoryPolicy.Service
}): MemorySession.Operations => {
	const { store, model, policy } = input
	const read: MemorySession.Operations["read"] = (session) =>
		store
			.read(session)
			.pipe(
				Effect.map(
					(view) =>
						view.state.value["@openbot-build/plugin-memory"] ?? Memory.empty(),
				),
			)
	const consolidate: MemorySession.Operations["consolidate"] = (
		session,
		options,
	) =>
		Effect.gen(function* () {
			const view = yield* store.read(session),
				state =
					view.state.value["@openbot-build/plugin-memory"] ?? Memory.empty()
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
		Effect.gen(function* () {
			const changed = yield* store.modifyEffect({
				session: base.session,
				expectedHead: base.version,
				expectedRevision: base.revision,
				update: (view) =>
					Effect.gen(function* () {
						const current =
							view.state.value["@openbot-build/plugin-memory"] ?? Memory.empty()
						return yield* Match.value(command).pipe(
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
									const id = Item.Id.make(crypto.randomUUID()),
										now = yield* Clock.currentTimeMillis
									const previous = current.entries[command.key]
									const entry = yield* Match.value(command).pipe(
										Match.tag("Remember", (command) =>
											Effect.succeed({
												key: command.key,
												content: command.content,
												kind: command.kind,
												sources: [...(previous?.sources ?? []), id],
												updatedAt: now,
												status: "active" as const,
											}),
										),
										Match.tag("Forget", () =>
											previous === undefined
												? Effect.fail(
														new Memory.MemoryError({
															reason: "invalid-change",
															message: "The memory key does not exist",
														}),
													)
												: Effect.succeed({
														...previous,
														sources: [...previous.sources, id],
														updatedAt: now,
														status: "retracted" as const,
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
						)
					}),
			})
			return changed.view
		})
	return { read, consolidate, update }
}
