import { randomBytes } from "node:crypto"
import { BotsApi, type Caller, VaultsApi } from "@openbot-build/api"
import { and, eq, inArray } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import type { Services as AuthorizationServices } from "../authorization/Check.ts"
import {
	type Errors as CheckErrors,
	check,
	filter,
	guard,
} from "../authorization/Check.ts"
import { vaultResource } from "../authorization/Resources.ts"
import { toWhere } from "../authorization/Sql.ts"
import { Bots } from "../bots/Bots.ts"
import * as Db from "../database/Database.ts"
import { vaultAccess, vaultItems, vaults } from "../database/Schema.ts"
import { Secrets } from "../secrets/Secrets.ts"
import { Readers, VaultReadFailed } from "./Readers.ts"
import { SecretProviders } from "./SecretProviders.ts"

type Vault = VaultsApi.Vault
type Item = VaultsApi.VaultItem
type Source = VaultsApi.VaultItemSource

export type Failure =
	| VaultsApi.VaultNotFound
	| VaultsApi.VaultItemNotFound
	| VaultsApi.SecretProviderNotFound
	| VaultsApi.VaultConflict
	| VaultsApi.VaultInvalid
	| VaultsApi.VaultsUnavailable
	| CheckErrors

/** What a Bot may know about an item it may use. It has no values. */
export interface Usable {
	readonly item: Item
	readonly vaultName: string
}

export const unavailable = () => VaultsApi.VaultsUnavailable.make({})
const invalid = (message: string) => VaultsApi.VaultInvalid.make({ message })
const notFound = (id: string) => VaultsApi.VaultNotFound.make({ id })
const itemNotFound = (id: string) => VaultsApi.VaultItemNotFound.make({ id })

const valuesBinding = (id: string) => `openbot_vault_items:${id}:values`

/** The kind of secret provider that each source of a provider needs. */
const kindOf = {
	OnePassword: "onepassword",
	Bitwarden: "bitwarden",
	HashiCorp: "hashicorp",
} as const satisfies Record<
	Exclude<Source["_tag"], "Builtin">,
	VaultsApi.SecretProviderKind
>

const providerOf = (source: Source) =>
	source._tag === "Builtin" ? null : source.provider

/** The values column holds JSON that only this file writes, from a checked request. */
const decodeValues = Schema.decodeUnknownEffect(
	Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
)
const decodeSource = Schema.decodeUnknownSync(
	Schema.fromJsonString(VaultsApi.VaultItemSource),
)
const decodeFields = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Array(VaultsApi.VaultFieldName)),
)
const decodeExits = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Array(VaultsApi.VaultExit)),
)

type VaultRow = typeof vaults.$inferSelect
type ItemRow = typeof vaultItems.$inferSelect

const fromRow = (row: VaultRow): Vault => ({
	id: VaultsApi.VaultId.make(row.id),
	name: row.name,
	owner:
		row.ownerUserId === null
			? { _tag: "Organization" }
			: { _tag: "Member", userId: row.ownerUserId },
	version: row.version,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

const fromItemRow = (row: ItemRow): Item => ({
	id: VaultsApi.VaultItemId.make(row.id),
	vault: VaultsApi.VaultId.make(row.vaultId),
	name: row.name,
	description: row.description,
	source: decodeSource(row.source),
	fields: decodeFields(row.fields),
	exits: decodeExits(row.exits),
	version: row.version,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

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
		) => Effect.Effect<ReadonlyArray<Vault>, Failure, AuthorizationServices>
		readonly get: (
			caller: Caller,
			id: string,
			action?: "read" | "use" | "write",
		) => Effect.Effect<Vault, Failure, AuthorizationServices>
		readonly create: (
			caller: Caller,
			input: VaultsApi.CreateVaultRequest,
		) => Effect.Effect<Vault, Failure, AuthorizationServices>
		readonly update: (
			caller: Caller,
			id: string,
			input: VaultsApi.UpdateVaultRequest,
		) => Effect.Effect<Vault, Failure, AuthorizationServices>
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<void, Failure, AuthorizationServices>
		readonly items: (
			caller: Caller,
			vaultId: string,
		) => Effect.Effect<ReadonlyArray<Item>, Failure, AuthorizationServices>
		readonly item: (
			caller: Caller,
			vaultId: string,
			itemId: string,
		) => Effect.Effect<Item, Failure, AuthorizationServices>
		readonly createItem: (
			caller: Caller,
			vaultId: string,
			input: VaultsApi.CreateVaultItemRequest,
		) => Effect.Effect<Item, Failure, AuthorizationServices>
		readonly updateItem: (
			caller: Caller,
			vaultId: string,
			itemId: string,
			input: VaultsApi.UpdateVaultItemRequest,
		) => Effect.Effect<Item, Failure, AuthorizationServices>
		readonly removeItem: (
			caller: Caller,
			vaultId: string,
			itemId: string,
		) => Effect.Effect<void, Failure, AuthorizationServices>
		readonly bots: (
			caller: Caller,
			vaultId: string,
		) => Effect.Effect<
			ReadonlyArray<VaultsApi.VaultAccess>,
			Failure,
			AuthorizationServices
		>
		readonly grant: (
			caller: Caller,
			vaultId: string,
			bot: BotsApi.BotId,
		) => Effect.Effect<VaultsApi.VaultAccess, Failure, AuthorizationServices>
		readonly revoke: (
			caller: Caller,
			vaultId: string,
			bot: BotsApi.BotId,
		) => Effect.Effect<void, Failure, AuthorizationServices>
		/** The items of the Vaults that a Bot has the right to use. It checks no permission. An archived Bot has none. */
		readonly usable: (
			organizationId: string,
			bot: string,
		) => Effect.Effect<ReadonlyArray<Usable>, VaultsApi.VaultsUnavailable>
		/** The values of fields of an item, for Code Mode only. It checks no permission. */
		readonly reveal: (
			organizationId: string,
			itemId: string,
			fields: ReadonlyArray<string>,
		) => Effect.Effect<ReadonlyMap<string, string>, VaultReadFailed>
	}
>()("@openbot-build/openbot/vaults/Vaults") {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const readers = yield* Readers
	const providers = yield* SecretProviders
	const botsService = yield* Bots
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(unavailable))
	const where = (organizationId: string, id: string) =>
		and(eq(vaults.organizationId, organizationId), eq(vaults.id, id))
	const row = (organizationId: string, id: string) =>
		stored(db.select().from(vaults).where(where(organizationId, id))).pipe(
			Effect.map((rows) => Option.fromNullishOr(rows[0])),
		)
	const itemRow = (organizationId: string, vaultId: string, id: string) =>
		stored(
			db
				.select()
				.from(vaultItems)
				.where(
					and(
						eq(vaultItems.organizationId, organizationId),
						eq(vaultItems.vaultId, vaultId),
						eq(vaultItems.id, id),
					),
				),
		).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))
	/** A caller who cannot read a Vault does not learn that it exists. */
	const access = (
		caller: Caller,
		id: string,
		action: "read" | "use" | "write",
	) =>
		Effect.gen(function* () {
			const found = yield* row(caller.organizationId, id)
			if (Option.isNone(found)) return yield* notFound(id)
			const vault = fromRow(found.value)
			yield* guard(
				caller,
				{
					action,
					resource: vaultResource({
						...vault,
						organizationId: caller.organizationId,
					}),
				},
				{ hide: () => notFound(id) },
			)
			return vault
		})
	const itemAccess = (
		caller: Caller,
		vaultId: string,
		itemId: string,
		action: "read" | "use" | "write",
	) =>
		Effect.gen(function* () {
			yield* access(caller, vaultId, action)
			const found = yield* itemRow(caller.organizationId, vaultId, itemId)
			if (Option.isNone(found)) return yield* itemNotFound(itemId)
			return fromItemRow(found.value)
		})
	/**
	 * Checks the source of an item and gives back its fields. For a provider, the
	 * caller must be able to use it, and OpenBot reads the item once.
	 */
	const checkSource = (
		caller: Caller,
		input: {
			readonly source: Source
			readonly fields: ReadonlyArray<string> | undefined
			readonly values: Readonly<Record<string, string>> | undefined
		},
	) =>
		Effect.gen(function* () {
			const source = input.source
			if (source._tag === "Builtin") {
				if (input.values === undefined)
					return yield* invalid("A builtin item needs its values.")
				const fields = Object.keys(input.values)
				if (fields.length === 0 || fields.length > 32)
					return yield* invalid("A builtin item has 1 to 32 values.")
				if (
					input.fields !== undefined &&
					(input.fields.length !== fields.length ||
						input.fields.some((name) => !fields.includes(name)))
				)
					return yield* invalid(
						"The fields of a builtin item are the keys of its values.",
					)
				return fields
			}
			if (input.values !== undefined)
				return yield* invalid(
					"Only a builtin item has values. The secret provider keeps the others.",
				)
			if (input.fields === undefined)
				return yield* invalid("Say which fields of the item programs may use.")
			const provider = yield* providers.get(caller, source.provider, "use")
			if (provider.kind !== kindOf[source._tag])
				return yield* invalid(
					`A ${source._tag} source needs a ${kindOf[source._tag]} provider.`,
				)
			const credentials = yield* providers.credentials(
				caller.organizationId,
				source.provider,
			)
			yield* readers
				.make(credentials)
				.read(source, input.fields)
				.pipe(
					Effect.mapError((error) =>
						invalid("OpenBot could not read the item: " + error.message),
					),
				)
			return input.fields
		})
	const nameFree = (
		organizationId: string,
		vaultId: string,
		name: string,
		except?: string,
	) =>
		Effect.gen(function* () {
			const rows = yield* stored(
				db
					.select({ id: vaultItems.id })
					.from(vaultItems)
					.where(
						and(
							eq(vaultItems.organizationId, organizationId),
							eq(vaultItems.vaultId, vaultId),
							eq(vaultItems.name, name),
						),
					),
			)
			if (rows.some((found) => found.id !== except))
				return yield* invalid(`The Vault already has an item called ${name}.`)
		})
	const sealValues = (id: string, values: Readonly<Record<string, string>>) =>
		stored(secrets.seal(JSON.stringify(values), valuesBinding(id)))

	return Vaults.of({
		list: (caller) =>
			Effect.gen(function* () {
				const readable = yield* filter(caller, {
					action: "read",
					kind: "Vault",
					within: ($) => $.eq("organizationId", caller.organizationId),
				}).pipe(
					Effect.flatMap((condition) =>
						toWhere(condition, {
							organizationId: vaults.organizationId,
							ownerUserId: vaults.ownerUserId,
							id: vaults.id,
						}),
					),
				)
				const rows = yield* stored(
					db
						.select()
						.from(vaults)
						.where(
							and(eq(vaults.organizationId, caller.organizationId), readable),
						)
						.orderBy(vaults.createdAt),
				)
				return rows.map(fromRow)
			}),
		get: (caller, id, action = "read") => access(caller, id, action),
		create: (caller, input) =>
			Effect.gen(function* () {
				const userId = input.shared === true ? null : caller.userId
				yield* check(caller, {
					action: "write",
					kind: "Vault",
					within: ($) =>
						$.and(
							$.eq("organizationId", caller.organizationId),
							$.eq("ownerUserId", userId),
						),
				})
				const now = yield* Clock.currentTimeMillis
				const inserted = yield* stored(
					db
						.insert(vaults)
						.values({
							organizationId: caller.organizationId,
							id: "vlt_" + randomBytes(16).toString("hex"),
							ownerUserId: userId,
							name: input.name,
							version: 0,
							createdAt: now,
							updatedAt: now,
						})
						.returning(),
				)
				return fromRow(inserted[0]!)
			}),
		update: (caller, id, input) =>
			Effect.gen(function* () {
				const vault = yield* access(caller, id, "write")
				if (input.expectedVersion !== vault.version)
					return yield* VaultsApi.VaultConflict.make({ version: vault.version })
				const now = yield* Clock.currentTimeMillis
				const changed = yield* stored(
					db
						.update(vaults)
						.set({
							...(input.name === undefined ? {} : { name: input.name }),
							version: vault.version + 1,
							updatedAt: now,
						})
						.where(
							and(
								where(caller.organizationId, id),
								eq(vaults.version, vault.version),
							),
						)
						.returning(),
				)
				const next = changed[0]
				if (next === undefined)
					return yield* VaultsApi.VaultConflict.make({ version: vault.version })
				return fromRow(next)
			}),
		remove: (caller, id) =>
			Effect.gen(function* () {
				yield* access(caller, id, "write")
				// The items and the rights go with the Vault.
				yield* stored(db.delete(vaults).where(where(caller.organizationId, id)))
			}),
		items: (caller, vaultId) =>
			Effect.gen(function* () {
				yield* access(caller, vaultId, "read")
				const rows = yield* stored(
					db
						.select()
						.from(vaultItems)
						.where(
							and(
								eq(vaultItems.organizationId, caller.organizationId),
								eq(vaultItems.vaultId, vaultId),
							),
						)
						.orderBy(vaultItems.name),
				)
				return rows.map(fromItemRow)
			}),
		item: (caller, vaultId, itemId) =>
			itemAccess(caller, vaultId, itemId, "read"),
		createItem: (caller, vaultId, input) =>
			Effect.gen(function* () {
				yield* access(caller, vaultId, "write")
				yield* nameFree(caller.organizationId, vaultId, input.name)
				const fields = yield* checkSource(caller, {
					source: input.source,
					fields: input.fields,
					values: input.values,
				})
				const now = yield* Clock.currentTimeMillis
				const id = "vli_" + randomBytes(16).toString("hex")
				const values =
					input.values === undefined
						? null
						: yield* sealValues(id, input.values)
				const inserted = yield* stored(
					db
						.insert(vaultItems)
						.values({
							organizationId: caller.organizationId,
							id,
							vaultId,
							name: input.name,
							description: input.description ?? "",
							providerId: providerOf(input.source),
							source: JSON.stringify(input.source),
							fields: JSON.stringify(fields),
							exits: JSON.stringify(input.exits),
							values,
							version: 0,
							createdAt: now,
							updatedAt: now,
						})
						.returning(),
				)
				return fromItemRow(inserted[0]!)
			}),
		updateItem: (caller, vaultId, itemId, input) =>
			Effect.gen(function* () {
				const item = yield* itemAccess(caller, vaultId, itemId, "write")
				if (input.expectedVersion !== item.version)
					return yield* VaultsApi.VaultConflict.make({ version: item.version })
				if (input.name !== undefined)
					yield* nameFree(caller.organizationId, vaultId, input.name, itemId)
				const source = input.source ?? item.source
				if ((source._tag === "Builtin") !== (item.source._tag === "Builtin"))
					return yield* invalid(
						"A builtin item stays builtin, and an item of a provider stays with a provider.",
					)
				const builtin = source._tag === "Builtin"
				const sameFields =
					input.fields === undefined ||
					(input.fields.length === item.fields.length &&
						input.fields.every((name) => item.fields.includes(name)))
				// A builtin item keeps its values unless new ones come.
				const fields =
					builtin && input.values === undefined
						? sameFields
							? item.fields
							: yield* invalid(
									"Send new values to change the fields of a builtin item.",
								)
						: input.source === undefined &&
							  input.fields === undefined &&
							  input.values === undefined
							? item.fields
							: yield* checkSource(caller, {
									source,
									fields: input.fields ?? (builtin ? undefined : item.fields),
									values: input.values,
								})
				const values =
					input.values === undefined
						? {}
						: { values: yield* sealValues(itemId, input.values) }
				const now = yield* Clock.currentTimeMillis
				const changed = yield* stored(
					db
						.update(vaultItems)
						.set({
							...(input.name === undefined ? {} : { name: input.name }),
							...(input.description === undefined
								? {}
								: { description: input.description }),
							providerId: providerOf(source),
							source: JSON.stringify(source),
							fields: JSON.stringify(fields),
							...(input.exits === undefined
								? {}
								: { exits: JSON.stringify(input.exits) }),
							...values,
							version: item.version + 1,
							updatedAt: now,
						})
						.where(
							and(
								eq(vaultItems.organizationId, caller.organizationId),
								eq(vaultItems.id, itemId),
								eq(vaultItems.version, item.version),
							),
						)
						.returning(),
				)
				const next = changed[0]
				if (next === undefined)
					return yield* VaultsApi.VaultConflict.make({ version: item.version })
				return fromItemRow(next)
			}),
		removeItem: (caller, vaultId, itemId) =>
			Effect.gen(function* () {
				yield* itemAccess(caller, vaultId, itemId, "write")
				yield* stored(
					db
						.delete(vaultItems)
						.where(
							and(
								eq(vaultItems.organizationId, caller.organizationId),
								eq(vaultItems.id, itemId),
							),
						),
				)
			}),
		bots: (caller, vaultId) =>
			Effect.gen(function* () {
				yield* access(caller, vaultId, "read")
				const rows = yield* stored(
					db
						.select()
						.from(vaultAccess)
						.where(
							and(
								eq(vaultAccess.organizationId, caller.organizationId),
								eq(vaultAccess.vaultId, vaultId),
							),
						)
						.orderBy(vaultAccess.grantedAt),
				)
				return rows.map((entry) => ({
					vault: VaultsApi.VaultId.make(entry.vaultId),
					bot: BotsApi.BotId.make(entry.bot),
					grantedBy: entry.grantedBy,
					grantedAt: entry.grantedAt,
				}))
			}),
		grant: (caller, vaultId, bot) =>
			Effect.gen(function* () {
				yield* access(caller, vaultId, "use")
				const target = yield* botsService.access(caller, bot, "write").pipe(
					Effect.catchTags({
						BotNotFound: () => invalid("The Bot does not exist."),
						BotStorageUnavailable: () => Effect.fail(unavailable()),
						BotConflict: () => invalid("The Bot changed. Try again."),
						BotInvalid: (error) => invalid(error.message),
					}),
				)
				if (target.archived)
					return yield* invalid("An archived Bot cannot use a Vault.")
				const now = yield* Clock.currentTimeMillis
				yield* stored(
					db
						.insert(vaultAccess)
						.values({
							organizationId: caller.organizationId,
							vaultId,
							bot,
							grantedBy: caller.userId,
							grantedAt: now,
						})
						.onConflictDoNothing(),
				)
				const rows = yield* stored(
					db
						.select()
						.from(vaultAccess)
						.where(
							and(
								eq(vaultAccess.organizationId, caller.organizationId),
								eq(vaultAccess.vaultId, vaultId),
								eq(vaultAccess.bot, bot),
							),
						),
				)
				const saved = rows[0]!
				return {
					vault: VaultsApi.VaultId.make(vaultId),
					bot,
					grantedBy: saved.grantedBy,
					grantedAt: saved.grantedAt,
				}
			}),
		revoke: (caller, vaultId, bot) =>
			Effect.gen(function* () {
				yield* access(caller, vaultId, "use")
				yield* stored(
					db
						.delete(vaultAccess)
						.where(
							and(
								eq(vaultAccess.organizationId, caller.organizationId),
								eq(vaultAccess.vaultId, vaultId),
								eq(vaultAccess.bot, bot),
							),
						),
				)
			}),
		usable: (organizationId, bot) =>
			Effect.gen(function* () {
				const found = yield* botsService
					.find(organizationId, bot)
					.pipe(Effect.mapError(unavailable))
				if (Option.isNone(found) || found.value.archived) return []
				const held = yield* stored(
					db
						.select({ vaultId: vaultAccess.vaultId })
						.from(vaultAccess)
						.where(
							and(
								eq(vaultAccess.organizationId, organizationId),
								eq(vaultAccess.bot, bot),
							),
						),
				)
				if (held.length === 0) return []
				const rows = yield* stored(
					db
						.select({ item: vaultItems, vaultName: vaults.name })
						.from(vaultItems)
						.innerJoin(
							vaults,
							and(
								eq(vaults.organizationId, vaultItems.organizationId),
								eq(vaults.id, vaultItems.vaultId),
							),
						)
						.where(
							and(
								eq(vaultItems.organizationId, organizationId),
								inArray(
									vaultItems.vaultId,
									held.map((entry) => entry.vaultId),
								),
							),
						)
						.orderBy(vaultItems.id),
				)
				return rows.map((entry) => ({
					item: fromItemRow(entry.item),
					vaultName: entry.vaultName,
				}))
			}),
		reveal: (organizationId, itemId, fields) =>
			Effect.gen(function* () {
				const rows = yield* db
					.select()
					.from(vaultItems)
					.where(
						and(
							eq(vaultItems.organizationId, organizationId),
							eq(vaultItems.id, itemId),
						),
					)
				const found = rows[0]
				if (found === undefined)
					return yield* VaultReadFailed.make({ message: "The item is gone." })
				const item = fromItemRow(found)
				if (item.source._tag === "Builtin") {
					if (found.values === null)
						return yield* VaultReadFailed.make({
							message: "The builtin item has no values.",
						})
					const values = yield* decodeValues(
						yield* secrets.open(found.values, valuesBinding(itemId)),
					)
					const missing = fields.filter((name) => values[name] === undefined)
					if (missing.length > 0)
						return yield* VaultReadFailed.make({
							message: `The item has no field with the name ${missing.join(", ")}`,
						})
					return new Map(fields.map((name) => [name, values[name]!] as const))
				}
				const credentials = yield* providers.credentials(
					organizationId,
					item.source.provider,
				)
				return yield* readers.make(credentials).read(item.source, fields)
			}).pipe(
				Effect.catchIf(
					(error) => !(error instanceof VaultReadFailed),
					() =>
						Effect.fail(
							VaultReadFailed.make({
								message: "OpenBot could not open the item.",
							}),
						),
				),
			),
	})
})

export const layer = Layer.effect(Vaults, make)
