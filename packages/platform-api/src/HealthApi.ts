import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { AuthBasePath } from "./AuthApi.ts"
import { UserTokensPath } from "./UserTokensApi.ts"

export const Health = Schema.Struct({ status: Schema.Literal("ok") })
export type Health = typeof Health.Type
/** The entry document for a headless deployment. Clients follow these links. */
export const service = {
	name: "OpenBot Platform API",
	documentation: "/docs",
	openapi: "/openapi.json",
	auth: AuthBasePath,
	tokens: UserTokensPath,
} as const
export const Service = Schema.Struct({
	name: Schema.Literal(service.name),
	documentation: Schema.Literal(service.documentation),
	openapi: Schema.Literal(service.openapi),
	auth: Schema.Literal(service.auth),
	tokens: Schema.Literal(service.tokens),
} satisfies {
	readonly [Key in keyof typeof service]: Schema.Literal<(typeof service)[Key]>
})
export type Service = typeof Service.Type

export const HealthApi = HttpApiGroup.make("health").add(
	HttpApiEndpoint.get("getService", "/", { success: Service }).annotate(
		OpenApi.Description,
		"Shows where to find the API reference, the Better Auth routes and the user token routes.",
	),
	HttpApiEndpoint.get("getHealth", "/health", { success: Health }).annotate(
		OpenApi.Description,
		"Checks that the HTTP service can respond. It does not check business dependencies.",
	),
)
