import { DeveloperApi, DeveloperPublicApi } from "./DeveloperApi.ts"
import { AppExperienceApi } from "./AppExperienceApi.ts"
import { ConnectionsApi } from "./ConnectionsApi.ts"
import { HttpApi, OpenApi } from "effect/http-api"
import { ChatsApi } from "./ChatsApi.ts"
import { DelegationsApi } from "./DelegationsApi.ts"
import { HealthApi } from "./HealthApi.ts"
import { AccountApi, BotAuth, SignInApi } from "./AuthApi.ts"
import { UserTokensApi } from "./UserTokensApi.ts"
import { OrganizationApi, OrganizationsApi } from "./OrganizationApi.ts"
import { ModelProvidersApi } from "./ModelProvidersApi.ts"
import { SsoApi } from "./SsoApi.ts"
import { PlatformApi } from "./PlatformApi.ts"
import { AppsApi } from "./AppsApi.ts"
import { AppIndexApi } from "./AppIndexApi.ts"
import {
	AppAuthorizationApi,
	AppAuthorizationPublicApi,
} from "./AppAuthorizationApi.ts"
import { BotInvitationsApi, BotsApi } from "./BotsApi.ts"
import { RequestsApi } from "./RequestsApi.ts"
import { MemberSettingsApi } from "./MemberSettingsApi.ts"
import { TriggerHooksApi, TriggersApi } from "./TriggersApi.ts"
import { ChannelHooksApi, ChannelLinksApi, ChannelsApi } from "./ChannelsApi.ts"
import {
	ComputerHooksApi,
	ComputerProvidersApi,
	ComputersApi,
} from "./ComputersApi.ts"
import { AppOperationsApi } from "./AppOperationsApi.ts"
import { CodeRunsApi } from "./CodeRunsApi.ts"
import { AppViewsApi } from "./AppViewsApi.ts"
import { BudgetsApi, UsageApi } from "./BillingApi.ts"
import { Authorize, GroupRequired, requires } from "./Permissions.ts"

const connection = (permission: Parameters<typeof requires>[0]) => [
	requires(permission).on("connection", "connectionId"),
]
const apps = [requires("apps.use").on("apps")]

/**
 * The shared contract for server handlers, typed clients and generated documentation.
 * Each group that needs a caller also says which permissions its endpoints need.
 */
export class OpenBotApi extends HttpApi.make("openbot-api")
	.add(
		DeveloperPublicApi,
		DeveloperApi.annotate(GroupRequired, {
			read: [requires("apps.publish").on("apps")],
			write: [requires("apps.publish").on("apps")],
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		AppIndexApi,
		AppAuthorizationPublicApi,
		AppAuthorizationApi.annotate(GroupRequired, {
			read: connection("connections.read"),
			write: connection("connections.write"),
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		AppsApi.annotate(GroupRequired, { read: apps, write: apps })
			.middleware(Authorize)
			.middleware(BotAuth),
		ChatsApi,
		DelegationsApi,
		BotsApi,
		BotInvitationsApi,
		RequestsApi,
		MemberSettingsApi,
		TriggersApi,
		TriggerHooksApi,
		ChannelsApi,
		ChannelLinksApi,
		ChannelHooksApi,
		ComputerProvidersApi,
		ComputersApi,
		ComputerHooksApi,
		UsageApi,
		BudgetsApi,
		AppOperationsApi.annotate(GroupRequired, { read: apps, write: apps })
			.middleware(Authorize)
			.middleware(BotAuth),
		CodeRunsApi.annotate(GroupRequired, { read: apps, write: apps })
			.middleware(Authorize)
			.middleware(BotAuth),
		AppViewsApi.annotate(GroupRequired, { read: apps, write: apps })
			.middleware(Authorize)
			.middleware(BotAuth),
		AppExperienceApi.annotate(GroupRequired, {
			read: connection("connections.read"),
			write: connection("connections.write"),
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		ConnectionsApi.annotate(GroupRequired, {
			read: connection("connections.read"),
			write: connection("connections.write"),
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		AccountApi,
		SignInApi,
		OrganizationsApi,
		PlatformApi,
		UserTokensApi.annotate(GroupRequired, {
			read: [requires("tokens.read").on("user")],
			write: [requires("tokens.write").on("user")],
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		OrganizationApi.annotate(GroupRequired, {
			read: [requires("organization.read").on("organization")],
			write: [requires("organization.write").on("organization")],
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		ModelProvidersApi.annotate(GroupRequired, {
			read: [requires("model_providers.read").on("organization")],
			write: [requires("model_providers.write").on("organization")],
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		SsoApi.annotate(GroupRequired, {
			read: [requires("sso.read").on("organization")],
			write: [requires("sso.write").on("organization")],
		})
			.middleware(Authorize)
			.middleware(BotAuth),
	)
	.add(HealthApi)
	.annotate(OpenApi.Title, "OpenBot API")
	.annotate(OpenApi.Version, "0.1.0")
	.annotate(
		OpenApi.Description,
		"Headless REST API for OpenBot. To authenticate, send `Authorization: Bearer <user token>`. Create tokens at /v1/user/tokens. Every call needs a permission from a role or policy. Browser clients on the same origin can use the sign-in session Cookie instead. Then every write must send the exact public Origin.",
	) {}
