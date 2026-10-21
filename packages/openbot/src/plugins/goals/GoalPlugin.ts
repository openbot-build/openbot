import { Agent, Plugin } from "@openbot-build/core"
import { Prompt, Toolkit } from "effect/ai"
import { Effect, Match, Option, Predicate, Record } from "effect"
import {
	Definition,
	GoalError,
	State,
	type Value,
	pluginId,
	store,
	toolkit,
} from "./Goal.ts"

const plugin = Plugin.make({ id: pluginId, store })<
	Toolkit.Tools<typeof toolkit>
>(() =>
	Effect.succeed((next, options) =>
		next({
			...options,
			toolkit: Effect.map(options.toolkit, (current) =>
				Toolkit.merge(current, toolkit),
			),
			instructions: Prompt.concat(
				options.instructions,
				Prompt.make([
					{
						role: "system",
						content:
							"Use SetGoal, GetGoal, UpdateGoal, PauseGoal, ResumeGoal and ClearGoal when the user asks you to manage a persistent goal. Goals belong to the current Session. Changing a goal does not schedule any work, and it does not enforce token budgets.",
					},
				]),
			),
		}),
	),
)
export const make = () => plugin

/** The native handlers use the plugin's Session store and the current Turn context. */
export const layer = toolkit.toLayer(
	Effect.gen(function* () {
		const state = yield* plugin.store
		const failure = (error: { readonly _tag: string }) =>
			new GoalError({
				reason: Match.value(error).pipe(
					Match.when(
						{ _tag: "SessionNotFound" },
						() => "session-not-found" as const,
					),
					Match.orElse(() => "storage-failed" as const),
				),
				message: String(error),
			})
		const currentSession = Effect.flatMap(
			Agent.Context,
			(context) => context.at,
		).pipe(
			Effect.map((at) => at.session),
			Effect.mapError(failure),
		)
		const definition = (input: {
			readonly objective: string
			readonly tokenBudget?: number | undefined
		}) =>
			Definition.make({
				objective: input.objective,
				...Record.filter(
					{ tokenBudget: input.tokenBudget },
					Predicate.isNotUndefined,
				),
			})
		/** Change the existing goal. It fails when the Session has no goal. */
		const change = (f: (current: Value) => Value) =>
			Effect.gen(function* () {
				const session = yield* currentSession
				const value = yield* state
					.modifyEffect((current) =>
						Option.match(current, {
							onNone: () =>
								Effect.fail(
									new GoalError({
										reason: "goal-not-found",
										message: "The Session has no goal",
									}),
								),
							onSome: (current) => {
								const next = f(current)
								return Effect.succeed([next, Option.some(next)] as const)
							},
						}),
					)
					.pipe(
						Effect.mapError((error) =>
							error instanceof GoalError ? error : failure(error),
						),
					)
				return State.make({ session, ...value })
			})

		return toolkit.of({
			SetGoal: (input) =>
				Effect.gen(function* () {
					const session = yield* currentSession
					const value = {
						definition: definition(input),
						status: "active" as const,
						usedTokens: 0,
					}
					yield* state.set(Option.some(value)).pipe(Effect.mapError(failure))
					return State.make({ session, ...value })
				}),
			GetGoal: () =>
				Effect.gen(function* () {
					const session = yield* currentSession,
						value = yield* state.get.pipe(Effect.mapError(failure))
					// The tool result is JSON, so a missing goal is null.
					return Option.match(value, {
						onNone: () => null,
						onSome: (value) => State.make({ session, ...value }),
					})
				}),
			UpdateGoal: (input) =>
				change((current) => ({ ...current, definition: definition(input) })),
			PauseGoal: () =>
				change((current) => ({ ...current, status: "paused" as const })),
			ResumeGoal: () =>
				change((current) => ({ ...current, status: "active" as const })),
			ClearGoal: () =>
				state
					.set(Option.none())
					.pipe(Effect.mapError(failure), Effect.as(null)),
		})
	}),
)
