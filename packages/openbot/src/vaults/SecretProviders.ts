import { type Caller, VaultsApi } from "@openbot-build/api"
import { and, eq } from "drizzle-orm"
import {
	Cause,
	Clock,
	Context,
	Crypto,
	Effect,
	Layer,
	Option,
	Schema,
} from "effect"
import { Hex } from "effect/encoding"
import * as Failures from "../app/Failures.ts"
import * as Check from "../authorization/Check.ts"
import { secretProviderResource } from "../authorization/Resources.ts"
import { toWhere } from "../authorization/Sql.ts"
import * as Db from "../database/Database.ts"
import { secretProviders, vaultItems } from "../database/Schema.ts"
import { hint, Secrets } from "../secrets/Secrets.ts"
import { Readers } from "./Readers.ts"

type Provider = VaultsApi.SecretProvider
type Credentials = VaultsApi.SecretProviderCredentials

export type Failure =
	| VaultsApi.SecretProviderNotFound
	| VaultsApi.VaultConflict
	| VaultsApi.VaultInvalid
	| VaultsApi.VaultsUnavailable
	| Check.Errors

export const unavailable = () => VaultsApi.VaultsUnavailable.make({})
const invalid = (message: string) => VaultsApi.VaultInvalid.make({ message })
const notFound = (id: string) => VaultsApi.SecretProviderNotFound.make({ id })

const binding = (id: string) => `openbot_secret_providers:${id}:credentials`

/** The opened secret holds JSON that only this file writes, from a checked request. */
const CredentialsJson = Schema.fromJsonString(
	VaultsApi.SecretProviderCredentials,
)
const decodeCredentials = Schema.decodeUnknownEffect(CredentialsJson)
const encodeCredentials = Schema.encodeEffect(CredentialsJson)
const decodeKind = Schema.decodeUnknownEffect(VaultsApi.SecretProviderKind)
/** The hints column holds the view of the credentials, which only this file writes. */
const ViewJson = Schema.fromJsonString(VaultsApi.SecretProviderCredentialsView)
const decodeView = Schema.decodeUnknownEffect(ViewJson)
const encodeView = Schema.encodeEffect(ViewJson)

const viewOf = (
	credentials: Credentials,
): VaultsApi.SecretProviderCredentialsView => {
	switch (credentials.kind) {
		case "onepassword":
			return {
				kind: "onepassword",
				url: credentials.url,
				token: { set: true, hint: hint(credentials.token) },
			}
		case "bitwarden":
			return {
				kind: "bitwarden",
				url: credentials.url,
				token: {
					set: credentials.token !== undefined,
					hint:
						credentials.token === undefined ? null : hint(credentials.token),
				},
			}
		case "hashicorp":
			return {
				kind: "hashicorp",
				url: credentials.url,
				token: { set: true, hint: hint(credentials.token) },
				mount: credentials.mount ?? "secret",
				namespace: credentials.namespace ?? null,
			}
	}
}

type Row = typeof secretProviders.$inferSelect

/** A row with a bad value is a broken store. The log keeps the cause. */
const fromRow = (
	row: Row,
): Effect.Effect<Provider, VaultsApi.VaultsUnavailable> =>
	Effect.gen(function* () {
		return {
			id: VaultsApi.SecretProviderId.make(row.id),
			kind: yield* decodeKind(row.kind),
			name: row.name,
			owner:
				row.ownerUserId === null
					? { _tag: "Organization" }
					: { _tag: "Member", userId: row.ownerUserId },
			credentials: yield* decodeView(row.hints),
			version: row.version,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		} satisfies Provider
	}).pipe(
		Failures.replace("A stored secret provider has a bad value", unavailable),
	)

/** The accounts at secret providers. Their tokens are sealed and never come out. */
export class SecretProviders extends Context.Service<
	SecretProviders,
	{
		readonly list: (
			caller: Caller,
		) => Effect.Effect<ReadonlyArray<Provider>, Failure>
		/** Reads a provider that the caller may read, and also use or change when asked. */
		readonly get: (
			caller: Caller,
			id: string,
			action?: "read" | "use" | "write",
		) => Effect.Effect<Provider, Failure>
		readonly create: (
			caller: Caller,
			input: VaultsApi.CreateSecretProviderRequest,
		) => Effect.Effect<Provider, Failure>
		readonly update: (
			caller: Caller,
			id: string,
			input: VaultsApi.UpdateSecretProviderRequest,
		) => Effect.Effect<Provider, Failure>
		/** Fails while Vault items still read from the provider. */
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<void, Failure>
		/** The secrets of a provider, for its reader. It checks no permission. */
		readonly credentials: (
			organizationId: string,
			id: string,
		) => Effect.Effect<
			Credentials,
			VaultsApi.SecretProviderNotFound | VaultsApi.VaultsUnavailable
		>
	}
>()("@openbot-build/openbot/vaults/SecretProviders") {}

export const make = Effect.gen(function* () {
	const db = yield* Db.make
	const secrets = yield* Secrets
	const readers = yield* Readers
	const crypto = yield* Crypto.Crypto
	const { check, filter, guard } = yield* Check.make
	const stored = (message: string) => Failures.replace(message, unavailable)
	const where = (organizationId: string, id: string) =>
		and(
			eq(secretProviders.organizationId, organizationId),
			eq(secretProviders.id, id),
		)
	const row = (organizationId: string, id: string) =>
		db
			.select()
			.from(secretProviders)
			.where(where(organizationId, id))
			.pipe(
				stored("A secret provider could not be read."),
				Effect.map((rows) => Option.fromNullishOr(rows[0])),
			)
	const seal = (id: string, credentials: Credentials) =>
		Effect.gen(function* () {
			// The credentials passed the request schema, so they always encode.
			const json = yield* encodeCredentials(credentials).pipe(Effect.orDie)
			return {
				credentials: yield* secrets
					.seal(json, binding(id))
					.pipe(
						stored("The credentials of a secret provider could not be sealed."),
					),
				hints: yield* encodeView(viewOf(credentials)).pipe(Effect.orDie),
			}
		})
	/** The provider must take the token before OpenBot stores it. */
	const verify = (credentials: Credentials) =>
		readers.make(credentials).verify.pipe(
			Effect.tapError((error) =>
				Effect.logInfo(
					"OpenBot could not read a secret provider",
					Cause.fail(error),
				),
			),
			Effect.mapError((error) =>
				invalid("The provider did not take the token: " + error.message),
			),
		)
	/** A caller who cannot read a provider does not learn that it exists. */
	const access = (
		caller: Caller,
		id: string,
		action: "read" | "use" | "write",
	) =>
		Effect.gen(function* () {
			const found = yield* row(caller.organizationId, id)
			if (Option.isNone(found)) return yield* notFound(id)
			const provider = yield* fromRow(found.value)
			yield* guard(
				caller,
				{
					action,
					resource: secretProviderResource({
						...provider,
						organizationId: caller.organizationId,
					}),
				},
				{ hide: () => notFound(id) },
			)
			return provider
		})
	return SecretProviders.of({
		list: (caller) =>
			Effect.gen(function* () {
				const readable = yield* filter(caller, {
					action: "read",
					kind: "SecretProvider",
					within: ($) => $.eq("organizationId", caller.organizationId),
				}).pipe(
					Effect.flatMap((condition) =>
						toWhere(condition, {
							organizationId: secretProviders.organizationId,
							ownerUserId: secretProviders.ownerUserId,
							id: secretProviders.id,
						}),
					),
				)
				const rows = yield* db
					.select()
					.from(secretProviders)
					.where(
						and(
							eq(secretProviders.organizationId, caller.organizationId),
							readable,
						),
					)
					.orderBy(secretProviders.createdAt)
					.pipe(stored("The secret providers could not be listed."))
				return yield* Effect.forEach(rows, fromRow)
			}),
		get: (caller, id, action = "read") => access(caller, id, action),
		create: (caller, input) =>
			Effect.gen(function* () {
				const userId = input.shared === true ? null : caller.userId
				yield* check(caller, {
					action: "write",
					kind: "SecretProvider",
					within: ($) =>
						$.and(
							$.eq("organizationId", caller.organizationId),
							$.eq("ownerUserId", userId),
						),
				})
				yield* verify(input.credentials)
				const now = yield* Clock.currentTimeMillis
				const id =
					"spr_" + Hex.encode(yield* crypto.randomBytes(16).pipe(Effect.orDie))
				const sealed = yield* seal(id, input.credentials)
				const inserted = yield* db
					.insert(secretProviders)
					.values({
						organizationId: caller.organizationId,
						id,
						ownerUserId: userId,
						kind: input.credentials.kind,
						name: input.name,
						...sealed,
						version: 0,
						createdAt: now,
						updatedAt: now,
					})
					.returning()
					.pipe(stored("A secret provider could not be created."))
				return yield* fromRow(inserted[0]!)
			}),
		update: (caller, id, input) =>
			Effect.gen(function* () {
				const provider = yield* access(caller, id, "write")
				if (input.expectedVersion !== provider.version)
					return yield* VaultsApi.VaultConflict.make({
						version: provider.version,
					})
				if (
					input.credentials !== undefined &&
					input.credentials.kind !== provider.kind
				)
					return yield* invalid("The kind of a secret provider cannot change.")
				if (input.credentials !== undefined) yield* verify(input.credentials)
				const sealed =
					input.credentials === undefined
						? {}
						: yield* seal(id, input.credentials)
				const now = yield* Clock.currentTimeMillis
				const changed = yield* db
					.update(secretProviders)
					.set({
						...(input.name === undefined ? {} : { name: input.name }),
						...sealed,
						version: provider.version + 1,
						updatedAt: now,
					})
					.where(
						and(
							where(caller.organizationId, id),
							eq(secretProviders.version, provider.version),
						),
					)
					.returning()
					.pipe(stored("A secret provider could not be changed."))
				const next = changed[0]
				if (next === undefined)
					return yield* VaultsApi.VaultConflict.make({
						version: provider.version,
					})
				return yield* fromRow(next)
			}),
		remove: (caller, id) =>
			Effect.gen(function* () {
				yield* access(caller, id, "write")
				const used = yield* db
					.select({ id: vaultItems.id })
					.from(vaultItems)
					.where(
						and(
							eq(vaultItems.organizationId, caller.organizationId),
							eq(vaultItems.providerId, id),
						),
					)
					.limit(1)
					.pipe(
						stored("The Vault items of a secret provider could not be read."),
					)
				if (used.length > 0)
					return yield* invalid(
						"Vault items still read from this provider. Delete them first.",
					)
				yield* db
					.delete(secretProviders)
					.where(where(caller.organizationId, id))
					.pipe(stored("A secret provider could not be deleted."))
			}),
		credentials: (organizationId, id) =>
			Effect.gen(function* () {
				const found = yield* row(organizationId, id)
				if (Option.isNone(found)) return yield* notFound(id)
				const json = yield* secrets
					.open(found.value.credentials, binding(id))
					.pipe(
						stored("The credentials of a secret provider could not be opened."),
					)
				// The decode failure can quote the opened JSON, and it holds the token. So the log does not keep it.
				return yield* decodeCredentials(json).pipe(
					Effect.catchTag("SchemaError", () =>
						Effect.logError(
							"The stored credentials of a secret provider are not valid",
						).pipe(
							Effect.annotateLogs({ provider: id }),
							Effect.andThen(Effect.fail(unavailable())),
						),
					),
				)
			}),
	})
})

export const layer = Layer.effect(SecretProviders, make)
