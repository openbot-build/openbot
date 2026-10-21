import { DeveloperApi, DeveloperPublicApi } from "./DeveloperApi.ts"
import { AppExperienceApi } from "./AppExperienceApi.ts"
import { ConnectionsApi } from "./ConnectionsApi.ts"
import { HttpApi, OpenApi } from "effect/http-api"
import { SessionsApi } from "./SessionsApi.ts"
import { HealthApi } from "./HealthApi.ts"
import { AccountApi, AgentAuth, LoginApi } from "./AuthApi.ts"
import { UserTokensApi } from "./UserTokensApi.ts"
import { OrganizationApi } from "./OrganizationApi.ts"
import { AppsApi } from "./AppsApi.ts"
import { AppIndexApi } from "./AppIndexApi.ts"
import {
	AppAuthorizationApi,
	AppAuthorizationPublicApi,
} from "./AppAuthorizationApi.ts"
import { SessionApprovalsApi } from "./SessionApprovalsApi.ts"
import { AppOperationsApi } from "./AppOperationsApi.ts"
import { AppViewsApi } from "./AppViewsApi.ts"
import { Authorize, GroupRequired, requires } from "./Permissions.ts"

const session = (permission: Parameters<typeof requires>[0]) => [
	requires(permission).on("session", "sessionId"),
]
const connection = (permission: Parameters<typeof requires>[0]) => [
	requires(permission).on("connection", "connectionId"),
]
const apps = [requires("apps.use").on("apps")]

/**
 * The shared contract for server handlers, typed clients and generated documentation.
 * Each group that needs a caller also says which permissions its endpoints need.
 */
export class PlatformApi extends HttpApi.make("openbot-platform-api")
	.add(
		HealthApi,
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
		SessionsApi.annotate(GroupRequired, {
			read: session("sessions.read"),
			write: session("sessions.write"),
		})
			.middleware(Authorize)
			.middleware(AgentAuth),
		SessionApprovalsApi.annotate(GroupRequired, {
			read: session("sessions.read"),
			write: session("approvals.resolve"),
		})
			.middleware(Authorize)
			.middleware(AgentAuth),
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
		LoginApi,
		AccountApi,
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
	)
	.annotate(OpenApi.Title, "OpenBot Platform API")
	.annotate(OpenApi.Version, "0.1.0")
	.annotate(
		OpenApi.Description,
		"Headless REST API for OpenBot. To authenticate, send `Authorization: Bearer <user token>`. Create tokens at /v1/user/tokens. Every call needs a permission from a role or policy. Browser clients on the same origin can use the session Cookie instead. Then every write must send the exact public Origin.",
	) {}
