import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"

export const Health = Schema.Struct({ status: Schema.Literal("ok") })
export type Health = typeof Health.Type
/** The entry document for a headless deployment. Clients follow these links. */
export const Service = Schema.Struct({
	name: Schema.Literal("OpenBot Platform API"),
	documentation: Schema.Literal("/docs"),
	openapi: Schema.Literal("/openapi.json"),
	auth: Schema.Literal("/auth"),
	tokens: Schema.Literal("/v1/user/tokens"),
})
export type Service = typeof Service.Type
export const service: Service = {
	name: "OpenBot Platform API",
	documentation: "/docs",
	openapi: "/openapi.json",
	auth: "/auth",
	tokens: "/v1/user/tokens",
}

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
