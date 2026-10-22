import { DeveloperApi, DeveloperPublicApi } from "./DeveloperApi.ts"
import { AppExperienceApi } from "./AppExperienceApi.ts"
import { ConnectionsApi } from "./ConnectionsApi.ts"
import { HttpApi, OpenApi } from "effect/http-api"
import { SessionsApi } from "./SessionsApi.ts"
import { HealthApi } from "./HealthApi.ts"
import { AccountApi, AgentAuth, SignInApi } from "./AuthApi.ts"
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
import { AgentsApi } from "./AgentsApi.ts"
import { RequestsApi } from "./RequestsApi.ts"
import { MemberSettingsApi } from "./MemberSettingsApi.ts"
import { AppOperationsApi } from "./AppOperationsApi.ts"
import { AppViewsApi } from "./AppViewsApi.ts"
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
			.middleware(AgentAuth),
		AppIndexApi,
		AppAuthorizationPublicApi,
		AppAuthorizationApi.annotate(GroupRequired, {
			read: connection("connections.read"),
			write: connection("connections.write"),
		})
			.middleware(Authorize)
			.middleware(AgentAuth),
		AppsApi.annotate(GroupRequired, { read: apps, write: apps })
			.middleware(Authorize)
			.middleware(AgentAuth),
		SessionsApi,
		AgentsApi,
		RequestsApi,
		MemberSettingsApi,
		AppOperationsApi.annotate(GroupRequired, { read: apps, write: apps })
			.middleware(Authorize)
			.middleware(AgentAuth),
		AppViewsApi.annotate(GroupRequired, { read: apps, write: apps })
			.middleware(Authorize)
			.middleware(AgentAuth),
		AppExperienceApi.annotate(GroupRequired, {
			read: connection("connections.read"),
			write: connection("connections.write"),
		})
			.middleware(Authorize)
			.middleware(AgentAuth),
		ConnectionsApi.annotate(GroupRequired, {
			read: connection("connections.read"),
			write: connection("connections.write"),
		})
			.middleware(Authorize)
			.middleware(AgentAuth),
		AccountApi,
		SignInApi,
		OrganizationsApi,
		PlatformApi,
		UserTokensApi.annotate(GroupRequired, {
			read: [requires("tokens.read").on("user")],
			write: [requires("tokens.write").on("user")],
		})
			.middleware(Authorize)
			.middleware(AgentAuth),
		OrganizationApi.annotate(GroupRequired, {
			read: [requires("organization.read").on("organization")],
			write: [requires("organization.write").on("organization")],
		})
			.middleware(Authorize)
			.middleware(AgentAuth),
		ModelProvidersApi.annotate(GroupRequired, {
			read: [requires("model_providers.read").on("organization")],
			write: [requires("model_providers.write").on("organization")],
		})
			.middleware(Authorize)
			.middleware(AgentAuth),
		SsoApi.annotate(GroupRequired, {
			read: [requires("sso.read").on("organization")],
			write: [requires("sso.write").on("organization")],
		})
			.middleware(Authorize)
			.middleware(AgentAuth),
	)
	.add(HealthApi)
	.annotate(OpenApi.Title, "OpenBot API")
	.annotate(OpenApi.Version, "0.1.0")
	.annotate(
		OpenApi.Description,
		"Headless REST API for OpenBot. To authenticate, send `Authorization: Bearer <user token>`. Create tokens at /v1/user/tokens. Every call needs a permission from a role or policy. Browser clients on the same origin can use the session Cookie instead. Then every write must send the exact public Origin.",
	) {}
