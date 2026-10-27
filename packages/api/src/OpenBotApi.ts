import { FailureBoundary } from "./FailureApi.ts"
import { ExecutionsApi } from "./ExecutionsApi.ts"
import { DeveloperApi, DeveloperPublicApi } from "./DeveloperApi.ts"
import { AppExperienceApi } from "./AppExperienceApi.ts"
import { ConnectionsApi } from "./ConnectionsApi.ts"
import { HttpApi, type HttpApiGroup, OpenApi } from "effect/http-api"
import { ChatsApi } from "./ChatsApi.ts"
import { LiveApi } from "./LiveApi.ts"
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
import { FilesApi } from "./FilesApi.ts"
import { ChannelHooksApi, ChannelLinksApi, ChannelsApi } from "./ChannelsApi.ts"
import {
	ComputerHooksApi,
	ComputerProvidersApi,
	ComputersApi,
} from "./ComputersApi.ts"
import { SecretProvidersApi, VaultsApi } from "./VaultsApi.ts"
import { AppOperationsApi } from "./AppOperationsApi.ts"
import { ToolCallsApi } from "./ToolCallsApi.ts"
import { CodeRunsApi } from "./CodeRunsApi.ts"
import { AppViewsApi } from "./AppViewsApi.ts"
import { BudgetsApi, UsageApi } from "./BillingApi.ts"
import { Authorize, GroupRequired, organization, own } from "./Authorization.ts"

const connection = (action: "read" | "write") => [
	own(action, "Connection", "connectionId"),
]
const apps = [own("use", "App")]

/**
 * The shared contract for server handlers, typed clients and generated documentation.
 * Each group that needs a caller also says which permissions its endpoints need.
 */
type ProtectedGroups =
	| typeof DeveloperApi
	| typeof AppAuthorizationApi
	| typeof AppsApi
	| typeof AppOperationsApi
	| typeof CodeRunsApi
	| typeof AppViewsApi
	| typeof AppExperienceApi
	| typeof ConnectionsApi
	| typeof UserTokensApi
	| typeof OrganizationApi
	| typeof ModelProvidersApi
	| typeof SsoApi

type Groups =
	| typeof DeveloperPublicApi
	| typeof AppIndexApi
	| typeof AppAuthorizationPublicApi
	| typeof ChatsApi
	| typeof ToolCallsApi
	| typeof ExecutionsApi
	| typeof LiveApi
	| typeof FilesApi
	| typeof DelegationsApi
	| typeof BotsApi
	| typeof BotInvitationsApi
	| typeof RequestsApi
	| typeof MemberSettingsApi
	| typeof TriggersApi
	| typeof TriggerHooksApi
	| typeof ChannelsApi
	| typeof ChannelLinksApi
	| typeof ChannelHooksApi
	| typeof ComputerProvidersApi
	| typeof ComputersApi
	| typeof ComputerHooksApi
	| typeof SecretProvidersApi
	| typeof VaultsApi
	| typeof UsageApi
	| typeof BudgetsApi
	| typeof AccountApi
	| typeof SignInApi
	| typeof OrganizationsApi
	| typeof PlatformApi
	| typeof HealthApi
	| HttpApiGroup.AddMiddleware<
			HttpApiGroup.AddMiddleware<ProtectedGroups, Authorize>,
			BotAuth
	  >

const contract: HttpApi.HttpApi<"openbot-api", Groups> = HttpApi.make(
	"openbot-api",
)
	.add(
		DeveloperPublicApi,
		DeveloperApi.annotate(GroupRequired, {
			read: [own("publish", "App")],
			write: [own("publish", "App")],
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		AppIndexApi,
		AppAuthorizationPublicApi,
		AppAuthorizationApi.annotate(GroupRequired, {
			read: connection("read"),
			write: connection("write"),
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		AppsApi.annotate(GroupRequired, { read: apps, write: apps })
			.middleware(Authorize)
			.middleware(BotAuth),
		ChatsApi,
		ToolCallsApi,
		ExecutionsApi,
		LiveApi,
		FilesApi,
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
		SecretProvidersApi,
		VaultsApi,
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
			read: [own("read", "Connection")],
			write: [own("write", "Connection")],
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		ConnectionsApi.annotate(GroupRequired, {
			read: connection("read"),
			write: connection("write"),
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		AccountApi,
		SignInApi,
		OrganizationsApi,
		PlatformApi,
		UserTokensApi.annotate(GroupRequired, {
			read: [own("read", "Token")],
			write: [own("write", "Token")],
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		OrganizationApi.annotate(GroupRequired, {
			read: [organization("read", "Organization")],
			write: [organization("write", "Organization")],
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		ModelProvidersApi.annotate(GroupRequired, {
			read: [organization("read", "ModelProvider")],
			write: [organization("write", "ModelProvider")],
		})
			.middleware(Authorize)
			.middleware(BotAuth),
		SsoApi.annotate(GroupRequired, {
			read: [organization("read", "Sso")],
			write: [organization("write", "Sso")],
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
	)

// A named type keeps TypeScript from expanding the full API for each middleware.
const publicContract: HttpApi.HttpApi<
	"openbot-api",
	HttpApiGroup.AddMiddleware<Groups, FailureBoundary>
> = contract.middleware(FailureBoundary)

export class OpenBotApi extends publicContract {}
