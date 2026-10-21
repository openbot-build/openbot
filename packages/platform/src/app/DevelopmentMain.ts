import { NodeRuntime } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as Development from "./Development.ts"
import * as Entry from "./Entry.ts"

NodeRuntime.runMain(
	Entry.withErrorReporting(
		Effect.gen(function* () {
			const settings = yield* EnvironmentConfiguration.load
			return yield* Layer.launch(
				Layer.effectDiscard(
					Effect.logInfo(
						`Development login: POST ${settings.auth.publicOrigin}/auth/development/sign-in`,
					),
				).pipe(Layer.provideMerge(Development.layer(settings))),
			)
		}),
	),
)
