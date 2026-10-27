import { Model } from "@openbot-build/core"
import type { ModelProvidersApi } from "@openbot-build/api"
import { Context, DateTime, type Effect, type Option } from "effect"
import type { Owner } from "./ModelProviders.ts"

/** A stored model. It does not belong to a provider. */
export interface StoredModel {
	readonly owner: Owner
	readonly id: string
	readonly type: ModelProvidersApi.ModelType
	readonly name: string
	readonly reasoningEfforts: ReadonlyArray<string>
	readonly serviceTiers: ReadonlyArray<string>
	readonly contextWindow: number | null
	readonly maxOutputTokens: number | null
	readonly availability: ModelProvidersApi.Availability | null
	readonly version: number
	readonly createdAt: number
	readonly updatedAt: number
}

export type Errors =
	| ModelProvidersApi.ModelNotFound
	| ModelProvidersApi.ModelConflict
	| ModelProvidersApi.ModelInUse
	| ModelProvidersApi.ModelProviderInvalid
	| ModelProvidersApi.ModelProvidersUnavailable

/** The models of the platform and of each organization. */
export class Models extends Context.Service<
	Models,
	{
		readonly list: (
			owner: Owner,
		) => Effect.Effect<
			ReadonlyArray<StoredModel>,
			ModelProvidersApi.ModelProvidersUnavailable
		>
		readonly get: (
			owner: Owner,
			id: string,
		) => Effect.Effect<
			Option.Option<StoredModel>,
			ModelProvidersApi.ModelProvidersUnavailable
		>
		/** The models that an organization can use: its own, and the shared ones it may use. */
		readonly available: (
			organizationId: string,
		) => Effect.Effect<
			ReadonlyArray<StoredModel>,
			ModelProvidersApi.ModelProvidersUnavailable
		>
		readonly create: (
			owner: Owner,
			input: ModelProvidersApi.CreatePlatformModelRequest,
		) => Effect.Effect<StoredModel, Errors>
		readonly update: (
			owner: Owner,
			id: string,
			patch: ModelProvidersApi.UpdatePlatformModelRequest,
		) => Effect.Effect<StoredModel, Errors>
		/**
		 * A provider of the same owner that links the model stops the delete.
		 * Links from the providers of organizations to a shared model go away
		 * with it.
		 */
		readonly delete: (owner: Owner, id: string) => Effect.Effect<void, Errors>
	}
>()("@openbot-build/openbot/models/Models") {}

/** A key that finds a model by its owner and ID. `HashMap` compares it by value. */
export const modelKey = ({
	owner,
	id,
}: {
	readonly owner: Owner
	readonly id: string
}) => [owner.kind, owner.kind === "platform" ? "" : owner.id, id] as const

/** The API form. */
export const view = (model: StoredModel): ModelProvidersApi.Model => ({
	id: Model.Id.make(model.id),
	owner: model.owner.kind,
	type: model.type,
	name: model.name,
	reasoningEfforts: model.reasoningEfforts,
	serviceTiers: model.serviceTiers,
	...(model.contextWindow === null
		? {}
		: { contextWindow: model.contextWindow }),
	...(model.maxOutputTokens === null
		? {}
		: { maxOutputTokens: model.maxOutputTokens }),
	availability: model.availability,
	version: model.version,
	createdAt: DateTime.formatIso(DateTime.makeUnsafe(model.createdAt)),
	updatedAt: DateTime.formatIso(DateTime.makeUnsafe(model.updatedAt)),
})

/** The values of a model for one provider: the values of the link replace the values of the model. */
export const effective = ({
	model,
	link,
}: {
	readonly model: StoredModel
	readonly link: ModelProvidersApi.ProviderModel
}) => ({
	id: Model.Id.make(model.id),
	owner: model.owner.kind,
	type: model.type,
	name: model.name,
	upstream: link.upstream ?? model.id,
	reasoningEfforts: link.reasoningEfforts ?? model.reasoningEfforts,
	serviceTiers: link.serviceTiers ?? model.serviceTiers,
	contextWindow: link.contextWindow ?? model.contextWindow,
	maxOutputTokens: link.maxOutputTokens ?? model.maxOutputTokens,
})
export type Effective = ReturnType<typeof effective>
