import * as DeveloperHandlers from "../apps/DeveloperHttpHandlers.ts"
import * as AppExperienceHandlers from "../apps/ExperienceHttpHandlers.ts"
import { PlatformApi, service } from "@openbot-build/platform-api"
import { Effect, Layer } from "effect"
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api"
import * as AppViewHandlers from "../apps/ViewHttpHandlers.ts"
import * as AppHandlers from "../apps/HttpHandlers.ts"
import * as AppOperationHandlers from "../apps/OperationHttpHandlers.ts"
import * as IndexHandlers from "../apps/IndexHttpHandlers.ts"
import * as AppAuthorizationHandlers from "../apps/AuthorizationHttpHandlers.ts"
import * as ConnectionHandlers from "../apps/ConnectionHttpHandlers.ts"
import * as SessionHandlers from "../sessions/SessionHandlers.ts"

const cloudHealth = HttpApiBuilder.group(PlatformApi, "health", (handlers) =>
	handlers
		.handle("getService", () => Effect.succeed(service))
		.handle("getHealth", () => Effect.succeed({ status: "ok" })),
)
export const layerPlatform = (publicOrigin: string) =>
	Layer.mergeAll(
		HttpApiBuilder.layer(PlatformApi, { openapiPath: "/openapi.json" }).pipe(
			Layer.provide(
				Layer.mergeAll(
					cloudHealth,
					DeveloperHandlers.layerPublic,
					DeveloperHandlers.layer,
					AppHandlers.layer,
					AppOperationHandlers.layer,
					AppViewHandlers.layer,
					AppExperienceHandlers.layer,
					IndexHandlers.layer,
					AppAuthorizationHandlers.layer(publicOrigin),
					ConnectionHandlers.layer,
					SessionHandlers.layerPlatform,
					SessionHandlers.layerPlatformApprovals,
				),
			),
		),
		HttpApiScalar.layer(PlatformApi, { path: "/docs" }),
	)
