import { OpenBotApi, HealthApi } from "@openbot-build/api"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"

/** The handlers of the `health` group. The host mounts them itself. */
export const layerHealth = HttpApiBuilder.group(
	OpenBotApi,
	"health",
	(handlers) =>
		handlers
			.handle("getService", () => Effect.succeed(HealthApi.service))
			.handle("getHealth", () => Effect.succeed({ status: "ok" })),
)
