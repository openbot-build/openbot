import { AppIndex } from "@openbot-build/domain"
import { Client } from "@openbot-build/protocol"
import {
	Array as Arr,
	Cause,
	Clock,
	Effect,
	Layer,
	Option,
	Ref,
	Redacted,
	Schema,
} from "effect"
import { DurableClock, DurableDeferred } from "effect/workflow"
import { Records } from "@openbot-build/server-kernel/errors/Records"
import { Calls } from "@openbot-build/server-execution/execution/Calls"
import * as Engine from "@openbot-build/server-execution/execution/Engine"
import {
	Policy,
	Workflows,
} from "@openbot-build/server-execution/execution/Workflows"
import * as Program from "@openbot-build/server-execution/execution/Program"
import {
	Store,
	type Fence,
} from "@openbot-build/server-execution/execution/Store"
import {
	CheckInput,
	CheckResult,
	IndexWork,
} from "../apps-contract/apps/IndexWork.ts"
import { nextSignal, serviceId, workflowName } from "./IndexWork.ts"

export const workflow = Engine.define(workflowName)
const inputCodec = Schema.toCodecJson(CheckInput)
const resultCodec = Schema.toCodecJson(CheckResult)
/** Adds the workflow and its access rules. When the scope closes, they go. */
export const contribute = Effect.gen(function* () {
	const index = yield* IndexWork
	const store = yield* Store
	const calls = yield* Calls
	const errors = yield* Records
	const workflows = yield* Workflows
	const run = yield* Program.make
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			while (true) {
				const current = yield* index.load(fence)
				const generation = current.row.completedGeneration
				const delay = current.row.nextCheckAt - (yield* Clock.currentTimeMillis)
				if (
					generation !== null &&
					generation === current.row.generation &&
					delay > 0
				) {
					if (current.saved.record.status !== "waiting")
						yield* store.commit(fence, { status: "waiting" }, Effect.void)
					yield* DurableDeferred.raceAll({
						name: `next:${generation}`,
						success: Schema.Void,
						error: Schema.Never,
						effects: [
							DurableDeferred.await(Engine.signal(nextSignal(generation))),
							DurableClock.sleep({
								name: `due:${generation}`,
								duration: delay,
								inMemoryThreshold: 0,
							}),
						],
					})
				}
				const next = yield* index.begin(fence)
				const step = `check:${next.generation}`
				const prior = Arr.findFirst(
					yield* store.calls(fence),
					(call) => call.step === step,
				)
				const body = Option.isSome(prior)
					? prior.value.input
					: yield* Schema.encodeEffect(inputCodec)(next.input)
				const input = yield* Schema.decodeEffect(inputCodec)(body)
				const call = yield* store.readAttempt(fence, step, body)
				const restriction = yield* Ref.make<
					Option.Option<AppIndex.Restriction>
				>(Option.none())
				const result = yield* calls.invoke(
					fence,
					call,
					() =>
						Ref.get(restriction).pipe(
							Effect.flatMap((value) => index.inspect(input, value)),
							Effect.timeout("4 minutes"),
							Effect.tap((result) =>
								Option.match(Client.errorCause(result), {
									onNone: () => Effect.void,
									onSome: (cause) =>
										errors.record(Redacted.value(cause), "external", fence.id),
								}),
							),
							Effect.map((result): CheckResult => ({
								_tag: "Checked",
								result,
							})),
							Effect.catchCauseIf(
								(cause) => !Cause.hasInterrupts(cause),
								(cause) =>
									errors.record(cause, "external", fence.id).pipe(
										Effect.map((failure): CheckResult => ({
											_tag: "Failed",
											failure,
										})),
									),
							),
							Effect.flatMap(Schema.encodeEffect(resultCodec)),
						),
					index
						.restriction(input.cardUrl)
						.pipe(Effect.flatMap((value) => Ref.set(restriction, value))),
				)
				if (result._tag === "Unknown") return
				yield* index.complete(
					fence,
					next.generation,
					yield* Schema.decodeEffect(resultCodec)(result.result),
				)
			}
		})
	yield* workflows.contribute({
		workflow,
		plugin: "apps",
		journal: 1,
		run: (key) => run(key, work),
		policy: Policy.Service({
			serviceId: serviceId,
			authorize: index.authorize,
		}),
	})
})

export const layer = Layer.effectDiscard(contribute)
