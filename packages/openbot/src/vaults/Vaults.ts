import { Redacted } from "effect"
import { BotsApi, type Caller, VaultsApi } from "@openbot-build/api"
import { and, eq, inArray } from "drizzle-orm"
import {
	Array as Arr,
	Cause,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Record as Rec,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"
import * as Failures from "../app/Failures.ts"
import * as Check from "../authorization/Check.ts"
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
	| VaultsApi.SecretProviderInUse
	| VaultsApi.SecretProviderFailed
	| VaultsApi.VaultNotFound
	| VaultsApi.VaultItemNotFound
	| VaultsApi.SecretProviderNotFound
	| VaultsApi.VaultConflict
	| VaultsApi.VaultInvalid
	| VaultsApi.VaultsUnavailable
	| Check.Errors

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
const ValuesJson = Schema.fromJsonString(
	Schema.Record(Schema.String, Schema.String),
)
const decodeValues = Schema.decodeUnknownEffect(ValuesJson)
/** The source, fields and exits columns hold JSON that only this file writes. */
const SourceJson = Schema.fromJsonString(VaultsApi.VaultItemSource)
const FieldsJson = Schema.fromJsonString(Schema.Array(VaultsApi.VaultFieldName))
const ExitsJson = Schema.fromJsonString(Schema.Array(VaultsApi.VaultExit))
const decodeSource = Schema.decodeUnknownEffect(SourceJson)
const decodeFields = Schema.decodeUnknownEffect(FieldsJson)
const decodeExits = Schema.decodeUnknownEffect(ExitsJson)
/** These values passed the request schema or came from the store, so they always encode. */
const encodeValues = (values: Readonly<Record<string, string>>) =>
	Schema.encodeEffect(ValuesJson)(values).pipe(Effect.orDie)
const encodeSource = (source: Source) =>
	Schema.encodeEffect(SourceJson)(source).pipe(Effect.orDie)
const encodeFields = (fields: ReadonlyArray<string>) =>
	Schema.encodeEffect(FieldsJson)(fields).pipe(Effect.orDie)
const encodeExits = (exits: ReadonlyArray<VaultsApi.VaultExit>) =>
	Schema.encodeEffect(ExitsJson)(exits).pipe(Effect.orDie)

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

/** A row with a bad value is a broken store. The log keeps the cause. */
const fromItemRow = (
	row: ItemRow,
): Effect.Effect<Item, VaultsApi.VaultsUnavailable> =>
	Effect.gen(function* () {
		return {
			id: VaultsApi.VaultItemId.make(row.id),
			vault: VaultsApi.VaultId.make(row.vaultId),
			name: row.name,
			description: row.description,
			source: yield* decodeSource(row.source),
			fields: yield* decodeFields(row.fields),
			exits: yield* decodeExits(row.exits),
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		} satisfies Item
	}).pipe(Failures.replace("A stored Vault item has a bad value", unavailable))

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
			input: VaultsApi.CreateVaultRequest,
		) => Effect.Effect<Vault, Failure>
		readonly update: (
			caller: Caller,
			id: string,
			input: VaultsApi.UpdateVaultRequest,
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
			input: VaultsApi.CreateVaultItemRequest,
		) => Effect.Effect<Item, Failure>
		readonly updateItem: (
			caller: Caller,
			vaultId: string,
			itemId: string,
			input: VaultsApi.UpdateVaultItemRequest,
		) => Effect.Effect<Item, Failure>
		readonly removeItem: (
			caller: Caller,
			vaultId: string,
			itemId: string,
		) => Effect.Effect<void, Failure>
		readonly bots: (
			caller: Caller,
			vaultId: string,
		) => Effect.Effect<ReadonlyArray<VaultsApi.VaultAccess>, Failure>
		readonly grant: (
			caller: Caller,
			vaultId: string,
			bot: BotsApi.BotId,
		) => Effect.Effect<VaultsApi.VaultAccess, Failure>
		readonly revoke: (
			caller: Caller,
			vaultId: string,
			bot: BotsApi.BotId,
		) => Effect.Effect<void, Failure>
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
	const crypto = yield* Crypto.Crypto
	const { check, filter, guard } = yield* Check.make
	/** A platform without secure random numbers is broken. */
	const newId = (prefix: string) =>
		crypto.randomBytes(16).pipe(
			Effect.orDie,
			Effect.map((bytes) => prefix + Hex.encode(bytes)),
		)
	const stored = (message: string) => Failures.replace(message, unavailable)
	const where = (organizationId: string, id: string) =>
		and(eq(vaults.organizationId, organizationId), eq(vaults.id, id))
	const row = (organizationId: string, id: string) =>
		db
			.select()
			.from(vaults)
			.where(where(organizationId, id))
			.pipe(
				stored("A Vault could not be read."),
				Effect.map((rows) => Option.fromNullishOr(rows[0])),
			)
	const itemRow = (organizationId: string, vaultId: string, id: string) =>
		db
			.select()
			.from(vaultItems)
			.where(
				and(
					eq(vaultItems.organizationId, organizationId),
					eq(vaultItems.vaultId, vaultId),
					eq(vaultItems.id, id),
				),
			)
			.pipe(
				stored("A Vault item could not be read."),
				Effect.map((rows) => Option.fromNullishOr(rows[0])),
			)
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
			return yield* fromItemRow(found.value)
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
			readonly values: Readonly<Record<string, unknown>> | undefined
		},
	) =>
		Effect.gen(function* () {
			const source = input.source
			if (source._tag === "Builtin") {
				if (input.values === undefined)
					return yield* invalid("A builtin item needs its values.")
				const fields = Rec.keys(input.values)
				if (fields.length === 0 || fields.length > 32)
					return yield* invalid("A builtin item has 1 to 32 values.")
				if (
					input.fields !== undefined &&
					(input.fields.length !== fields.length ||
						Arr.some(input.fields, (name) => !Arr.contains(fields, name)))
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
					Effect.tapError((error) =>
						Effect.logInfo(
							"OpenBot could not read a secret provider",
							Cause.fail(error),
						),
					),
					Effect.mapError((error) =>
						error.retry
							? VaultsApi.SecretProviderFailed.make({ message: error.message })
							: invalid("OpenBot could not read the item: " + error.message),
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
			const rows = yield* db
				.select({ id: vaultItems.id })
				.from(vaultItems)
				.where(
					and(
						eq(vaultItems.organizationId, organizationId),
						eq(vaultItems.vaultId, vaultId),
						eq(vaultItems.name, name),
					),
				)
				.pipe(stored("The item names of a Vault could not be read."))
			if (Arr.some(rows, (found) => found.id !== except))
				return yield* invalid(`The Vault already has an item called ${name}.`)
		})
	const sealValues = (
		id: string,
		values: Readonly<Record<string, Redacted.Redacted<string>>>,
	) =>
		Effect.flatMap(encodeValues(Rec.map(values, Redacted.value)), (json) =>
			secrets
				.seal(json, valuesBinding(id))
				.pipe(stored("The values of a Vault item could not be sealed.")),
		)

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
				const rows = yield* db
					.select()
					.from(vaults)
					.where(
						and(eq(vaults.organizationId, caller.organizationId), readable),
					)
					.orderBy(vaults.createdAt)
					.pipe(stored("The Vaults could not be listed."))
				return Arr.map(rows, fromRow)
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
				const inserted = yield* db
					.insert(vaults)
					.values({
						organizationId: caller.organizationId,
						id: yield* newId("vlt_"),
						ownerUserId: userId,
						name: input.name,
						version: 0,
						createdAt: now,
						updatedAt: now,
					})
					.returning()
					.pipe(stored("A Vault could not be created."))
				return fromRow(inserted[0]!)
			}),
		update: (caller, id, input) =>
			Effect.gen(function* () {
				const vault = yield* access(caller, id, "write")
				if (input.expectedVersion !== vault.version)
					return yield* VaultsApi.VaultConflict.make({ version: vault.version })
				const now = yield* Clock.currentTimeMillis
				const changed = yield* db
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
					.returning()
					.pipe(stored("A Vault could not be changed."))
				const next = changed[0]
				if (next === undefined)
					return yield* VaultsApi.VaultConflict.make({ version: vault.version })
				return fromRow(next)
			}),
		remove: (caller, id) =>
			Effect.gen(function* () {
				yield* access(caller, id, "write")
				// The items and the rights go with the Vault.
				yield* db
					.delete(vaults)
					.where(where(caller.organizationId, id))
					.pipe(stored("A Vault could not be deleted."))
			}),
		items: (caller, vaultId) =>
			Effect.gen(function* () {
				yield* access(caller, vaultId, "read")
				const rows = yield* db
					.select()
					.from(vaultItems)
					.where(
						and(
							eq(vaultItems.organizationId, caller.organizationId),
							eq(vaultItems.vaultId, vaultId),
						),
					)
					.orderBy(vaultItems.name)
					.pipe(stored("The items of a Vault could not be listed."))
				return yield* Effect.forEach(rows, fromItemRow)
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
				const id = yield* newId("vli_")
				const values =
					input.values === undefined
						? null
						: yield* sealValues(id, input.values)
				const inserted = yield* db
					.insert(vaultItems)
					.values({
						organizationId: caller.organizationId,
						id,
						vaultId,
						name: input.name,
						description: input.description ?? "",
						providerId: providerOf(input.source),
						source: yield* encodeSource(input.source),
						fields: yield* encodeFields(fields),
						exits: yield* encodeExits(input.exits),
						values,
						version: 0,
						createdAt: now,
						updatedAt: now,
					})
					.returning()
					.pipe(stored("A Vault item could not be created."))
				return yield* fromItemRow(inserted[0]!)
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
						Arr.every(input.fields, (name) => Arr.contains(item.fields, name)))
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
				const changed = yield* db
					.update(vaultItems)
					.set({
						...(input.name === undefined ? {} : { name: input.name }),
						...(input.description === undefined
							? {}
							: { description: input.description }),
						providerId: providerOf(source),
						source: yield* encodeSource(source),
						fields: yield* encodeFields(fields),
						...(input.exits === undefined
							? {}
							: { exits: yield* encodeExits(input.exits) }),
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
					.returning()
					.pipe(stored("A Vault item could not be changed."))
				const next = changed[0]
				if (next === undefined)
					return yield* VaultsApi.VaultConflict.make({ version: item.version })
				return yield* fromItemRow(next)
			}),
		removeItem: (caller, vaultId, itemId) =>
			Effect.gen(function* () {
				yield* itemAccess(caller, vaultId, itemId, "write")
				yield* db
					.delete(vaultItems)
					.where(
						and(
							eq(vaultItems.organizationId, caller.organizationId),
							eq(vaultItems.id, itemId),
						),
					)
					.pipe(stored("A Vault item could not be deleted."))
			}),
		bots: (caller, vaultId) =>
			Effect.gen(function* () {
				yield* access(caller, vaultId, "read")
				const rows = yield* db
					.select()
					.from(vaultAccess)
					.where(
						and(
							eq(vaultAccess.organizationId, caller.organizationId),
							eq(vaultAccess.vaultId, vaultId),
						),
					)
					.orderBy(vaultAccess.grantedAt)
					.pipe(stored("The Bots of a Vault could not be read."))
				return Arr.map(rows, (entry) => ({
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
				yield* db
					.insert(vaultAccess)
					.values({
						organizationId: caller.organizationId,
						vaultId,
						bot,
						grantedBy: caller.userId,
						grantedAt: now,
					})
					.onConflictDoNothing()
					.pipe(stored("A Vault right could not be saved."))
				const rows = yield* db
					.select()
					.from(vaultAccess)
					.where(
						and(
							eq(vaultAccess.organizationId, caller.organizationId),
							eq(vaultAccess.vaultId, vaultId),
							eq(vaultAccess.bot, bot),
						),
					)
					.pipe(stored("A Vault right could not be read."))
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
				yield* db
					.delete(vaultAccess)
					.where(
						and(
							eq(vaultAccess.organizationId, caller.organizationId),
							eq(vaultAccess.vaultId, vaultId),
							eq(vaultAccess.bot, bot),
						),
					)
					.pipe(stored("A Vault right could not be deleted."))
			}),
		usable: (organizationId, bot) =>
			Effect.gen(function* () {
				// Bots logs the cause of this failure itself.
				const found = yield* botsService
					.find(organizationId, bot)
					.pipe(
						Effect.catchTag("BotStorageUnavailable", () =>
							Effect.fail(unavailable()),
						),
					)
				if (Option.isNone(found) || found.value.archived) return []
				const held = yield* db
					.select({ vaultId: vaultAccess.vaultId })
					.from(vaultAccess)
					.where(
						and(
							eq(vaultAccess.organizationId, organizationId),
							eq(vaultAccess.bot, bot),
						),
					)
					.pipe(stored("The Vault rights of a Bot could not be read."))
				if (held.length === 0) return []
				const rows = yield* db
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
								Arr.map(held, (entry) => entry.vaultId),
							),
						),
					)
					.orderBy(vaultItems.id)
					.pipe(stored("The usable Vault items could not be read."))
				return yield* Effect.forEach(rows, (entry) =>
					Effect.map(fromItemRow(entry.item), (item) => ({
						item,
						vaultName: entry.vaultName,
					})),
				)
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
					.pipe(stored("A Vault item could not be read."))
				const found = rows[0]
				if (found === undefined)
					return yield* VaultReadFailed.make({
						retry: false,
						message: "The item is gone.",
					})
				const item = yield* fromItemRow(found)
				if (item.source._tag === "Builtin") {
					if (found.values === null)
						return yield* VaultReadFailed.make({
							retry: false,
							message: "The builtin item has no values.",
						})
					const values = yield* decodeValues(
						yield* secrets
							.open(found.values, valuesBinding(itemId))
							.pipe(stored("The values of a Vault item could not be opened.")),
					)
					const missing = Arr.filter(
						fields,
						(name) => values[name] === undefined,
					)
					if (missing.length > 0)
						return yield* VaultReadFailed.make({
							retry: false,
							message: `The item has no field with the name ${Arr.join(missing, ", ")}`,
						})
					return new Map(
						Arr.map(fields, (name) => [name, values[name]!] as const),
					)
				}
				const credentials = yield* providers.credentials(
					organizationId,
					item.source.provider,
				)
				return yield* readers.make(credentials).read(item.source, fields)
			}).pipe(
				// A failure of the reader keeps its message. `stored` and `fromItemRow` have logged the store failures.
				Effect.catchTags({
					// The decode failure can quote the opened values, so neither the log nor the error keeps it.
					SchemaError: () =>
						Effect.logError(
							"The stored values of a Vault item are not valid",
						).pipe(
							Effect.andThen(
								Effect.fail(
									VaultReadFailed.make({
										retry: false,
										message: "OpenBot could not open the item.",
									}),
								),
							),
						),
					SecretProviderNotFound: (error) =>
						Effect.fail(
							VaultReadFailed.make({
								retry: false,
								message: "The secret provider of the item is gone.",
								cause: error,
							}),
						),
					VaultsUnavailable: (error) =>
						Effect.fail(
							VaultReadFailed.make({
								retry: true,
								message: "OpenBot could not open the item.",
								cause: error,
							}),
						),
				}),
				Effect.annotateLogs({ item: itemId }),
			),
	})
})

export const layer = Layer.effect(Vaults, make)
