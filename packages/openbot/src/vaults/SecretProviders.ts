import { randomBytes } from "node:crypto"
import { type Caller, VaultsApi } from "@openbot-build/api"
import { and, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import type { Services as AuthorizationServices } from "../authorization/Check.ts"
import {
	type Errors as CheckErrors,
	check,
	filter,
	guard,
} from "../authorization/Check.ts"
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
	| CheckErrors

export const unavailable = () => VaultsApi.VaultsUnavailable.make({})
const invalid = (message: string) => VaultsApi.VaultInvalid.make({ message })
const notFound = (id: string) => VaultsApi.SecretProviderNotFound.make({ id })

const binding = (id: string) => `openbot_secret_providers:${id}:credentials`

/** The opened secret holds JSON that only this file writes, from a checked request. */
const decodeCredentials = Schema.decodeUnknownEffect(
	Schema.fromJsonString(VaultsApi.SecretProviderCredentials),
)
const decodeKind = Schema.decodeUnknownSync(VaultsApi.SecretProviderKind)
/** The hints column holds the view of the credentials, which only this file writes. */
const decodeView = Schema.decodeUnknownSync(
	Schema.fromJsonString(VaultsApi.SecretProviderCredentialsView),
)

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

const fromRow = (row: Row): Provider => ({
	id: VaultsApi.SecretProviderId.make(row.id),
	kind: decodeKind(row.kind),
	name: row.name,
	owner:
		row.ownerUserId === null
			? { _tag: "Organization" }
			: { _tag: "Member", userId: row.ownerUserId },
	credentials: decodeView(row.hints),
	version: row.version,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

/** The accounts at secret providers. Their tokens are sealed and never come out. */
export class SecretProviders extends Context.Service<
	SecretProviders,
	{
		readonly list: (
			caller: Caller,
		) => Effect.Effect<ReadonlyArray<Provider>, Failure, AuthorizationServices>
		/** Reads a provider that the caller may read, and also use or change when asked. */
		readonly get: (
			caller: Caller,
			id: string,
			action?: "read" | "use" | "write",
		) => Effect.Effect<Provider, Failure, AuthorizationServices>
		readonly create: (
			caller: Caller,
			input: VaultsApi.CreateSecretProviderRequest,
		) => Effect.Effect<Provider, Failure, AuthorizationServices>
		readonly update: (
			caller: Caller,
			id: string,
			input: VaultsApi.UpdateSecretProviderRequest,
		) => Effect.Effect<Provider, Failure, AuthorizationServices>
		/** Fails while Vault items still read from the provider. */
		readonly remove: (
			caller: Caller,
			id: string,
		) => Effect.Effect<void, Failure, AuthorizationServices>
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
	const stored = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(unavailable))
	const where = (organizationId: string, id: string) =>
		and(
			eq(secretProviders.organizationId, organizationId),
			eq(secretProviders.id, id),
		)
	const row = (organizationId: string, id: string) =>
		stored(
			db.select().from(secretProviders).where(where(organizationId, id)),
		).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))
	const seal = (id: string, credentials: Credentials) =>
		Effect.map(
			stored(secrets.seal(JSON.stringify(credentials), binding(id))),
			(sealed) => ({
				credentials: sealed,
				hints: JSON.stringify(viewOf(credentials)),
			}),
		)
	/** The provider must take the token before OpenBot stores it. */
	const verify = (credentials: Credentials) =>
		readers
			.make(credentials)
			.verify.pipe(
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
			const provider = fromRow(found.value)
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
				const rows = yield* stored(
					db
						.select()
						.from(secretProviders)
						.where(
							and(
								eq(secretProviders.organizationId, caller.organizationId),
								readable,
							),
						)
						.orderBy(secretProviders.createdAt),
				)
				return rows.map(fromRow)
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
				const id = "spr_" + randomBytes(16).toString("hex")
				const sealed = yield* seal(id, input.credentials)
				const inserted = yield* stored(
					db
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
						.returning(),
				)
				return fromRow(inserted[0]!)
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
				const changed = yield* stored(
					db
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
						.returning(),
				)
				const next = changed[0]
				if (next === undefined)
					return yield* VaultsApi.VaultConflict.make({
						version: provider.version,
					})
				return fromRow(next)
			}),
		remove: (caller, id) =>
			Effect.gen(function* () {
				yield* access(caller, id, "write")
				const used = yield* stored(
					db
						.select({ id: vaultItems.id })
						.from(vaultItems)
						.where(
							and(
								eq(vaultItems.organizationId, caller.organizationId),
								eq(vaultItems.providerId, id),
							),
						)
						.limit(1),
				)
				if (used.length > 0)
					return yield* invalid(
						"Vault items still read from this provider. Delete them first.",
					)
				yield* stored(
					db.delete(secretProviders).where(where(caller.organizationId, id)),
				)
			}),
		credentials: (organizationId, id) =>
			Effect.gen(function* () {
				const found = yield* row(organizationId, id)
				if (Option.isNone(found)) return yield* notFound(id)
				const json = yield* stored(
					secrets.open(found.value.credentials, binding(id)),
				)
				return yield* stored(decodeCredentials(json))
			}),
	})
})

export const layer = Layer.effect(SecretProviders, make)
