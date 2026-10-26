import { OpenBotApi } from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { PublicIndex } from "./Index.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "appIndex", (handlers) =>
	Effect.gen(function* () {
		const index = yield* PublicIndex
		return handlers
			.handle("listSources", () => index.sources)
			.handle("searchApps", ({ query }) => index.search(query))
			.handle("getApp", ({ query }) => index.get(query.cardUrl, query.source))
	}),
)
