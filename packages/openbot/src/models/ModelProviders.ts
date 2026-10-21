import type { ModelProvidersApi } from "@openbot-build/api"
import { Context, type Effect, type Option, type Redacted } from "effect"

/** The platform owns shared providers. An organization owns its own providers. */
export type Owner =
	| { readonly kind: "platform" }
	| { readonly kind: "organization"; readonly id: string }

export const platformOwner: Owner = { kind: "platform" }
export const organizationOwner = (id: string): Owner => ({
	kind: "organization",
	id,
})

/** A stored provider. The key stays sealed until a model needs it. */
export interface Stored {
	readonly id: string
	readonly owner: Owner
	readonly kind: ModelProvidersApi.ProviderKind
	readonly name: string
	readonly endpoint: string | null
	readonly apiKey: string
	readonly apiKeyHint: string | null
	readonly models: ReadonlyArray<ModelProvidersApi.ModelEntry>
	readonly availability: ModelProvidersApi.Availability | null
	readonly version: number
	readonly createdAt: number
	readonly updatedAt: number
}

export type Errors =
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

/** Whether an organization may use a provider. */
export const usableBy = ({
	provider,
	organizationId,
}: {
	readonly provider: Stored
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

/** The API form. The key only shows whether it is set and its last characters. */
export const view = (provider: Stored): ModelProvidersApi.ModelProvider => ({
	id: provider.id,
	owner: provider.owner.kind,
	kind: provider.kind,
	name: provider.name,
	endpoint: provider.endpoint,
	apiKey: { set: true, hint: provider.apiKeyHint },
	models: provider.models,
	availability: provider.availability,
	version: provider.version,
	createdAt: new Date(provider.createdAt).toISOString(),
	updatedAt: new Date(provider.updatedAt).toISOString(),
})
