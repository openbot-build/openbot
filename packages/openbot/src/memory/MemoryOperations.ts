import { Array as A, Clock, Effect, Match, Option, Record } from "effect"
import { Item, type Session } from "@openbot-build/core"
import { Prompt } from "effect/ai"
import * as Memory from "./Memory.ts"
import * as MemoryConsolidation from "./MemoryConsolidation.ts"
import type * as MemorySession from "./MemorySession.ts"

/** The store field is optional. A Session without memory starts empty. */
const stateOf = (view: Session.View<Memory.Values>): Memory.State =>
	view.state.value[Memory.storeKey] ?? Memory.empty()

export const make = (input: {
	readonly store: MemorySession.Store
	readonly model: typeof Memory.MemoryModel.Service
	readonly policy: typeof Memory.MemoryPolicy.Service
}): MemorySession.Operations => {
	const { store, model, policy } = input
	const read: MemorySession.Operations["read"] = (session) =>
		store.read(session).pipe(Effect.map(stateOf))
	const consolidate: MemorySession.Operations["consolidate"] = (session) =>
		Effect.gen(function* () {
			const view = yield* store.read(session)
			const changed = yield* MemoryConsolidation.run({
				model,
				policy,
				state: stateOf(view),
				history: view.state.value.conversation.history,
				update: (apply) =>
					store
						.modifyEffect({
							session,
							update: (current) =>
								apply(stateOf(current)).pipe(
									Effect.map(
										(memory) =>
											[
												undefined,
												Option.some({
													value: {
														...current.state.value,
														[Memory.storeKey]: memory,
													},
												}),
											] as const,
									),
								),
						})
						.pipe(Effect.map((changed) => changed.view)),
			})
			return Option.getOrElse(changed, () => view)
		})
	const update: MemorySession.Operations["update"] = (base, command) =>
		store
			.modifyEffect({
				session: base.session,
				expectedHead: base.version,
				expectedRevision: base.revision,
				update: (view) =>
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
									[Memory.storeKey]: memory,
									conversation: {
										...view.state.value.conversation,
										history: A.append(
											view.state.value.conversation.history,
											evidence,
										),
									},
								},
							}),
						] as const
					}),
			})
			.pipe(Effect.map((changed) => changed.view))
	return { read, consolidate, update }
}
