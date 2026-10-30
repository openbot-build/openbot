import { CreditConflict } from "./BillingApi.ts"
import * as ProviderOAuth from "@openbot-build/domain/ProviderOAuth"
import { Model as CoreModel, Provider } from "@openbot-build/core"
import { Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { AccountAuth, NoStore } from "./AuthApi.ts"
import { Email } from "./Email.ts"
import { Delivery } from "./Mail.ts"
import { Limit } from "./Page.ts"
import {
	CreditGrant,
	Credits,
	GrantCreditsRequest,
	ModelPrice,
	ModelPrices,
	SetModelPriceRequest,
	UpdateCreditsRequest,
} from "./BillingApi.ts"
import {
	CreatePlatformModelProviderRequest,
	CreatePlatformModelRequest,
	Model,
	ModelProvider,
	ModelProviderErrors,
	UpdatePlatformModelProviderRequest,
	UpdatePlatformModelRequest,
} from "./ModelProvidersApi.ts"
import {
	Organization,
	OrganizationStorageUnavailable,
} from "./OrganizationApi.ts"
import {
	GroupRequired,
	onPlatform,
	PlatformAuthorize,
} from "./Authorization.ts"
import {
	PlatformSettings,
	SettingsErrors,
	UpdatePlatformSettingsRequest,
} from "./Settings.ts"

import {
	PlatformAdmin,
	AddPlatformAdminRequest,
	UpdatePlatformOrganizationRequest,
	PlatformAdminNotFound,
	LastPlatformAdmin,
	OrganizationNotFound,
	PlatformUnavailable,
} from "@openbot-build/domain/Platform"
export {
	PlatformAdmin,
	AddPlatformAdminRequest,
	UpdatePlatformOrganizationRequest,
	PlatformAdminNotFound,
	LastPlatformAdmin,
	OrganizationNotFound,
	PlatformUnavailable,
} from "@openbot-build/domain/Platform"

const errors = [
	PlatformUnavailable.pipe(HttpApiSchema.status(503)),
	OrganizationStorageUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const ProviderParams = { providerId: Provider.Id }
const ModelParams = { modelId: CoreModel.Id }

/** The settings of the whole deployment. Only platform admins can use it. */
export class PlatformApi extends HttpApiGroup.make("platform")
	.add(
		HttpApiEndpoint.post("sendTestMail", "/v1/platform/mail/test", {
			payload: Schema.Struct({ to: Email }),
			success: Delivery,
			error: errors,
		}).annotate(
			OpenApi.Description,
			"Sends a test email with the current platform SMTP settings. Only platform admins can use this endpoint. Sent means that SMTP accepted the email; it does not prove inbox delivery. A failed send is not retried.",
		),
		HttpApiEndpoint.post(
			"startPlatformProviderAuthorization",
			"/v1/platform/model_providers/:providerId/oauth/authorizations",
			{
				params: ProviderParams,
				payload: ProviderOAuth.StartProviderOAuthAuthorizationRequest,
				success: ProviderOAuth.ProviderOAuthAuthorization,
				error: [...errors, ...ModelProviderErrors],
			},
		),
		HttpApiEndpoint.post(
			"completePlatformProviderAuthorization",
			"/v1/platform/model_providers/:providerId/oauth/authorizations/:authorizationId/complete",
			{
				params: { ...ProviderParams, authorizationId: Schema.NonEmptyString },
				payload: ProviderOAuth.CompleteProviderOAuthAuthorizationRequest,
				success: ModelProvider,
				error: [...errors, ...ModelProviderErrors],
			},
		),
		HttpApiEndpoint.delete(
			"disconnectPlatformProviderOAuth",
			"/v1/platform/model_providers/:providerId/oauth",
			{
				params: ProviderParams,
				success: ProviderOAuth.ProviderOAuthDisconnect,
				error: [...errors, ...ModelProviderErrors],
			},
		),
		HttpApiEndpoint.get(
			"getPlatformProviderAvailableModels",
			"/v1/platform/model_providers/:providerId/available_models",
			{
				params: ProviderParams,
				success: ProviderOAuth.ProviderOAuthModels,
				error: [...errors, ...ModelProviderErrors],
			},
		),

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
					limit: Schema.optionalKey(Limit(100)),
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
		HttpApiEndpoint.get("listPlatformModels", "/v1/platform/models", {
			success: Schema.Struct({ items: Schema.Array(Model) }),
			error: [...errors, ...ModelProviderErrors],
		}),
		HttpApiEndpoint.get("getPlatformModel", "/v1/platform/models/:modelId", {
			params: ModelParams,
			success: Model,
			error: [...errors, ...ModelProviderErrors],
		}),
		HttpApiEndpoint.post("createPlatformModel", "/v1/platform/models", {
			payload: CreatePlatformModelRequest,
			success: Model,
			error: [...errors, ...ModelProviderErrors],
		}).annotate(
			OpenApi.Description,
			"Adds a model of the platform. `availability` says which organizations can use it. A provider must link it before anyone can call it.",
		),
		HttpApiEndpoint.patch(
			"updatePlatformModel",
			"/v1/platform/models/:modelId",
			{
				params: ModelParams,
				payload: UpdatePlatformModelRequest,
				success: Model,
				error: [...errors, ...ModelProviderErrors],
			},
		),
		HttpApiEndpoint.delete(
			"deletePlatformModel",
			"/v1/platform/models/:modelId",
			{
				params: ModelParams,
				success: HttpApiSchema.NoContent,
				error: [...errors, ...ModelProviderErrors],
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
		HttpApiEndpoint.get(
			"listPlatformModelPrices",
			"/v1/platform/model_providers/:providerId/prices",
			{
				params: ProviderParams,
				success: ModelPrices,
				error: [...errors, ...ModelProviderErrors],
			},
		).annotate(
			OpenApi.Description,
			"Lists the current price of each model of a provider of the platform. Organizations pay this price with their credits.",
		),
		HttpApiEndpoint.put(
			"setPlatformModelPrice",
			"/v1/platform/model_providers/:providerId/prices",
			{
				params: ProviderParams,
				payload: SetModelPriceRequest,
				success: ModelPrice,
				error: [...errors, ...ModelProviderErrors],
			},
		).annotate(
			OpenApi.Description,
			"Sets a new price for one model of the provider. The price applies to calls from now on. Old calls keep their cost.",
		),
		HttpApiEndpoint.get(
			"getPlatformOrganizationCredits",
			"/v1/platform/organizations/:organizationId/credits",
			{
				params: { organizationId: Schema.String },
				success: Credits,
				error: [
					...errors,
					OrganizationNotFound.pipe(HttpApiSchema.status(404)),
				],
			},
		),
		HttpApiEndpoint.patch(
			"updatePlatformOrganizationCredits",
			"/v1/platform/organizations/:organizationId/credits",
			{
				params: { organizationId: Schema.String },
				payload: UpdateCreditsRequest,
				success: Credits,
				error: [
					...errors,
					OrganizationNotFound.pipe(HttpApiSchema.status(404)),
				],
			},
		).annotate(
			OpenApi.Description,
			"Turns the credits of an organization on or off. While they are on, the organization can use the models of the platform only when its balance is more than 0.",
		),
		HttpApiEndpoint.post(
			"grantPlatformOrganizationCredits",
			"/v1/platform/organizations/:organizationId/credits/grants",
			{
				params: { organizationId: Schema.String },
				payload: GrantCreditsRequest,
				success: CreditGrant.pipe(HttpApiSchema.status(201)),
				error: [
					CreditConflict.pipe(HttpApiSchema.status(409)),
					...errors,
					OrganizationNotFound.pipe(HttpApiSchema.status(404)),
				],
			},
		).annotate(
			OpenApi.Description,
			"Adds credits to an organization. A negative amount takes credits back.",
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
	.annotate(GroupRequired, {
		read: [onPlatform("read")],
		write: [onPlatform("write")],
	})
	.middleware(PlatformAuthorize)
	.middleware(AccountAuth)
	.middleware(NoStore) {}
