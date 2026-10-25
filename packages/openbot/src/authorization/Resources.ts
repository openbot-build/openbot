import {
	Authorization,
	type BotsApi,
	type ComputersApi,
	type TriggersApi,
	type VaultsApi,
} from "@openbot-build/api"

/**
 * The member at the top of the owner tree of a Bot.
 * It is `null` when the organization owns the Bot at the top.
 */
export const rootOf = (owner: BotsApi.BotOwner): string | null => {
	switch (owner._tag) {
		case "Organization":
			return null
		case "Member":
		case "Bot":
			return owner.userId
	}
}

/**
 * The resource value of a Bot. Shared Bots, and the Bots below them, have no
 * owner. The other Bots belong to the member at the top of their owner tree.
 */
export const botResource = (bot: {
	readonly organizationId: string
	readonly id: string
	readonly owner: BotsApi.BotOwner
}) =>
	Authorization.Bot.make({
		organizationId: bot.organizationId,
		ownerUserId: rootOf(bot.owner),
		id: bot.id,
	})

const ownerOf = (
	owner:
		| TriggersApi.TriggerOwner
		| ComputersApi.ComputerOwner
		| VaultsApi.VaultOwner,
): string | null => (owner._tag === "Member" ? owner.userId : null)

export const triggerResource = (trigger: {
	readonly organizationId: string
	readonly id: string
	readonly owner: TriggersApi.TriggerOwner
}) =>
	Authorization.Trigger.make({
		organizationId: trigger.organizationId,
		ownerUserId: ownerOf(trigger.owner),
		id: trigger.id,
	})

export const computerResource = (computer: {
	readonly organizationId: string
	readonly id: string
	readonly owner: ComputersApi.ComputerOwner
}) =>
	Authorization.Computer.make({
		organizationId: computer.organizationId,
		ownerUserId: ownerOf(computer.owner),
		id: computer.id,
	})

export const computerProviderResource = (provider: {
	readonly organizationId: string
	readonly id: string
	readonly owner: ComputersApi.ComputerOwner
}) =>
	Authorization.ComputerProvider.make({
		organizationId: provider.organizationId,
		ownerUserId: ownerOf(provider.owner),
		id: provider.id,
	})

export const vaultResource = (vault: {
	readonly organizationId: string
	readonly id: string
	readonly owner: VaultsApi.VaultOwner
}) =>
	Authorization.Vault.make({
		organizationId: vault.organizationId,
		ownerUserId: ownerOf(vault.owner),
		id: vault.id,
	})

export const secretProviderResource = (provider: {
	readonly organizationId: string
	readonly id: string
	readonly owner: VaultsApi.VaultOwner
}) =>
	Authorization.SecretProvider.make({
		organizationId: provider.organizationId,
		ownerUserId: ownerOf(provider.owner),
		id: provider.id,
	})
