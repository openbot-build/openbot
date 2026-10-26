import { Provider } from "@openbot-build/core"
import type { ModelProvidersApi } from "@openbot-build/api"
import {
	Context,
	DateTime,
	type Effect,
	type Option,
	type Redacted,
} from "effect"

/** The platform owns shared providers. An organization owns its own providers. */
export type Owner =
	| { readonly kind: "platform" }
	| { readonly kind: "organization"; readonly id: string }

export const platformOwner: Owner = { kind: "platform" }
export const organizationOwner = (id: string): Owner => ({
	kind: "organization",
	id,
})

/** The owner columns of the provider and model tables. */
export const ownerColumns = (owner: Owner) =>
	owner.kind === "platform"
		? { ownerKind: "platform", ownerId: "platform" }
		: { ownerKind: "organization", ownerId: owner.id }
export const ownerOf = (columns: {
	readonly ownerKind: string
	readonly ownerId: string
}): Owner =>
	columns.ownerKind === "platform"
		? platformOwner
		: organizationOwner(columns.ownerId)

/** A stored provider. The key stays sealed until a model needs it. */
export interface Stored {
	readonly id: string
	readonly owner: Owner
	readonly kind: ModelProvidersApi.ProviderKind
	readonly name: string
	readonly endpoint: string | null
	readonly apiKey: string
	readonly apiKeyHint: string | null
	/** The links to the models that the provider offers, in order. */
	readonly models: ReadonlyArray<ModelProvidersApi.ProviderModel>
	readonly availability: ModelProvidersApi.Availability | null
	readonly version: number
	readonly createdAt: number
	readonly updatedAt: number
}

export type Errors =
	| ModelProvidersApi.ModelNotFound
	| ModelProvidersApi.ModelProviderNotFound
	| ModelProvidersApi.ModelProviderConflict
	| ModelProvidersApi.ModelProviderInvalid
	| ModelProvidersApi.ModelProvidersUnavailable

/** The model providers of the platform and of each organization, with their keys. */
export class ModelProviders extends Context.Service<
	ModelProviders,
	{
		readonly list: (
			owner: Owner,
		) => Effect.Effect<
			ReadonlyArray<Stored>,
			ModelProvidersApi.ModelProvidersUnavailable
		>
		readonly get: (
			owner: Owner,
			id: string,
		) => Effect.Effect<
			Option.Option<Stored>,
			ModelProvidersApi.ModelProvidersUnavailable
		>
		/** The providers that an organization can use: its own, and the shared ones it may use. */
		readonly available: (
			organizationId: string,
		) => Effect.Effect<
			ReadonlyArray<Stored>,
			ModelProvidersApi.ModelProvidersUnavailable
		>
		readonly create: (
			owner: Owner,
			input: ModelProvidersApi.CreatePlatformModelProviderRequest,
		) => Effect.Effect<Stored, Errors>
		readonly update: (
			owner: Owner,
			id: string,
			patch: ModelProvidersApi.UpdatePlatformModelProviderRequest,
		) => Effect.Effect<Stored, Errors>
		readonly delete: (owner: Owner, id: string) => Effect.Effect<void, Errors>
		readonly openKey: (
			provider: Stored,
		) => Effect.Effect<
			Redacted.Redacted<string>,
			ModelProvidersApi.ModelProvidersUnavailable
		>
	}
>()("@openbot-build/openbot/models/ModelProviders") {}

/** Whether an organization may use a provider or a model. */
export const usableBy = ({
	provider,
	organizationId,
}: {
	readonly provider: {
		readonly owner: Owner
		readonly availability: ModelProvidersApi.Availability | null
	}
	readonly organizationId: string
}) => {
	if (provider.owner.kind === "organization")
		return provider.owner.id === organizationId
	const availability = provider.availability
	if (availability === null) return false
	switch (availability._tag) {
		case "All":
			return true
		case "None":
			return false
		case "Selected":
			return availability.organizations.includes(organizationId)
	}
}

/** The owner of a model that a link names. Only an organization's own providers link its models. */
export const linkedOwner = ({
	provider,
	link,
}: {
	readonly provider: { readonly owner: Owner }
	readonly link: ModelProvidersApi.ProviderModel
}): Owner =>
	link.modelOwner === "platform" || provider.owner.kind === "platform"
		? platformOwner
		: provider.owner

/** The API form. The key only shows whether it is set and its last characters. */
export const view = (provider: Stored): ModelProvidersApi.ModelProvider => ({
	id: Provider.Id.make(provider.id),
	owner: provider.owner.kind,
	kind: provider.kind,
	name: provider.name,
	endpoint: provider.endpoint,
	apiKey: { set: true, hint: provider.apiKeyHint },
	models: provider.models,
	availability: provider.availability,
	version: provider.version,
	createdAt: DateTime.formatIso(DateTime.makeUnsafe(provider.createdAt)),
	updatedAt: DateTime.formatIso(DateTime.makeUnsafe(provider.updatedAt)),
})
