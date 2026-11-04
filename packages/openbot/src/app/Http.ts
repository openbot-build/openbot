import * as ExecutionHandlers from "../server-execution/execution/HttpHandlers.ts"
import { OpenBotApi, service } from "@openbot-build/api"

import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as HttpHost from "../server-kernel/errors/HttpHost.ts"
import * as AccessMounts from "../plugin-access/HttpMounts.ts"
import * as AppsMounts from "../plugin-apps/HttpMounts.ts"
import * as AuthMounts from "../plugin-auth/HttpMounts.ts"
import * as BillingMounts from "../plugin-billing/HttpMounts.ts"
import * as BotsMounts from "../plugin-bots/HttpMounts.ts"
import * as CapabilitiesMounts from "../plugin-capabilities/HttpMounts.ts"
import * as ChannelsMounts from "../plugin-channels/HttpMounts.ts"
import * as ChatsMounts from "../plugin-chats/HttpMounts.ts"
import * as CodeMounts from "../plugin-code/HttpMounts.ts"
import * as ComputersMounts from "../plugin-computers/HttpMounts.ts"
import * as FilesMounts from "../plugin-files/HttpMounts.ts"
import * as ModelsMounts from "../plugin-models/HttpMounts.ts"
import * as OrganizationMounts from "../plugin-organization/HttpMounts.ts"
import * as PlatformMounts from "../plugin-platform/HttpMounts.ts"
import * as SettingsMounts from "../plugin-settings/HttpMounts.ts"
import * as SsoMounts from "../plugin-sso/HttpMounts.ts"
import * as TriggersMounts from "../plugin-triggers/HttpMounts.ts"
import * as VaultsMounts from "../plugin-vaults/HttpMounts.ts"

/** The handlers of the `health` group. The host mounts them itself. */
export const layerHealth = HttpApiBuilder.group(
	OpenBotApi,
	"health",
	(handlers) =>
		handlers
			.handle("getService", () => Effect.succeed(service))
			.handle("getHealth", () => Effect.succeed({ status: "ok" })),
)
/**
 * Mounts every group of the contract for the life of the server. Each plugin
 * folder gives the mounts of its groups.
 */
export const layerGroups = Layer.effectDiscard(
	Effect.gen(function* () {
		const host = yield* HttpHost.HttpHost
		yield* Effect.all(
			[
				host.mount(["health"], layerHealth),
				host.mount(["executions"], ExecutionHandlers.layer),
				AuthMounts.mount,
				AccessMounts.mount,
				AppsMounts.mount,
				CodeMounts.mount,
				ChatsMounts.mount,
				BotsMounts.mount,
				CapabilitiesMounts.mount,
				SettingsMounts.mount,
				TriggersMounts.mount,
				FilesMounts.mount,
				ChannelsMounts.mount,
				ComputersMounts.mount,
				VaultsMounts.mount,
				BillingMounts.mount,
				OrganizationMounts.mount,
				ModelsMounts.mount,
				PlatformMounts.mount,
				SsoMounts.mount,
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
	AuthMounts.mountBetterAuth.pipe(
		// No other mount has this name, so a conflict is a broken rule of the code.
		Effect.catchTag("MountConflict", Effect.die),
	),
)
