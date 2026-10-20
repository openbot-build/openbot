import { PlatformApi } from "@openbot-build/platform-api"
import { HttpApiBuilder } from "effect/http-api"
import { discover } from "./Discovery.ts"

export const layer = HttpApiBuilder.group(PlatformApi, "apps", (handlers) =>
	handlers.handle("discoverApp", ({ payload }) => discover(payload.input)),
)
