import { Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiMiddleware,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { AccountAuth, NoStore } from "./AuthApi.ts"
import { Account } from "./Identity.ts"
import {
	CreatePlatformModelProviderRequest,
	ModelProvider,
	ModelProviderErrors,
	UpdatePlatformModelProviderRequest,
} from "./ModelProvidersApi.ts"
import {
	Organization,
	OrganizationStatus,
	OrganizationStorageUnavailable,
} from "./OrganizationApi.ts"
import { PermissionErrors } from "./Permissions.ts"
import {
	PlatformSettings,
	SettingsErrors,
	UpdatePlatformSettingsRequest,
} from "./Settings.ts"

/**
 * Lets only platform admins in. GET needs `platform.read` and every other method
 * needs `platform.write`. A user token must also allow that permission group on
 * `openbot.platform` in its own policies.
 * @effect-expect-leaking RouteContext
 */
export class PlatformAuthorize extends HttpApiMiddleware.Service<
	PlatformAuthorize,
	{ readonly requires: Account }
>()("@openbot-build/api/PlatformApi/PlatformAuthorize", {
	error: PermissionErrors,
}) {}

export const PlatformAdmin = Schema.Struct({
	/** A person becomes a platform admin when they sign in with this verified email. */
	email: Schema.String,
	/** Null until the person signs in for the first time. */
	userId: Schema.NullOr(Schema.String),
	addedAt: Schema.String,
})
export type PlatformAdmin = typeof PlatformAdmin.Type
export const AddPlatformAdminRequest = Schema.Struct({
	email: Schema.String.check(
		Schema.isMaxLength(320),
		Schema.isPattern(/^[^@\s]+@[^@\s]+$/),
	),
})
export const UpdatePlatformOrganizationRequest = Schema.Struct({
	status: OrganizationStatus,
})

export class PlatformAdminNotFound extends Schema.TaggedError<PlatformAdminNotFound>()(
	"PlatformAdminNotFound",
	{ email: Schema.String },
) {}
/** The platform must keep at least one admin. */
export class LastPlatformAdmin extends Schema.TaggedError<LastPlatformAdmin>()(
	"LastPlatformAdmin",
	{},
) {}
export class OrganizationNotFound extends Schema.TaggedError<OrganizationNotFound>()(
	"OrganizationNotFound",
	{ organizationId: Schema.String },
) {}
export class PlatformUnavailable extends Schema.TaggedError<PlatformUnavailable>()(
	"PlatformUnavailable",
	{},
) {}
const errors = [
	PlatformUnavailable.pipe(HttpApiSchema.status(503)),
	OrganizationStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const Limit = Schema.FiniteFromString.check(
	Schema.isBetween({ minimum: 1, maximum: 100 }),
)
const ProviderParams = { providerId: Schema.String }

/** The settings of the whole deployment. Only platform admins can use it. */
export const PlatformApi = HttpApiGroup.make("platform")
	.add(
		HttpApiEndpoint.get("getPlatformSettings", "/v1/platform/settings", {
			success: PlatformSettings,
			error: [...errors, ...SettingsErrors],
		}),
		HttpApiEndpoint.patch("updatePlatformSettings", "/v1/platform/settings", {
			payload: UpdatePlatformSettingsRequest,
			success: PlatformSettings,
			error: [...errors, ...SettingsErrors],
		}).annotate(
			OpenApi.Description,
			"Changes the platform settings. Send the `version` that you read as `expectedVersion`. Every instance uses the new settings right away. A new `publicOrigin` signs everyone out and changes the sign-in redirect URI.",
		),
		HttpApiEndpoint.get(
			"listPlatformOrganizations",
			"/v1/platform/organizations",
			{
				query: {
					after: Schema.optionalKey(Schema.String),
					limit: Schema.optionalKey(Limit),
				},
				success: Schema.Struct({
					items: Schema.Array(Organization),
					next: Schema.NullOr(Schema.String),
				}),
				error: errors,
			},
		),
		HttpApiEndpoint.patch(
			"updatePlatformOrganization",
			"/v1/platform/organizations/:organizationId",
			{
				params: { organizationId: Schema.String },
				payload: UpdatePlatformOrganizationRequest,
				success: Organization,
				error: [
					...errors,
					OrganizationNotFound.pipe(HttpApiSchema.status(404)),
				],
			},
		).annotate(
			OpenApi.Description,
			"Suspends an organization or makes it active again. Nobody can use a suspended organization, and its tokens stop working.",
		),
		HttpApiEndpoint.get("listPlatformAdmins", "/v1/platform/admins", {
			success: Schema.Struct({ items: Schema.Array(PlatformAdmin) }),
			error: errors,
		}),
		HttpApiEndpoint.post("addPlatformAdmin", "/v1/platform/admins", {
			payload: AddPlatformAdminRequest,
			success: PlatformAdmin,
			error: errors,
		}),
		HttpApiEndpoint.delete(
			"removePlatformAdmin",
			"/v1/platform/admins/:email",
			{
				params: { email: Schema.String },
				success: HttpApiSchema.NoContent,
				error: [
					...errors,
					PlatformAdminNotFound.pipe(HttpApiSchema.status(404)),
					LastPlatformAdmin.pipe(HttpApiSchema.status(409)),
				],
			},
		),
		HttpApiEndpoint.get(
			"listPlatformModelProviders",
			"/v1/platform/model_providers",
			{
				success: Schema.Struct({ items: Schema.Array(ModelProvider) }),
				error: [...errors, ...ModelProviderErrors],
			},
		),
		HttpApiEndpoint.get(
			"getPlatformModelProvider",
			"/v1/platform/model_providers/:providerId",
			{
				params: ProviderParams,
				success: ModelProvider,
				error: [...errors, ...ModelProviderErrors],
			},
		),
		HttpApiEndpoint.post(
			"createPlatformModelProvider",
			"/v1/platform/model_providers",
			{
				payload: CreatePlatformModelProviderRequest,
				success: ModelProvider,
				error: [...errors, ...ModelProviderErrors],
			},
		).annotate(
			OpenApi.Description,
			"Adds a model provider that the platform pays for. `availability` says which organizations can use it.",
		),
		HttpApiEndpoint.patch(
			"updatePlatformModelProvider",
			"/v1/platform/model_providers/:providerId",
			{
				params: ProviderParams,
				payload: UpdatePlatformModelProviderRequest,
				success: ModelProvider,
				error: [...errors, ...ModelProviderErrors],
			},
		),
		HttpApiEndpoint.delete(
			"deletePlatformModelProvider",
			"/v1/platform/model_providers/:providerId",
			{
				params: ProviderParams,
				success: HttpApiSchema.NoContent,
				error: [...errors, ...ModelProviderErrors],
			},
		),
	)
	.middleware(PlatformAuthorize)
	.middleware(AccountAuth)
	.middleware(NoStore)
