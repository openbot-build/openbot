import { Identity, OpenBotApi } from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Experience } from "./Experience.ts"
export const layer = HttpApiBuilder.group(
	OpenBotApi,
	"appExperience",
	(handlers) =>
		Effect.gen(function* () {
			const experience = yield* Experience
			return handlers
				.handle("export", () =>
					Effect.flatMap(Identity, (identity) => experience.export(identity)),
				)
				.handle("import", ({ payload }) =>
					Effect.flatMap(Identity, (identity) =>
						experience.import(identity, payload),
					),
				)
				.handle("reset", () =>
					Effect.flatMap(Identity, (identity) => experience.reset(identity)),
				)
		}),
)
