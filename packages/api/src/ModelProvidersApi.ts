import { Config, Model as CoreModel, Provider } from "@openbot-build/core"
import { Array as Arr, pipe, Schema } from "effect"
import {
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { ModelPrice, ModelPrices, SetModelPriceRequest } from "./BillingApi.ts"
import { AuthorizationErrors, Required } from "./Authorization.ts"
import { SecretInput, SecretState, Version } from "./Settings.ts"

/** The API that a provider speaks. */
export const ProviderKind = Schema.Literals([
	"openai",
	"anthropic",
	"openai-compat",
	/** The decision API of TypeSafe, as Jev uses it. It links only decision models. */
	"typesafe",
])
export type ProviderKind = typeof ProviderKind.Type

/**
 * What a model does. A `language` model writes text and calls tools. A
 * `decision` model, such as Jev, only picks an answer from a fixed list. A `live`
 * model talks with a person in real time, with sound, in Live mode.
 */
export const ModelType = Schema.Literals(["language", "decision", "live"])
export type ModelType = typeof ModelType.Type

/** An HTTP address without credentials, query or fragment. */
export const Endpoint = Schema.NonEmptyString.check(
	Schema.makeFilter((value: string) => {
		if (!URL.canParse(value)) return "Expected an absolute model endpoint URL"
		const url = new URL(value)
		return (url.protocol === "https:" || url.protocol === "http:") &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === ""
			? undefined
			: "Expected an HTTP endpoint without credentials, query or fragment"
	}),
)

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const ModelId = CoreModel.Id.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(200),
)
const ModelName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(200),
)
const Options = Schema.Array(Schema.NonEmptyString).check(
	Schema.isMaxLength(50),
)

/** Which organizations can use a provider or a model of the platform. */
export const Availability = Schema.Union([
	Schema.TaggedStruct("All", {}),
	Schema.TaggedStruct("None", {}),
	Schema.TaggedStruct("Selected", {
		organizations: Schema.Array(Schema.String).check(Schema.isMaxLength(1000)),
	}),
])
export type Availability = typeof Availability.Type

export const ProviderOwner = Schema.Literals(["platform", "organization"])
export type ProviderOwner = typeof ProviderOwner.Type
/** The platform or an organization owns a model, in the same way as a provider. */
export const ModelOwner = ProviderOwner
export type ModelOwner = ProviderOwner

/**
 * A model, such as `gpt-5`. It does not belong to a provider. A provider
 * links it to offer it, and the link can change some of its values.
 */
export const Model = Schema.Struct({
	/** The ID is unique for its owner. A provider sends it as the model name unless the link sets `upstream`. */
	id: CoreModel.Id,
	owner: ModelOwner,
	type: ModelType,
	name: Schema.String,
	reasoningEfforts: Schema.Array(Schema.String),
	serviceTiers: Schema.Array(Schema.String),
	/** Missing means unknown; an empty list accepts text only. */
	inputMediaTypes: Schema.optionalKey(Config.InputMediaTypes),
	contextWindow: Schema.optionalKey(PositiveInt),
	maxOutputTokens: Schema.optionalKey(PositiveInt),
	/** Only models of the platform have it. */
	availability: Schema.NullOr(Availability),
	version: Version,
	createdAt: Schema.String,
	updatedAt: Schema.String,
})
export type Model = typeof Model.Type

export const CreateModelRequest = Schema.Struct({
	id: ModelId,
	/** Leave it out for a language model. You cannot change it later. */
	type: Schema.optionalKey(ModelType),
	name: ModelName,
	reasoningEfforts: Options,
	serviceTiers: Options,
	inputMediaTypes: Schema.optionalKey(Config.InputMediaTypes),
	contextWindow: Schema.optionalKey(PositiveInt),
	maxOutputTokens: Schema.optionalKey(PositiveInt),
})
export type CreateModelRequest = typeof CreateModelRequest.Type
export const UpdateModelRequest = Schema.Struct({
	expectedVersion: Version,
	name: Schema.optionalKey(ModelName),
	reasoningEfforts: Schema.optionalKey(Options),
	serviceTiers: Schema.optionalKey(Options),
	/** Null removes the declaration, leaving media support unknown. */
	inputMediaTypes: Schema.optionalKey(Schema.NullOr(Config.InputMediaTypes)),
	/** Null removes the limit. */
	contextWindow: Schema.optionalKey(Schema.NullOr(PositiveInt)),
	maxOutputTokens: Schema.optionalKey(Schema.NullOr(PositiveInt)),
})
export type UpdateModelRequest = typeof UpdateModelRequest.Type
export const CreatePlatformModelRequest = Schema.Struct({
	...CreateModelRequest.fields,
	availability: Availability,
})
export type CreatePlatformModelRequest = typeof CreatePlatformModelRequest.Type
export const UpdatePlatformModelRequest = Schema.Struct({
	...UpdateModelRequest.fields,
	availability: Schema.optionalKey(Availability),
})
export type UpdatePlatformModelRequest = typeof UpdatePlatformModelRequest.Type

/**
 * A link from a provider to a model. Each value that the link sets
 * replaces the value of the model for this provider only.
 */
export const ProviderModel = Schema.Struct({
	/** The ID of the model. A provider links at most one model with each ID. */
	model: ModelId,
	modelOwner: ModelOwner,
	/** The model name that the provider gets. Leave it out to send the model ID. */
	upstream: Schema.optionalKey(ModelName),
	reasoningEfforts: Schema.optionalKey(Options),
	serviceTiers: Schema.optionalKey(Options),
	inputMediaTypes: Schema.optionalKey(Config.InputMediaTypes),
	contextWindow: Schema.optionalKey(PositiveInt),
	maxOutputTokens: Schema.optionalKey(PositiveInt),
})
export type ProviderModel = typeof ProviderModel.Type
export const ProviderModels = Schema.Array(ProviderModel).check(
	Schema.isMaxLength(200),
	Schema.makeFilter((links: ReadonlyArray<ProviderModel>) =>
		pipe(
			links,
			Arr.map((link) => link.model),
			Arr.dedupe,
		).length === links.length
			? undefined
			: "Expected each model ID only once",
	),
)

export const ModelProvider = Schema.Struct({
	/** A provider ID is unique in the whole platform. A model selection names it. */
	id: Provider.Id,
	owner: ProviderOwner,
	kind: ProviderKind,
	name: Schema.String,
	/** Null means the default address of the provider kind. */
	endpoint: Schema.NullOr(Schema.String),
	apiKey: SecretState,
	models: Schema.Array(ProviderModel),
	/** Only providers of the platform have it. */
	availability: Schema.NullOr(Availability),
	version: Version,
	createdAt: Schema.String,
	updatedAt: Schema.String,
})
export type ModelProvider = typeof ModelProvider.Type

const ProviderName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(120),
)
export const CreateModelProviderRequest = Schema.Struct({
	kind: ProviderKind,
	name: ProviderName,
	/** An `openai-compat` or `typesafe` provider needs it. */
	endpoint: Schema.optionalKey(Endpoint),
	apiKey: SecretInput,
	models: ProviderModels,
})
export type CreateModelProviderRequest = typeof CreateModelProviderRequest.Type
export const UpdateModelProviderRequest = Schema.Struct({
	expectedVersion: Version,
	name: Schema.optionalKey(ProviderName),
	endpoint: Schema.optionalKey(Schema.NullOr(Endpoint)),
	/** Leave it out to keep the current key. */
	apiKey: Schema.optionalKey(SecretInput),
	models: Schema.optionalKey(ProviderModels),
})
export type UpdateModelProviderRequest = typeof UpdateModelProviderRequest.Type
export const CreatePlatformModelProviderRequest = Schema.Struct({
	...CreateModelProviderRequest.fields,
	availability: Availability,
})
export type CreatePlatformModelProviderRequest =
	typeof CreatePlatformModelProviderRequest.Type
export const UpdatePlatformModelProviderRequest = Schema.Struct({
	...UpdateModelProviderRequest.fields,
	availability: Schema.optionalKey(Availability),
})
export type UpdatePlatformModelProviderRequest =
	typeof UpdatePlatformModelProviderRequest.Type

/**
 * The models that the organization can use now. Each item is one model of one
 * provider, with the values of the link already applied.
 */
export const ModelCatalog = Schema.Struct({
	providers: Schema.Array(
		Schema.Struct({
			id: Provider.Id,
			owner: ProviderOwner,
			kind: ProviderKind,
			name: Schema.String,
		}),
	),
	models: Schema.Array(
		Schema.Struct({
			provider: Provider.Id,
			id: CoreModel.Id,
			owner: ModelOwner,
			type: ModelType,
			name: Schema.String,
			reasoningEfforts: Schema.Array(Schema.String),
			serviceTiers: Schema.Array(Schema.String),
			inputMediaTypes: Schema.optionalKey(Config.InputMediaTypes),
			contextWindow: Schema.optionalKey(PositiveInt),
			maxOutputTokens: Schema.optionalKey(PositiveInt),
			/** The current price at this provider. Missing when the model has no price. */
			price: Schema.optionalKey(ModelPrice),
		}),
	),
})
export type ModelCatalog = typeof ModelCatalog.Type

export class ModelProviderNotFound extends Schema.TaggedError<
	ModelProviderNotFound,
	{ readonly brand: unique symbol }
>()("ModelProviderNotFound", { providerId: Provider.Id }) {}
export class ModelProviderConflict extends Schema.TaggedError<
	ModelProviderConflict,
	{ readonly brand: unique symbol }
>()("ModelProviderConflict", { version: Version }) {}
export class ModelProviderInvalid extends Schema.TaggedError<
	ModelProviderInvalid,
	{ readonly brand: unique symbol }
>()("ModelProviderInvalid", { message: Schema.String }) {}
/** A setting still names the provider, such as the Rules model. Change the setting first. */
export class ModelProviderInUse extends Schema.TaggedError<
	ModelProviderInUse,
	{ readonly brand: unique symbol }
>()("ModelProviderInUse", { providerId: Provider.Id }) {}
export class ModelNotFound extends Schema.TaggedError<
	ModelNotFound,
	{ readonly brand: unique symbol }
>()("ModelNotFound", { modelId: CoreModel.Id }) {}
export class ModelConflict extends Schema.TaggedError<
	ModelConflict,
	{ readonly brand: unique symbol }
>()("ModelConflict", { version: Version }) {}
/** A provider still links the model, or a setting names it. Remove those first. */
export class ModelInUse extends Schema.TaggedError<
	ModelInUse,
	{ readonly brand: unique symbol }
>()("ModelInUse", {
	modelId: CoreModel.Id,
}) {}
export class ModelProvidersUnavailable extends Schema.TaggedError<
	ModelProvidersUnavailable,
	{ readonly brand: unique symbol }
>()("ModelProvidersUnavailable", {}) {}
export const ModelProviderErrors = [
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
		"Adds a model provider with the API key of the organization.",
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
