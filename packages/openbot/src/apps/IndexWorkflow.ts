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
import { Records } from "../errors/Records.ts"
import { Calls } from "../execution/Calls.ts"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence } from "../execution/Store.ts"
import {
	CheckInput,
	CheckResult,
	IndexWork,
	nextSignal,
	serviceId,
	workflowName,
} from "./IndexWork.ts"

export const workflow = Engine.define(workflowName)
const inputCodec = Schema.toCodecJson(CheckInput)
const resultCodec = Schema.toCodecJson(CheckResult)
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const index = yield* IndexWork
		const store = yield* Store
		const calls = yield* Calls
		const errors = yield* Records
		const registry = yield* Engine.Registry
		const run = yield* Program.make
		const work = (fence: Fence) =>
			Effect.gen(function* () {
				while (true) {
					const current = yield* index.load(fence)
					const generation = current.row.completedGeneration
					const delay =
						current.row.nextCheckAt - (yield* Clock.currentTimeMillis)
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
											errors.record(
												Redacted.value(cause),
												"external",
												fence.id,
											),
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
		return workflow
			.toLayer((key) => run(key, work))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(
						registry.registerService(workflow, serviceId, index.authorize),
					),
				),
			)
	}),
)
