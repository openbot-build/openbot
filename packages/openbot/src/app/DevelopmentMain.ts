import { NodeRuntime } from "@effect/platform-node"
import { Settings as Api } from "@openbot-build/api"
import { Config, Effect, Layer } from "effect"
import * as EnvironmentConfiguration from "../configuration/EnvironmentConfiguration.ts"
import * as Development from "./Development.ts"
import * as ErrorReporting from "./ErrorReporting.ts"

NodeRuntime.runMain(
	ErrorReporting.withStartup(
		Effect.gen(function* () {
			const settings = yield* EnvironmentConfiguration.load
			// Only the development entry reads the origin from the environment.
			// It has one instance, and it writes the platform settings itself.
			const publicOrigin = yield* Config.schema(
				Api.PublicOrigin,
				"OPENBOT_DEV_PUBLIC_ORIGIN",
			)
			return yield* Layer.launch(
				Layer.effectDiscard(
					Effect.logInfo(
						`Development login: POST ${publicOrigin}/auth/development/sign-in`,
					),
				).pipe(
					Layer.provideMerge(
						Development.layer({
							...settings,
							auth: {
								mode: "development",
								publicOrigin,
								secret: Development.developmentSecret(settings.secretKeys),
							},
						}),
					),
				),
			)
		}),
	),
)
