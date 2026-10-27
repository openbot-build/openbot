import { Array as Arr, Schema } from "effect"
import { PublicOrigin } from "./Settings.ts"
import { SecretInput, SecretState } from "./Secret.ts"
import { ConnectionId } from "./ConnectionId.ts"
import { BotId } from "./BotId.ts"
import { Version } from "./Version.ts"

const Text = (max: number) =>
	Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))

export const VaultId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/VaultId"))
export type VaultId = typeof VaultId.Type

export const VaultItemId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/VaultItemId"))
export type VaultItemId = typeof VaultItemId.Type

export const SecretProviderId = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(128),
).pipe(Schema.brand("@openbot-build/domain/SecretProviderId"))
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
	App: { connection: ConnectionId, tool: Schema.NullOr(Text(256)) },
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

/** A saved name keeps the same item and fields when a program resumes. */
export const ReferenceBinding = Schema.Struct({
	alias: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)),
	item: VaultItemId,
	fields: Schema.Array(VaultFieldName),
})
export type ReferenceBinding = typeof ReferenceBinding.Type

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
