import { OpenBotApi } from "@openbot-build/api"
import { HttpApiBuilder } from "effect/http-api"
import { discover } from "./Discovery.ts"

export const layer = HttpApiBuilder.group(OpenBotApi, "apps", (handlers) =>
	handlers.handle("discoverApp", ({ payload }) => discover(payload.input)),
)
