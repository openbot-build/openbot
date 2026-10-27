import { BotId } from "@openbot-build/domain"
import {
	VaultId,
	VaultItemId,
	SecretProviderId,
	Vault,
	VaultItem,
	VaultAccess,
	VaultNotFound,
	VaultItemNotFound,
	SecretProviderNotFound,
	SecretProviderFailed,
	SecretProviderInUse,
	VaultConflict,
	VaultInvalid,
	VaultsUnavailable,
} from "@openbot-build/domain/Vaults"
export {
	VaultId,
	VaultItemId,
	SecretProviderId,
	VaultOwner,
	Vault,
	VaultItemName,
	VaultFieldName,
	VaultItemSource,
	VaultExit,
	VaultItem,
	VaultAccess,
	VaultNotFound,
	VaultItemNotFound,
	SecretProviderNotFound,
	SecretProviderFailed,
	SecretProviderInUse,
	VaultConflict,
	VaultInvalid,
	VaultsUnavailable,
} from "@openbot-build/domain/Vaults"
import { Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { BotAuth } from "./AuthApi.ts"
import {
	Authorize,
	AuthorizationErrors,
	GroupRequired,
} from "./Authorization.ts"

import {
	SecretProvider,
	CreateSecretProviderRequest,
	UpdateSecretProviderRequest,
	CreateVaultRequest,
	UpdateVaultRequest,
	CreateVaultItemRequest,
	UpdateVaultItemRequest,
} from "@openbot-build/domain/Vaults"
export {
	SecretProviderCredentials,
	SecretProviderKind,
	SecretProviderCredentialsView,
	SecretProvider,
	CreateSecretProviderRequest,
	UpdateSecretProviderRequest,
	CreateVaultRequest,
	UpdateVaultRequest,
	CreateVaultItemRequest,
	UpdateVaultItemRequest,
} from "@openbot-build/domain/Vaults"

export const VaultErrors = [
	...AuthorizationErrors,
	VaultNotFound.pipe(HttpApiSchema.status(404)),
	VaultItemNotFound.pipe(HttpApiSchema.status(404)),
	SecretProviderNotFound.pipe(HttpApiSchema.status(404)),
	SecretProviderFailed.pipe(HttpApiSchema.status(502)),
	SecretProviderInUse.pipe(HttpApiSchema.status(409)),
	VaultConflict.pipe(HttpApiSchema.status(409)),
	VaultInvalid.pipe(HttpApiSchema.status(400)),
	VaultsUnavailable.pipe(HttpApiSchema.status(503)),
] as const

const providerParams = { providerId: SecretProviderId }
const vaultParams = { vaultId: VaultId }
const itemParams = { vaultId: VaultId, itemId: VaultItemId }

export class SecretProvidersApi extends HttpApiGroup.make("secretProviders")
	.add(
		HttpApiEndpoint.get("listSecretProviders", "/v1/secret-providers", {
			success: Schema.Array(SecretProvider),
			error: VaultErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the secret providers that the caller can use: their own and the shared ones.",
		),
		HttpApiEndpoint.post("createSecretProvider", "/v1/secret-providers", {
			payload: CreateSecretProviderRequest,
			success: SecretProvider.pipe(HttpApiSchema.status(201)),
			error: VaultErrors,
		}).annotate(
			OpenApi.Description,
			"Adds an account at a secret provider. OpenBot checks the token with the provider first.",
		),
		HttpApiEndpoint.get(
			"getSecretProvider",
			"/v1/secret-providers/:providerId",
			{ params: providerParams, success: SecretProvider, error: VaultErrors },
		),
		HttpApiEndpoint.patch(
			"updateSecretProvider",
			"/v1/secret-providers/:providerId",
			{
				params: providerParams,
				payload: UpdateSecretProviderRequest,
				success: SecretProvider,
				error: VaultErrors,
			},
		),
		HttpApiEndpoint.delete(
			"deleteSecretProvider",
			"/v1/secret-providers/:providerId",
			{
				params: providerParams,
				success: HttpApiSchema.NoContent,
				error: VaultErrors,
			},
		).annotate(
			OpenApi.Description,
			"Deletes a secret provider. It fails while Vault items still read from it.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// The resource key depends on the owner, which the path does not show.
	// So the handlers check the permissions themselves.
	.annotate(GroupRequired, { read: [], write: [] })
	.middleware(Authorize)
	.middleware(BotAuth) {}

export class VaultsApi extends HttpApiGroup.make("vaults")
	.add(
		HttpApiEndpoint.get("listVaults", "/v1/vaults", {
			success: Schema.Array(Vault),
			error: VaultErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Vaults that the caller can use: their own and the shared ones.",
		),
		HttpApiEndpoint.post("createVault", "/v1/vaults", {
			payload: CreateVaultRequest,
			success: Vault.pipe(HttpApiSchema.status(201)),
			error: VaultErrors,
		}),
		HttpApiEndpoint.get("getVault", "/v1/vaults/:vaultId", {
			params: vaultParams,
			success: Vault,
			error: VaultErrors,
		}),
		HttpApiEndpoint.patch("updateVault", "/v1/vaults/:vaultId", {
			params: vaultParams,
			payload: UpdateVaultRequest,
			success: Vault,
			error: VaultErrors,
		}),
		HttpApiEndpoint.delete("deleteVault", "/v1/vaults/:vaultId", {
			params: vaultParams,
			success: HttpApiSchema.NoContent,
			error: VaultErrors,
		}).annotate(
			OpenApi.Description,
			"Deletes a Vault, its items and the rights of all Bots to use it. The secret providers keep their secrets.",
		),
		HttpApiEndpoint.get("listVaultItems", "/v1/vaults/:vaultId/items", {
			params: vaultParams,
			success: Schema.Array(VaultItem),
			error: VaultErrors,
		}),
		HttpApiEndpoint.post("createVaultItem", "/v1/vaults/:vaultId/items", {
			params: vaultParams,
			payload: CreateVaultItemRequest,
			success: VaultItem.pipe(HttpApiSchema.status(201)),
			error: VaultErrors,
		}).annotate(
			OpenApi.Description,
			"Adds an item. For an item of a secret provider, the caller must be able to use the provider, and OpenBot reads the item once to check that its fields are there.",
		),
		HttpApiEndpoint.get("getVaultItem", "/v1/vaults/:vaultId/items/:itemId", {
			params: itemParams,
			success: VaultItem,
			error: VaultErrors,
		}),
		HttpApiEndpoint.patch(
			"updateVaultItem",
			"/v1/vaults/:vaultId/items/:itemId",
			{
				params: itemParams,
				payload: UpdateVaultItemRequest,
				success: VaultItem,
				error: VaultErrors,
			},
		),
		HttpApiEndpoint.delete(
			"deleteVaultItem",
			"/v1/vaults/:vaultId/items/:itemId",
			{
				params: itemParams,
				success: HttpApiSchema.NoContent,
				error: VaultErrors,
			},
		),
		HttpApiEndpoint.get("listVaultBots", "/v1/vaults/:vaultId/bots", {
			params: vaultParams,
			success: Schema.Array(VaultAccess),
			error: VaultErrors,
		}).annotate(
			OpenApi.Description,
			"Lists the Bots that have the right to use a Vault.",
		),
		HttpApiEndpoint.put("grantVault", "/v1/vaults/:vaultId/bots/:botId", {
			params: { ...vaultParams, botId: BotId },
			success: VaultAccess,
			error: VaultErrors,
		}).annotate(
			OpenApi.Description,
			"Gives a Bot the right to use every item of a Vault in Code Mode. The caller must be able to use the Vault and to change the Bot.",
		),
		HttpApiEndpoint.delete("revokeVault", "/v1/vaults/:vaultId/bots/:botId", {
			params: { ...vaultParams, botId: BotId },
			success: HttpApiSchema.NoContent,
			error: VaultErrors,
		}).annotate(
			OpenApi.Description,
			"Takes the right to use a Vault away from a Bot.",
		),
	)
	.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })
	// The resource key depends on the owner, which the path does not show.
	// So the handlers check the permissions themselves.
	.annotate(GroupRequired, { read: [], write: [] })
	.middleware(Authorize)
	.middleware(BotAuth) {}
