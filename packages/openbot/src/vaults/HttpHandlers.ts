import {
	type Caller,
	Identity,
	OpenBotApi,
	type OrganizationApi,
	type VaultsApi,
} from "@openbot-build/api"
import { Effect, type Schema } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import * as Failures from "../app/Failures.ts"
import { AuditLog } from "../audit/AuditLog.ts"
import { secretProviderKey, vaultKey } from "../audit/Resources.ts"
import { SecretProviders } from "./SecretProviders.ts"
import { unavailable, Vaults } from "./Vaults.ts"

/** Runs a call of a service as the caller of the request. */
const as = <A, E>(work: (caller: Caller) => Effect.Effect<A, E>) =>
	Effect.flatMap(Identity, work)

/**
 * Runs a change and its audit entry as one step. A client that closes the
 * connection must not stop the audit entry after the change is done.
 */
const audited = <A, E>(work: (caller: Caller) => Effect.Effect<A, E>) =>
	Effect.uninterruptible(as(work))

export const layerProviders = HttpApiBuilder.group(
	OpenBotApi,
	"secretProviders",
	(handlers) =>
		Effect.gen(function* () {
			const providers = yield* SecretProviders
			const audit = yield* AuditLog
			const record = (
				caller: Caller,
				action: OrganizationApi.AuditAction,
				provider: Pick<VaultsApi.SecretProvider, "id" | "owner">,
				details: Schema.JsonObject,
			) =>
				audit
					.record({
						organizationId: caller.organizationId,
						action,
						actor: caller,
						resource: secretProviderKey({
							organizationId: caller.organizationId,
							id: provider.id,
							owner: provider.owner,
						}),
						details,
					})
					.pipe(
						Failures.replace(
							"OpenBot could not write the audit entry of a secret provider.",
							unavailable,
						),
					)
			return handlers
				.handle("listSecretProviders", () =>
					as((caller) => providers.list(caller)),
				)
				.handle("createSecretProvider", ({ payload }) =>
					audited((caller) =>
						Effect.tap(providers.create(caller, payload), (provider) =>
							record(caller, "secret_provider.created", provider, {
								kind: provider.kind,
							}),
						),
					),
				)
				.handle("getSecretProvider", ({ params }) =>
					as((caller) => providers.get(caller, params.providerId)),
				)
				.handle("updateSecretProvider", ({ params, payload }) =>
					audited((caller) =>
						Effect.tap(
							providers.update(caller, params.providerId, payload),
							(provider) =>
								record(caller, "secret_provider.updated", provider, {
									tokenChanged: payload.credentials !== undefined,
								}),
						),
					),
				)
				.handle("deleteSecretProvider", ({ params }) =>
					audited((caller) =>
						Effect.gen(function* () {
							const provider = yield* providers.get(
								caller,
								params.providerId,
								"write",
							)
							yield* providers.remove(caller, params.providerId)
							yield* record(caller, "secret_provider.deleted", provider, {})
						}),
					),
				)
		}),
)

export const layer = HttpApiBuilder.group(OpenBotApi, "vaults", (handlers) =>
	Effect.gen(function* () {
		const vaults = yield* Vaults
		const audit = yield* AuditLog
		const record = (
			caller: Caller,
			action: OrganizationApi.AuditAction,
			vault: Pick<VaultsApi.Vault, "id" | "owner">,
			details: Schema.JsonObject,
		) =>
			audit
				.record({
					organizationId: caller.organizationId,
					action,
					actor: caller,
					resource: vaultKey({
						organizationId: caller.organizationId,
						id: vault.id,
						owner: vault.owner,
					}),
					details,
				})
				.pipe(
					Failures.replace(
						"OpenBot could not write the audit entry of a Vault.",
						unavailable,
					),
				)
		/** Records a change in a Vault. The caller could change it, so the caller can read it. */
		const recordIn = (
			caller: Caller,
			vaultId: string,
			action: OrganizationApi.AuditAction,
			details: Schema.JsonObject,
		) =>
			Effect.flatMap(vaults.get(caller, vaultId), (vault) =>
				record(caller, action, vault, details),
			)
		return handlers
			.handle("listVaults", () => as((caller) => vaults.list(caller)))
			.handle("createVault", ({ payload }) =>
				audited((caller) =>
					Effect.tap(vaults.create(caller, payload), (vault) =>
						record(caller, "vault.created", vault, {}),
					),
				),
			)
			.handle("getVault", ({ params }) =>
				as((caller) => vaults.get(caller, params.vaultId)),
			)
			.handle("updateVault", ({ params, payload }) =>
				audited((caller) =>
					Effect.tap(vaults.update(caller, params.vaultId, payload), (vault) =>
						record(caller, "vault.updated", vault, {}),
					),
				),
			)
			.handle("deleteVault", ({ params }) =>
				audited((caller) =>
					Effect.gen(function* () {
						const vault = yield* vaults.get(caller, params.vaultId, "write")
						yield* vaults.remove(caller, params.vaultId)
						yield* record(caller, "vault.deleted", vault, {})
					}),
				),
			)
			.handle("listVaultItems", ({ params }) =>
				as((caller) => vaults.items(caller, params.vaultId)),
			)
			.handle("createVaultItem", ({ params, payload }) =>
				audited((caller) =>
					Effect.tap(
						vaults.createItem(caller, params.vaultId, payload),
						(item) =>
							recordIn(caller, params.vaultId, "vault.item.created", {
								item: item.id,
								name: item.name,
								source: item.source._tag,
							}),
					),
				),
			)
			.handle("getVaultItem", ({ params }) =>
				as((caller) => vaults.item(caller, params.vaultId, params.itemId)),
			)
			.handle("updateVaultItem", ({ params, payload }) =>
				audited((caller) =>
					Effect.tap(
						vaults.updateItem(caller, params.vaultId, params.itemId, payload),
						(item) =>
							recordIn(caller, params.vaultId, "vault.item.updated", {
								item: item.id,
								valuesChanged: payload.values !== undefined,
								sourceChanged: payload.source !== undefined,
								exitsChanged: payload.exits !== undefined,
							}),
					),
				),
			)
			.handle("deleteVaultItem", ({ params }) =>
				audited((caller) =>
					Effect.gen(function* () {
						yield* vaults.removeItem(caller, params.vaultId, params.itemId)
						yield* recordIn(caller, params.vaultId, "vault.item.deleted", {
							item: params.itemId,
						})
					}),
				),
			)
			.handle("listVaultBots", ({ params }) =>
				as((caller) => vaults.bots(caller, params.vaultId)),
			)
			.handle("grantVault", ({ params }) =>
				audited((caller) =>
					Effect.tap(vaults.grant(caller, params.vaultId, params.botId), () =>
						recordIn(caller, params.vaultId, "vault.granted", {
							bot: params.botId,
						}),
					),
				),
			)
			.handle("revokeVault", ({ params }) =>
				audited((caller) =>
					Effect.gen(function* () {
						yield* vaults.revoke(caller, params.vaultId, params.botId)
						yield* recordIn(caller, params.vaultId, "vault.revoked", {
							bot: params.botId,
						})
					}),
				),
			)
	}),
)
