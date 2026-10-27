import { Chat } from "@openbot-build/core"
import { HostTools, OpenBot, Server } from "@openbot-build/openbot"
import { Effect, HashMap, Layer, Option, Ref } from "effect"
import * as DevelopmentModel from "../../src/app/DevelopmentModel.ts"
import { Scenarios, type Mode } from "../../src/app/DevelopmentScenarios.ts"
import { Business } from "../../src/app/DevelopmentBusiness.ts"
import { ownerKey } from "../../src/apps/StoredConnections.ts"
import { PublicIndex } from "../../src/apps/Index.ts"

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

/** Read the public App list kept by the running host. */
export const searchPublicApps = Effect.flatMap(PublicIndex, (index) =>
	index.search({}),
)

/** Build a server whose confirmation tool counts calls for each Chat. */
export const layerWithConfirmation = (
	options: Parameters<typeof Server.layerFixed>[0] &
		Parameters<typeof OpenBot.layerShared>[0],
	calls: Ref.Ref<HashMap.HashMap<Chat.Id, number>>,
) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const { builtinModels } = yield* DevelopmentModel.make
			return Server.layerFixed({ ...options, builtinModels }).pipe(
				Layer.provide(
					Layer.merge(
						OpenBot.layerOutside,
						HostTools.layer({
							toolkit: DevelopmentModel.toolkit,
							handlers: (chat) =>
								DevelopmentModel.toolkit.toLayer({
									DevelopmentConfirmation: ({ description }) =>
										Ref.update(calls, (current) =>
											HashMap.set(
												current,
												chat,
												Option.getOrElse(HashMap.get(current, chat), () => 0) +
													1,
											),
										).pipe(Effect.as({ confirmed: `${chat}: ${description}` })),
								}),
						}),
					),
				),
				Layer.provideMerge(OpenBot.layerShared(options)),
			)
		}),
	)
