import { Array as Arr, Schema } from "effect"
import {
	HttpApi,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
	OpenApi,
} from "effect/http-api"
import { BotId } from "./BotsApi.ts"
import { BotAuth } from "./AuthApi.ts"
import {
	Authorize,
	AuthorizationErrors,
	GroupRequired,
} from "./Authorization.ts"
import { PublicOrigin, SecretInput, SecretState, Version } from "./Settings.ts"

export const VaultId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/VaultId"))
export type VaultId = typeof VaultId.Type

export const VaultItemId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/VaultItemId"))
export type VaultItemId = typeof VaultItemId.Type

export const SecretProviderId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/api/SecretProviderId"))
export type SecretProviderId = typeof SecretProviderId.Type

/**
 * A member owns their own Vaults and secret providers. Only they and their Bots
 * can use them. The organization owns shared ones. Policies decide who can use them.
 */
export const VaultOwner = Schema.TaggedUnion({
	Member: { userId: Schema.String },
	Organization: {},
})
export type VaultOwner = typeof VaultOwner.Type

const Text = (max: number) =>
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))

/** The secrets that OpenBot uses to read a secret provider. They go in, but they never come out. */
export const SecretProviderCredentials = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("onepassword"),
		/** The address of the 1Password Connect server. */
		url: PublicOrigin,
		/** A Connect token. Give it access to only the 1Password vaults that Bots may use. */
		token: SecretInput,
	}),
	Schema.Struct({
		kind: Schema.Literal("bitwarden"),
		/** The address of `bw serve`. The vault must be unlocked. */
		url: PublicOrigin,
		/** Optional. OpenBot sends it as a bearer token, for a proxy in front of `bw serve`. */
		token: Schema.optionalKey(SecretInput),
	}),
	Schema.Struct({
		kind: Schema.Literal("hashicorp"),
		url: PublicOrigin,
		/** A Vault token. Give it a policy that can only read the paths that Bots may use. */
		token: SecretInput,
		/** The path of the KV version 2 engine. Without it, OpenBot uses `secret`. */
		mount: Schema.optionalKey(Text(256)),
		/** The namespace of Vault Enterprise or OpenBao. */
		namespace: Schema.optionalKey(Text(256)),
	}),
])
export type SecretProviderCredentials = typeof SecretProviderCredentials.Type

/**
 * A service that keeps secrets, which OpenBot reads.
 * `onepassword`: a 1Password Connect server.
 * `bitwarden`: the API of `bw serve`, the Bitwarden command line tool. It works with Bitwarden and Vaultwarden.
 * `hashicorp`: the KV version 2 engine of HashiCorp Vault or OpenBao.
 * It comes from `SecretProviderCredentials`.
 */
export const SecretProviderKind = Schema.Literals(
	Arr.map(
		SecretProviderCredentials.members,
		(member) => member.fields.kind.literal,
	),
)
export type SecretProviderKind = typeof SecretProviderKind.Type

/** What the API shows of the secrets of a secret provider. */
export const SecretProviderCredentialsView = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("onepassword"),
		url: Schema.String,
		token: SecretState,
	}),
	Schema.Struct({
		kind: Schema.Literal("bitwarden"),
		url: Schema.String,
		token: SecretState,
	}),
	Schema.Struct({
		kind: Schema.Literal("hashicorp"),
		url: Schema.String,
		token: SecretState,
		mount: Schema.String,
		namespace: Schema.NullOr(Schema.String),
	}),
])
export type SecretProviderCredentialsView =
	typeof SecretProviderCredentialsView.Type

/** An account at a password manager or a secrets service. Vault items read their values from it. */
export const SecretProvider = Schema.Struct({
	id: SecretProviderId,
	kind: SecretProviderKind,
	name: Schema.String,
	owner: VaultOwner,
	credentials: SecretProviderCredentialsView,
	version: Version,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type SecretProvider = typeof SecretProvider.Type

const Name = Text(120)

export const CreateSecretProviderRequest = Schema.Struct({
	name: Name,
	credentials: SecretProviderCredentials,
	/** Shared providers belong to the organization. Other providers belong to the caller. */
	shared: Schema.optionalKey(Schema.Boolean),
})
export type CreateSecretProviderRequest =
	typeof CreateSecretProviderRequest.Type

export const UpdateSecretProviderRequest = Schema.Struct({
	expectedVersion: Version,
	name: Schema.optionalKey(Name),
	/** Leave it out to keep the current secrets. The kind cannot change. */
	credentials: Schema.optionalKey(SecretProviderCredentials),
})
export type UpdateSecretProviderRequest =
	typeof UpdateSecretProviderRequest.Type

/**
 * A collection of secrets that Bots may use but never see. Each item can come
 * from another place: OpenBot itself or any secret provider. Bots use the items
 * only in Code Mode, by name.
 */
export const Vault = Schema.Struct({
	id: VaultId,
	name: Schema.String,
	owner: VaultOwner,
	version: Version,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type Vault = typeof Vault.Type

export const CreateVaultRequest = Schema.Struct({
	name: Name,
	/** Shared Vaults belong to the organization. Other Vaults belong to the caller. */
	shared: Schema.optionalKey(Schema.Boolean),
})
export type CreateVaultRequest = typeof CreateVaultRequest.Type

export const UpdateVaultRequest = Schema.Struct({
	expectedVersion: Version,
	name: Schema.optionalKey(Name),
})
export type UpdateVaultRequest = typeof UpdateVaultRequest.Type

/**
 * The name that a program uses for an item, such as `github` in `vault.github.password`.
 * Small letters, digits and `_`. It starts with a letter.
 */
export const VaultItemName = Schema.String.check(
	Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/),
)
export type VaultItemName = typeof VaultItemName.Type

/** The name of one field of an item, such as `password`. It has no `/`, `⟦` or `⟧`. */
export const VaultFieldName = Schema.String.check(
	Schema.isPattern(/^[^/⟦⟧\u0000-\u001f]{1,64}$/),
)
export type VaultFieldName = typeof VaultFieldName.Type

/**
 * Where the values of an item are.
 * `Builtin`: OpenBot keeps them itself, sealed with `OPENBOT_SECRET_KEYS`.
 * `OnePassword`: the IDs of a 1Password vault and of an item in it.
 * `Bitwarden`: the ID of an item.
 * `HashiCorp`: the path of a secret in the KV engine, such as `bots/github`.
 * The `provider` must be of the same kind as the tag.
 */
export const VaultItemSource = Schema.TaggedUnion({
	Builtin: {},
	OnePassword: {
		provider: SecretProviderId,
		vault: Text(128),
		item: Text(128),
	},
	Bitwarden: { provider: SecretProviderId, item: Text(128) },
	HashiCorp: { provider: SecretProviderId, path: Text(512) },
})
export type VaultItemSource = typeof VaultItemSource.Type

/**
 * A place where the values of an item may go. Nothing else gets them.
 * `App`: the arguments of a tool of one App connection. `tool: null` allows every tool of the connection.
 */
export const VaultExit = Schema.TaggedUnion({
	App: { connection: Text(128), tool: Schema.NullOr(Text(256)) },
})
export type VaultExit = typeof VaultExit.Type

/**
 * One secret thing in a Vault, such as a login. A program uses its fields only by
 * reference, and OpenBot puts the values in only where `exits` allows.
 */
export const VaultItem = Schema.Struct({
	id: VaultItemId,
	vault: VaultId,
	name: VaultItemName,
	/** Tells the Bot what the item is for. It must not hold a secret. */
	description: Schema.String,
	source: VaultItemSource,
	/** The fields that programs may use. */
	fields: Schema.Array(VaultFieldName),
	exits: Schema.Array(VaultExit),
	version: Version,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
})
export type VaultItem = typeof VaultItem.Type

const Description = Schema.String.check(Schema.isMaxLength(500))
const Fields = Schema.Array(VaultFieldName).check(
	Schema.isMinLength(1),
	Schema.isMaxLength(32),
)
const Exits = Schema.Array(VaultExit).check(Schema.isMaxLength(32))
/** The values of a `Builtin` item, by field. They go in, but they never come out. */
const Values = Schema.Record(VaultFieldName, SecretInput)

export const CreateVaultItemRequest = Schema.Struct({
	name: VaultItemName,
	description: Schema.optionalKey(Description),
	source: VaultItemSource,
	/** For a `Builtin` item, leave it out: the fields are the keys of `values`. */
	fields: Schema.optionalKey(Fields),
	/** Only for a `Builtin` item. */
	values: Schema.optionalKey(Values),
	exits: Exits,
})
export type CreateVaultItemRequest = typeof CreateVaultItemRequest.Type

export const UpdateVaultItemRequest = Schema.Struct({
	expectedVersion: Version,
	name: Schema.optionalKey(VaultItemName),
	description: Schema.optionalKey(Description),
	/** A new place of the values. A `Builtin` item stays `Builtin`. */
	source: Schema.optionalKey(VaultItemSource),
	fields: Schema.optionalKey(Fields),
	/** Only for a `Builtin` item. It takes the place of all values and fields. */
	values: Schema.optionalKey(Values),
	exits: Schema.optionalKey(Exits),
})
export type UpdateVaultItemRequest = typeof UpdateVaultItemRequest.Type

/** The right of one Bot to use every item of one Vault. It ends when the Bot is archived. */
export const VaultAccess = Schema.Struct({
	vault: VaultId,
	bot: BotId,
	/** The member who gave the right. */
	grantedBy: Schema.String,
	grantedAt: Schema.Finite,
})
export type VaultAccess = typeof VaultAccess.Type

export class VaultNotFound extends Schema.TaggedError<
	VaultNotFound,
	{ readonly brand: unique symbol }
>()("VaultNotFound", { id: Schema.String }) {}
export class VaultItemNotFound extends Schema.TaggedError<
	VaultItemNotFound,
	{ readonly brand: unique symbol }
>()("VaultItemNotFound", { id: Schema.String }) {}
export class SecretProviderNotFound extends Schema.TaggedError<
	SecretProviderNotFound,
	{ readonly brand: unique symbol }
>()("SecretProviderNotFound", { id: Schema.String }) {}
/** The provider did not answer, or it failed. The same call can pass later. */
export class SecretProviderFailed extends Schema.TaggedError<
	SecretProviderFailed,
	{ readonly brand: unique symbol }
>()("SecretProviderFailed", { message: Schema.String }) {}
/** Vault items still read from this provider. */
export class SecretProviderInUse extends Schema.TaggedError<
	SecretProviderInUse,
	{ readonly brand: unique symbol }
>()("SecretProviderInUse", { id: Schema.String }) {}
export class VaultConflict extends Schema.TaggedError<
	VaultConflict,
	{ readonly brand: unique symbol }
>()("VaultConflict", { version: Version }) {}
export class VaultInvalid extends Schema.TaggedError<
	VaultInvalid,
	{ readonly brand: unique symbol }
>()("VaultInvalid", { message: Schema.String }) {}
export class VaultsUnavailable extends Schema.TaggedError<
	VaultsUnavailable,
	{ readonly brand: unique symbol }
>()("VaultsUnavailable", {}) {}

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
