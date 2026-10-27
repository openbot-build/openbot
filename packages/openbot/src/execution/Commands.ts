import { type Caller, Execution } from "@openbot-build/domain"
import { Array as Arr, Context, Effect, Layer, Option, Stream } from "effect"
import { Store } from "./Store.ts"
import { Registry, type Access } from "./Engine.ts"
import { Observation } from "./Observation.ts"

const make = Effect.gen(function* () {
	const store = yield* Store
	const registry = yield* Registry
	const observation = yield* Observation
	/** Every entry point uses the feature's current resource and permission checks. */
	const check = Effect.fn("ExecutionCommands.check")(function* (
		id: Execution.Id,
		actor: Caller,
		access: Access,
	) {
		const key = yield* store.locate(id, actor.organizationId)
		const execution = yield* store.load(key)
		const feature = yield* registry.get(execution.workflow)
		if (Option.isNone(feature)) return yield* Execution.Forbidden.make({})
		yield* feature.value.authorize(key, actor, access)
		return key
	})
	const get = Effect.fn("ExecutionCommands.get")(function* (
		id: Execution.Id,
		actor: Caller,
	) {
		return yield* store.get(yield* check(id, actor, "read"))
	})
	const events = Effect.fn("ExecutionCommands.events")(function* (
		id: Execution.Id,
		actor: Caller,
		afterSequence: number,
	) {
		const key = yield* check(id, actor, "read")
		const events = yield* store.events(key, afterSequence)
		const cursor = Option.getOrElse(
			Option.map(Arr.last(events), (event) => event.sequence),
			() => afterSequence,
		)
		const state = yield* store.get(key)
		return {
			events,
			afterSequence: cursor,
			terminal: Execution.isTerminal(state.status) && cursor >= state.sequence,
		}
	})
	const observe = (id: Execution.Id, actor: Caller, afterSequence: number) =>
		Stream.unwrap(
			Effect.map(check(id, actor, "read"), (key) =>
				observation.observe(key, afterSequence).pipe(
					// A permission revoked during a stream stops further output.
					Stream.tap(() => check(id, actor, "read")),
				),
			),
		)
	const cancel = Effect.fn("ExecutionCommands.cancel")(function* (
		id: Execution.Id,
		actor: Caller,
		commandKey: Execution.CommandKey,
	) {
		return yield* store.cancel(
			yield* check(id, actor, "cancel"),
			commandKey,
			actor,
		)
	})
	const decide = Effect.fn("ExecutionCommands.decide")(function* (
		id: Execution.Id,
		actor: Caller,
		input: {
			readonly commandKey: Execution.CommandKey
			readonly decisionId: string
			readonly answer: Execution.Answer
		},
	) {
		const key = yield* check(id, actor, "decide")
		const execution = yield* store.load(key)
		const feature = yield* registry.get(execution.workflow)
		if (Option.isNone(feature)) return yield* Execution.Forbidden.make({})
		return yield* feature.value.decide === undefined
			? store.decide(
					key,
					input.commandKey,
					input.decisionId,
					input.answer,
					actor,
				)
			: feature.value.decide(key, actor, input)
	})
	return { get, events, observe, cancel, decide }
})
export class Commands extends Context.Service<
	Commands,
	Effect.Success<typeof make>
>()("@openbot-build/openbot/execution/Commands") {}
export const layer = Layer.effect(Commands, make)
