import * as ProviderOAuth from "@openbot-build/domain/ProviderOAuth"
import { Model as CoreModel, Provider } from "@openbot-build/core"
import { Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { ModelPrice, ModelPrices, SetModelPriceRequest } from "./BillingApi.ts"
import { AuthorizationErrors, Required } from "./Authorization.ts"
import {
	Model,
	CreateModelRequest,
	UpdateModelRequest,
	ModelProvider,
	CreateModelProviderRequest,
	UpdateModelProviderRequest,
	ModelCatalog,
	ModelProviderNotFound,
	ModelProviderConflict,
	ModelProviderInvalid,
	ModelProviderInUse,
	ModelNotFound,
	ModelConflict,
	ModelInUse,
	ModelProvidersUnavailable,
} from "@openbot-build/domain/Models"
export {
	ProviderKind,
	ModelType,
	Endpoint,
	Availability,
	ProviderOwner,
	ModelOwner,
	Model,
	CreateModelRequest,
	UpdateModelRequest,
	CreatePlatformModelRequest,
	UpdatePlatformModelRequest,
	ProviderModel,
	ProviderModels,
	ModelProvider,
	CreateModelProviderRequest,
	UpdateModelProviderRequest,
	CreatePlatformModelProviderRequest,
	UpdatePlatformModelProviderRequest,
	ModelCatalog,
	ModelProviderNotFound,
	ModelProviderConflict,
	ModelProviderInvalid,
	ModelProviderInUse,
	ModelNotFound,
	ModelConflict,
	ModelInUse,
	ModelProvidersUnavailable,
} from "@openbot-build/domain/Models"

export const ModelProviderErrors = [
	ProviderOAuth.ModelProviderLoginRequired.pipe(HttpApiSchema.status(409)),
	ProviderOAuth.ModelProviderAuthorizationInvalid.pipe(
		HttpApiSchema.status(400),
	),
	ProviderOAuth.ModelProviderOAuthUnavailable.pipe(HttpApiSchema.status(503)),
	ModelProviderNotFound.pipe(HttpApiSchema.status(404)),
	ModelProviderConflict.pipe(HttpApiSchema.status(409)),
	ModelProviderInUse.pipe(HttpApiSchema.status(409)),
	ModelProviderInvalid.pipe(HttpApiSchema.status(400)),
	ModelProvidersUnavailable.pipe(HttpApiSchema.status(503)),
	ModelNotFound.pipe(HttpApiSchema.status(404)),
	ModelConflict.pipe(HttpApiSchema.status(409)),
	ModelInUse.pipe(HttpApiSchema.status(409)),
] as const
const errors = [...ModelProviderErrors, ...AuthorizationErrors] as const

const ProviderParams = { providerId: Provider.Id }
const ModelParams = { modelId: CoreModel.Id }

/** The models and model providers of the organization. API keys go in, but they never come out. */
export class ModelProvidersApi extends HttpApiGroup.make("modelProviders").add(
	HttpApiEndpoint.post(
		"startProviderAuthorization",
		"/v1/organization/model_providers/:providerId/oauth/authorizations",
		{
			params: ProviderParams,
			payload: ProviderOAuth.StartProviderOAuthAuthorizationRequest,
			success: ProviderOAuth.ProviderOAuthAuthorization,
			error: errors,
		},
	),
	HttpApiEndpoint.post(
		"completeProviderAuthorization",
		"/v1/organization/model_providers/:providerId/oauth/authorizations/:authorizationId/complete",
		{
			params: { ...ProviderParams, authorizationId: Schema.NonEmptyString },
			payload: ProviderOAuth.CompleteProviderOAuthAuthorizationRequest,
			success: ModelProvider,
			error: errors,
		},
	),
	HttpApiEndpoint.delete(
		"disconnectProviderOAuth",
		"/v1/organization/model_providers/:providerId/oauth",
		{
			params: ProviderParams,
			success: ProviderOAuth.ProviderOAuthDisconnect,
			error: errors,
		},
	),
	HttpApiEndpoint.get(
		"getProviderAvailableModels",
		"/v1/organization/model_providers/:providerId/available_models",
		{
			params: ProviderParams,
			success: ProviderOAuth.ProviderOAuthModels,
			error: errors,
		},
	),

	HttpApiEndpoint.get("getModelCatalog", "/v1/organization/model_catalog", {
		success: ModelCatalog,
		error: errors,
	})
		// Every member may ask. The list has only the models that the caller may use.
		.annotate(Required, [])
		.annotate(
			OpenApi.Description,
			"Lists the models that the caller may use now, for each provider that offers them.",
		),
	HttpApiEndpoint.get("listModels", "/v1/organization/models", {
		success: Schema.Struct({ items: Schema.Array(Model) }),
		error: errors,
	}).annotate(
		OpenApi.Description,
		"Lists the models of the organization. The models that the platform shares are not in the list.",
	),
	HttpApiEndpoint.get("getModel", "/v1/organization/models/:modelId", {
		params: ModelParams,
		success: Model,
		error: errors,
	}),
	HttpApiEndpoint.post("createModel", "/v1/organization/models", {
		payload: CreateModelRequest,
		success: Model,
		error: errors,
	}).annotate(
		OpenApi.Description,
		"Adds a model to the organization. Link it to a provider to use it.",
	),
	HttpApiEndpoint.patch("updateModel", "/v1/organization/models/:modelId", {
		params: ModelParams,
		payload: UpdateModelRequest,
		success: Model,
		error: errors,
	}),
	HttpApiEndpoint.delete("deleteModel", "/v1/organization/models/:modelId", {
		params: ModelParams,
		success: HttpApiSchema.NoContent,
		error: errors,
	}),
	HttpApiEndpoint.get(
		"listModelProviders",
		"/v1/organization/model_providers",
		{
			success: Schema.Struct({ items: Schema.Array(ModelProvider) }),
			error: errors,
		},
	),
	HttpApiEndpoint.get(
		"getModelProvider",
		"/v1/organization/model_providers/:providerId",
		{ params: ProviderParams, success: ModelProvider, error: errors },
	),
	HttpApiEndpoint.post(
		"createModelProvider",
		"/v1/organization/model_providers",
		{
			payload: CreateModelProviderRequest,
			success: ModelProvider,
			error: errors,
		},
	).annotate(
		OpenApi.Description,
		"Adds a model provider. ChatGPT uses sign-in; other kinds need an API key.",
	),
	HttpApiEndpoint.patch(
		"updateModelProvider",
		"/v1/organization/model_providers/:providerId",
		{
			params: ProviderParams,
			payload: UpdateModelProviderRequest,
			success: ModelProvider,
			error: errors,
		},
	).annotate(
		OpenApi.Description,
		"Changes a model provider. The next model call uses the change.",
	),
	HttpApiEndpoint.delete(
		"deleteModelProvider",
		"/v1/organization/model_providers/:providerId",
		{
			params: ProviderParams,
			success: HttpApiSchema.NoContent,
			error: errors,
		},
	),
	HttpApiEndpoint.get(
		"listModelPrices",
		"/v1/organization/model_providers/:providerId/prices",
		{ params: ProviderParams, success: ModelPrices, error: errors },
	).annotate(
		OpenApi.Description,
		"Lists the current price of each model of a provider of the organization. Usage of these models counts toward budgets, but never takes credits.",
	),
	HttpApiEndpoint.put(
		"setModelPrice",
		"/v1/organization/model_providers/:providerId/prices",
		{
			params: ProviderParams,
			payload: SetModelPriceRequest,
			success: ModelPrice,
			error: errors,
		},
	).annotate(
		OpenApi.Description,
		"Sets a new price for one model of the provider. The price applies to calls from now on. Old calls keep their cost.",
	),
) {}
