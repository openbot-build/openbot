import type { BotId } from "@openbot-build/domain/BotId"
import type { Caller } from "@openbot-build/domain/Identity"
import { Vaults as VaultsModel } from "@openbot-build/domain"
import { Context, Effect } from "effect"
import * as Check from "@openbot-build/identity-contract/authorization/Check"
import { VaultReadFailed } from "./Readers.ts"

type Vault = VaultsModel.Vault

type Item = VaultsModel.VaultItem

export type Failure =
	| VaultsModel.SecretProviderInUse
	| VaultsModel.SecretProviderFailed
	| VaultsModel.VaultNotFound
	| VaultsModel.VaultItemNotFound
	| VaultsModel.SecretProviderNotFound
	| VaultsModel.VaultConflict
	| VaultsModel.VaultInvalid
	| VaultsModel.VaultsUnavailable
	| Check.Errors

/** What a Bot may know about an item it may use. It has no values. */
export interface Usable {
	readonly item: Item
	readonly vaultName: string
}

/**
 * The Vaults of an organization, their items, and the rights of Bots to use them.
 * A Vault is only a collection: each item says where its values are. Values never
 * come out of the API. Only Code Mode reads them, with `reveal`.
 */
export class Vaults extends Context.Service<
	Vaults,
	{
		readonly list: (
			caller: Caller,
		) => Effect.Effect<ReadonlyArray<Vault>, Failure>
		readonly get: (
			caller: Caller,
			id: string,
			action?: "read" | "use" | "write",
		) => Effect.Effect<Vault, Failure>
		readonly create: (
			caller: Caller,
			input: VaultsModel.CreateVaultRequest,
		) => Effect.Effect<Vault, Failure>
		readonly update: (
			caller: Caller,
			id: string,
			input: VaultsModel.UpdateVaultRequest,
		) => Effect.Effect<Vault, Failure>
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<void, Failure>
		readonly items: (
			caller: Caller,
			vaultId: string,
		) => Effect.Effect<ReadonlyArray<Item>, Failure>
		readonly item: (
			caller: Caller,
			vaultId: string,
			itemId: string,
		) => Effect.Effect<Item, Failure>
		readonly createItem: (
			caller: Caller,
			vaultId: string,
			input: VaultsModel.CreateVaultItemRequest,
		) => Effect.Effect<Item, Failure>
		readonly updateItem: (
			caller: Caller,
			vaultId: string,
			itemId: string,
			input: VaultsModel.UpdateVaultItemRequest,
		) => Effect.Effect<Item, Failure>
		readonly removeItem: (
			caller: Caller,
			vaultId: string,
			itemId: string,
		) => Effect.Effect<void, Failure>
		readonly bots: (
			caller: Caller,
			vaultId: string,
		) => Effect.Effect<ReadonlyArray<VaultsModel.VaultAccess>, Failure>
		readonly grant: (
			caller: Caller,
			vaultId: string,
			bot: BotId,
		) => Effect.Effect<VaultsModel.VaultAccess, Failure>
		readonly revoke: (
			caller: Caller,
			vaultId: string,
			bot: BotId,
		) => Effect.Effect<void, Failure>
		/** The items of the Vaults that a Bot has the right to use. It checks no permission. An archived Bot has none. */
		readonly usable: (
			organizationId: string,
			bot: string,
		) => Effect.Effect<ReadonlyArray<Usable>, VaultsModel.VaultsUnavailable>
		/** The values of fields of an item, for Code Mode only. It checks no permission. */
		readonly reveal: (
			organizationId: string,
			itemId: string,
			fields: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyMap<string, string>, VaultReadFailed>
	}
>()("@openbot-build/apps-contract/vaults/Vaults") {}

export { type Vault, type Item }
