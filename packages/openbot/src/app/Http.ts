import * as AccessHandlers from "../plugin-access/HttpHandlers.ts"
import * as ExecutionHandlers from "../server-execution/execution/HttpHandlers.ts"
import * as DeveloperHandlers from "../plugin-apps/DeveloperHttpHandlers.ts"
import * as AppExperienceHandlers from "../plugin-apps/ExperienceHttpHandlers.ts"
import { OpenBotApi, service } from "@openbot-build/api"

import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as HttpHost from "../server-kernel/errors/HttpHost.ts"
import * as AuthHandlers from "../plugin-auth/HttpHandlers.ts"
import * as AppViewHandlers from "../plugin-apps/ViewHttpHandlers.ts"
import * as AppHandlers from "../plugin-apps/HttpHandlers.ts"
import * as AppToolHandlers from "../plugin-apps/OperationHttpHandlers.ts"
import * as CodeRunHandlers from "../plugin-code/HttpHandlers.ts"
import * as IndexHandlers from "../plugin-apps/IndexHttpHandlers.ts"
import * as AppAuthorizationHandlers from "../plugin-apps/AuthorizationHttpHandlers.ts"
import * as ConnectionHandlers from "../plugin-apps/ConnectionHttpHandlers.ts"
import * as ChatHandlers from "../plugin-chats/ChatHandlers.ts"
import * as ToolHandlers from "../plugin-chats/ToolHttpHandlers.ts"
import * as LiveHandlers from "../plugin-chats/live/LiveHandlers.ts"
import * as DelegationHandlers from "../plugin-bots/DelegationHandlers.ts"
import * as BotHandlers from "../plugin-bots/HttpHandlers.ts"
import * as RequestHandlers from "../plugin-capabilities/HttpHandlers.ts"
import * as OrganizationHandlers from "../plugin-organization/HttpHandlers.ts"
import * as ModelProviderHandlers from "../plugin-models/HttpHandlers.ts"
import * as PlatformHandlers from "../plugin-platform/HttpHandlers.ts"
import * as SsoHandlers from "../plugin-sso/HttpHandlers.ts"
import * as SettingsHandlers from "../plugin-settings/HttpHandlers.ts"
import * as TriggerHandlers from "../plugin-triggers/HttpHandlers.ts"
import * as FileHandlers from "../plugin-files/HttpHandlers.ts"
import * as ChannelHandlers from "../plugin-channels/HttpHandlers.ts"
import * as ComputerHandlers from "../plugin-computers/HttpHandlers.ts"
import * as VaultHandlers from "../plugin-vaults/HttpHandlers.ts"
import * as BillingHandlers from "../plugin-billing/HttpHandlers.ts"

const health = HttpApiBuilder.group(OpenBotApi, "health", (handlers) =>
	handlers
		.handle("getService", () => Effect.succeed(service))
		.handle("getHealth", () => Effect.succeed({ status: "ok" })),
)
/** Mounts every group of the contract for the life of the server. The mounts follow the future plugins. */
export const layerGroups = Layer.effectDiscard(
	Effect.gen(function* () {
		const host = yield* HttpHost.HttpHost
		yield* Effect.all(
			[
				host.mount(["health"], health),
				host.mount(["executions"], ExecutionHandlers.layer),
				host.mount(
					["account", "userTokens", "signIn"],
					AuthHandlers.layerGroups,
				),
				host.mount(
					["access", "loginOptions", "emailSignIn"],
					AccessHandlers.layer,
				),
				host.mount(
					[
						"developerPublic",
						"developer",
						"apps",
						"appOperations",
						"appViews",
						"appExperience",
						"appIndex",
						"appAuthorization",
						"appAuthorizationPublic",
						"connections",
					],
					Layer.mergeAll(
						DeveloperHandlers.layerPublic,
						DeveloperHandlers.layer,
						AppHandlers.layer,
						AppToolHandlers.layer,
						AppViewHandlers.layer,
						AppExperienceHandlers.layer,
						IndexHandlers.layer,
						AppAuthorizationHandlers.layer,
						ConnectionHandlers.layer,
					),
				),
				host.mount(["codeRuns"], CodeRunHandlers.layer),
				host.mount(
					["chats", "toolCalls", "live"],
					Layer.mergeAll(
						ChatHandlers.layerPlatform,
						ToolHandlers.layer,
						LiveHandlers.layer,
					),
				),
				host.mount(
					["bots", "botInvitations", "delegations"],
					Layer.mergeAll(
						BotHandlers.layer,
						BotHandlers.layerInvitations,
						DelegationHandlers.layerPlatform,
					),
				),
				host.mount(["requests"], RequestHandlers.layer),
				host.mount(["memberSettings"], SettingsHandlers.layerMember),
				host.mount(
					["triggers", "triggerHooks"],
					Layer.merge(TriggerHandlers.layer, TriggerHandlers.layerHooks),
				),
				host.mount(["files"], FileHandlers.layer),
				host.mount(
					["channels", "channelLinks", "channelHooks"],
					Layer.mergeAll(
						ChannelHandlers.layer,
						ChannelHandlers.layerLinks,
						ChannelHandlers.layerHooks,
					),
				),
				host.mount(
					["computerProviders", "computers", "computerHooks"],
					Layer.mergeAll(
						ComputerHandlers.layerProviders,
						ComputerHandlers.layer,
						ComputerHandlers.layerHooks,
					),
				),
				host.mount(
					["secretProviders", "vaults"],
					Layer.merge(VaultHandlers.layerProviders, VaultHandlers.layer),
				),
				host.mount(["usage", "budgets"], BillingHandlers.layer),
				host.mount(
					["organization", "organizations"],
					OrganizationHandlers.layer,
				),
				host.mount(["modelProviders"], ModelProviderHandlers.layer),
				host.mount(["platform"], PlatformHandlers.layer),
				host.mount(["sso"], SsoHandlers.layer),
			],
			{ concurrency: "unbounded", discard: true },
		).pipe(
			// Each group has one mount in this list, so a conflict is a broken rule of the code.
			Effect.catchTag("MountConflict", Effect.die),
		)
	}),
)

/** Better Auth serves its own routes under `/auth`. A contract route always wins over them. */
export const layerBetterAuth = Layer.effectDiscard(
	Effect.flatMap(HttpHost.HttpHost, (host) =>
		host.mountRoutes("better-auth", AuthHandlers.layerBetterAuth),
	).pipe(
		// No other mount has this name, so a conflict is a broken rule of the code.
		Effect.catchTag("MountConflict", Effect.die),
	),
)
