import type { ServiceId } from "@openbot-build/domain/Identity"
import { Effect, HashMap, Layer, Option, Stream } from "effect"
import type * as Admission from "@openbot-build/server-execution/Admission"
import type * as Engine from "@openbot-build/server-execution/Engine"
import type { Key } from "@openbot-build/server-execution/Store"
import * as Workflows from "@openbot-build/server-execution/Workflows"

const { Policy } = Workflows

/** A test policy has no handler. A test that runs the workflow hosts its own. */
const contribute = (
	workflow: ReturnType<typeof Engine.define>,
	policy: Workflows.Policy,
) =>
	Effect.flatMap(Workflows.Workflows, (workflows) =>
		workflows.contribute({
			workflow,
			plugin: "test",
			journal: 1,
			run: () => Effect.die("This test hosts no handler."),
			policy,
		}),
	).pipe(Effect.orDie)

/** Adds the access rules of a public workflow while the scope is open. */
export const register = (
	workflow: ReturnType<typeof Engine.define>,
	authorize: Engine.Authorize,
	decide?: Engine.Decide,
	admit?: Admission.Check,
) =>
	contribute(
		workflow,
		Policy.Public({
			authorize,
			...(decide === undefined ? {} : { decide }),
			...(admit === undefined ? {} : { admit }),
		}),
	)

/** Adds the access rules of a service workflow while the scope is open. */
export const registerService = (
	workflow: ReturnType<typeof Engine.define>,
	serviceId: ServiceId,
	authorize: (key: Key, access: Engine.Access) => ReturnType<Engine.Authorize>,
	admit?: Admission.Check,
	publicRead?: Engine.Authorize,
	publicDecision?: {
		readonly authorize: Engine.Authorize
		readonly decide: Engine.Decide
	},
) =>
	contribute(
		workflow,
		Policy.Service({
			serviceId,
			authorize,
			...(admit === undefined ? {} : { admit }),
			...(publicRead === undefined ? {} : { publicRead }),
			...(publicDecision === undefined ? {} : { publicDecision }),
		}),
	)

/**
 * A fixed Workflows service for tests that need only access rules. `require`
 * follows `get`, and the other parts hold nothing.
 */
export const stub = (input: {
	readonly get: Workflows.Service["get"]
	readonly names?: Workflows.Service["names"]
}) =>
	Workflows.Workflows.of({
		contribute: () => Effect.void,
		get: input.get,
		require: (name) =>
			Effect.flatMap(
				input.get(name),
				Option.match({
					onNone: () =>
						Effect.fail(
							Workflows.Unavailable.make({ workflow: name, feature: name }),
						),
					onSome: Effect.succeed,
				}),
			),
		names: input.names ?? Effect.succeed([]),
		current: Effect.succeed(HashMap.empty()),
		seal: Effect.succeed(HashMap.empty()),
		hold: () => Effect.void,
		changes: Stream.make(HashMap.empty()),
		acquire: Effect.succeed(HashMap.empty()),
	})

/** A layer of `stub`. */
export const layerStub = (input: Parameters<typeof stub>[0]) =>
	Layer.succeed(Workflows.Workflows, stub(input))
