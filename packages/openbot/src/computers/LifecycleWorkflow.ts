import { Computers as ComputerData } from "@openbot-build/domain"
import { Effect, Layer, Option, Schema } from "effect"
import { WorkAdmission } from "../chats/WorkAdmission.ts"
import { Calls } from "../execution/Calls.ts"
import * as Engine from "../execution/Engine.ts"
import * as Program from "../execution/Program.ts"
import { Store, type Fence } from "../execution/Store.ts"
import { workflowName } from "./Activity.ts"
import type { ComputerError } from "./Computer.ts"
import { ComputerProviders } from "./ComputerProviders.ts"
import { Drivers } from "./Drivers.ts"
import { Lifecycle, Result } from "./Lifecycle.ts"
import { Connectors } from "./connector/Connectors.ts"

export const workflow = Engine.define(workflowName)
/** Only the workflow can write provider lifecycle results into Computer state. */
export const make = Effect.gen(function* () {
	const lifecycle = yield* Lifecycle
	const providers = yield* ComputerProviders
	const drivers = yield* Drivers
	const connectors = yield* Connectors
	const calls = yield* Calls
	const store = yield* Store
	const work = (fence: Fence) =>
		Effect.gen(function* () {
			const { saved, input } = yield* lifecycle.load(fence)
			yield* lifecycle.authorize(fence, saved.identity.actor, "advance")
			const computer = input.computer
			const action = input.action
			if (computer.source === "connector" && action._tag === "Create")
				return yield* lifecycle.complete(fence, { ref: null })
			const attempt = yield* store.writeAttempt(
				fence,
				action._tag,
				{ computer: computer.id },
				computer.source === "connector" ? "idempotent" : "never",
			)
			// Preparation reads provider data. It must finish before the send record changes.
			const prepare = yield* Effect.cached(
				Effect.gen(function* () {
					if (computer.source === "connector")
						return {
							send: connectors
								.close(fence.namespace, computer.id)
								.pipe(Effect.as({ ref: null })),
						}
					if (computer.providerId === null)
						return yield* ComputerData.ComputerNotReady.make({
							state: "failed",
						})
					const { credentials } = yield* providers.credentials(
						fence.namespace,
						computer.providerId,
					)
					const provider = yield* drivers.make(credentials)
					if (action._tag === "Create") {
						const source = action.request.source
						if (source._tag !== "Provider")
							return yield* Effect.die(
								"A provider Computer needs a provider source.",
							)
						return {
							send: provider.create({
								...(source.template === null
									? {}
									: { template: source.template }),
								desktop: action.request.desktop === true,
								labels: {
									openbot_computer: computer.id,
									openbot_organization: fence.namespace,
								},
							}),
						}
					}
					if (computer.ref === null) {
						if (action._tag === "Remove")
							return { send: Effect.succeed({ ref: null }) }
						return yield* ComputerData.ComputerNotReady.make({
							state: "failed",
						})
					}
					const machine = yield* provider.attach(computer.ref).pipe(
						Effect.asSome,
						Effect.catchTag("ComputerGone", (error) =>
							action._tag === "Remove"
								? Effect.succeedNone
								: Effect.fail(error),
						),
					)
					if (Option.isNone(machine))
						return { send: Effect.succeed({ ref: computer.ref }) }
					if (action._tag === "Remove")
						return {
							send: machine.value.destroy.pipe(
								Effect.as({ ref: computer.ref }),
							),
						}
					if (machine.value.pausable === undefined)
						return yield* ComputerData.ComputerUnsupported.make({
							feature: "pause",
						})
					return {
						send: (action._tag === "Pause"
							? machine.value.pausable.pause
							: machine.value.pausable.resume
						).pipe(Effect.as({ ref: computer.ref })),
					}
				}),
			)
			// Replayed results and unknown sends never open a new provider connection.
			const result = yield* calls.invoke(
				fence,
				{
					...attempt,
					onResult: (_, value) => lifecycle.remember(fence, value),
				},
				() =>
					prepare.pipe(
						Effect.flatMap(
							({ send }): Effect.Effect<typeof Result.Type, ComputerError> =>
								send,
						),
						Effect.flatMap(Schema.encodeEffect(Result)),
					),
				Effect.asVoid(prepare),
			)
			if (result._tag === "Completed")
				yield* lifecycle.complete(fence, result.result)
		})
	return work
})
export const layer = Layer.unwrap(
	Effect.gen(function* () {
		const work = yield* make
		const lifecycle = yield* Lifecycle
		const registry = yield* Engine.Registry
		const admission = yield* WorkAdmission
		const run = yield* Program.make
		return workflow
			.toLayer((key) => run(key, work, lifecycle.finish))
			.pipe(
				Layer.provideMerge(
					Layer.effectDiscard(
						registry.register(
							workflow,
							lifecycle.authorize,
							undefined,
							admission.check,
						),
					),
				),
			)
	}),
)
