import { Chat } from "@openbot-build/core"
import { Host } from "@openbot-build/openbot"
import { BuiltinModels } from "@openbot-build/models-contract/BuiltinModels"
import * as HostTools from "@openbot-build/tools-contract/HostTools"
import { Effect, HashMap, Layer, Option, Ref } from "effect"
import * as DevelopmentModel from "@openbot-build/server-development/DevelopmentModel"
import {
	Scenarios,
	type Mode,
} from "@openbot-build/server-development/DevelopmentScenarios"
import { Business } from "@openbot-build/server-development/DevelopmentBusiness"
import { ownerKey } from "@openbot-build/apps-contract/apps/StoredConnections"
import { AppHost } from "@openbot-build/plugin-apps/AppHost"
import { PublicIndex } from "@openbot-build/plugin-apps/AppIndex"

/** Set a failure of the simulated App for the next request. */
export const setScenario = (mode: Mode) =>
	Effect.flatMap(Scenarios, (scenarios) => scenarios.set(mode))

/** Count real calls made to the simulated App for one member. */
export const executionCount = (member: {
	readonly userId: string
	readonly organizationId: string
}) =>
	Effect.flatMap(Business, (business) => business.executions(ownerKey(member)))

/** Use the fixed text model and the host tools of the development server. */
export const memoryModel = Effect.gen(function* () {
	const { builtinModels } = yield* DevelopmentModel.make
	return {
		model: yield* builtinModels.resolve(DevelopmentModel.selection),
		hostTools: DevelopmentModel.layerHostTools,
	}
})

/** The services of plugins that the App helpers of this module read. */
export const appServices = [AppHost, PublicIndex] as const

/** Read the public App list kept by the running host. */
export const searchPublicApps = Effect.flatMap(PublicIndex, (index) =>
	index.search({}),
)

/** Build a server whose confirmation tool counts calls for each Chat. */
export const layerWithConfirmation = (
	options: Host.Options,
	calls: Ref.Ref<HashMap.HashMap<Chat.Id, number>>,
) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const { builtinModels } = yield* DevelopmentModel.make
			return Host.layer({
				...options,
				outside: Layer.succeed(BuiltinModels, builtinModels),
				hostTools: HostTools.layer({
					toolkit: DevelopmentModel.toolkit,
					handlers: (chat) =>
						DevelopmentModel.toolkit.toLayer({
							DevelopmentConfirmation: ({ description }) =>
								Ref.update(calls, (current) =>
									HashMap.set(
										current,
										chat,
										Option.getOrElse(HashMap.get(current, chat), () => 0) + 1,
									),
								).pipe(Effect.as({ confirmed: `${chat}: ${description}` })),
						}),
				}),
			})
		}),
	)
