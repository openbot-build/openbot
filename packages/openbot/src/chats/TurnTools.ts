import type { Paused } from "../execution/Admission.ts"
import { type Developers, Execution } from "@openbot-build/domain"
import type { CallContext } from "../execution/CallContext.ts"
import * as DecisionWait from "../execution/DecisionWait.ts"
import * as ToolDefinitions from "./ToolDefinitions.ts"
import {
	Operation,
	type Operations,
	type ToolStep,
	type ModelStep,
	Turn,
} from "@openbot-build/core"
import {
	Array as Arr,
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Queue,
	Schema,
	Stream,
} from "effect"
import { Response, type Prompt, type Tool } from "effect/ai"
import * as Db from "../database/Database.ts"
import { Calls } from "../execution/Calls.ts"
import { Observation } from "../execution/Observation.ts"
import { Store, storage, type Fence } from "../execution/Store.ts"
import * as ToolResults from "./ToolResults.ts"
import * as StoredChats from "./StoredChats.ts"
import { ToolCommands } from "./ToolCommands.ts"
import { ToolSteps, beforeSend, outputCodec, stepId } from "./ToolSteps.ts"

type Part = Response.StreamPart<Record<string, Tool.Any>>
const outputPart = (output: typeof outputCodec.Type): Part =>
	Response.makePart("tool-result", {
		...output,
		result: output.result,
		encodedResult: output.result,
		providerExecuted: false,
	})
export interface Service {
	readonly executor: (
		parent: Fence,
		settings: Operations.Settings,
	) => ToolStep.Executor<
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.OutcomeUnknown
		| Paused
		| Developers.StorageFailure
		| Execution.Failure
	>
	readonly run: <Tools extends Record<string, Tool.Any>>(
		parent: Fence,
		position: ModelStep.Position,
		input: ToolStep.Input<Tools>,
		settings: Operations.Settings,
		publish: (part: Part) => Effect.Effect<void>,
	) => Effect.Effect<
		void,
		| Execution.Conflict
		| Execution.Forbidden
		| Execution.KeyConflict
		| Execution.NotFound
		| Execution.OutcomeUnknown
		| Paused
		| Developers.StorageFailure
		| Execution.Failure,
		Exclude<
			Exclude<Tool.HandlerServices<Tools[keyof Tools]>, CallContext>,
			never
		>
	>
}

export class TurnTools extends Context.Service<TurnTools, Service>()(
	"@openbot-build/openbot/chats/TurnTools",
) {}

const make = Effect.gen(function* () {
	const db = yield* Db.make
	const tools = yield* ToolCommands
	const steps = yield* ToolSteps
	const calls = yield* Calls
	const store = yield* Store
	const observation = yield* Observation
	const decisionWait = yield* DecisionWait.make
	const route = Effect.fn("TurnTools.route")(function* (
		parent: Fence,
		position: ModelStep.Position,
		call: Prompt.ToolCallPart,
	) {
		yield* calls.authorize(parent, "replay")
		const child = Arr.findFirst(
			yield* tools.list(parent.namespace, position.chat),
			(record) =>
				record.parentExecutionId === parent.id &&
				record.position.item === position.item &&
				record.callId === call.id,
		)
		const prior = Option.isSome(
			yield* store.latestCall(parent, stepId(position.item, call.id)),
		)
		if (Option.isSome(child) && prior)
			return yield* Execution.Conflict.make({ id: parent.id })
		return { child, prior }
	})
	const run = Effect.fn("TurnTools.run")(function* <
		Tools extends Record<string, Tool.Any>,
	>(
		parent: Fence,
		position: ModelStep.Position,
		input: ToolStep.Input<Tools>,
		settings: Operations.Settings,
		publish: (part: Part) => Effect.Effect<void>,
	) {
		const { child, prior } = yield* route(parent, position, input.call)
		const tool = input.toolkit.tools[input.call.name]
		const definition = Option.isSome(child)
			? (yield* tools.load({
					namespace: parent.namespace,
					id: child.value.executionId,
				})).input.definition
			: Option.getOrUndefined(
					yield* ToolDefinitions.selected(
						store,
						parent,
						position,
						input.call.name,
						tool,
					),
				)
		if (!prior && Option.isNone(child) && definition === undefined)
			return yield* publish(
				outputPart({
					id: input.call.id,
					name: input.call.name,
					result: { error: "The tool was not in the model request" },
					isFailure: true,
					preliminary: false,
				}),
			)
		const budget =
			definition === undefined
				? tool === undefined
					? undefined
					: Option.getOrUndefined(
							Context.getOption(tool.annotations, Operation.Budget),
						)
				: definition.budgetMs === null
					? "foreground"
					: definition.budgetMs

		// The first stored call fixes its route. A tool annotation can change after a restart.
		if (prior || (Option.isNone(child) && budget === "foreground")) {
			const saved = yield* steps.saved(parent, position, input.call)
			if (Option.isSome(saved))
				return yield* publish(
					outputPart(yield* Schema.decodeEffect(outputCodec)(saved.value)),
				)
			if (tool === undefined)
				return yield* Execution.Conflict.make({ id: parent.id })
			const view = yield* StoredChats.ref(
				db,
				parent.namespace,
				position.chat,
			).pipe(storage)
			const turn = Option.isSome(view) ? view.value.turn : undefined
			if (
				turn?.id !== position.turn ||
				turn.pendingStep?.item !== position.item
			)
				return yield* Execution.Conflict.make({ id: parent.id })
			return yield* steps
				.run(
					parent,
					position,
					input,
					publish,
					beforeSend(tool, input.call, Turn.stepPrompt(turn.pendingStep)),
					definition,
				)
				.pipe(Effect.asVoid)
		}

		const submitted = yield* tools.submit(
			parent,
			position,
			input.call,
			settings,
			budget,
			definition,
		)
		const key = { namespace: parent.namespace, id: submitted.executionId }
		const saved = yield* tools.load(key)
		// A saved move to the background has the same answer even after the child ends.
		if (saved.record.detached)
			return yield* publish(
				outputPart(
					yield* ToolResults.output({ ...saved.record, calls: [] }, input.call),
				),
			)
		let cursor = 0
		const observe = (after: number) =>
			observation.observe(key, after).pipe(
				Stream.runForEach((event) =>
					Effect.gen(function* () {
						yield* calls.authorize(key, "replay")
						cursor = event.sequence
						if (event.body._tag !== "ToolOutput") return
						const output = yield* Schema.decodeEffect(outputCodec)(
							event.body.output,
						)
						if (output.id !== input.call.id || output.name !== input.call.name)
							return yield* Execution.Conflict.make({ id: key.id })
						// The final result waits for the child scope to close and its terminal commit.
						if (output.preliminary) yield* publish(outputPart(output))
					}),
				),
			)
		const wait = (after: number) =>
			Effect.raceFirst(
				observe(after),
				decisionWait(key).pipe(
					Stream.mapEffect((waiting) => tools.detach(parent, key.id, waiting)),
					Stream.filter((record) => record.detached),
					Stream.runHead,
					Effect.flatMap(
						Option.match({
							onNone: () => Effect.never,
							onSome: () => Effect.void,
						}),
					),
				),
			)
		const remaining =
			saved.input.budgetMs === null
				? undefined
				: saved.record.startedAt +
					saved.input.budgetMs -
					(yield* Clock.currentTimeMillis)
		if (remaining !== undefined && !Execution.isTerminal(saved.record.status)) {
			// This timer only ends this Turn's wait. The accepted time and detach decision are stored.
			const ended =
				remaining <= 0
					? Option.none()
					: yield* wait(cursor).pipe(Effect.timeoutOption(remaining))
			if (Option.isNone(ended)) {
				const moved = yield* tools.detach(parent, key.id)
				if (moved.detached)
					return yield* publish(
						outputPart(
							yield* ToolResults.output({ ...moved, calls: [] }, input.call),
						),
					)
				// All background slots may be in use. Keep observing without a second polling loop.
				if (!Execution.isTerminal(moved.status)) yield* wait(cursor)
			}
		} else {
			yield* wait(cursor)
		}
		yield* calls.authorize(key, "replay")
		const ended = (yield* tools.load(key)).record
		yield* publish(
			outputPart(
				yield* ToolResults.output(
					{
						...ended,
						calls: ended.detached ? [] : yield* store.calls(key),
					},
					input.call,
				),
			),
		)
	})
	const executor = (
		parent: Fence,
		settings: Operations.Settings,
	): ToolStep.Executor<Effect.Error<ReturnType<typeof run>>> => {
		const stream: ToolStep.Run<Effect.Error<ReturnType<typeof run>>> = (
			position,
			input,
		) =>
			Stream.callback(
				(queue) =>
					run(parent, position, input, settings, (part) =>
						Queue.offer(queue, part).pipe(Effect.asVoid),
					).pipe(Effect.andThen(Queue.end(queue))),
				{ bufferSize: 128 },
			)
		return {
			run: stream,
			resume: (position, input) =>
				Effect.gen(function* () {
					const { child, prior } = yield* route(parent, position, input.call)
					if (prior || Option.isSome(child))
						return Option.some(stream(position, input))
					const selected = yield* ToolDefinitions.selected(
						store,
						parent,
						position,
						input.call.name,
					)
					return Option.exists(
						selected,
						(tool) => tool.local && tool.inputState !== undefined,
					)
						? Option.some(stream(position, input))
						: Option.none()
				}),
		}
	}

	return TurnTools.of({ executor, run })
})

/** A Turn waits on the same saved event stream as any other observer. */

export const layer = Layer.effect(TurnTools, make)
