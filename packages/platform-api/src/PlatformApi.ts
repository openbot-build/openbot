import { DeveloperApi, DeveloperPublicApi } from "./DeveloperApi.ts"
import { AppExperienceApi } from "./AppExperienceApi.ts"
import { ConnectionsApi } from "./ConnectionsApi.ts"
import { HttpApi, OpenApi } from "effect/http-api"
import { SessionsApi } from "./SessionsApi.ts"
import { HealthApi } from "./HealthApi.ts"
import { AccountApi, AgentAuth } from "./AuthApi.ts"
import { ApiKeysApi } from "./ApiKeysApi.ts"
import { AppsApi } from "./AppsApi.ts"
import { AppIndexApi } from "./AppIndexApi.ts"
import {
	AppAuthorizationApi,
	AppAuthorizationPublicApi,
} from "./AppAuthorizationApi.ts"
import { SessionApprovalsApi } from "./SessionApprovalsApi.ts"
import { AppOperationsApi } from "./AppOperationsApi.ts"
import { AppViewsApi } from "./AppViewsApi.ts"

/** The shared contract for server handlers, typed clients and generated documentation. */
export class PlatformApi extends HttpApi.make("openbot-platform-api")
	.add(
		HealthApi,
		DeveloperPublicApi,
		DeveloperApi.middleware(AgentAuth),
		AppIndexApi,
		AppAuthorizationPublicApi,
		AppAuthorizationApi.middleware(AgentAuth),
		AppsApi.middleware(AgentAuth),
		SessionsApi.middleware(AgentAuth),
		SessionApprovalsApi.middleware(AgentAuth),
		AppOperationsApi.middleware(AgentAuth),
		AppViewsApi.middleware(AgentAuth),
		AppExperienceApi.middleware(AgentAuth),
		ConnectionsApi.middleware(AgentAuth),
		AccountApi,
		ApiKeysApi,
	)
	.annotate(OpenApi.Title, "OpenBot Platform API")
	.annotate(OpenApi.Version, "0.1.0")
	.annotate(
		OpenApi.Description,
		"Headless REST API for OpenBot. To authenticate, send `Authorization: Bearer <API key>`. Create keys at /auth/api-keys while you are signed in. Browser clients on the same origin can use the session Cookie instead. Then every write must send the exact public Origin.",
	) {}
