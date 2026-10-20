import { PlatformApi } from "@openbot-build/platform-api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { PublicIndex } from "./Index.ts"

export const layer = HttpApiBuilder.group(PlatformApi, "appIndex", (handlers) =>
	Effect.gen(function* () {
		const index = yield* PublicIndex
		return handlers
			.handle("listSources", () => Effect.succeed(index.sources))
			.handle("searchApps", ({ query }) => index.search(query))
			.handle("getApp", ({ query }) => index.get(query.cardUrl, query.source))
	}),
)
