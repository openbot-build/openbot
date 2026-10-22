import * as DeveloperHandlers from "../apps/DeveloperHttpHandlers.ts"
import * as AppExperienceHandlers from "../apps/ExperienceHttpHandlers.ts"
import { OpenBotApi, service } from "@openbot-build/api"
import { Effect, Layer } from "effect"
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api"
import * as AppViewHandlers from "../apps/ViewHttpHandlers.ts"
import * as AppHandlers from "../apps/HttpHandlers.ts"
import * as AppOperationHandlers from "../apps/OperationHttpHandlers.ts"
import * as IndexHandlers from "../apps/IndexHttpHandlers.ts"
import * as AppAuthorizationHandlers from "../apps/AuthorizationHttpHandlers.ts"
import * as ConnectionHandlers from "../apps/ConnectionHttpHandlers.ts"
import * as SessionHandlers from "../sessions/SessionHandlers.ts"
import * as AgentHandlers from "../agents/HttpHandlers.ts"
import * as RequestHandlers from "../capabilities/HttpHandlers.ts"
import * as OrganizationHandlers from "../organization/HttpHandlers.ts"
import * as ModelProviderHandlers from "../models/HttpHandlers.ts"
import * as PlatformHandlers from "../platform/HttpHandlers.ts"
import * as SsoHandlers from "../sso/HttpHandlers.ts"
import * as SettingsHandlers from "../settings/HttpHandlers.ts"
import * as TriggerHandlers from "../triggers/HttpHandlers.ts"

const cloudHealth = HttpApiBuilder.group(OpenBotApi, "health", (handlers) =>
	handlers
		.handle("getService", () => Effect.succeed(service))
		.handle("getHealth", () => Effect.succeed({ status: "ok" })),
)
export const layerPlatform = (publicOrigin: string) =>
	Layer.mergeAll(
		HttpApiBuilder.layer(OpenBotApi, { openapiPath: service.openapi }).pipe(
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
					AgentHandlers.layer,
					RequestHandlers.layer,
					SettingsHandlers.layerMember,
					TriggerHandlers.layer(publicOrigin),
					TriggerHandlers.layerHooks,
					OrganizationHandlers.layer,
					ModelProviderHandlers.layer,
					PlatformHandlers.layer,
					SsoHandlers.layer({ publicOrigin }),
				),
			),
		),
		HttpApiScalar.layer(OpenBotApi, { path: service.documentation }),
	)
