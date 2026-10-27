import { ResetCommands } from "./ResetCommands.ts"
import * as HttpErrors from "../execution/HttpErrors.ts"
import { OpenBotApi } from "@openbot-build/api"

import { Identity } from "@openbot-build/domain"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Experience } from "./Experience.ts"
export const layer = HttpApiBuilder.group(
	OpenBotApi,
	"appExperience",
	(handlers) =>
		Effect.gen(function* () {
			const experience = yield* Experience
			const reset = yield* ResetCommands
			const safe = yield* HttpErrors.make
			return handlers
				.handle("export", () =>
					Effect.flatMap(Identity, (identity) => experience.export(identity)),
				)
				.handle("import", ({ payload }) =>
					Effect.flatMap(Identity, (identity) =>
						experience.import(identity, payload),
					),
				)
				.handle("reset", ({ payload }) =>
					Effect.flatMap(Identity, (identity) =>
						reset.start(identity, payload.commandKey),
					).pipe(safe),
				)
				.handle("getReset", ({ params }) =>
					Effect.flatMap(Identity, (identity) =>
						reset.get(identity, params.executionId),
					).pipe(safe),
				)
		}),
)
