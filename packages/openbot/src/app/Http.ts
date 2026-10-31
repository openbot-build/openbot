import * as AccessHandlers from "../access/HttpHandlers.ts"
import * as ExecutionHandlers from "../execution/HttpHandlers.ts"
import * as DeveloperHandlers from "../apps/DeveloperHttpHandlers.ts"
import * as AppExperienceHandlers from "../apps/ExperienceHttpHandlers.ts"
import { OpenBotApi, service } from "@openbot-build/api"

import { Effect, Layer } from "effect"
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api"
import * as AppViewHandlers from "../apps/ViewHttpHandlers.ts"
import * as AppHandlers from "../apps/HttpHandlers.ts"
import * as AppToolHandlers from "../apps/OperationHttpHandlers.ts"
import * as CodeRunHandlers from "../code/HttpHandlers.ts"
import * as IndexHandlers from "../apps/IndexHttpHandlers.ts"
import * as AppAuthorizationHandlers from "../apps/AuthorizationHttpHandlers.ts"
import * as ConnectionHandlers from "../apps/ConnectionHttpHandlers.ts"
import * as ChatHandlers from "../chats/ChatHandlers.ts"
import * as ToolHandlers from "../chats/ToolHttpHandlers.ts"
import * as LiveHandlers from "../chats/live/LiveHandlers.ts"
import * as DelegationHandlers from "../bots/DelegationHandlers.ts"
import * as BotHandlers from "../bots/HttpHandlers.ts"
import * as RequestHandlers from "../capabilities/HttpHandlers.ts"
import * as OrganizationHandlers from "../organization/HttpHandlers.ts"
import * as ModelProviderHandlers from "../models/HttpHandlers.ts"
import * as PlatformHandlers from "../platform/HttpHandlers.ts"
import * as SsoHandlers from "../sso/HttpHandlers.ts"
import * as SettingsHandlers from "../settings/HttpHandlers.ts"
import * as TriggerHandlers from "../triggers/HttpHandlers.ts"
import * as FileHandlers from "../files/HttpHandlers.ts"
import * as ArtifactHandlers from "../artifacts/HttpHandlers.ts"
import * as ChannelHandlers from "../channels/HttpHandlers.ts"
import * as ComputerHandlers from "../computers/HttpHandlers.ts"
import * as VaultHandlers from "../vaults/HttpHandlers.ts"
import * as BillingHandlers from "../billing/HttpHandlers.ts"

const health = HttpApiBuilder.group(OpenBotApi, "health", (handlers) =>
	handlers
		.handle("getService", () => Effect.succeed(service))
		.handle("getHealth", () => Effect.succeed({ status: "ok" })),
)
/** The OpenBot API and its documentation page. */
export const layerPlatform = Layer.mergeAll(
	HttpApiBuilder.layer(OpenBotApi, { openapiPath: service.openapi }).pipe(
		Layer.provide(
			Layer.mergeAll(
				health,
				DeveloperHandlers.layerPublic,
				DeveloperHandlers.layer,
				AppHandlers.layer,
				AppToolHandlers.layer,
				CodeRunHandlers.layer,
				AppViewHandlers.layer,
				AppExperienceHandlers.layer,
				IndexHandlers.layer,
				AppAuthorizationHandlers.layer,
				ConnectionHandlers.layer,
				ChatHandlers.layerPlatform,
				ToolHandlers.layer,
				ExecutionHandlers.layer,
				LiveHandlers.layer,
				DelegationHandlers.layerPlatform,
				BotHandlers.layer,
				BotHandlers.layerInvitations,
				RequestHandlers.layer,
				SettingsHandlers.layerMember,
				TriggerHandlers.layer,
				FileHandlers.layer,
				ArtifactHandlers.layer,
				TriggerHandlers.layerHooks,
				ChannelHandlers.layer,
				ChannelHandlers.layerLinks,
				ChannelHandlers.layerHooks,
				ComputerHandlers.layerProviders,
				ComputerHandlers.layer,
				ComputerHandlers.layerHooks,
				VaultHandlers.layerProviders,
				VaultHandlers.layer,
				BillingHandlers.layer,
				OrganizationHandlers.layer,
				ModelProviderHandlers.layer,
				PlatformHandlers.layer,
				AccessHandlers.layer,
				SsoHandlers.layer,
			),
		),
	),
	HttpApiScalar.layer(OpenBotApi, { path: service.documentation }),
)
